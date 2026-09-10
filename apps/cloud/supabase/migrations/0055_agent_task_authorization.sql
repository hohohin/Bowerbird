-- Only v3 approvals opt into goal-scoped execution. Historical approvals remain exact plans.
alter table public.agent_approvals add column task_policy jsonb;
alter table public.agent_tool_calls add column task_approval_id uuid references public.agent_approvals(id);
create index agent_tool_calls_task_quota_idx
  on public.agent_tool_calls (run_id, task_approval_id, tool_name);

create or replace function public.reserve_agent_task_tool()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_run public.agent_runs%rowtype;
  v_approval public.agent_approvals%rowtype;
  v_limit integer;
  v_used integer;
begin
  if new.phase <> 'execute_approved_plan' then return new; end if;
  -- Serializes different tools and parallel requests against the same authorization.
  select * into v_run from public.agent_runs where id = new.run_id for update;
  select * into v_approval from public.agent_approvals
    where run_id = new.run_id and proposal_hash = v_run.approved_plan_hash and status = 'approved'
    order by requested_at desc limit 1;
  if v_approval.task_policy is null then return new; end if;
  if v_run.status <> 'running' then raise exception 'agent_task_not_running'; end if;
  if new.tool_name = 'model_turn' then
    v_limit := (v_approval.task_policy->>'modelTurns')::integer;
  elsif new.tool_name = 'finalize_output' then
    v_limit := (v_approval.task_policy->>'outputCount')::integer;
  else
    select (entry->>'maxCalls')::integer into v_limit
      from jsonb_array_elements(v_approval.task_policy->'capabilities') entry
      where entry->>'tool' = new.tool_name;
  end if;
  if v_limit is null or v_limit < 1 then raise exception 'agent_task_capability_denied'; end if;
  select count(*) into v_used from public.agent_tool_calls
    where run_id = new.run_id and task_approval_id = v_approval.id and tool_name = new.tool_name;
  -- Failed and uncertain calls retain their allocation; never refund an unknown side effect.
  if v_used >= v_limit then raise exception 'agent_task_quota_exhausted'; end if;
  new.task_approval_id := v_approval.id;
  return new;
end;
$$;
revoke all on function public.reserve_agent_task_tool() from public, anon, authenticated;
create trigger reserve_agent_task_tool_before_insert
  before insert on public.agent_tool_calls
  for each row execute function public.reserve_agent_task_tool();

-- Settlement accounting must also be serialized, not read/check/insert in concurrent HTTP handlers.
create or replace function public.guard_agent_usage_budget()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_budget integer; v_spent bigint;
begin
  select budget_credits into v_budget from public.agent_runs where id = new.run_id for update;
  select coalesce(sum(credits), 0) into v_spent from public.agent_usage_items where run_id = new.run_id;
  if v_spent + new.credits > v_budget then raise exception 'agent_usage_budget_exceeded'; end if;
  return new;
end;
$$;
revoke all on function public.guard_agent_usage_budget() from public, anon, authenticated;
create trigger guard_agent_usage_budget_before_insert
  before insert on public.agent_usage_items
  for each row execute function public.guard_agent_usage_budget();
