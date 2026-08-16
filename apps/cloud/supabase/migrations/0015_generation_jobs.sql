-- Durable Bowerbird Cloud image-generation queue.
-- Prompts and reference images stay in private short-TTL Storage objects; this
-- table contains only control-plane metadata and hashes.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'generation-temp',
  'generation-temp',
  false,
  41943040,
  array['application/json', 'image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table public.generation_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.billing_accounts(id) on delete restrict,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  service text not null check (service in ('image_sd', 'image_hd')),
  status text not null default 'uploading' check (status in (
    'uploading', 'queued', 'leased', 'running', 'cancel_requested',
    'cancelled', 'succeeded', 'failed', 'outcome_unknown'
  )),
  progress smallint not null default 0 check (progress between 0 and 100),
  request_object_key text not null check (char_length(request_object_key) between 1 and 512),
  input_manifest_hash text not null check (input_manifest_hash ~ '^[0-9a-f]{64}$'),
  input_count smallint not null check (input_count between 0 and 10),
  hold_id uuid not null unique references public.credit_holds(id) on delete restrict,
  estimated_credits integer not null check (estimated_credits > 0),
  actual_credits integer check (actual_credits is null or actual_credits >= 0),
  pricing_version integer not null check (pricing_version > 0),
  lease_id uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  upstream_submitted_at timestamptz,
  provider_request_id text,
  output_object_key text check (output_object_key is null or char_length(output_object_key) between 1 and 512),
  output_mime text check (output_mime is null or output_mime in ('image/png', 'image/jpeg', 'image/webp')),
  output_bytes bigint check (output_bytes is null or output_bytes > 0),
  output_sha256 text check (output_sha256 is null or output_sha256 ~ '^[0-9a-f]{64}$'),
  error_code text check (error_code is null or char_length(error_code) <= 80),
  safe_message text check (safe_message is null or char_length(safe_message) <= 500),
  created_at timestamptz not null default now(),
  queued_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  content_expires_at timestamptz not null,
  downloaded_at timestamptz,
  deleted_at timestamptz,
  unique (user_id, idempotency_key),
  check (
    (lease_id is null and lease_owner is null and lease_expires_at is null)
    or (lease_id is not null and lease_owner is not null and lease_expires_at is not null)
  ),
  check ((status in ('cancelled', 'succeeded', 'failed', 'outcome_unknown')) = (finished_at is not null)),
  check (
    status <> 'succeeded'
    or (output_object_key is not null and output_mime is not null and output_bytes is not null and output_sha256 is not null)
  )
);

create index generation_jobs_user_status_idx
  on public.generation_jobs (user_id, status, created_at desc);
create index generation_jobs_claim_idx
  on public.generation_jobs (status, lease_expires_at, queued_at, created_at)
  where status in ('queued', 'leased', 'running');
create unique index generation_jobs_active_lease_idx
  on public.generation_jobs (lease_id) where lease_id is not null;
create index generation_jobs_content_expiry_idx
  on public.generation_jobs (content_expires_at) where deleted_at is null;

alter table public.generation_jobs enable row level security;
alter table public.generation_jobs force row level security;
revoke all on table public.generation_jobs from anon, authenticated;
grant select on table public.generation_jobs to authenticated;

create policy generation_jobs_select_own
on public.generation_jobs for select to authenticated
using (
  exists (
    select 1 from public.billing_accounts as account
    where account.id = generation_jobs.user_id
      and account.auth_user_id = (select auth.uid())
  )
);

create or replace function public.claim_generation_job(
  p_worker_id text,
  p_lease_seconds integer default 90
)
returns public.generation_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate_id uuid;
  claimed public.generation_jobs;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' or char_length(p_worker_id) > 120 then
    raise exception 'invalid worker id' using errcode = '22023';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'lease seconds must be between 30 and 300' using errcode = '22023';
  end if;

  select job.id into candidate_id
  from public.generation_jobs as job
  where job.upstream_submitted_at is null
    and (
      job.status = 'queued'
      or (job.status in ('leased', 'running') and job.lease_expires_at <= now())
    )
  order by coalesce(job.queued_at, job.created_at), job.created_at, job.id
  for update skip locked
  limit 1;

  if candidate_id is null then
    return null;
  end if;

  update public.generation_jobs as job
  set status = 'leased',
      progress = greatest(job.progress, 5),
      lease_id = extensions.gen_random_uuid(),
      lease_owner = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      attempt_count = job.attempt_count + 1,
      started_at = coalesce(job.started_at, now())
  where job.id = candidate_id
  returning job.* into claimed;

  return claimed;
