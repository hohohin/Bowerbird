-- V2 云端文字提炼（AGENT-RUNTIME-PLAN §8.7 / §11 V2-T1）：
-- visual_profile_jobs 队列镜像 0019 understand_jobs——反推卡 JSON 快照只存私有
-- generation-temp 短 TTL 对象；表内仅控制面元数据 + 结果 draft JSON（≤64KB，过期清空）。
-- payload 永不含图片/路径/文件名/URL；服务端无从取得或请求原图。

create table public.visual_profile_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.billing_accounts(id) on delete restrict,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  status text not null default 'uploading' check (status in (
    'uploading', 'queued', 'leased', 'running', 'cancel_requested',
    'cancelled', 'succeeded', 'failed', 'outcome_unknown'
  )),
  request_object_key text not null check (char_length(request_object_key) between 1 and 512),
  input_manifest_hash text not null check (input_manifest_hash ~ '^[0-9a-f]{64}$'),
  card_count integer not null check (card_count >= 0),
  hold_id uuid not null unique references public.credit_holds(id) on delete restrict,
  estimated_credits integer not null check (estimated_credits > 0),
  actual_credits integer check (actual_credits is null or actual_credits >= 0),
  pricing_version integer not null check (pricing_version > 0),
  lease_id uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  upstream_submitted_at timestamptz,
  result_text text check (result_text is null or char_length(result_text) between 1 and 65536),
  error_code text check (error_code is null or char_length(error_code) <= 80),
  safe_message text check (safe_message is null or char_length(safe_message) <= 500),
  created_at timestamptz not null default now(),
  queued_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  content_expires_at timestamptz not null,
  deleted_at timestamptz,
  unique (user_id, idempotency_key),
  check (
    (lease_id is null and lease_owner is null and lease_expires_at is null)
    or (lease_id is not null and lease_owner is not null and lease_expires_at is not null)
  ),
  check ((status in ('cancelled', 'succeeded', 'failed', 'outcome_unknown')) = (finished_at is not null)),
  check (status <> 'succeeded' or result_text is not null)
);

create index visual_profile_jobs_user_status_idx
  on public.visual_profile_jobs (user_id, status, created_at desc);
create index visual_profile_jobs_claim_idx
  on public.visual_profile_jobs (status, lease_expires_at, queued_at, created_at)
  where status in ('queued', 'leased', 'running');
create unique index visual_profile_jobs_active_lease_idx
  on public.visual_profile_jobs (lease_id) where lease_id is not null;
create index visual_profile_jobs_content_expiry_idx
  on public.visual_profile_jobs (content_expires_at) where deleted_at is null;

alter table public.visual_profile_jobs enable row level security;
alter table public.visual_profile_jobs force row level security;
revoke all on table public.visual_profile_jobs from anon, authenticated;
grant select on table public.visual_profile_jobs to authenticated;

create policy visual_profile_jobs_select_own
on public.visual_profile_jobs for select to authenticated
using (
  exists (
    select 1 from public.billing_accounts as account
    where account.id = visual_profile_jobs.user_id
      and account.auth_user_id = (select auth.uid())
  )
);

create or replace function public.claim_visual_profile_job(
  p_worker_id text,
  p_lease_seconds integer default 120
)
returns public.visual_profile_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate_id uuid;
  claimed public.visual_profile_jobs;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' or char_length(p_worker_id) > 120 then
    raise exception 'invalid worker id' using errcode = '22023';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'lease seconds must be between 30 and 600' using errcode = '22023';
  end if;

  select job.id into candidate_id
  from public.visual_profile_jobs as job
  where job.upstream_submitted_at is null
    and (
      job.status = 'queued'
      or (job.status in ('leased', 'running') and job.lease_expires_at <= now())
    )
  order by coalesce(job.queued_at, job.created_at), job.created_at, job.id
  for update skip locked
  limit 1;

  if candidate_id is null then
    return null;
  end if;

  update public.visual_profile_jobs as job
  set status = 'leased',
      lease_id = extensions.gen_random_uuid(),
      lease_owner = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      attempt_count = job.attempt_count + 1,
      started_at = coalesce(job.started_at, now())
  where job.id = candidate_id
  returning job.* into claimed;

  return claimed;
