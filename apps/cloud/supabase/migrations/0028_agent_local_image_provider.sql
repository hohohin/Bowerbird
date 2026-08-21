-- 本机 CLI provider（dreamina / codex）接入 bowerbird-controlled-image-edit。
-- 架构：VPS Worker 继续负责文本回合、计划、审批与编排；image_provider='jimeng' 的 Run
-- 或 image_provider='codex' 的 Run，在每个生图步骤把执行权交回用户桌面
-- （CLI 只在本机运行，VPS 不共享用户账号）。
-- 新增 awaiting_local_task 停车状态：与 awaiting_approval 同款（无租约、等待用户侧动作
-- 后重新入队），桌面执行结果按确定性 artifact object key 直传，由既有 artifact commit
-- 校验路径复用。

-- 1) Run 声明生图 provider。
alter table public.agent_runs
  add column image_provider text not null default 'cloud'
  check (image_provider in ('cloud', 'jimeng', 'codex'));

comment on column public.agent_runs.image_provider is
  'Approved-plan image generation provider: cloud = VPS Ark Seedream; jimeng/codex = desktop-local CLI driven through agent_local_tasks.';

-- 2) 桌面本地执行任务表：Worker 创建（pending），桌面消费并回报结果。
create table public.agent_local_tasks (
  id uuid primary key default extensions.gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  call_id text not null,
  provider text not null check (provider in ('jimeng', 'codex')),
  step_id text not null,
  params_object_key text not null,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'failed', 'expired')),
  result_object_key text,
  result_sha256 text check (result_sha256 is null or result_sha256 ~ '^[0-9a-f]{64}$'),
  result_mime text,
  result_bytes bigint check (result_bytes is null or (result_bytes > 0 and result_bytes <= 20971520)),
  error_code text check (error_code is null or char_length(error_code) <= 80),
  safe_message text check (safe_message is null or char_length(safe_message) <= 500),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (run_id, call_id)
);

create index agent_local_tasks_run_idx on public.agent_local_tasks (run_id);
create index agent_local_tasks_stale_idx on public.agent_local_tasks (status, expires_at);

alter table public.agent_local_tasks enable row level security;
alter table public.agent_local_tasks force row level security;

revoke all on table public.agent_local_tasks from anon, authenticated;
grant select on table public.agent_local_tasks to authenticated;

create policy agent_local_tasks_select_own
on public.agent_local_tasks for select to authenticated
using (exists (
  select 1 from public.agent_runs as run
  join public.billing_accounts as account on account.id = run.user_id
  where run.id = agent_local_tasks.run_id and account.auth_user_id = (select auth.uid())
));

-- 3) 状态机：running 可停车等待本地执行；停车态可重新入队/取消/失败。
create or replace function public.agent_run_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_from
    when 'uploading' then p_to in ('queued', 'cancelled', 'failed')
    when 'queued' then p_to in ('leased', 'cancelled', 'failed')
    when 'leased' then p_to in ('running', 'queued', 'cancel_requested', 'cancelled', 'failed')
    when 'running' then p_to in (
      'awaiting_clarification', 'awaiting_approval', 'awaiting_result_feedback', 'awaiting_local_task',
      'exporting', 'cancel_requested', 'cancelled', 'failed'
    )
    when 'awaiting_clarification' then p_to in ('queued', 'cancelled', 'failed')
    when 'awaiting_approval' then p_to in ('queued', 'cancelled', 'failed')
    when 'awaiting_result_feedback' then p_to in ('queued', 'exporting', 'cancelled', 'failed')
    when 'awaiting_local_task' then p_to in ('queued', 'cancelled', 'failed')
    when 'exporting' then p_to in ('succeeded', 'cancel_requested', 'cancelled', 'failed')
    when 'cancel_requested' then p_to in ('cancelled', 'failed')
    else false
  end;
$$;