end;
$$;

create or replace function public.heartbeat_generation_job(
  p_job_id uuid,
  p_lease_id uuid,
  p_lease_seconds integer default 90
)
returns table (
  job_status text,
  cancel_requested boolean,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked public.generation_jobs;
begin
  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'lease seconds must be between 30 and 300' using errcode = '22023';
  end if;
  select job.* into locked
  from public.generation_jobs as job
  where job.id = p_job_id
  for update;
  if not found then
    raise exception 'unknown generation job' using errcode = 'P0002';
  end if;
  if locked.lease_id is distinct from p_lease_id
      or locked.lease_expires_at is null
      or locked.lease_expires_at <= now() then
    raise exception 'invalid or expired generation lease' using errcode = '55000';
  end if;
  if locked.status not in ('leased', 'running', 'cancel_requested') then
    raise exception 'generation status does not hold a lease: %', locked.status using errcode = '55000';
  end if;

  update public.generation_jobs as job
  set heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where job.id = p_job_id
  returning job.status, job.status = 'cancel_requested', job.lease_expires_at
  into job_status, cancel_requested, lease_expires_at;
  return next;
end;
$$;

create or replace function public.mark_generation_job_submitted(
  p_job_id uuid,
  p_lease_id uuid,
  p_provider_request_id text default null
)
returns public.generation_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked public.generation_jobs;
  result public.generation_jobs;
begin
  select job.* into locked
  from public.generation_jobs as job
  where job.id = p_job_id
  for update;
  if not found then
    raise exception 'unknown generation job' using errcode = 'P0002';
  end if;
  if locked.lease_id is distinct from p_lease_id
      or locked.lease_expires_at is null
      or locked.lease_expires_at <= now()
      or locked.status not in ('leased', 'running', 'cancel_requested') then
    raise exception 'invalid generation lease or status' using errcode = '55000';
  end if;

  perform public.mark_hold_pending_settlement(locked.hold_id, 'ark request submitted');
  update public.generation_jobs as job
  set status = case when job.status = 'cancel_requested' then job.status else 'running' end,
      progress = greatest(job.progress, 15),
      upstream_submitted_at = coalesce(job.upstream_submitted_at, now()),
      provider_request_id = coalesce(nullif(btrim(p_provider_request_id), ''), job.provider_request_id),
      heartbeat_at = now()
  where job.id = p_job_id
  returning job.* into result;
  return result;
end;
$$;

create or replace function public.complete_generation_job(
  p_job_id uuid,
  p_lease_id uuid,
  p_status text,
  p_output_object_key text default null,
  p_output_mime text default null,
  p_output_bytes bigint default null,
  p_output_sha256 text default null,
  p_error_code text default null,
  p_safe_message text default null
)
returns public.generation_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked public.generation_jobs;
  result public.generation_jobs;
begin
  if p_status not in ('succeeded', 'failed', 'cancelled', 'outcome_unknown') then
    raise exception 'invalid terminal generation status' using errcode = '22023';
  end if;
  if p_output_sha256 is not null and p_output_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid output hash' using errcode = '22023';
  end if;
  if p_status = 'succeeded' and (
      p_output_object_key is null or p_output_mime not in ('image/png', 'image/jpeg', 'image/webp')
      or p_output_bytes is null or p_output_bytes <= 0 or p_output_sha256 is null
  ) then
    raise exception 'successful generation requires output metadata' using errcode = '22023';
  end if;

  select job.* into locked
  from public.generation_jobs as job
  where job.id = p_job_id
  for update;
  if not found then
    raise exception 'unknown generation job' using errcode = 'P0002';
  end if;
  if locked.status in ('succeeded', 'failed', 'cancelled', 'outcome_unknown') then
    if locked.status <> p_status then
      raise exception 'generation job already completed as %', locked.status using errcode = '55000';
    end if;
    return locked;
  end if;
  if locked.lease_id is distinct from p_lease_id
      or locked.lease_expires_at is null
      or locked.lease_expires_at <= now()
      or locked.status not in ('leased', 'running', 'cancel_requested') then
    raise exception 'invalid generation lease or status' using errcode = '55000';
  end if;

  if p_status = 'succeeded' then
    perform public.credit_confirm(locked.hold_id, locked.estimated_credits);
  elsif p_status in ('failed', 'cancelled') then
    perform public.credit_rollback(locked.hold_id, coalesce(p_error_code, p_status));
  else
    perform public.mark_hold_pending_settlement(locked.hold_id, coalesce(p_error_code, 'outcome_unknown'));
  end if;

  update public.generation_jobs as job
  set status = p_status,
      progress = case when p_status = 'succeeded' then 100 else job.progress end,
      actual_credits = case when p_status = 'succeeded' then job.estimated_credits else null end,
      output_object_key = case when p_status = 'succeeded' then p_output_object_key else null end,
      output_mime = case when p_status = 'succeeded' then p_output_mime else null end,
      output_bytes = case when p_status = 'succeeded' then p_output_bytes else null end,
      output_sha256 = case when p_status = 'succeeded' then p_output_sha256 else null end,
      error_code = left(p_error_code, 80),
      safe_message = left(p_safe_message, 500),
      finished_at = now(),
      lease_id = null,
      lease_owner = null,
      lease_expires_at = null
  where job.id = p_job_id
  returning job.* into result;
  return result;
end;
$$;

create or replace function public.cancel_generation_job(
  p_job_id uuid,
  p_user_id uuid
)
returns public.generation_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked public.generation_jobs;
  result public.generation_jobs;
begin
  select job.* into locked
  from public.generation_jobs as job
  where job.id = p_job_id and job.user_id = p_user_id
  for update;
  if not found then
    raise exception 'unknown generation job' using errcode = 'P0002';
  end if;
  if locked.status in ('cancelled', 'succeeded', 'failed', 'outcome_unknown') then
    return locked;
  end if;

  if locked.upstream_submitted_at is null and locked.status in ('uploading', 'queued') then
    perform public.credit_rollback(locked.hold_id, 'user_cancelled');
    update public.generation_jobs as job
    set status = 'cancelled', finished_at = now(), error_code = 'cancelled',
        safe_message = '任务已取消', lease_id = null, lease_owner = null, lease_expires_at = null
    where job.id = p_job_id
    returning job.* into result;
  else
    update public.generation_jobs as job
    set status = 'cancel_requested', safe_message = case
      when job.upstream_submitted_at is null then '正在停止任务'
      else '请求已提交方舟；生成结果仍会保留'
    end
    where job.id = p_job_id
    returning job.* into result;
  end if;
  return result;
end;
$$;

create or replace function public.reconcile_stale_generation_jobs(p_limit integer default 100)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  stale public.generation_jobs;
  reconciled integer := 0;
begin
  if p_limit < 1 or p_limit > 1000 then
    raise exception 'limit must be between 1 and 1000' using errcode = '22023';
  end if;
  for stale in
    select job.*
    from public.generation_jobs as job
    where job.status in ('leased', 'running', 'cancel_requested')
      and job.upstream_submitted_at is not null
      and job.lease_expires_at <= now()
    order by job.lease_expires_at, job.id
    for update skip locked
    limit p_limit
  loop
    perform public.mark_hold_pending_settlement(stale.hold_id, 'worker lease expired after upstream submission');
    update public.generation_jobs as job
    set status = 'outcome_unknown', finished_at = now(), error_code = 'worker_lost_after_submit',
        safe_message = '请求已提交方舟，但 Worker 连接中断，结果状态暂时无法确认',
        lease_id = null, lease_owner = null, lease_expires_at = null
    where job.id = stale.id;
    reconciled := reconciled + 1;
  end loop;
  return reconciled;
end;
$$;

revoke execute on function public.claim_generation_job(text, integer) from public, anon, authenticated;
revoke execute on function public.heartbeat_generation_job(uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function public.mark_generation_job_submitted(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.complete_generation_job(uuid, uuid, text, text, text, bigint, text, text, text) from public, anon, authenticated;
revoke execute on function public.cancel_generation_job(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.reconcile_stale_generation_jobs(integer) from public, anon, authenticated;

grant execute on function public.claim_generation_job(text, integer) to service_role;
grant execute on function public.heartbeat_generation_job(uuid, uuid, integer) to service_role;
grant execute on function public.mark_generation_job_submitted(uuid, uuid, text) to service_role;
grant execute on function public.complete_generation_job(uuid, uuid, text, text, text, bigint, text, text, text) to service_role;
grant execute on function public.cancel_generation_job(uuid, uuid) to service_role;
grant execute on function public.reconcile_stale_generation_jobs(integer) to service_role;

comment on table public.generation_jobs is
  'Durable Cloud image jobs. Prompt/reference content lives only in private generation-temp objects.';
comment on column public.generation_jobs.upstream_submitted_at is
  'Once set, an expired lease must never be reclaimed automatically; reconcile to outcome_unknown instead.';
