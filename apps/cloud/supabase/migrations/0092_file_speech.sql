-- File speech has an asynchronous upstream request keyed by the durable job UUID.
-- Service pricing is provisioned separately; this migration does not enable it.
alter table public.understand_jobs drop constraint understand_jobs_operation_check,
  add constraint understand_jobs_operation_check check (operation in (
    'caption', 'autoname', 'classify', 'video-analysis', 'text-rewrite',
    'speech-transcription', 'file-speech-transcription'
  ));

alter table public.understand_jobs drop constraint understand_jobs_result_text_check,
  add constraint understand_jobs_result_text_check check (result_text is null or case
    when operation = 'file-speech-transcription' then octet_length(result_text) between 1 and 4194304
    else char_length(result_text) between 1 and 65536
  end);

alter table public.understand_jobs add column file_speech_source_duration_ms integer,
  add constraint understand_jobs_file_speech_duration_check check (case
    when operation = 'file-speech-transcription' then file_speech_source_duration_ms is not null
      and file_speech_source_duration_ms between 1 and 7200000
    else file_speech_source_duration_ms is null
  end);

create function public.begin_file_speech_upload(
  p_user_id uuid, p_key text, p_hash text, p_expected_credits integer,
  p_unit_cost_micros numeric, p_daily_limit bigint, p_per_minute integer,
  p_source_duration_ms integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  existing public.understand_jobs;
  held record;
  job_id uuid := extensions.gen_random_uuid();
  accepted public.understand_jobs;
  current_price integer;
begin
  if p_key is null or char_length(p_key) not between 13 and 200 or not starts_with(p_key, 'file-speech:')
      or p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
      or p_source_duration_ms is null or p_source_duration_ms not between 1 and 7200000 then
    raise exception 'invalid file speech input identity' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_key, 0));
  select job.* into existing from public.understand_jobs as job
    where job.user_id = p_user_id and job.idempotency_key = p_key;
  if found then
    if existing.operation <> 'file-speech-transcription' or existing.input_manifest_hash is distinct from p_hash
        or existing.file_speech_source_duration_ms is distinct from p_source_duration_ms then
      raise exception 'different content' using errcode = '22023', detail = 'manifest_conflict';
    end if;
    if existing.status = 'uploading' then
      return public.transition_text_upload('public.understand_jobs'::regclass, existing.id, p_hash, false);
    end if;
    return to_jsonb(existing);
  end if;

  select cost.unit_cost into current_price from public.service_costs as cost
    where cost.service = 'library_file_speech' and cost.active and cost.unit_cost > 0
      and cost.parameters->'pricing_ready' = 'true'::jsonb for share;
  if not found then
    raise exception 'file speech price unavailable' using detail = 'price_unavailable';
  end if;
  if p_expected_credits is distinct from current_price then
    raise exception 'stale file speech quote' using errcode = '22023', detail = 'stale_quote';
  end if;

  perform public.ensure_daily_credits(p_user_id, 0);
  select * into strict held from public.credit_hold(p_user_id, p_key, 'library_file_speech', p_expected_credits);
  if held.status <> 'held' or exists(
    select 1 from public.credit_holds where id = held.hold_id and reserved_cost_micros is not null
  ) then
    raise exception 'key already accepted' using detail = 'key_in_use';
  end if;
  perform public.reserve_managed_usage(p_user_id, held.hold_id,
    ceil(held.estimated_amount * p_unit_cost_micros)::bigint, p_daily_limit, p_per_minute);
  insert into public.understand_jobs as job(
    id, user_id, idempotency_key, input_manifest_hash, operation, request_object_key,
    hold_id, estimated_credits, pricing_version, content_expires_at, file_speech_source_duration_ms
  ) values (
    job_id, p_user_id, p_key, p_hash, 'file-speech-transcription', 'understand/' || job_id::text || '/inputs/request.json',
    held.hold_id, held.estimated_amount, held.pricing_version, now() + interval '24 hours', p_source_duration_ms
  ) returning job.* into accepted;
  return to_jsonb(accepted);
end $$;

revoke all on function public.begin_file_speech_upload(uuid,text,text,integer,numeric,bigint,integer,integer) from public, anon, authenticated;
grant execute on function public.begin_file_speech_upload(uuid,text,text,integer,numeric,bigint,integer,integer) to service_role;

