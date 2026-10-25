-- Approved Bcoin formula. Availability remains off until real provider/usage acceptance.
insert into public.service_costs(service,unit_cost,active,pricing_version,parameters)
 select 'video_seedance25_'||r,0,false,20261023,'{}'::jsonb from (values ('480p'),('720p'),('1080p')) v(r)
 on conflict(service) do update set pricing_version=20261023;
insert into public.video_service_pricing(service,resolution,pricing_version,text_tokens_per_credit,video_tokens_per_credit,text_cny_per_million,video_cny_per_million,active)
 select 'video_seedance25_'||r,r,20261023,floor(1000000.0/(t*32)),floor(1000000.0/(v*32)),t,v,false from (values ('480p',70,42),('720p',70,42),('1080p',77,46)) prices(r,t,v)
 on conflict(service) do update set pricing_version=20261023,text_cny_per_million=excluded.text_cny_per_million,video_cny_per_million=excluded.video_cny_per_million;
-- tokens_per_credit is retained only for legacy snapshots; new quotes use CNY rates.

create or replace function public.credit_hold_bcoin_video(
  p_user_id uuid,
  p_idempotency_key text,
  p_service text,
  p_duration integer,
  p_has_video boolean,
  p_ratio text,
  p_reference_seconds numeric
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
    if existing.video_pricing_snapshot->>'settlement'='fixed' and (existing.video_pricing_snapshot->>'ratio' is distinct from p_ratio or (existing.video_pricing_snapshot->>'reference_seconds')::numeric is distinct from p_reference_seconds) then raise exception 'video quote input conflict'; end if;
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
  if p_reference_seconds is null or p_reference_seconds<0 or p_reference_seconds>30 or p_has_video<>(p_reference_seconds>0) then raise exception 'invalid reference duration'; end if;
  if p_ratio is not null and p_ratio not in ('16:9','9:16','4:3','3:4','1:1','21:9','adaptive') then raise exception 'invalid video ratio'; end if;
  max_tokens := ceil((p_duration+p_reference_seconds)
    * case when p_ratio in ('16:9','9:16') then
       case price.resolution when '480p' then 854*480 when '720p' then 1280*720 else 1920*1080 end
      else case price.resolution when '480p' then 992*432 when '720p' then 1112*834 else 2206*946 end end
    *24.0/1024);
  charge:=ceil(((max_tokens*(case when p_has_video then price.video_cny_per_million else price.text_cny_per_million end)/1000000+0.006)*1.6*20)/5)*5;
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
    'settlement','fixed','ratio',p_ratio,'reference_seconds',p_reference_seconds,'prompt_budget_cny',0.006,'cost_multiplier',1.6,'bcoin_per_cny',20,
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

revoke execute on function public.credit_hold_bcoin_video(uuid,text,text,integer,boolean,text,numeric) from public,anon,authenticated;
grant execute on function public.credit_hold_bcoin_video(uuid,text,text,integer,boolean,text,numeric) to service_role;


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
    actual := case when pricing->>'settlement'='fixed' then locked.estimated_credits else ceil(p_completion_tokens / (pricing->>'tokens_per_credit')::numeric) end;
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

-- A stale Edge can recover an old hold, but cannot price a new Bcoin video.
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
  if price.pricing_version>=20261023 then raise exception 'Bcoin video requires versioned quoting'; end if;
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
