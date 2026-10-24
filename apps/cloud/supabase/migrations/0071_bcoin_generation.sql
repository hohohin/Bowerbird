-- Prices apply to newly accepted work only. Do not enable unverified providers.
alter table public.credit_holds add column billing_snapshot jsonb;
update public.service_costs set unit_cost=case when service in ('image_lite','image_sd') then 8 else 20 end,
 pricing_version=20261023,parameters=parameters||'{"currency":"Bcoin","extra_reference_cost":1,"output_size":"2K"}'::jsonb,
 updated_at=now() where service in ('image_hd','image_fast','image_lite','image_sd');
insert into public.service_costs(service,unit_cost,active,pricing_version,parameters)
 select name,10,active,20261023,jsonb_build_object('currency','Bcoin','extra_reference_cost',1,'output_size',size,'label',title,'sort',position)
 from public.service_costs cross join (values
 ('image_pro_1k','1K','Seedream 5.0 Pro 1K',11),('image_pro_15k','1.5K','Seedream 5.0 Pro 1.5K',12)) v(name,size,title,position)
 where service='image_hd';
update public.service_costs set unit_cost=case service when 'image_layer_decompose' then 170 else 20 end,
 pricing_version=20261023,parameters=parameters||'{"currency":"Bcoin","pricing_ready":true,"small_layer_cost":5,"large_layer_cost":10,"pixel_threshold":2610000,"max_outputs":17}'::jsonb,
 updated_at=now() where service in ('image_layer_decompose','image_layer_edit');