create function public.defer_file_speech_job(p_job_id uuid, p_lease_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.understand_jobs as job
  set status = 'queued', queued_at = now() + interval '15 seconds',
      lease_id = null, lease_owner = null, lease_expires_at = null
  where job.id = p_job_id and job.lease_id = p_lease_id and job.lease_expires_at > now()
    and job.operation = 'file-speech-transcription' and job.upstream_submitted_at is not null
    and job.content_expires_at > now() and job.status in ('leased', 'running');
  if not found then
    raise exception 'invalid file speech lease or state' using errcode = '55000';
  end if;
end $$;

revoke all on function public.defer_file_speech_job(uuid,uuid) from public, anon, authenticated;
grant execute on function public.defer_file_speech_job(uuid,uuid) to service_role;

create function public.claim_understand_job(
  p_worker_id text, p_lease_seconds integer, p_file_speech_capable boolean
) returns public.understand_jobs
language plpgsql security definer set search_path = '' as $$
declare
  candidate_id uuid;
  claimed public.understand_jobs;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' or char_length(p_worker_id) > 120 then
    raise exception 'invalid worker id' using errcode = '22023';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'lease seconds must be between 30 and 300' using errcode = '22023';
  end if;

  select job.id into candidate_id
  from public.understand_jobs as job
  where (
    job.operation <> 'file-speech-transcription' and job.upstream_submitted_at is null
    and (job.status = 'queued' or (job.status in ('leased', 'running') and job.lease_expires_at <= now()))
  ) or (
    p_file_speech_capable and job.operation = 'file-speech-transcription'
    and job.content_expires_at > now() and job.deleted_at is null
    and exists(select 1 from public.credit_holds as held where held.id = job.hold_id and held.status = 'pending_settlement')
    and ((job.status = 'queued' and job.queued_at <= now())
      or (job.status in ('leased', 'running', 'cancel_requested') and job.lease_expires_at <= now()))
  )
  order by coalesce(job.queued_at, job.created_at), job.created_at, job.id
  for update skip locked
  limit 1;

  if candidate_id is null then
    return null;
  end if;
  update public.understand_jobs as job
  set status = case when job.status = 'cancel_requested' then job.status else 'leased' end,
      lease_id = extensions.gen_random_uuid(), lease_owner = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds), heartbeat_at = now(),
      attempt_count = job.attempt_count + 1, started_at = coalesce(job.started_at, now())
  where job.id = candidate_id
  returning job.* into claimed;
  return claimed;
end $$;

revoke all on function public.claim_understand_job(text,integer,boolean) from public, anon, authenticated;
grant execute on function public.claim_understand_job(text,integer,boolean) to service_role;

-- Old Edge and worker versions can keep serving existing operations on rollback.
create or replace function public.claim_understand_job(
  p_worker_id text, p_lease_seconds integer default 90
) returns public.understand_jobs
language sql security definer set search_path = '' as $$
  select public.claim_understand_job(p_worker_id, p_lease_seconds, false)
$$;

create or replace function public.mark_understand_job_submitted(
  p_job_id uuid, p_lease_id uuid
) returns public.understand_jobs
language plpgsql security definer set search_path = '' as $$
declare
  locked public.understand_jobs;
  result public.understand_jobs;
begin
  select job.* into locked from public.understand_jobs as job where job.id = p_job_id for update;
  if not found then
    raise exception 'unknown understand job' using errcode = 'P0002';
  end if;
  if locked.lease_id is distinct from p_lease_id or locked.lease_expires_at is null
      or locked.lease_expires_at <= now() or locked.status not in ('leased', 'running', 'cancel_requested') then
    raise exception 'invalid understand lease or status' using errcode = '55000';
  end if;
  if locked.operation = 'file-speech-transcription' and (
      locked.upstream_submitted_at is not null or locked.content_expires_at <= now()
      or locked.deleted_at is not null or locked.status = 'cancel_requested'
  ) then
    raise exception 'file speech already submitted, expired or cancelled' using errcode = '55000';
  end if;

  perform public.mark_hold_pending_settlement(locked.hold_id, 'ark request submitted');
  update public.understand_jobs as job
  set status = case when job.status = 'cancel_requested' then job.status else 'running' end,
      upstream_submitted_at = coalesce(job.upstream_submitted_at, now()), heartbeat_at = now()
  where job.id = p_job_id
  returning job.* into result;
  return result;
end $$;

create function public.complete_understand_job(
  p_job_id uuid, p_lease_id uuid, p_status text, p_result_text text,
  p_error_code text, p_safe_message text, p_file_speech_capable boolean
) returns public.understand_jobs
language plpgsql security definer set search_path = '' as $$
declare
  locked public.understand_jobs;
  result public.understand_jobs;
