-- Bowerbird Agent Runtime A1-T1: durable Run control-plane facts and lease RPCs.
-- User content remains in private, short-TTL objects; these tables store only control metadata.

insert into public.service_costs (service, unit_cost, pricing_version, parameters, active)
values (
  'agent_smart_refinement',
  15,
  1,
  '{"billing":"usage_items","max_budget_credits":15,"text_provider":"deepseek","image_provider":"ark"}'::jsonb,
  true
)
on conflict (service) do nothing;

create table public.agent_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.billing_accounts(id) on delete restrict,
  skill_id text not null check (char_length(skill_id) between 1 and 80),
  skill_version text not null check (char_length(skill_version) between 1 and 40),
  worker_version text,
  kernel_version text not null check (char_length(kernel_version) between 1 and 40),
  status text not null default 'uploading' check (status in (
    'uploading', 'queued', 'leased', 'running',
    'awaiting_clarification', 'awaiting_approval', 'awaiting_result_feedback',
    'exporting', 'cancel_requested', 'cancelled', 'succeeded', 'failed'
  )),
  current_step text,
  progress smallint not null default 0 check (progress between 0 and 100),
  input_count smallint not null check (input_count between 1 and 8),
  input_manifest_hash text not null check (input_manifest_hash ~ '^[0-9a-f]{64}$'),
  request_object_key text not null check (char_length(request_object_key) between 1 and 512),
  budget_credits integer not null check (budget_credits > 0),
  hold_id uuid not null unique references public.credit_holds(id) on delete restrict,
  actual_credits integer check (actual_credits is null or actual_credits between 0 and budget_credits),
  pricing_version integer not null check (pricing_version > 0),
  lease_id uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  cancel_requested_at timestamptz,
  approval_required boolean not null default false,
  checkpoint_object_key text,
  checkpoint_hash text check (checkpoint_hash is null or checkpoint_hash ~ '^[0-9a-f]{64}$'),
  snapshot_schema_version integer check (snapshot_schema_version is null or snapshot_schema_version > 0),
  context_capsule_hash text check (context_capsule_hash is null or context_capsule_hash ~ '^[0-9a-f]{64}$'),
  error_code text,
  safe_message text check (safe_message is null or char_length(safe_message) <= 500),
  created_at timestamptz not null default now(),
  queued_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  content_expires_at timestamptz not null,
  check (
    (lease_id is null and lease_owner is null and lease_expires_at is null)
    or (lease_id is not null and lease_owner is not null and lease_expires_at is not null)
  ),
  check ((status in ('cancelled', 'succeeded', 'failed')) = (finished_at is not null))
);

create index agent_runs_user_status_idx on public.agent_runs (user_id, status, created_at desc);
create index agent_runs_claim_idx on public.agent_runs (status, lease_expires_at, queued_at, created_at)
  where status in ('queued', 'leased', 'running');
create unique index agent_runs_active_lease_idx on public.agent_runs (lease_id) where lease_id is not null;
create index agent_runs_content_expiry_idx on public.agent_runs (content_expires_at);

create table public.agent_events (
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  seq bigint not null check (seq > 0),
  type text not null check (char_length(type) between 1 and 80),
  step text,
  progress smallint check (progress is null or progress between 0 and 100),
  display_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  content_expires_at timestamptz not null,
  primary key (run_id, seq),
  check (jsonb_typeof(display_payload) = 'object'),
  check (octet_length(display_payload::text) <= 16384)
);

create index agent_events_expiry_idx on public.agent_events (content_expires_at);

create table public.agent_approvals (
  id uuid primary key default extensions.gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  kind text not null check (kind in ('creative_plan', 'refine_plan')),
  proposal_object_key text not null check (char_length(proposal_object_key) between 1 and 512),
  proposal_hash text not null check (proposal_hash ~ '^[0-9a-f]{64}$'),
  estimated_additional_credits integer not null default 0 check (estimated_additional_credits >= 0),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  expires_at timestamptz not null,
  check ((status = 'pending') = (decided_at is null))
);

create unique index agent_approvals_one_pending_idx on public.agent_approvals (run_id)
  where status = 'pending';
