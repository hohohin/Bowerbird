-- 修复 0040 引入的 PL/pgSQL 歧义：cancel_unleased_agent_run 声明了
-- RETURNS TABLE(status text, ...)，输出列在函数体内是变量；0040 新增的
-- agent_approvals UPDATE 的 WHERE 里裸写 `and status = 'pending'`，解析期即
-- SQLSTATE 42702（column reference "status" is ambiguous）。
-- 该语句在 0040 上线时没有任何待结算的过期停车 Run，从未被执行，bug 潜伏到
-- 2026-08-26 05:34 UTC 两个停车 Run 内容过期后才显形：此后 Edge cleanup_expired
-- 每 10 分钟 500（事务原子回滚，Run 与 hold 保持原状，无资损），TTL 清理停滞。
-- 修复 = WHERE 内列引用表限定；行为与 0040 完全一致。

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
  if v_run.status not in (
      'uploading', 'queued', 'awaiting_clarification', 'awaiting_approval',
      'awaiting_result_feedback', 'awaiting_local_task'
    ) or v_run.lease_id is not null then
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

  update public.agent_approvals
  set status = 'expired',
      decided_at = now()
  where run_id = p_run_id
    and agent_approvals.status = 'pending';

  return query select 'cancelled'::text, v_actual;
end;
$$;

revoke all on function public.cancel_unleased_agent_run(uuid) from public, anon, authenticated;
grant execute on function public.cancel_unleased_agent_run(uuid) to service_role;

comment on function public.cancel_unleased_agent_run(uuid) is
  'Atomically settles and cancels an unleased active/parked Agent Run; also expires its pending approval so approval abandonment stays measurable.';
