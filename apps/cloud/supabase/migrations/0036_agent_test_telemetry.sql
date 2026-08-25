-- A7-T4: keep internal E2E/desktop-development Runs out of release success-rate
-- and cost telemetry while still counting them in live queue/capacity metrics.

alter table public.agent_runs
  add column if not exists is_test boolean not null default false;

-- Agent is still dev-only at this migration boundary; every historical Run is
-- an internal fixture/manual validation and may be classified deterministically.
update public.agent_runs set is_test = true where is_test = false;

create index agent_runs_terminal_telemetry_idx
  on public.agent_runs (is_test, finished_at desc)
  where status in ('succeeded', 'failed', 'cancelled');

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
  run_is_test boolean;
  created public.agent_runs;
begin
  if p_max_user_parallel < 1 or p_max_user_parallel > 16
      or p_global_active_limit < 1 or p_global_active_limit > 10000 then
    raise exception 'invalid agent capacity limits' using errcode = '22023';
  end if;

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

  select coalesce(auth_user.raw_app_meta_data -> 'bowerbird_test' = 'true'::jsonb, false)
  into run_is_test
  from public.billing_accounts as account
  left join auth.users as auth_user on auth_user.id = account.auth_user_id
  where account.id = p_user_id;

  insert into public.agent_runs (
    id, conversation_id, user_id, skill_id, skill_version, kernel_version,
    status, input_count, input_manifest_hash, request_object_key, image_provider,
    budget_credits, hold_id, pricing_version, content_expires_at, is_test
  ) values (
    p_run_id, p_conversation_id, p_user_id, p_skill_id, p_skill_version,
    p_kernel_version, 'uploading', p_input_count, p_input_manifest_hash,
    p_request_object_key, p_image_provider, p_budget_credits, p_hold_id,
    p_pricing_version, p_content_expires_at, coalesce(run_is_test, false)
  ) returning * into created;
  return created;
end;
$$;

comment on column public.agent_runs.is_test is
  'True only for internal Agent E2E/manual-validation accounts; excluded from release quality/cost telemetry.';