begin
  if p_status not in ('succeeded', 'failed', 'cancelled', 'outcome_unknown') then
    raise exception 'invalid terminal understand status' using errcode = '22023';
  end if;
  select job.* into locked from public.understand_jobs as job where job.id = p_job_id for update;
  if not found then
    raise exception 'unknown understand job' using errcode = 'P0002';
  end if;
  if (locked.operation = 'file-speech-transcription') is distinct from coalesce(p_file_speech_capable, false) then
    raise exception 'worker cannot settle this understand operation' using errcode = '55000';
  end if;
  if p_status = 'succeeded' and (p_result_text is null or btrim(p_result_text) = '' or case
      when locked.operation = 'file-speech-transcription' then octet_length(p_result_text) > 4194304
      else char_length(p_result_text) > 65536
  end) then
    raise exception 'successful understand requires bounded result text' using errcode = '22023';
  end if;
  if locked.status in ('succeeded', 'failed', 'cancelled', 'outcome_unknown') then
    if locked.status <> p_status then
      raise exception 'understand job already completed as %', locked.status using errcode = '55000';
    end if;
    return locked;
  end if;
  if locked.lease_id is distinct from p_lease_id or locked.lease_expires_at is null
      or locked.lease_expires_at <= now() or locked.status not in ('leased', 'running', 'cancel_requested') then
    raise exception 'invalid understand lease or status' using errcode = '55000';
  end if;
  if locked.operation = 'file-speech-transcription' and (
      (p_status = 'succeeded' and (locked.upstream_submitted_at is null or locked.content_expires_at <= now()))
      or (p_status = 'outcome_unknown' and locked.content_expires_at > now())
  ) then
    raise exception 'invalid file speech terminal state' using errcode = '55000';
  end if;

  if p_status = 'succeeded' then
    perform public.credit_confirm(locked.hold_id, locked.estimated_credits);
  elsif p_status in ('failed', 'cancelled') then
    perform public.credit_rollback(locked.hold_id, coalesce(p_error_code, p_status));
    if locked.quota_consumed then
      perform public.undo_understand_quota(locked.user_id);
    end if;
  else
    perform public.mark_hold_pending_settlement(locked.hold_id, coalesce(p_error_code, 'outcome_unknown'));
  end if;

  update public.understand_jobs as job
  set status = p_status, actual_credits = case when p_status = 'succeeded' then job.estimated_credits else null end,
      result_text = case when p_status = 'succeeded' then p_result_text else null end,
      error_code = left(p_error_code, 80), safe_message = left(p_safe_message, 500), finished_at = now(),
      lease_id = null, lease_owner = null, lease_expires_at = null
  where job.id = p_job_id
  returning job.* into result;
  return result;
end $$;

revoke all on function public.complete_understand_job(uuid,uuid,text,text,text,text,boolean) from public, anon, authenticated;
grant execute on function public.complete_understand_job(uuid,uuid,text,text,text,text,boolean) to service_role;

create or replace function public.complete_understand_job(
  p_job_id uuid, p_lease_id uuid, p_status text, p_result_text text default null,
  p_error_code text default null, p_safe_message text default null
) returns public.understand_jobs
language sql security definer set search_path = '' as $$
  select public.complete_understand_job(p_job_id, p_lease_id, p_status, p_result_text, p_error_code, p_safe_message, false)
$$;

create or replace function public.reconcile_stale_understand_jobs(p_limit integer default 100)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  stale public.understand_jobs;
  reconciled integer := 0;
  file_speech boolean;
begin
  if p_limit < 1 or p_limit > 1000 then
    raise exception 'limit must be between 1 and 1000' using errcode = '22023';
  end if;
  for stale in
    select job.* from public.understand_jobs as job
    where job.upstream_submitted_at is not null and (
      (job.operation <> 'file-speech-transcription' and job.status in ('leased', 'running', 'cancel_requested')
        and job.lease_expires_at <= now())
      or (job.operation = 'file-speech-transcription' and job.status in ('queued', 'leased', 'running', 'cancel_requested')
        and job.content_expires_at <= now())
    )
    order by case when job.operation = 'file-speech-transcription' then job.content_expires_at else job.lease_expires_at end, job.id
    for update skip locked
    limit p_limit
  loop
    file_speech := stale.operation = 'file-speech-transcription';
    perform public.mark_hold_pending_settlement(stale.hold_id, 'worker lease expired after upstream submission');
    update public.understand_jobs as job
    set status = 'outcome_unknown', finished_at = now(),
        error_code = case when file_speech then 'file_speech_result_expired' else 'worker_lost_after_submit' end,
        safe_message = case when file_speech then '语音识别到期前尚未确认，积分预留待核对'
          else '请求已提交方舟，但 Worker 连接中断，结果状态暂时无法确认' end,
        lease_id = null, lease_owner = null, lease_expires_at = null
    where job.id = stale.id;
    reconciled := reconciled + 1;
  end loop;
  return reconciled;
end $$;

comment on column public.understand_jobs.upstream_submitted_at is
  'Durable submit fence. Existing operations are not reclaimed after submission. File speech resumes query-only by the immutable job UUID until content expiry.';