create function public.quote_bcoin_image(p_service text,p_reference_count integer,p_size text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.service_costs; amount integer; output_size text;
begin
 if p_reference_count is null or p_reference_count not between 0 and 10 then raise exception 'invalid reference count'; end if;
 select * into c from public.service_costs where service=p_service and active;
 if not found or p_service not like 'image_%' then raise exception 'image price unavailable'; end if;
 output_size:=coalesce(c.parameters->>'output_size',p_size);
 amount:=c.unit_cost;
 if c.pricing_version=20261023 then
  if p_service='image_layer_decompose' then
   if p_size is null or p_size not in ('auto','1K','1.5K','2K') or p_reference_count<>1 then raise exception 'invalid layer quote'; end if;
   -- At most 17 returned images; each costs at most 10. Refund unused reservation.
   amount:=170;
  elsif p_service='image_layer_edit' then
   if p_size is null or p_size not in ('1K','1.5K','2K') or p_reference_count<>1 then raise exception 'invalid layer edit quote'; end if;
   amount:=case when p_size='2K' then 20 else 10 end;
  else
   amount:=amount+greatest(0,p_reference_count-1);
  end if;
 end if;
 return jsonb_build_object('service',p_service,'credits',amount,'pricing_version',c.pricing_version,
  'reference_count',p_reference_count,'output_size',output_size,'requested_size',p_size,
  'settlement',case when p_service='image_layer_decompose' and c.pricing_version=20261023 then 'per_layer' else 'fixed' end,
  'small_layer_cost',5,'large_layer_cost',10,'pixel_threshold',2610000,'max_outputs',17);
end $$;
revoke all on function public.quote_bcoin_image(text,integer,text) from public,anon,authenticated;
grant execute on function public.quote_bcoin_image(text,integer,text) to service_role;

create or replace function public.credit_hold_bcoin_image(
  p_user_id uuid,
  p_idempotency_key text,
  p_service text,
  p_reference_count integer,
  p_size text default null
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
  quote jsonb;
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
    if existing.billing_snapshot is not null and (existing.billing_snapshot->>'reference_count' is distinct from p_reference_count::text or existing.billing_snapshot->>'requested_size' is distinct from p_size) then raise exception 'image pricing input conflict'; end if;
    if existing.service <> p_service then
      raise exception 'idempotency key reused for a different service' using errcode = '22023';
    end if;
    snapshot := public.refresh_user_credit_snapshot(p_user_id);
    return query select existing.id, existing.status, existing.estimated_amount,
      snapshot.daily_balance, snapshot.sub_balance, snapshot.topup_balance, existing.pricing_version;
    return;
  end if;

  perform 1 from public.service_costs where service=p_service for share;
  quote:=public.quote_bcoin_image(p_service,p_reference_count,p_size);
  charge:=(quote->>'credits')::integer;
  price_version:=(quote->>'pricing_version')::integer;

  -- Expired lots are excluded; daily/sub/topup priority is explicit, then earliest expiry/creation.
  select coalesce(sum(credits.remaining_amount), 0) into available
  from public.credit_lots as credits
  where credits.user_id = p_user_id and credits.remaining_amount > 0 and credits.expires_at > now();

  if available < charge then
    raise exception 'insufficient credits' using errcode = 'P0001', detail = 'insufficient_credits';
  end if;

  insert into public.credit_holds (user_id, idempotency_key, service, pricing_version, estimated_amount)
  values (p_user_id, p_idempotency_key, p_service, price_version, charge)
  returning id into created_hold_id;

  update public.credit_holds set billing_snapshot=quote where id=created_hold_id;
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


revoke all on function public.credit_hold_bcoin_image(uuid,text,text,integer,text) from public,anon,authenticated;
grant execute on function public.credit_hold_bcoin_image(uuid,text,text,integer,text) to service_role;

create or replace function public.complete_bcoin_image_job(
  p_job_id uuid,
  p_lease_id uuid,
  p_status text,
  p_output_object_key text default null,
  p_output_mime text default null,
  p_output_bytes bigint default null,
  p_output_sha256 text default null,
  p_error_code text default null,
  p_safe_message text default null,
  p_layer_pixels integer[] default null
)
returns public.generation_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked public.generation_jobs;
  price jsonb;
  charge integer;
  result public.generation_jobs;
begin
  if p_status not in ('succeeded', 'failed', 'cancelled', 'outcome_unknown') then
    raise exception 'invalid terminal generation status' using errcode = '22023';
  end if;
  if p_output_sha256 is not null and p_output_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid output hash' using errcode = '22023';
  end if;
  if p_status = 'succeeded' and (
      p_output_object_key is null or p_output_mime is null or p_output_mime not in ('image/png', 'image/jpeg', 'image/webp', 'application/json')
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
  if p_status = 'succeeded' and ((locked.service in ('image_layer_decompose','image_layer_edit')) is distinct from (p_output_mime = 'application/json')) then
    raise exception 'layer output/service mismatch' using errcode = '22023';
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

  charge:=locked.estimated_credits;
  select billing_snapshot into price from public.credit_holds where id=locked.hold_id;
  if p_status='succeeded' and price->>'settlement'='per_layer' then
    if p_layer_pixels is null or cardinality(p_layer_pixels) not between 1 and 17
      or exists(select 1 from unnest(p_layer_pixels) pixels where pixels is null or pixels<=0 or pixels>36000000) then
      raise exception 'valid output layer pixels required';
    end if;
    select sum(case when pixels<=(price->>'pixel_threshold')::int then (price->>'small_layer_cost')::int else (price->>'large_layer_cost')::int end)
      into charge from unnest(p_layer_pixels) pixels;
    if charge>locked.estimated_credits then raise exception 'layer charge exceeds accepted budget'; end if;
  end if;
  if p_status = 'succeeded' then
    perform public.credit_confirm(locked.hold_id, charge);
  elsif p_status in ('failed', 'cancelled') then
    perform public.credit_rollback(locked.hold_id, coalesce(p_error_code, p_status));
  else
    perform public.mark_hold_pending_settlement(locked.hold_id, coalesce(p_error_code, 'outcome_unknown'));
  end if;

  update public.generation_jobs as job
  set status = p_status,
      progress = case when p_status = 'succeeded' then 100 else job.progress end,
      actual_credits = case when p_status = 'succeeded' then charge else null end,
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

revoke all on function public.complete_bcoin_image_job(uuid,uuid,text,text,text,bigint,text,text,text,integer[]) from public,anon,authenticated;
grant execute on function public.complete_bcoin_image_job(uuid,uuid,text,text,text,bigint,text,text,text,integer[]) to service_role;

-- An old Edge cannot accept a new job using the old flat-price RPC. Existing holds replay.
create or replace function public.credit_hold(
  p_user_id uuid,
  p_idempotency_key text,
  p_service text,
  p_estimated_amount integer default null
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
    snapshot := public.refresh_user_credit_snapshot(p_user_id);
    return query select existing.id, existing.status, existing.estimated_amount,
      snapshot.daily_balance, snapshot.sub_balance, snapshot.topup_balance, existing.pricing_version;
    return;
  end if;

  select cost.unit_cost, cost.pricing_version
    into charge, price_version
  from public.service_costs as cost
  where cost.service = p_service and cost.active;

  if charge is null then
    raise exception 'unknown or inactive service: %', p_service using errcode = '22023';
  end if;
  if price_version>=20261023 and p_service ~ '^(image|video)_' then raise exception 'Bcoin generation requires versioned quoting'; end if;
  if p_estimated_amount is not null and p_estimated_amount <> charge then
    raise exception 'stale client estimate' using errcode = '22023';
  end if;

  -- Expired lots are excluded; daily/sub/topup priority is explicit, then earliest expiry/creation.
  select coalesce(sum(credits.remaining_amount), 0) into available
  from public.credit_lots as credits
  where credits.user_id = p_user_id and credits.remaining_amount > 0 and credits.expires_at > now();

  if available < charge then
    raise exception 'insufficient credits' using errcode = 'P0001', detail = 'insufficient_credits';
  end if;

  insert into public.credit_holds (user_id, idempotency_key, service, pricing_version, estimated_amount)
  values (p_user_id, p_idempotency_key, p_service, price_version, charge)
  returning id into created_hold_id;

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