end;
$$;

create or replace function public.heartbeat_visual_profile_job(
  p_job_id uuid,
  p_lease_id uuid,
  p_lease_seconds integer default 120
)
returns table (
  job_status text,
  cancel_requested boolean,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked public.visual_profile_jobs;
begin
  if p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'lease seconds must be between 30 and 600' using errcode = '22023';
  end if;
  select job.* into locked
  from public.visual_profile_jobs as job
  where job.id = p_job_id
  for update;
  if not found then
    raise exception 'unknown visual profile job' using errcode = 'P0002';
  end if;
  if locked.lease_id is distinct from p_lease_id
      or locked.lease_expires_at is null
      or locked.lease_expires_at <= now() then
    raise exception 'invalid or expired visual profile lease' using errcode = '55000';
  end if;
  if locked.status not in ('leased', 'running', 'cancel_requested') then
    raise exception 'visual profile status does not hold a lease: %', locked.status using errcode = '55000';
  end if;

  update public.visual_profile_jobs as job
  set heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where job.id = p_job_id
  returning job.status, job.status = 'cancel_requested', job.lease_expires_at
  into job_status, cancel_requested, lease_expires_at;
  return next;
end;
$$;

create or replace function public.mark_visual_profile_job_submitted(
  p_job_id uuid,
  p_lease_id uuid
)
returns public.visual_profile_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked public.visual_profile_jobs;
  result public.visual_profile_jobs;
begin
  select job.* into locked
  from public.visual_profile_jobs as job
  where job.id = p_job_id
  for update;
  if not found then
    raise exception 'unknown visual profile job' using errcode = 'P0002';
  end if;
  if locked.lease_id is distinct from p_lease_id
      or locked.lease_expires_at is null
      or locked.lease_expires_at <= now()
      or locked.status not in ('leased', 'running', 'cancel_requested') then
    raise exception 'invalid visual profile lease or status' using errcode = '55000';
  end if;

  perform public.mark_hold_pending_settlement(locked.hold_id, 'deepseek request submitted');
  update public.visual_profile_jobs as job
  set status = case when job.status = 'cancel_requested' then job.status else 'running' end,
      upstream_submitted_at = coalesce(job.upstream_submitted_at, now()),
      heartbeat_at = now()
  where job.id = p_job_id
  returning job.* into result;
  return result;
end;
$$;

create or replace function public.complete_visual_profile_job(
  p_job_id uuid,
  p_lease_id uuid,
  p_status text,
  p_result_text text default null,
  p_error_code text default null,
  p_safe_message text default null
)
returns public.visual_profile_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked public.visual_profile_jobs;
  result public.visual_profile_jobs;
begin
  if p_status not in ('succeeded', 'failed', 'cancelled', 'outcome_unknown') then
    raise exception 'invalid terminal visual profile status' using errcode = '22023';
  end if;
  if p_status = 'succeeded' and (
      p_result_text is null or btrim(p_result_text) = '' or char_length(p_result_text) > 65536
  ) then
    raise exception 'successful visual profile requires result text' using errcode = '22023';
  end if;

  select job.* into locked
  from public.visual_profile_jobs as job
  where job.id = p_job_id
  for update;
  if not found then
    raise exception 'unknown visual profile job' using errcode = 'P0002';
  end if;
  if locked.status in ('succeeded', 'failed', 'cancelled', 'outcome_unknown') then
    if locked.status <> p_status then
      raise exception 'visual profile job already completed as %', locked.status using errcode = '55000';
    end if;
    return locked;
  end if;
  if locked.lease_id is distinct from p_lease_id
      or locked.lease_expires_at is null
      or locked.lease_expires_at <= now()
      or locked.status not in ('leased', 'running', 'cancel_requested') then
    raise exception 'invalid visual profile lease or status' using errcode = '55000';
  end if;

  if p_status = 'succeeded' then
    perform public.credit_confirm(locked.hold_id, locked.estimated_credits);
  elsif p_status in ('failed', 'cancelled') then
    perform public.credit_rollback(locked.hold_id, coalesce(p_error_code, p_status));
  else
    perform public.mark_hold_pending_settlement(locked.hold_id, coalesce(p_error_code, 'outcome_unknown'));
  end if;

  update public.visual_profile_jobs as job
  set status = p_status,
      actual_credits = case when p_status = 'succeeded' then job.estimated_credits else null end,
      result_text = case when p_status = 'succeeded' then p_result_text else null end,
      error_code = left(p_error_code, 80),
      safe_message = left(p_safe_message, 500),
      finished_at = now(),
      lease_id = null,
      lease_owner = null,
      lease_expires_at = null
  where job.id = p_job_id
  returning job.* into result;
  return result;
end;
$$;

create or replace function public.reconcile_stale_visual_profile_jobs(p_limit integer default 100)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  stale public.visual_profile_jobs;
  reconciled integer := 0;
begin
  if p_limit < 1 or p_limit > 1000 then
    raise exception 'limit must be between 1 and 1000' using errcode = '22023';
  end if;
  for stale in
    select job.*
    from public.visual_profile_jobs as job
    where job.status in ('leased', 'running', 'cancel_requested')
      and job.upstream_submitted_at is not null
      and job.lease_expires_at <= now()
    order by job.lease_expires_at, job.id
    for update skip locked
    limit p_limit
  loop
    perform public.mark_hold_pending_settlement(stale.hold_id, 'worker lease expired after upstream submission');
    update public.visual_profile_jobs as job
    set status = 'outcome_unknown', finished_at = now(), error_code = 'worker_lost_after_submit',
        safe_message = '请求已提交模型，但 Worker 连接中断，结果状态暂时无法确认',
        lease_id = null, lease_owner = null, lease_expires_at = null
    where job.id = stale.id;
    reconciled := reconciled + 1;
  end loop;
  return reconciled;
end;
$$;

revoke execute on function public.claim_visual_profile_job(text, integer) from public, anon, authenticated;
revoke execute on function public.heartbeat_visual_profile_job(uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function public.mark_visual_profile_job_submitted(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.complete_visual_profile_job(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.reconcile_stale_visual_profile_jobs(integer) from public, anon, authenticated;

grant execute on function public.claim_visual_profile_job(text, integer) to service_role;
grant execute on function public.heartbeat_visual_profile_job(uuid, uuid, integer) to service_role;
grant execute on function public.mark_visual_profile_job_submitted(uuid, uuid) to service_role;
grant execute on function public.complete_visual_profile_job(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.reconcile_stale_visual_profile_jobs(integer) to service_role;

-- V2-T1 定价：M0「每动作固定积分」降级规则同款——单次提炼任务一口价 2 积分
-- （DeepSeek 文本分批 + 聚合的实际上游成本 ≫ 低于该价，见 A8 provider_cost 费率）。
insert into public.service_costs (service, unit_cost, pricing_version, parameters, active)
values (
  'visual_profile_extract',
  2,
  1,
  '{"billing":"visual_profile"}'::jsonb,
  true
)
on conflict (service) do update
set unit_cost = excluded.unit_cost,
    pricing_version = excluded.pricing_version,
    parameters = excluded.parameters,
    active = excluded.active;

comment on table public.visual_profile_jobs is
  'Durable Cloud visual profile extraction jobs. Sanitized caption-card JSON lives only in private generation-temp objects; draft JSON result is nulled after content expiry.';
comment on column public.visual_profile_jobs.upstream_submitted_at is
  'Once set, an expired lease must never be reclaimed automatically; reconcile to outcome_unknown instead.';
