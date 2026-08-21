-- A4: atomically settle a user cancellation while no Worker lease is active.
-- Paused/requeued runs may already have billable usage, so a plain rollback is
-- incorrect; aggregate durable usage first, then confirm the actual amount.

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
  if v_run.status not in ('uploading', 'queued', 'awaiting_approval', 'awaiting_result_feedback')
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

revoke all on function public.cancel_unleased_agent_run(uuid) from public, anon, authenticated;
grant execute on function public.cancel_unleased_agent_run(uuid) to service_role;
