-- A2-T0 / A3 first-skill control-plane fields for bowerbird-controlled-image-edit.
-- User content stays in private short-TTL objects; rows contain only routing metadata.

insert into public.service_costs (service, unit_cost, pricing_version, parameters, active)
values (
  'agent_controlled_image_edit',
  48,
  1,
  '{"billing":"usage_items","max_budget_credits":48,"max_plan_steps":8,"max_generate_calls":8,"text_provider":"deepseek","image_provider":"ark"}'::jsonb,
  true
)
on conflict (service) do update
set parameters = excluded.parameters,
    active = excluded.active;

alter table public.agent_runs
  add column if not exists conversation_id uuid,
  add column if not exists approved_plan_hash text,
  add column if not exists planned_tool_count smallint,
  add column if not exists feedback_object_key text,
  add column if not exists result_feedback_action text;

update public.agent_runs
set conversation_id = id
where conversation_id is null;

alter table public.agent_runs
  alter column conversation_id set default extensions.gen_random_uuid(),
  alter column conversation_id set not null;

alter table public.agent_runs
  drop constraint if exists agent_runs_input_count_check,
  add constraint agent_runs_input_count_check check (input_count between 0 and 8),
  add constraint agent_runs_approved_plan_hash_check
    check (approved_plan_hash is null or approved_plan_hash ~ '^[0-9a-f]{64}$'),
  add constraint agent_runs_planned_tool_count_check
    check (planned_tool_count is null or planned_tool_count between 0 and 32),
  add constraint agent_runs_feedback_object_key_check
    check (feedback_object_key is null or char_length(feedback_object_key) between 1 and 512),
  add constraint agent_runs_result_feedback_action_check
    check (result_feedback_action is null or result_feedback_action in ('accept', 'retry'));

create unique index if not exists agent_runs_user_conversation_idx
  on public.agent_runs (user_id, conversation_id);
create unique index if not exists agent_runs_id_conversation_idx
  on public.agent_runs (id, conversation_id);

alter table public.agent_approvals
  add column if not exists planned_tool_count smallint;

alter table public.agent_approvals
  drop constraint if exists agent_approvals_kind_check,
  add constraint agent_approvals_kind_check check (kind in (
    'creative_plan', 'refine_plan',
    'controlled_image_edit_plan', 'controlled_image_edit_revision'
  )),
  add constraint agent_approvals_planned_tool_count_check
    check (planned_tool_count is null or planned_tool_count between 0 and 32);

alter table public.agent_artifacts
  add column if not exists conversation_id uuid,
  add column if not exists role text,
  add column if not exists step_id text,
  add column if not exists parent_artifact_id uuid,
  add column if not exists user_visible boolean not null default true;

update public.agent_artifacts as artifact
set conversation_id = run.conversation_id,
    role = case
      when artifact.kind in ('final_image', 'final_result') then 'final_result'
      else 'stage_result'
    end
from public.agent_runs as run
where run.id = artifact.run_id
  and (artifact.conversation_id is null or artifact.role is null);

alter table public.agent_artifacts
  alter column conversation_id set not null,
  alter column role set not null,
  add constraint agent_artifacts_role_check check (role in (
    'input', 'control_reference', 'stage_result', 'final_result', 'plan', 'diagnostic'
  )),
  add constraint agent_artifacts_step_id_check
    check (step_id is null or char_length(step_id) between 1 and 120);

create unique index if not exists agent_artifacts_run_id_id_idx
  on public.agent_artifacts (run_id, id);

alter table public.agent_artifacts
  add constraint agent_artifacts_run_conversation_fkey
    foreign key (run_id, conversation_id)
    references public.agent_runs(id, conversation_id) on delete cascade,
  add constraint agent_artifacts_parent_fkey
    foreign key (run_id, parent_artifact_id)
    references public.agent_artifacts(run_id, id) on delete restrict;

create index if not exists agent_artifacts_conversation_role_idx
  on public.agent_artifacts (conversation_id, role, step_id);

create index if not exists agent_artifacts_parent_idx
  on public.agent_artifacts (parent_artifact_id)
  where parent_artifact_id is not null;

-- A provider call produces at most one conversation artifact. This makes
-- artifact_commit replayable after a Worker crash without creating a second
-- row or a second final_result.
create unique index if not exists agent_artifacts_run_source_call_idx
  on public.agent_artifacts (run_id, source_call_id)
  where source_call_id is not null;

-- Checkpoint persistence is intentionally two-phase:
-- 1) Worker uploads the content-addressed object and Edge verifies its hash.
-- 2) This RPC atomically advances the DB pointer while the lease is still valid.
-- It is separate from transition_agent_run so repeated checkpoints do not require
-- an otherwise-invalid running -> running state transition.
create or replace function public.commit_agent_checkpoint(
  p_run_id uuid,
  p_lease_id uuid,
  p_object_key text,
  p_checkpoint_hash text,
  p_snapshot_schema_version integer,
  p_current_step text default null,
  p_progress integer default null
)
returns public.agent_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked public.agent_runs;
  committed public.agent_runs;
begin
  if p_object_key is null or char_length(p_object_key) < 1 or char_length(p_object_key) > 512 then
    raise exception 'invalid checkpoint object key' using errcode = '22023';
  end if;
  if p_checkpoint_hash is null or p_checkpoint_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid checkpoint hash' using errcode = '22023';
  end if;
  if p_snapshot_schema_version <> 1 then
    raise exception 'unsupported snapshot schema version' using errcode = '22023';
  end if;
  if p_progress is not null and (p_progress < 0 or p_progress > 100) then
    raise exception 'progress must be between 0 and 100' using errcode = '22023';
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
    raise exception 'run status does not accept checkpoints: %', locked.status using errcode = '55000';
  end if;

  update public.agent_runs as run
  set status = case when run.status = 'leased' then 'running' else run.status end,
      current_step = coalesce(p_current_step, run.current_step),
      progress = coalesce(p_progress, run.progress),
      checkpoint_object_key = p_object_key,
      checkpoint_hash = p_checkpoint_hash,
      snapshot_schema_version = p_snapshot_schema_version,
      heartbeat_at = now()
  where run.id = p_run_id
  returning run.* into committed;

  return committed;
end;
$$;

revoke execute on function public.commit_agent_checkpoint(uuid, uuid, text, text, integer, text, integer)
  from public, anon, authenticated;
grant execute on function public.commit_agent_checkpoint(uuid, uuid, text, text, integer, text, integer)
  to service_role;

comment on function public.commit_agent_checkpoint(uuid, uuid, text, text, integer, text, integer) is
  'Atomically advances a leased Agent Run checkpoint pointer after Edge verified the uploaded object hash.';