create index agent_approvals_run_requested_idx on public.agent_approvals (run_id, requested_at desc);

create table public.agent_clarifications (
  id uuid primary key default extensions.gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  question_key text not null check (char_length(question_key) between 1 and 120),
  context_hash text not null check (context_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'answered', 'expired', 'cancelled')),
  question_object_key text not null check (char_length(question_object_key) between 1 and 512),
  answer_object_key text,
  intent_patch_hash text check (intent_patch_hash is null or intent_patch_hash ~ '^[0-9a-f]{64}$'),
  asked_at timestamptz not null default now(),
  answered_at timestamptz,
  expires_at timestamptz not null,
  unique (run_id, question_key),
  check ((status = 'answered') = (answered_at is not null)),
  check (status <> 'answered' or (answer_object_key is not null and intent_patch_hash is not null))
);

create index agent_clarifications_run_asked_idx on public.agent_clarifications (run_id, asked_at desc);

create table public.agent_tool_calls (
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  call_id text not null check (char_length(call_id) between 1 and 160),
  phase text not null check (char_length(phase) between 1 and 80),
  tool_name text not null check (char_length(tool_name) between 1 and 80),
  args_hash text not null check (args_hash ~ '^[0-9a-f]{64}$'),
  attempt integer not null default 1 check (attempt > 0),
  status text not null check (status in ('prepared', 'submitted', 'succeeded', 'failed', 'outcome_unknown')),
  provider_request_id text,
  result_object_key text,
  result_hash text check (result_hash is null or result_hash ~ '^[0-9a-f]{64}$'),
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  finished_at timestamptz,
  safe_error_code text,
  primary key (run_id, call_id),
  check (status not in ('submitted', 'outcome_unknown') or submitted_at is not null),
  check (status not in ('succeeded', 'failed') or finished_at is not null)
);

create index agent_tool_calls_status_idx on public.agent_tool_calls (run_id, status);

