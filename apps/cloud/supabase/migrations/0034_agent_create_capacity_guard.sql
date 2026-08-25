-- A5-T6: serialize Agent Run creation in the database so concurrent Edge
-- requests cannot race past per-user or project-wide capacity checks.

create or replace function public.create_agent_run_guarded(
  p_run_id uuid,
  p_conversation_id uuid,
  p_user_id uuid,
  p_skill_id text,
  p_skill_version text,
  p_kernel_version text,
  p_input_count integer,
  p_input_manifest_hash text,
  p_request_object_key text,
  p_image_provider text,
  p_budget_credits integer,
  p_hold_id uuid,
  p_pricing_version integer,
  p_content_expires_at timestamptz,
  p_max_user_parallel integer,
  p_global_active_limit integer
)
returns public.agent_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.agent_runs;
  held public.credit_holds;
  user_active integer;
  global_active integer;
  created public.agent_runs;
begin
  if p_max_user_parallel < 1 or p_max_user_parallel > 16
      or p_global_active_limit < 1 or p_global_active_limit > 10000 then
    raise exception 'invalid agent capacity limits' using errcode = '22023';
  end if;

  -- One short global create lock gives the global count a strict upper bound;
  -- it also closes the per-user check/insert race without a separate lock.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('bowerbird:agent-run:create', 0)
  );

  select run.* into existing
  from public.agent_runs as run
  where run.hold_id = p_hold_id;
  if found then
    if existing.user_id <> p_user_id
        or existing.skill_id <> p_skill_id
        or existing.skill_version <> p_skill_version
        or existing.kernel_version <> p_kernel_version
        or existing.input_count <> p_input_count
        or existing.input_manifest_hash is distinct from p_input_manifest_hash
        or existing.image_provider <> p_image_provider
        or existing.budget_credits <> p_budget_credits
        or existing.pricing_version <> p_pricing_version then
      raise exception 'agent idempotency mismatch'
        using errcode = '55000', detail = 'agent_idempotency_mismatch';
    end if;
    return existing;
  end if;

  select hold.* into held
  from public.credit_holds as hold
  where hold.id = p_hold_id
  for update;
  if not found or held.user_id <> p_user_id or held.status <> 'held'
      or held.estimated_amount <> p_budget_credits
      or held.pricing_version <> p_pricing_version then
    raise exception 'agent hold mismatch' using errcode = '55000';
  end if;

  select count(*)::integer into user_active
  from public.agent_runs as run
  where run.user_id = p_user_id
    and run.status in (
      'uploading', 'queued', 'leased', 'running', 'awaiting_clarification',
      'awaiting_approval', 'awaiting_result_feedback', 'awaiting_local_task',
      'exporting', 'cancel_requested'
    );
  if user_active >= p_max_user_parallel then
    raise exception 'agent user parallel limit reached'
      using errcode = 'P0001', detail = 'agent_user_parallel_limit';
  end if;

  select count(*)::integer into global_active
  from public.agent_runs as run
  where run.status in (
    'uploading', 'queued', 'leased', 'running', 'awaiting_clarification',
    'awaiting_approval', 'awaiting_result_feedback', 'awaiting_local_task',
    'exporting', 'cancel_requested'
  );
  if global_active >= p_global_active_limit then
    raise exception 'agent global capacity reached'
      using errcode = 'P0001', detail = 'agent_global_capacity';
  end if;

  insert into public.agent_runs (
    id, conversation_id, user_id, skill_id, skill_version, kernel_version,
    status, input_count, input_manifest_hash, request_object_key, image_provider,
    budget_credits, hold_id, pricing_version, content_expires_at
  ) values (
    p_run_id, p_conversation_id, p_user_id, p_skill_id, p_skill_version,
    p_kernel_version, 'uploading', p_input_count, p_input_manifest_hash,
    p_request_object_key, p_image_provider, p_budget_credits, p_hold_id,
    p_pricing_version, p_content_expires_at
  ) returning * into created;
  return created;
end;
$$;

revoke execute on function public.create_agent_run_guarded(
  uuid, uuid, uuid, text, text, text, integer, text, text, text,
  integer, uuid, integer, timestamptz, integer, integer
) from public, anon, authenticated;
grant execute on function public.create_agent_run_guarded(
  uuid, uuid, uuid, text, text, text, integer, text, text, text,
  integer, uuid, integer, timestamptz, integer, integer
) to service_role;

comment on function public.create_agent_run_guarded(
  uuid, uuid, uuid, text, text, text, integer, text, text, text,
  integer, uuid, integer, timestamptz, integer, integer
) is 'Atomically enforces per-user and global Agent capacity, then inserts one idempotent uploading Run.';
