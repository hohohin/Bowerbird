-- A2-T9: atomically bind one still-current clarification answer to its Run,
-- invalidate any stale approval hash, and re-queue for a fresh text-only plan.

create or replace function public.answer_agent_clarification(
  p_clarification_id uuid,
  p_run_id uuid,
  p_context_hash text,
  p_answer_object_key text,
  p_intent_patch_hash text
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_clarification public.agent_clarifications%rowtype;
  v_run public.agent_runs%rowtype;
begin
  if p_context_hash !~ '^[0-9a-f]{64}$'
     or p_intent_patch_hash !~ '^[0-9a-f]{64}$'
     or char_length(p_answer_object_key) not between 1 and 512 then
    raise exception 'invalid clarification answer metadata' using errcode = '22023';
  end if;

  select * into v_clarification
  from public.agent_clarifications
  where id = p_clarification_id and run_id = p_run_id
  for update;
  if not found
     or v_clarification.status <> 'pending'
     or v_clarification.context_hash <> p_context_hash
     or v_clarification.expires_at <= now() then
    raise exception 'clarification is stale' using errcode = '55000';
  end if;

  select * into v_run
  from public.agent_runs
  where id = p_run_id
  for update;
  if not found or v_run.status <> 'awaiting_clarification' then
    raise exception 'run is not awaiting clarification' using errcode = '55000';
  end if;

  update public.agent_clarifications
  set status = 'answered',
      answer_object_key = p_answer_object_key,
      intent_patch_hash = p_intent_patch_hash,
      answered_at = now()
  where id = p_clarification_id;

  -- Defensive invalidation: a clarification should normally precede approval,
  -- but a delayed answer must never leave an older approval usable.
  update public.agent_approvals
  set status = 'expired', decided_at = now()
  where run_id = p_run_id and status = 'pending';

  update public.agent_runs
  set status = 'queued',
      queued_at = now(),
      current_step = 'apply_intent_patch',
      approved_plan_hash = null,
      planned_tool_count = null
  where id = p_run_id;

  return true;
end;
$$;

revoke all on function public.answer_agent_clarification(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.answer_agent_clarification(uuid, uuid, text, text, text) to service_role;

comment on function public.answer_agent_clarification(uuid, uuid, text, text, text) is
  'Atomically accepts one context-bound IntentPatch answer, invalidates stale plan approval, and requeues the Agent Run.';
