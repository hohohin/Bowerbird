-- The only allowed relations are both control-plane text queues. Identifiers
-- below come from validated regclass values; payloads are always parameters.
create function public.transition_text_upload(
  p_table regclass, p_id uuid, p_hash text, p_enqueue boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job record;
  held public.credit_holds;
  expired boolean;
  next_status text;
  result jsonb;
begin
  if p_table is null or p_table not in ('public.understand_jobs'::regclass, 'public.visual_profile_jobs'::regclass) then
    raise exception 'unknown text queue';
  end if;
  execute format('select * from %s where id=$1 for update', p_table) into strict job using p_id;
  if job.input_manifest_hash is distinct from p_hash then
    raise exception 'different content' using errcode='22023', detail='manifest_conflict';
  end if;
  expired := job.content_expires_at <= now() or
    (job.status='uploading' and job.created_at + interval '10 minutes' <= now());
  if job.finished_at is not null or job.upstream_submitted_at is not null
      or (job.status <> 'uploading' and not expired) then return to_jsonb(job); end if;
  if not p_enqueue and not expired then return to_jsonb(job); end if;

  -- Match the credit RPC lock order before examining refundable allocations.
  perform 1 from public.user_credits where user_id=job.user_id for update;
  select * into strict held from public.credit_holds where id=job.hold_id and user_id=job.user_id for update;
  if expired or held.status in ('expired','rolled_back') then
    if held.status in ('held','pending_settlement') then
      perform public.credit_rollback(held.id,'upload_expired');
    elsif held.status not in ('expired','rolled_back') then
      raise exception 'unexpected upload hold status: %',held.status;
    end if;
    if p_table='public.understand_jobs'::regclass and (to_jsonb(job)->>'quota_consumed')::boolean then
      perform public.undo_understand_quota(job.user_id, timezone('Asia/Shanghai',job.created_at)::date);
    end if;
    next_status := 'failed';
  else
    if held.status not in ('held','pending_settlement') or held.reserved_cost_micros is null then
      raise exception 'upload has no active reservation';
    end if;
    -- The job now owns settlement (including queued time beyond the generic hold TTL).
    perform public.mark_hold_pending_settlement(held.id,'text job queued');
    next_status := 'queued';
  end if;
  execute format('update %s as j set status=$2,
    queued_at=case when $2=''queued'' then now() else queued_at end,
    lease_id=null,lease_owner=null,lease_expires_at=null,
    finished_at=case when $2=''failed'' then now() end,
    actual_credits=case when $2=''failed'' then 0 end,
    error_code=case when $2=''failed'' then ''upload_expired'' end,
    safe_message=case when $2=''failed'' then ''任务输入已过期，未执行模型，可重新提交'' end
    where id=$1 returning to_jsonb(j)',p_table)
    into result using p_id,next_status;
  return result;
end $$;

create function public.begin_text_upload(
  p_table regclass, p_user_id uuid, p_key text, p_hash text, p_operation text,
  p_service text, p_cards integer, p_unit_cost_micros numeric, p_daily_limit bigint, p_per_minute integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job jsonb;
  held record;
  job_id uuid := gen_random_uuid();
  bucket_prefix text;
  base_price text;
begin
  if p_table is null or p_table not in ('public.understand_jobs'::regclass,'public.visual_profile_jobs'::regclass) then
    raise exception 'unknown text queue';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||p_key,0));
  execute format('select to_jsonb(j) from %s j where user_id=$1 and idempotency_key=$2',p_table)
    into job using p_user_id,p_key;
  if job is not null then
    if job->>'input_manifest_hash' is distinct from p_hash then
      raise exception 'different content' using errcode='22023', detail='manifest_conflict';
    end if;
    if job->>'status'<>'uploading' then return job; end if;
    job := public.transition_text_upload(p_table,(job->>'id')::uuid,p_hash,false);
    if job->>'status'<>'uploading' then return job; end if;
    if exists(select 1 from public.credit_holds where id=(job->>'hold_id')::uuid and reserved_cost_micros is not null) then
      return job;
    end if;
    -- Rows from before 0086 may have crashed just before the cost reservation.
  else
    if p_table='public.visual_profile_jobs'::regclass then
      if p_service is distinct from 'visual_profile_extract' then raise exception 'invalid visual service'; end if;
      bucket_prefix := 'visual-profile/';
    else
      base_price := case p_operation when 'video-analysis' then 'replication_video_analysis'
        when 'text-rewrite' then 'replication_text_rewrite' when 'speech-transcription' then 'replication_speech_transcription'
        else 'caption' end;
      if p_service is distinct from base_price and not (p_operation='text-rewrite' and p_service='replication_text_rewrite_short') then
        raise exception 'invalid understand service';
      end if;
      if base_price <> 'caption' and not exists (
        select 1 from public.service_costs where service=base_price and active and unit_cost>0 and parameters->'pricing_ready'='true'::jsonb
      ) then raise exception 'replication unavailable' using detail='price_unavailable'; end if;
      bucket_prefix := 'understand/';
    end if;

    perform public.ensure_daily_credits(p_user_id,0);
    select * into strict held from public.credit_hold(p_user_id,p_key,p_service,null);
    -- A legacy synchronous call may already own this key without a job row.
    if held.status <> 'held' or exists(select 1 from public.credit_holds where id=held.hold_id and reserved_cost_micros is not null) then
      raise exception 'key already accepted' using detail='key_in_use';
    end if;
    if p_table='public.visual_profile_jobs'::regclass then
      insert into public.visual_profile_jobs as j(id,user_id,idempotency_key,input_manifest_hash,card_count,
        request_object_key,hold_id,estimated_credits,pricing_version,content_expires_at)
      values(job_id,p_user_id,p_key,p_hash,p_cards,bucket_prefix||job_id||'/inputs/request.json',
        held.hold_id,held.estimated_amount,held.pricing_version,now()+interval '24 hours') returning to_jsonb(j) into job;
    else
      insert into public.understand_jobs as j(id,user_id,idempotency_key,input_manifest_hash,operation,
        request_object_key,hold_id,estimated_credits,pricing_version,content_expires_at)
      values(job_id,p_user_id,p_key,p_hash,p_operation,bucket_prefix||job_id||'/inputs/request.json',
        held.hold_id,held.estimated_amount,held.pricing_version,now()+interval '24 hours') returning to_jsonb(j) into job;
    end if;
  end if;
  perform public.reserve_managed_usage(p_user_id,(job->>'hold_id')::uuid,
    ceil((job->>'estimated_credits')::integer*p_unit_cost_micros)::bigint,p_daily_limit,p_per_minute);
  return job;
end $$;

-- The synchronous fallback shares the caption key namespace (including with
-- always-async brand observation). Only the transaction that first reserves
-- usage can call the upstream or acquire compensation rights.
create function public.begin_sync_understand(
  p_user_id uuid, p_key text, p_unit_cost_micros numeric, p_daily_limit bigint, p_per_minute integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  held record;
  reserved record;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||p_key,0));
  if exists(select 1 from public.understand_jobs where user_id=p_user_id and idempotency_key=p_key) then
    raise exception 'key already accepted' using detail='key_in_use';
  end if;
  perform public.ensure_daily_credits(p_user_id,0);
  select * into strict held from public.credit_hold(p_user_id,p_key,'caption',null);
  if held.status <> 'held' then raise exception 'key already accepted' using detail='key_in_use'; end if;
  select * into strict reserved from public.reserve_managed_usage(p_user_id,held.hold_id,
    ceil(held.estimated_amount*p_unit_cost_micros)::bigint,p_daily_limit,p_per_minute);
  if reserved.already_reserved then raise exception 'key already accepted' using detail='key_in_use'; end if;
  return to_jsonb(held);