create table public.agent_artifacts (
  id uuid primary key default extensions.gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  kind text not null check (char_length(kind) between 1 and 80),
  object_key text not null check (char_length(object_key) between 1 and 512),
  mime text not null check (char_length(mime) between 1 and 120),
  bytes bigint not null check (bytes >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  source_call_id text,
  expires_at timestamptz not null,
  downloaded_at timestamptz,
  deleted_at timestamptz,
  unique (run_id, object_key),
  foreign key (run_id, source_call_id)
    references public.agent_tool_calls(run_id, call_id) on delete restrict
);

create index agent_artifacts_run_kind_idx on public.agent_artifacts (run_id, kind);
create index agent_artifacts_expiry_idx on public.agent_artifacts (expires_at) where deleted_at is null;

create table public.agent_usage_items (
  id uuid primary key default extensions.gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  call_id text not null check (char_length(call_id) between 1 and 160),
  kind text not null check (kind in ('model_tokens', 'vision_call', 'image_generation')),
  provider text not null check (provider in ('deepseek', 'ark')),
  model text not null check (char_length(model) between 1 and 120),
  input_units bigint not null default 0 check (input_units >= 0),
  output_units bigint not null default 0 check (output_units >= 0),
  image_count integer not null default 0 check (image_count >= 0),
  resolution text,
  provider_cost_micros bigint check (provider_cost_micros is null or provider_cost_micros >= 0),
  credits integer not null default 0 check (credits >= 0),
  pricing_version integer not null check (pricing_version > 0),
  created_at timestamptz not null default now(),
  unique (run_id, call_id),
  foreign key (run_id, call_id)
    references public.agent_tool_calls(run_id, call_id) on delete restrict
);

create index agent_usage_items_run_created_idx on public.agent_usage_items (run_id, created_at);

-- All user-visible Agent tables are own-row SELECT only. Writes are service-side.
alter table public.agent_runs enable row level security;
alter table public.agent_runs force row level security;
alter table public.agent_events enable row level security;
alter table public.agent_events force row level security;
alter table public.agent_approvals enable row level security;
alter table public.agent_approvals force row level security;
alter table public.agent_clarifications enable row level security;
alter table public.agent_clarifications force row level security;
alter table public.agent_artifacts enable row level security;
alter table public.agent_artifacts force row level security;
alter table public.agent_usage_items enable row level security;
alter table public.agent_usage_items force row level security;
alter table public.agent_tool_calls enable row level security;
alter table public.agent_tool_calls force row level security;

revoke all on table public.agent_runs from anon, authenticated;
revoke all on table public.agent_events from anon, authenticated;
revoke all on table public.agent_approvals from anon, authenticated;
revoke all on table public.agent_clarifications from anon, authenticated;
revoke all on table public.agent_artifacts from anon, authenticated;
revoke all on table public.agent_usage_items from anon, authenticated;
revoke all on table public.agent_tool_calls from anon, authenticated;

grant select on table public.agent_runs to authenticated;
grant select on table public.agent_events to authenticated;
grant select on table public.agent_approvals to authenticated;
grant select on table public.agent_clarifications to authenticated;
grant select on table public.agent_artifacts to authenticated;
grant select on table public.agent_usage_items to authenticated;
grant select on table public.agent_tool_calls to authenticated;

create policy agent_runs_select_own
on public.agent_runs for select to authenticated
using (
  exists (
    select 1 from public.billing_accounts as account
    where account.id = agent_runs.user_id
      and account.auth_user_id = (select auth.uid())
  )
);

create policy agent_events_select_own
on public.agent_events for select to authenticated
using (exists (
  select 1 from public.agent_runs as run
  join public.billing_accounts as account on account.id = run.user_id
  where run.id = agent_events.run_id and account.auth_user_id = (select auth.uid())
));

create policy agent_approvals_select_own
on public.agent_approvals for select to authenticated
using (exists (
  select 1 from public.agent_runs as run
  join public.billing_accounts as account on account.id = run.user_id
  where run.id = agent_approvals.run_id and account.auth_user_id = (select auth.uid())
));

create policy agent_clarifications_select_own
on public.agent_clarifications for select to authenticated
using (exists (
  select 1 from public.agent_runs as run
  join public.billing_accounts as account on account.id = run.user_id
  where run.id = agent_clarifications.run_id and account.auth_user_id = (select auth.uid())
));

create policy agent_artifacts_select_own
on public.agent_artifacts for select to authenticated
using (exists (
  select 1 from public.agent_runs as run
  join public.billing_accounts as account on account.id = run.user_id
  where run.id = agent_artifacts.run_id and account.auth_user_id = (select auth.uid())
));

create policy agent_usage_items_select_own
on public.agent_usage_items for select to authenticated
using (exists (
  select 1 from public.agent_runs as run
  join public.billing_accounts as account on account.id = run.user_id
  where run.id = agent_usage_items.run_id and account.auth_user_id = (select auth.uid())
));

create policy agent_tool_calls_select_own
on public.agent_tool_calls for select to authenticated
using (exists (
  select 1 from public.agent_runs as run
  join public.billing_accounts as account on account.id = run.user_id
  where run.id = agent_tool_calls.run_id and account.auth_user_id = (select auth.uid())
));

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
      'awaiting_clarification', 'awaiting_approval', 'awaiting_result_feedback',
      'exporting', 'cancel_requested', 'cancelled', 'failed'
    )
    when 'awaiting_clarification' then p_to in ('queued', 'cancelled', 'failed')
    when 'awaiting_approval' then p_to in ('queued', 'cancelled', 'failed')
    when 'awaiting_result_feedback' then p_to in ('queued', 'exporting', 'cancelled', 'failed')
    when 'exporting' then p_to in ('succeeded', 'cancel_requested', 'cancelled', 'failed')
    when 'cancel_requested' then p_to in ('cancelled', 'failed')
    else false
  end;
$$;