-- 4) 停车态无租约：用户取消沿用既有原子结算路径。
create or replace function public.cancel_unleased_agent_run(p_run_id uuid)
returns table(status text, actual_credits integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.agent_runs%rowtype;
  v_actual integer;
begin
  select * into v_run
  from public.agent_runs
  where id = p_run_id
  for update;

  if not found then
    raise exception 'agent_run_not_found';
  end if;
  if v_run.status in ('succeeded', 'failed', 'cancelled') then
    return query select v_run.status, coalesce(v_run.actual_credits, 0);
    return;
  end if;
  if v_run.status not in ('uploading', 'queued', 'awaiting_approval', 'awaiting_result_feedback', 'awaiting_local_task')
     or v_run.lease_id is not null then
    raise exception 'agent_run_not_unleased';
  end if;

  select coalesce(sum(credits), 0)::integer into v_actual
  from public.agent_usage_items
  where run_id = p_run_id;

  if v_actual < 0 or v_actual > v_run.budget_credits then
    raise exception 'agent_usage_budget_invalid';
  end if;

  if v_actual > 0 then
    perform public.credit_confirm(v_run.hold_id, v_actual);
  else
    perform public.credit_rollback(v_run.hold_id);
  end if;

  update public.agent_runs
  set status = 'cancelled',
      actual_credits = v_actual,
      cancel_requested_at = coalesce(cancel_requested_at, now()),
      finished_at = now(),
      lease_id = null,
      lease_owner = null,
      lease_expires_at = null,
      heartbeat_at = null
  where id = p_run_id;

  return query select 'cancelled'::text, v_actual;
end;
$$;

-- 5) 桌面回报本地执行失败时的原子失败结算（镜像 0027，但终态为 failed）。
create or replace function public.fail_unleased_agent_run(
  p_run_id uuid,
  p_error_code text,
  p_safe_message text
)
returns table(status text, actual_credits integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.agent_runs%rowtype;
  v_actual integer;
begin
  if p_error_code is null or btrim(p_error_code) = '' or char_length(p_error_code) > 80 then
    raise exception 'agent_error_code_invalid';
  end if;
  if p_safe_message is not null and char_length(p_safe_message) > 500 then
    raise exception 'agent_safe_message_invalid';
  end if;

  select * into v_run
  from public.agent_runs
  where id = p_run_id
  for update;

  if not found then
    raise exception 'agent_run_not_found';
  end if;
  if v_run.status in ('succeeded', 'failed', 'cancelled') then
    return query select v_run.status, coalesce(v_run.actual_credits, 0);
    return;
  end if;
  if v_run.status <> 'awaiting_local_task' or v_run.lease_id is not null then
    raise exception 'agent_run_not_awaiting_local_task';
  end if;

  select coalesce(sum(credits), 0)::integer into v_actual
  from public.agent_usage_items
  where run_id = p_run_id;

  if v_actual < 0 or v_actual > v_run.budget_credits then
    raise exception 'agent_usage_budget_invalid';
  end if;

  if v_actual > 0 then
    perform public.credit_confirm(v_run.hold_id, v_actual);
  else
    perform public.credit_rollback(v_run.hold_id);
  end if;

  update public.agent_runs
  set status = 'failed',
      actual_credits = v_actual,
      error_code = p_error_code,
      safe_message = coalesce(p_safe_message, ''),
      finished_at = now(),
      lease_id = null,
      lease_owner = null,
      lease_expires_at = null,
      heartbeat_at = null
  where id = p_run_id;

  return query select 'failed'::text, v_actual;
end;
$$;

revoke all on function public.fail_unleased_agent_run(uuid, text, text) from public, anon, authenticated;
grant execute on function public.fail_unleased_agent_run(uuid, text, text) to service_role;

-- 6) 本机 CLI 生图不消耗 Bowerbird 积分（用户自有账号），但 usage 账本仍需可登记。
alter table public.agent_usage_items
  drop constraint agent_usage_items_provider_check;
alter table public.agent_usage_items
  add constraint agent_usage_items_provider_check check (provider in ('deepseek', 'ark', 'jimeng', 'codex'));

-- 7) 过期回收：桌面失联时由 Worker 的 claim 轮询兜底结算，避免停车 Run 永久滞留。
create or replace function public.expire_stale_local_tasks()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_run_id uuid;
begin
  if not exists (
    select 1 from public.agent_local_tasks
    where status = 'pending' and expires_at <= now()
  ) then
    return 0;
  end if;

  for v_run_id in
    select distinct run_id
    from public.agent_local_tasks
    where status = 'pending' and expires_at <= now()
  loop
    update public.agent_local_tasks
    set status = 'expired', completed_at = now(), error_code = 'local_task_timeout'
    where run_id = v_run_id and status = 'pending' and expires_at <= now();
    v_count := v_count + 1;

    if exists (select 1 from public.agent_runs where id = v_run_id and status = 'awaiting_local_task' and lease_id is null) then
      perform public.fail_unleased_agent_run(v_run_id, 'local_task_timeout', '本地生图任务超时未回报，已按实际用量结算');
    end if;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.expire_stale_local_tasks() from public, anon, authenticated;
grant execute on function public.expire_stale_local_tasks() to service_role;

-- 8) claim 顶部挂接过期回收（Worker 每 2s 轮询，无需额外定时设施）。
create or replace function public.claim_agent_run(
  p_worker_id text,
  p_lease_seconds integer default 60
)
returns public.agent_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate_id uuid;
  claimed public.agent_runs;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' or char_length(p_worker_id) > 120 then
    raise exception 'invalid worker id' using errcode = '22023';
  end if;
  if p_lease_seconds < 15 or p_lease_seconds > 300 then
    raise exception 'lease seconds must be between 15 and 300' using errcode = '22023';
  end if;

  perform public.expire_stale_local_tasks();

  select run.id into candidate_id
  from public.agent_runs as run
  where run.cancel_requested_at is null
    and (
      run.status = 'queued'
      or (run.status in ('leased', 'running', 'exporting') and run.lease_expires_at <= now())
    )
  order by coalesce(run.queued_at, run.created_at), run.created_at, run.id
  for update skip locked
  limit 1;

  if candidate_id is null then
    return null;
  end if;

  update public.agent_runs as run
  set status = 'leased',
      lease_id = extensions.gen_random_uuid(),
      lease_owner = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      attempt_count = run.attempt_count + 1,
      started_at = coalesce(run.started_at, now())
  where run.id = candidate_id
  returning run.* into claimed;

  return claimed;
end;
$$;