end $$;

create function public.expire_unsubmitted_text_jobs(p_table regclass)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  job record;
  total integer := 0;
begin
  if p_table is null or p_table not in ('public.understand_jobs'::regclass,'public.visual_profile_jobs'::regclass) then
    raise exception 'unknown text queue';
  end if;
  for job in execute format('select id,input_manifest_hash from %s where finished_at is null
    and upstream_submitted_at is null and (content_expires_at<=now() or
    (status=''uploading'' and created_at<=now()-interval ''10 minutes'')) order by created_at,id limit 100 for update skip locked',p_table)
  loop
    perform public.transition_text_upload(p_table,job.id,job.input_manifest_hash,false);
    total := total+1;
  end loop;
  return total;
end $$;

revoke all on function public.begin_text_upload(regclass,uuid,text,text,text,text,integer,numeric,bigint,integer),
  public.begin_sync_understand(uuid,text,numeric,bigint,integer), public.transition_text_upload(regclass,uuid,text,boolean), public.expire_unsubmitted_text_jobs(regclass) from public,anon,authenticated;
grant execute on function public.begin_text_upload(regclass,uuid,text,text,text,text,integer,numeric,bigint,integer),
  public.begin_sync_understand(uuid,text,numeric,bigint,integer), public.transition_text_upload(regclass,uuid,text,boolean), public.expire_unsubmitted_text_jobs(regclass) to service_role;

-- The original multi-column checks in 0019/0041 were named by PostgreSQL.
alter table public.understand_jobs drop constraint understand_jobs_check2,
  add constraint understand_result_retention check(status<>'succeeded' or result_text is not null or (deleted_at is not null and deleted_at>=content_expires_at));
alter table public.visual_profile_jobs drop constraint visual_profile_jobs_check2,
  add constraint visual_profile_result_retention check(status<>'succeeded' or result_text is not null or (deleted_at is not null and deleted_at>=content_expires_at));

-- A submitted worker may finish after Storage/SQL cleanup. Settle the job
-- normally and keep its previous erasure decision even under concurrent writes.
create function public.preserve_text_job_erasure() returns trigger language plpgsql set search_path='' as $$
begin
  if new.deleted_at is not null then new.result_text := null; end if;
  return new;
end $$;
create trigger preserve_understand_erasure before update of result_text on public.understand_jobs
  for each row execute function public.preserve_text_job_erasure();
create trigger preserve_visual_erasure before update of result_text on public.visual_profile_jobs
  for each row execute function public.preserve_text_job_erasure();

-- Old cleanup could mark a live task before completion subsequently restored text.
update public.understand_jobs set result_text=null where deleted_at>=content_expires_at and result_text is not null;
update public.visual_profile_jobs set result_text=null where deleted_at>=content_expires_at and result_text is not null;

-- Website/desktop image replays can encounter either a stale input or a
-- generic hold sweeper that already refunded it. Never cancel accepted work.
create function public.inspect_image_upload(p_job_id uuid, p_user_id uuid, p_enqueue boolean default false)
returns public.generation_jobs language plpgsql security definer set search_path='' as $$
declare
  job public.generation_jobs;
  held public.credit_holds;
begin
  select * into strict job from public.generation_jobs where id=p_job_id and user_id=p_user_id for update;
  if not starts_with(job.service,'image_') then raise exception 'not an image job'; end if;
  if job.status<>'uploading' or job.upstream_submitted_at is not null or job.provider_request_id is not null then return job; end if;
  perform 1 from public.user_credits where user_id=p_user_id for update;
  select * into strict held from public.credit_holds where id=job.hold_id and user_id=p_user_id for update;
  if held.status in ('rolled_back','expired') or
     (held.status in ('held','pending_settlement') and job.content_expires_at<=now()) or
     (held.status='held' and held.expires_at<=now()) then
    if held.status in ('held','pending_settlement') then perform public.credit_rollback(held.id,'image_upload_expired'); end if;
    update public.generation_jobs set status='failed',finished_at=now(),actual_credits=0,
      error_code='image_upload_expired',safe_message='图片生成输入已过期，未执行模型，可重新提交'
      where id=job.id returning * into job;
  elsif p_enqueue then
    job := public.enqueue_generation_job(job.id,p_user_id);
  end if;
  return job;
end $$;
revoke all on function public.inspect_image_upload(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.inspect_image_upload(uuid,uuid,boolean) to service_role;