create or replace function public.claim_agent_run(
  p_worker_id text,
  p_lease_seconds integer default 60
)
returns public.agent_runs
language plpgsql
security definer
set search_path = ''
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

  select run.id into candidate_id
  from public.agent_runs as run
  where run.cancel_requested_at is null
    and (
      run.status = 'queued'
      or (run.status in ('leased', 'running') and run.lease_expires_at <= now())
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

create or replace function public.heartbeat_agent_run(
  p_run_id uuid,
  p_lease_id uuid,
  p_lease_seconds integer default 60
)
returns table (
  run_status text,
  cancel_requested boolean,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked public.agent_runs;
begin
  if p_lease_seconds < 15 or p_lease_seconds > 300 then
    raise exception 'lease seconds must be between 15 and 300' using errcode = '22023';
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
  if locked.status not in ('leased', 'running', 'exporting', 'cancel_requested') then
    raise exception 'run status does not hold a lease: %', locked.status using errcode = '55000';
  end if;

  update public.agent_runs as run
  set heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where run.id = p_run_id
  returning run.status, run.cancel_requested_at is not null, run.lease_expires_at
  into run_status, cancel_requested, lease_expires_at;
  return next;
end;
$$;

create or replace function public.transition_agent_run(
  p_run_id uuid,
  p_lease_id uuid,
  p_to_status text,
  p_current_step text default null,
  p_progress integer default null,
  p_checkpoint_object_key text default null,
  p_checkpoint_hash text default null,
  p_snapshot_schema_version integer default null
)
returns public.agent_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked public.agent_runs;
  transitioned public.agent_runs;
  releases_lease boolean;
begin
  if p_progress is not null and (p_progress < 0 or p_progress > 100) then
    raise exception 'progress must be between 0 and 100' using errcode = '22023';
  end if;
  if p_checkpoint_hash is not null and p_checkpoint_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid checkpoint hash' using errcode = '22023';
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
  if not public.agent_run_transition_allowed(locked.status, p_to_status) then
    raise exception 'invalid agent run transition: % -> %', locked.status, p_to_status using errcode = '55000';
  end if;

  releases_lease := p_to_status not in ('leased', 'running', 'exporting', 'cancel_requested');
  update public.agent_runs as run
  set status = p_to_status,
      current_step = coalesce(p_current_step, run.current_step),
      progress = coalesce(p_progress, run.progress),
      checkpoint_object_key = coalesce(p_checkpoint_object_key, run.checkpoint_object_key),
      checkpoint_hash = coalesce(p_checkpoint_hash, run.checkpoint_hash),
      snapshot_schema_version = coalesce(p_snapshot_schema_version, run.snapshot_schema_version),
      lease_id = case when releases_lease then null else run.lease_id end,
      lease_owner = case when releases_lease then null else run.lease_owner end,
      lease_expires_at = case when releases_lease then null else run.lease_expires_at end,
      heartbeat_at = case when releases_lease then run.heartbeat_at else now() end,
      finished_at = case when p_to_status in ('cancelled', 'succeeded', 'failed') then now() else run.finished_at end
  where run.id = p_run_id
  returning run.* into transitioned;

  return transitioned;
end;
$$;

revoke execute on function public.agent_run_transition_allowed(text, text) from public, anon, authenticated;
revoke execute on function public.claim_agent_run(text, integer) from public, anon, authenticated;
revoke execute on function public.heartbeat_agent_run(uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function public.transition_agent_run(uuid, uuid, text, text, integer, text, text, integer)
  from public, anon, authenticated;

grant execute on function public.agent_run_transition_allowed(text, text) to service_role;
grant execute on function public.claim_agent_run(text, integer) to service_role;
grant execute on function public.heartbeat_agent_run(uuid, uuid, integer) to service_role;
grant execute on function public.transition_agent_run(uuid, uuid, text, text, integer, text, text, integer)
  to service_role;

comment on table public.agent_runs is
  'Durable Agent Run control metadata. User goals, prompts, plans and model responses belong in private TTL objects.';
comment on table public.agent_usage_items is
  'Raw provider usage plus server-calculated credits. Worker-provided credit totals are never authoritative.';
comment on table public.agent_tool_calls is
  'Idempotent side-effect ledger. Submitted/outcome_unknown calls must be reconciled before replay.';
comment on function public.claim_agent_run(text, integer) is
  'Atomically claims one queued or stale-leased Agent Run with FOR UPDATE SKIP LOCKED.';
