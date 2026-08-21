-- A5-T3: an exporting Run may have completed every provider side effect but
-- still lose its lease before the atomic finish call returns. Reclaim it so
-- the checkpoint can replay finish without repeating the image generation.

drop index if exists public.agent_runs_claim_idx;
create index agent_runs_claim_idx
  on public.agent_runs (status, lease_expires_at, queued_at, created_at)
  where status in ('queued', 'leased', 'running', 'exporting');

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
      or (run.status in ('leased', 'running', 'exporting') and run.lease_expires_at <= now())
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

comment on function public.claim_agent_run(text, integer) is
  'Claims queued or expired active Agent Runs, including exporting recovery after a lost finish response.';
