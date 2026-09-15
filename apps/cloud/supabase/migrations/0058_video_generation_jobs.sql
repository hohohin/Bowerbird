-- Seedance 2.5 Cloud jobs. No production prices or service activation are seeded.
-- Existing image billing stays unchanged. Video prices must be explicitly approved/configured.
alter table public.generation_jobs drop constraint generation_jobs_service_check;
alter table public.generation_jobs add constraint generation_jobs_service_check check (service ~ '^(image|video)_[a-z0-9_]{1,40}$');
alter table public.generation_jobs drop constraint generation_jobs_input_count_check;
alter table public.generation_jobs add constraint generation_jobs_input_count_check check (input_count between 0 and 40);
alter table public.generation_jobs drop constraint generation_jobs_output_mime_check;
alter table public.generation_jobs add constraint generation_jobs_output_mime_check check (output_mime is null or output_mime in ('image/png','image/jpeg','image/webp','video/mp4'));
alter table public.generation_jobs add column provider_usage jsonb;
alter table public.credit_holds add column video_pricing_snapshot jsonb;
create table public.video_service_pricing (
  service text primary key references public.service_costs(service),
  resolution text not null check (resolution in ('480p','720p','1080p')),
  pricing_version integer not null check (pricing_version > 0),
  text_tokens_per_credit numeric not null check (text_tokens_per_credit > 0),
  video_tokens_per_credit numeric not null check (video_tokens_per_credit > 0),
  text_cny_per_million numeric not null check (text_cny_per_million > 0),
  video_cny_per_million numeric not null check (video_cny_per_million > 0),
  active boolean not null default false,
  check (service='video_seedance25_' || resolution)
);
alter table public.video_service_pricing enable row level security;
revoke all on public.video_service_pricing from anon, authenticated;
grant all on public.video_service_pricing to service_role;
update storage.buckets set file_size_limit=524288000,
  allowed_mime_types=array['application/json','image/png','image/jpeg','image/webp','video/mp4','video/quicktime']
  where id='generation-temp';

