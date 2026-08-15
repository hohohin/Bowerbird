-- Bowerbird Agent Runtime A1-T5: settlement support RPC.
-- agent_run_spent_credits: idempotent aggregation of recorded usage credits.
-- agent_run_register_artifact / agent_run_request_approval: lease-validated writes
-- that the Worker performs through the agent-worker Edge Function.

create or replace function public.agent_run_spent_credits(p_run_id uuid)
returns table (spent bigint)
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(credits), 0)::bigint as spent
  from public.agent_usage_items
  where run_id = p_run_id;
$$;

create or replace function public.agent_run_register_artifact(
  p_run_id uuid,
  p_lease_id uuid,
  p_kind text,
  p_object_key text,
  p_mime text,
  p_bytes bigint,
  p_sha256 text,
  p_expires_at timestamptz,
  p_source_call_id text default null
)
returns public.agent_artifacts
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked public.agent_runs;
  inserted public.agent_artifacts;
begin
  if p_kind is null or char_length(p_kind) < 1 or char_length(p_kind) > 80 then
    raise exception 'invalid artifact kind' using errcode = '22023';
  end if;
  if p_object_key is null or char_length(p_object_key) < 1 or char_length(p_object_key) > 512 then
    raise exception 'invalid object key' using errcode = '22023';
  end if;
  if p_mime is null or char_length(p_mime) < 1 or char_length(p_mime) > 120 then
    raise exception 'invalid mime' using errcode = '22023';
  end if;
  if p_bytes is null or p_bytes < 0 then
    raise exception 'invalid bytes' using errcode = '22023';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid sha256' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'invalid expiry' using errcode = '22023';
  end if;

  select run.* into locked from public.agent_runs as run where run.id = p_run_id for update;
  if not found then
    raise exception 'unknown agent run' using errcode = 'P0002';
  end if;
  if locked.lease_id is distinct from p_lease_id then
    raise exception 'invalid or expired agent lease' using errcode = '55000';
  end if;

  insert into public.agent_artifacts (
    run_id, kind, object_key, mime, bytes, sha256, source_call_id, expires_at
  ) values (
    p_run_id, p_kind, p_object_key, p_mime, p_bytes, p_sha256, p_source_call_id, p_expires_at
  )
  on conflict (run_id, object_key) do update
    set kind = excluded.kind,
        mime = excluded.mime,
        bytes = excluded.bytes,
        sha256 = excluded.sha256,
        expires_at = excluded.expires_at
  returning * into inserted;

  return inserted;
end;
$$;

create or replace function public.agent_run_request_approval(
  p_run_id uuid,
  p_lease_id uuid,
  p_kind text,
  p_proposal_object_key text,
  p_proposal_hash text,
  p_estimated_additional_credits integer default 0,
  p_expires_seconds integer default 86400
)
returns public.agent_approvals
language plpgsql
security definer
set search_path = ''
as $$
declare
  transitioned public.agent_runs;
  approval public.agent_approvals;
begin
  if p_kind not in ('creative_plan', 'refine_plan') then
    raise exception 'invalid approval kind' using errcode = '22023';
  end if;
  if p_proposal_object_key is null or char_length(p_proposal_object_key) < 1 or char_length(p_proposal_object_key) > 512 then
    raise exception 'invalid proposal key' using errcode = '22023';
  end if;
  if p_proposal_hash is null or p_proposal_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid proposal hash' using errcode = '22023';
  end if;
  if p_estimated_additional_credits is null or p_estimated_additional_credits < 0 then
    raise exception 'invalid estimate' using errcode = '22023';
  end if;
  if p_expires_seconds < 300 or p_expires_seconds > 604800 then
    raise exception 'expiry out of range' using errcode = '22023';
  end if;

  -- pending-to-pending guard: one pending approval per run at a time
  if exists (
    select 1 from public.agent_approvals
    where run_id = p_run_id and status = 'pending'
  ) then
    raise exception 'approval already pending' using errcode = '55000';
  end if;

  insert into public.agent_approvals (
    run_id, kind, proposal_object_key, proposal_hash,
    estimated_additional_credits, expires_at
  ) values (
    p_run_id, p_kind, p_proposal_object_key, p_proposal_hash,
    p_estimated_additional_credits, now() + make_interval(secs => p_expires_seconds)
  )
  returning * into approval;

  -- Pausing the run releases the lease; desktop polling sees awaiting_approval.
  select run.* into transitioned from public.agent_runs as run where run.id = p_run_id for update;
  if transitioned.lease_id is distinct from p_lease_id then
    raise exception 'invalid or expired agent lease' using errcode = '55000';
  end if;
  if not public.agent_run_transition_allowed(transitioned.status, 'awaiting_approval') then
    raise exception 'invalid agent run transition: % -> awaiting_approval', transitioned.status
      using errcode = '55000';
  end if;
  update public.agent_runs
  set status = 'awaiting_approval',
      approval_required = true,
      lease_id = null,
      lease_owner = null,
      lease_expires_at = null
  where id = p_run_id
  returning * into transitioned;

  return approval;
end;
$$;

revoke execute on function public.agent_run_spent_credits(uuid) from public, anon, authenticated;
revoke execute on function public.agent_run_register_artifact(uuid, uuid, text, text, text, bigint, text, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.agent_run_request_approval(uuid, uuid, text, text, text, integer, integer) from public, anon, authenticated;

grant execute on function public.agent_run_spent_credits(uuid) to service_role;
grant execute on function public.agent_run_register_artifact(uuid, uuid, text, text, text, bigint, text, timestamptz, text) to service_role;
grant execute on function public.agent_run_request_approval(uuid, uuid, text, text, text, integer, integer) to service_role;
