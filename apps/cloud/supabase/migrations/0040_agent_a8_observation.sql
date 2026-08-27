-- A8 小流量观察支持：
-- 1) cancel_unleased_agent_run 同时把该 Run 的 pending 审批置为 expired（带 decided_at，
--    满足 0012 的 (status='pending')=(decided_at is null) 约束）。「审批后放弃率」从此可从
--    agent_approvals.status 直接统计，用户拒绝后取消 / 用户主动取消 / TTL 过期清理三条路径统一生效。
-- 2) agent_usage_v1 parameters 增加可选 provider_cost 估算费率（micro CNY）。Edge 在 usage
--    落库时按费率估算上游成本，A8-T2 的每 Run 成本与积分毛利由此可算。数值为 2026-08 刊例价的
--    保守估算（DeepSeek 峰谷输入约 ¥1.5–4.5/M、输出约 ¥4.5–9/M；Seedream 2K ≈ ¥0.25/张），
--    运营核对后直接 UPDATE service_costs 即可，无需改代码。

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
    and status = 'pending';

  return query select 'cancelled'::text, v_actual;
end;
$$;

revoke all on function public.cancel_unleased_agent_run(uuid) from public, anon, authenticated;
grant execute on function public.cancel_unleased_agent_run(uuid) to service_role;

comment on function public.cancel_unleased_agent_run(uuid) is
  'Atomically settles and cancels an unleased active/parked Agent Run; also expires its pending approval so approval abandonment stays measurable.';

update public.service_costs
set parameters = jsonb_set(parameters, '{provider_cost}', $json$
  {
    "currency": "CNY",
    "deepseek_input_micros_per_million_tokens": 2000000,
    "deepseek_output_micros_per_million_tokens": 6000000,
    "ark_vision_micros_per_call": 30000,
    "image_micros_per_image": { "ark": 250000, "jimeng": 0, "codex": 0 }
  }
$json$::jsonb, true)
where service = 'agent_usage_v1';
