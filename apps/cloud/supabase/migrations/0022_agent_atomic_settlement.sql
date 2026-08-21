-- A5-T2: settle Agent usage, credit hold, actual_credits and terminal status
-- in one database transaction. A terminal Run must never be visible before
-- its billing outcome is durable.

create or replace function public.settle_agent_run(
  p_run_id uuid,
  p_lease_id uuid,
  p_final_status text,
  p_error_code text default null,
  p_safe_message text default null
)
returns public.agent_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked public.agent_runs;
  settled public.agent_runs;
  actual integer;
  final_count integer;
begin
  if p_final_status not in ('succeeded', 'failed', 'cancelled') then
    raise exception 'invalid agent final status' using errcode = '22023';
  end if;
  if p_error_code is not null and char_length(p_error_code) > 80 then
    raise exception 'agent error code too long' using errcode = '22023';
  end if;
  if p_safe_message is not null and char_length(p_safe_message) > 500 then
    raise exception 'agent safe message too long' using errcode = '22023';
  end if;

  select run.* into locked
  from public.agent_runs as run
  where run.id = p_run_id
  for update;
  if not found then
    raise exception 'unknown agent run' using errcode = 'P0002';
  end if;
  if locked.lease_id is distinct from p_lease_id
      or locked.lease_expires_at is null
      or locked.lease_expires_at <= now() then
    raise exception 'invalid or expired agent lease' using errcode = '55000';
  end if;
  if not public.agent_run_transition_allowed(locked.status, p_final_status) then
    raise exception 'invalid agent run transition: % -> %', locked.status, p_final_status
      using errcode = '55000';
  end if;

  if p_final_status = 'succeeded' then
    select count(*)::integer into final_count
    from public.agent_artifacts as artifact
    where artifact.run_id = p_run_id
      and artifact.role = 'final_result'
      and artifact.deleted_at is null;
    if final_count <> 1 then
      raise exception 'succeeded agent run requires exactly one final result'
        using errcode = '55000';
    end if;
  end if;

  select coalesce(sum(item.credits), 0)::integer into actual
  from public.agent_usage_items as item
  where item.run_id = p_run_id;
  if actual > locked.budget_credits then
    raise exception 'agent usage exceeds budget' using errcode = '55000';
  end if;

  if actual > 0 then
    perform * from public.credit_confirm(locked.hold_id, actual);
  else
    perform * from public.credit_rollback(
      locked.hold_id,
      'agent run ' || p_final_status || ' without usage'
    );
  end if;

  update public.agent_runs as run
  set status = p_final_status,
      current_step = case when p_final_status = 'succeeded' then 'done' else coalesce(p_error_code, p_final_status) end,
      progress = case when p_final_status = 'succeeded' then 100 else run.progress end,
      actual_credits = actual,
      approval_required = false,
      error_code = case when p_final_status = 'failed' then p_error_code else null end,
      safe_message = case when p_final_status = 'failed' then p_safe_message else null end,
      lease_id = null,
      lease_owner = null,
      lease_expires_at = null,
      finished_at = now()
  where run.id = p_run_id
  returning run.* into settled;

  return settled;
end;
$$;

revoke execute on function public.settle_agent_run(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.settle_agent_run(uuid, uuid, text, text, text)
  to service_role;

comment on function public.settle_agent_run(uuid, uuid, text, text, text) is
  'Atomically settles recorded Agent usage and its credit hold before exposing a terminal Run status.';