create or replace function public.credit_hold_video(
  p_user_id uuid,
  p_idempotency_key text,
  p_service text,
  p_duration integer,
  p_has_video boolean
)
returns table (
  hold_id uuid,
  status text,
  estimated_amount integer,
  daily_balance integer,
  sub_balance integer,
  topup_balance integer,
  pricing_version integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.credit_holds;
  price public.video_service_pricing;
  max_tokens integer;
  charge integer;
  price_version integer;
  available bigint;
  needed integer;
  take_amount integer;
  created_hold_id uuid;
  credit_lot record;
  snapshot public.user_credits;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'idempotency key is required' using errcode = '22023';
  end if;

  insert into public.user_credits (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;
  perform 1 from public.user_credits where user_id = p_user_id for update;

  select hold.* into existing
  from public.credit_holds as hold
  where hold.user_id = p_user_id and hold.idempotency_key = p_idempotency_key;

  if found then
    if existing.service <> p_service then
      raise exception 'idempotency key reused for a different service' using errcode = '22023';
    end if;
    if existing.video_pricing_snapshot->>'duration' is distinct from p_duration::text
      or existing.video_pricing_snapshot->>'has_video' is distinct from p_has_video::text then
      raise exception 'video idempotency conflict' using errcode='22023';
    end if;
    snapshot := public.refresh_user_credit_snapshot(p_user_id);
    return query select existing.id, existing.status, existing.estimated_amount,
      snapshot.daily_balance, snapshot.sub_balance, snapshot.topup_balance, existing.pricing_version;
    return;
  end if;

  if p_duration is null or p_duration not between 4 and 30 or p_has_video is null then
    raise exception 'invalid video duration or references' using errcode = '22023';
  end if;
  select pricing.* into price from public.video_service_pricing pricing
    join public.service_costs cost on cost.service=pricing.service
    where pricing.service=p_service and pricing.active and cost.active for share of pricing, cost;
  if not found then raise exception 'video pricing not enabled' using errcode = '22023'; end if;
  max_tokens := ceil((p_duration + case when p_has_video then 30 else 0 end)
    * case price.resolution when '480p' then 992*432 when '720p' then 1112*834 else 2206*946 end
    * 24.0 / 1024);
  charge := ceil(max_tokens / case when p_has_video then price.video_tokens_per_credit else price.text_tokens_per_credit end);
  price_version := price.pricing_version;

  select coalesce(sum(credits.remaining_amount), 0) into available
  from public.credit_lots as credits
  where credits.user_id = p_user_id
    and credits.remaining_amount > 0
    and credits.expires_at > now();

  if available < charge then
    raise exception 'insufficient credits' using errcode = 'P0001', detail = 'insufficient_credits';
  end if;

  insert into public.credit_holds (user_id, idempotency_key, service, pricing_version, estimated_amount)
  values (p_user_id, p_idempotency_key, p_service, price_version, charge)
  returning id into created_hold_id;

  update public.credit_holds set video_pricing_snapshot=jsonb_build_object(
    'tokens_per_credit',case when p_has_video then price.video_tokens_per_credit else price.text_tokens_per_credit end,
    'provider_cny_per_million',case when p_has_video then price.video_cny_per_million else price.text_cny_per_million end,
    'duration',p_duration,'has_video',p_has_video,'max_tokens',max_tokens)
    where id=created_hold_id;
  needed := charge;
  for credit_lot in
    select credits.id, credits.remaining_amount
    from public.credit_lots as credits
    where credits.user_id = p_user_id
      and credits.remaining_amount > 0
      and credits.expires_at > now()
    order by case credits.bucket when 'daily' then 0 when 'sub' then 1 else 2 end,
      credits.expires_at, credits.created_at, credits.id
    for update
  loop
    exit when needed = 0;
    take_amount := least(needed, credit_lot.remaining_amount);

    update public.credit_lots
      set remaining_amount = remaining_amount - take_amount
      where id = credit_lot.id;
    insert into public.credit_hold_allocations (user_id, hold_id, lot_id, amount)
      values (p_user_id, created_hold_id, credit_lot.id, take_amount);
    insert into public.credit_transactions (user_id, hold_id, lot_id, kind, amount, service)
      values (p_user_id, created_hold_id, credit_lot.id, 'hold', -take_amount, p_service);

    needed := needed - take_amount;
  end loop;

  if needed <> 0 then
    raise exception 'credit allocation invariant failed' using errcode = 'XX000';
  end if;

  snapshot := public.refresh_user_credit_snapshot(p_user_id);
  return query select created_hold_id, 'held'::text, charge,
    snapshot.daily_balance, snapshot.sub_balance, snapshot.topup_balance, price_version;
end;
$$;

revoke execute on function public.credit_hold_video(uuid,text,text,integer,boolean) from public,anon,authenticated;
grant execute on function public.credit_hold_video(uuid,text,text,integer,boolean) to service_role;

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
  where (job.upstream_submitted_at is null or (job.service like 'video_%' and job.provider_request_id is not null))
    and (job.service not like 'video_%' or exists(select 1 from public.credit_holds hold where hold.id=job.hold_id and hold.status='pending_settlement'))
    and (
      job.status = 'queued'
      or (job.status in ('leased', 'running', 'cancel_requested') and job.lease_expires_at <= now())
    )
  order by coalesce(job.queued_at, job.created_at), job.created_at, job.id
  for update skip locked
  limit 1;

  if candidate_id is null then
    return null;
  end if;

  update public.generation_jobs as job
  set status = case when job.status='cancel_requested' then job.status else 'leased' end,
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
      and not (job.service like 'video_%' and job.provider_request_id is not null)
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

  if locked.provider_request_id is not null and p_provider_request_id is not null
    and locked.provider_request_id <> p_provider_request_id then
    raise exception 'upstream task identity is immutable' using errcode='22023';
  end if;
  if locked.service like 'video_%' then
    perform 1 from public.credit_holds where id=locked.hold_id and status='pending_settlement' for update;
    if not found then raise exception 'video hold is not active'; end if;
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

create or replace function public.complete_generation_video_job(
  p_job_id uuid,
  p_lease_id uuid,
  p_status text,
  p_completion_tokens bigint default null,
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
  pricing jsonb;
  actual integer;
begin
  if p_status not in ('succeeded', 'failed', 'cancelled', 'outcome_unknown') then
    raise exception 'invalid terminal generation status' using errcode = '22023';
  end if;
  if p_output_sha256 is not null and p_output_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid output hash' using errcode = '22023';
  end if;
  if p_status = 'succeeded' and (
      p_output_object_key is null or p_output_mime is distinct from 'video/mp4'
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
  if locked.service not like 'video_%' then raise exception 'not a video job' using errcode='22023'; end if;
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
    if p_completion_tokens is null or p_completion_tokens <= 0 then raise exception 'video usage required' using errcode='22023'; end if;
    select hold.video_pricing_snapshot into pricing from public.credit_holds hold where hold.id=locked.hold_id;
    actual := ceil(p_completion_tokens / (pricing->>'tokens_per_credit')::numeric);
    if actual is null then raise exception 'video pricing snapshot missing'; end if;
    if actual > locked.estimated_credits then
      -- Preserve verified output and authoritative usage; reconciliation must not
      -- automatically resubmit, refund, or debit beyond the accepted reservation.
      update public.generation_jobs set status='outcome_unknown',
        output_object_key=p_output_object_key,output_mime=p_output_mime,output_bytes=p_output_bytes,output_sha256=p_output_sha256,
        provider_usage=jsonb_build_object('model','doubao-seedance-2-5-260628','completion_tokens',p_completion_tokens,
          'provider_cny',p_completion_tokens*(pricing->>'provider_cny_per_million')::numeric/1000000),
        error_code='video_usage_exceeds_reservation',safe_message='视频已生成，用量超出预留额度，待核对结算',
        finished_at=now(),content_expires_at=now()+interval '7 days',lease_id=null,lease_owner=null,lease_expires_at=null
        where id=p_job_id returning * into result;
      return result;
    end if;
    perform public.credit_confirm(locked.hold_id, actual);
  elsif p_status in ('failed', 'cancelled') then
    perform public.credit_rollback(locked.hold_id, coalesce(p_error_code, p_status));
  else
    perform public.mark_hold_pending_settlement(locked.hold_id, coalesce(p_error_code, 'outcome_unknown'));
  end if;

  update public.generation_jobs as job
  set status = p_status,
      progress = case when p_status = 'succeeded' then 100 else job.progress end,
      actual_credits = case when p_status = 'succeeded' then actual when p_status in ('failed','cancelled') then 0 else null end,
      output_object_key = case when p_status = 'succeeded' then p_output_object_key else null end,
      output_mime = case when p_status = 'succeeded' then p_output_mime else null end,
      output_bytes = case when p_status = 'succeeded' then p_output_bytes else null end,
      output_sha256 = case when p_status = 'succeeded' then p_output_sha256 else null end,
      error_code = left(p_error_code, 80),
      safe_message = left(p_safe_message, 500),
      provider_usage = case when p_status='succeeded' then jsonb_build_object(
        'model','doubao-seedance-2-5-260628','completion_tokens',p_completion_tokens,
        'provider_cny',p_completion_tokens*(pricing->>'provider_cny_per_million')::numeric/1000000) else job.provider_usage end,
      finished_at = now(),
      content_expires_at = case when p_status='succeeded' then now()+interval '24 hours' else job.content_expires_at end,
      lease_id = null,
      lease_owner = null,
      lease_expires_at = null
  where job.id = p_job_id
  returning job.* into result;
  return result;
end;
$$;
revoke execute on function public.complete_generation_video_job(uuid,uuid,text,bigint,text,text,bigint,text,text,text) from public,anon,authenticated;
grant execute on function public.complete_generation_video_job(uuid,uuid,text,bigint,text,text,bigint,text,text,text) to service_role;
comment on column public.generation_jobs.provider_request_id is 'Immutable upstream Ark task id; distinct from the Bowerbird job UUID. Known video tasks can be reclaimed for GET only.';

create or replace function public.defer_generation_video_job(p_job_id uuid, p_lease_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  update public.generation_jobs set lease_expires_at=now()+interval '10 seconds'
    where id=p_job_id and lease_id=p_lease_id and lease_expires_at>now()
      and service like 'video_%' and provider_request_id is not null
      and status in ('leased','running','cancel_requested');
  if not found then raise exception 'invalid video lease' using errcode='55000'; end if;
end; $$;
revoke execute on function public.defer_generation_video_job(uuid,uuid) from public,anon,authenticated;
grant execute on function public.defer_generation_video_job(uuid,uuid) to service_role;

create or replace function public.enqueue_generation_job(p_job_id uuid, p_user_id uuid)
returns public.generation_jobs language plpgsql security definer set search_path='' as $$
declare job public.generation_jobs; held public.credit_holds;
begin
  select * into job from public.generation_jobs where id=p_job_id and user_id=p_user_id for update;
  if not found then raise exception 'unknown generation job'; end if;
  if job.status <> 'uploading' then return job; end if;
  if not exists(select 1 from public.credit_holds where id=job.hold_id and status in ('held','pending_settlement')) then raise exception 'generation hold expired'; end if;
  if job.service like 'video_%' then
    select * into held from public.credit_holds where id=job.hold_id for update;
    if held.status <> 'pending_settlement' and (held.status <> 'held' or held.expires_at <= now()) then raise exception 'generation hold expired'; end if;
    perform public.mark_hold_pending_settlement(job.hold_id,'durable video queue');
  end if;
  update public.generation_jobs set status='queued',progress=1,queued_at=now() where id=job.id returning * into job;
  return job;
end; $$;
revoke execute on function public.enqueue_generation_job(uuid,uuid) from public,anon,authenticated;
grant execute on function public.enqueue_generation_job(uuid,uuid) to service_role;

create or replace function public.fail_uploading_generation_job(p_job_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare job public.generation_jobs;
begin
  select * into job from public.generation_jobs where id=p_job_id and user_id=p_user_id for update;
  if not found or job.status <> 'uploading' then return; end if;
  perform public.credit_rollback(job.hold_id, 'queue_failed');
  update public.generation_jobs set status='failed',finished_at=now(),error_code='queue_failed',safe_message='云任务入队失败' where id=job.id;
end; $$;
revoke execute on function public.fail_uploading_generation_job(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fail_uploading_generation_job(uuid,uuid) to service_role;

create or replace function public.expire_video_uploads(p_limit integer default 100)
returns integer language plpgsql security definer set search_path='' as $$
declare job public.generation_jobs; closed integer:=0;
begin
  for job in select * from public.generation_jobs where service like 'video_%' and status='uploading'
    and content_expires_at<=now() order by content_expires_at for update skip locked limit p_limit
  loop
    perform 1 from public.credit_holds where id=job.hold_id and status in ('held','pending_settlement') for update;
    if found then perform public.credit_rollback(job.hold_id,'video_upload_expired'); end if;
    update public.generation_jobs set status='failed',finished_at=now(),error_code='video_upload_expired',safe_message='参考视频上传已过期' where id=job.id;
    closed:=closed+1;
  end loop;
  return closed;
end; $$;
revoke execute on function public.expire_video_uploads(integer) from public,anon,authenticated;
grant execute on function public.expire_video_uploads(integer) to service_role;

-- Operations-only audited reconciliation. Never increases the user's approved hold.
create or replace function public.reconcile_video_usage(p_job_id uuid,p_approved_credits integer,p_reason text)
returns public.generation_jobs language plpgsql security definer set search_path='' as $$
declare job public.generation_jobs; pricing jsonb; quoted integer;
begin
  if p_reason is null or length(btrim(p_reason))<8 then raise exception 'reconciliation reason required'; end if;
  select * into job from public.generation_jobs where id=p_job_id for update;
  if not found or job.service not like 'video_%' or job.error_code is distinct from 'video_usage_exceeds_reservation' then raise exception 'not a video usage reconciliation'; end if;
  if job.status='succeeded' then return job; end if;
  if job.status<>'outcome_unknown' or job.output_object_key is null then raise exception 'invalid reconciliation state'; end if;
  select video_pricing_snapshot into pricing from public.credit_holds where id=job.hold_id;
  quoted:=ceil((job.provider_usage->>'completion_tokens')::numeric/(pricing->>'tokens_per_credit')::numeric);
  if p_approved_credits is null or p_approved_credits<0 or p_approved_credits>job.estimated_credits or p_approved_credits>quoted then raise exception 'reconciliation cannot exceed accepted reservation'; end if;
  perform public.credit_confirm(job.hold_id,p_approved_credits);
  update public.generation_jobs set status='succeeded',actual_credits=p_approved_credits,
    provider_usage=job.provider_usage || jsonb_build_object('reconciliation_reason',left(p_reason,500),'reconciled_at',now(),'quoted_credits',quoted),
    safe_message=null,content_expires_at=greatest(content_expires_at,now()+interval '24 hours')
    where id=job.id returning * into job;
  return job;
end; $$;
revoke execute on function public.reconcile_video_usage(uuid,integer,text) from public,anon,authenticated;
grant execute on function public.reconcile_video_usage(uuid,integer,text) to service_role;
