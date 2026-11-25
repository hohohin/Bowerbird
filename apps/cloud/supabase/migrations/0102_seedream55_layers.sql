-- Seedream 5.5 rates apply only to new holds. Drain pre-cutover layer jobs before
-- changing the Worker model. Keep these two services paused during cutover.
-- Ark list price: 0.05 CNY per input, 0.13 / 0.23 per output at 2.61M pixels.
-- Explicit split rate: ceil(Ark rate * 20 Bcoin/CNY * 1.6).
-- Old desktop quotes stay at their published split and single-reference edit rates.
update public.service_costs
set pricing_version=20261124,
    parameters=parameters || case service
      when 'image_layer_decompose' then '{"small_layer_cost":5,"large_layer_cost":8,"legacy_large_layer_cost":10,"pixel_threshold":2610000,"max_outputs":100,"input_cost":2}'::jsonb
      else '{"max_outputs":1,"input_cost":2,"small_edit_cost":10}'::jsonb
    end,
    updated_at=now()
where service in ('image_layer_decompose','image_layer_edit');

create function public.quote_bcoin_image(p_service text,p_reference_count integer,p_size text,p_max_images integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 c public.service_costs;
 amount integer;
 output_size text;
 output_limit integer;
 input_credits integer;
 large_output_credits integer;
begin
 if p_reference_count is null or p_reference_count not between 0 and 10 then raise exception 'invalid reference count'; end if;
 select * into c from public.service_costs where service=p_service and active;
 if not found or p_service not like 'image_%' then raise exception 'image price unavailable'; end if;
 if p_max_images is not null and p_service <> 'image_layer_decompose' then raise exception 'invalid layer output limit'; end if;
 output_size:=coalesce(c.parameters->>'output_size',p_size);
 amount:=c.unit_cost;

 if p_service in ('image_layer_decompose','image_layer_edit') then
   if c.pricing_version <> 20261124 or (c.parameters->>'pricing_ready')::boolean is distinct from true then
     raise exception 'layer price unavailable';
   end if;
   if p_size is null or p_size not in ('auto','1K','1.5K','2K') then raise exception 'invalid layer size'; end if;
   if p_service='image_layer_decompose' then
     -- The old desktop protocol discounts input and publishes 5/10 prices for up to 17 images.
     output_limit:=coalesce(p_max_images,17);
     if p_reference_count<>1 or output_limit not between 2 and (c.parameters->>'max_outputs')::integer then
       raise exception 'invalid layer quote';
     end if;
     input_credits:=case when p_max_images is null then 0 else (c.parameters->>'input_cost')::integer end;
     large_output_credits:=(c.parameters->>case when p_max_images is null
       then 'legacy_large_layer_cost' else 'large_layer_cost' end)::integer;
     amount:=output_limit * large_output_credits + input_credits;
     return jsonb_build_object(
       'service',p_service,'credits',amount,'pricing_version',c.pricing_version,
       'reference_count',p_reference_count,'output_size',output_size,'requested_size',p_size,
       'requested_max_images',p_max_images,'settlement','per_layer','input_credits',input_credits,
       'small_layer_cost',(c.parameters->>'small_layer_cost')::integer,
       'large_layer_cost',large_output_credits,
       'pixel_threshold',(c.parameters->>'pixel_threshold')::integer,'max_outputs',output_limit
     );
   end if;
   output_size:=case when p_size='auto' then '2K' else p_size end;
   -- The base edit rate includes the selected layer. Generation has no references.
   input_credits:=greatest(0,p_reference_count-1) * (c.parameters->>'input_cost')::integer;
   amount:=(case when output_size='2K' then c.unit_cost else (c.parameters->>'small_edit_cost')::integer end) + input_credits;
   return jsonb_build_object(
     'service',p_service,'credits',amount,'pricing_version',c.pricing_version,
     'reference_count',p_reference_count,'output_size',output_size,'requested_size',p_size,
     'settlement','fixed','input_credits',input_credits,'max_outputs',1
   );
 end if;

 -- Keep the existing price snapshot shape for ordinary images and replay.
 if c.pricing_version=20261023 then amount:=amount+greatest(0,p_reference_count-1); end if;
 return jsonb_build_object('service',p_service,'credits',amount,'pricing_version',c.pricing_version,
  'reference_count',p_reference_count,'output_size',output_size,'requested_size',p_size,
  'settlement','fixed','small_layer_cost',5,'large_layer_cost',10,'pixel_threshold',2610000,'max_outputs',17);
end $$;

revoke all on function public.quote_bcoin_image(text,integer,text,integer) from public,anon,authenticated;
grant execute on function public.quote_bcoin_image(text,integer,text,integer) to service_role;

create or replace function public.quote_bcoin_image(p_service text,p_reference_count integer,p_size text default null)
returns jsonb language sql security definer set search_path='' as $$
 select public.quote_bcoin_image(p_service,p_reference_count,p_size,null::integer);
$$;

create or replace function public.credit_hold_bcoin_image(
  p_user_id uuid,
  p_idempotency_key text,
  p_service text,
  p_reference_count integer,
  p_size text,
  p_max_images integer
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
    if existing.billing_snapshot is not null and (existing.billing_snapshot->>'reference_count' is distinct from p_reference_count::text or existing.billing_snapshot->>'requested_size' is distinct from p_size or existing.billing_snapshot->>'requested_max_images' is distinct from p_max_images::text) then raise exception 'image pricing input conflict'; end if;
    if existing.service <> p_service then
      raise exception 'idempotency key reused for a different service' using errcode = '22023';
    end if;
    snapshot := public.refresh_user_credit_snapshot(p_user_id);
    return query select existing.id, existing.status, existing.estimated_amount,
      snapshot.daily_balance, snapshot.sub_balance, snapshot.topup_balance, existing.pricing_version;
    return;
  end if;

  perform 1 from public.service_costs where service=p_service for share;
  quote:=public.quote_bcoin_image(p_service,p_reference_count,p_size,p_max_images);
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


revoke all on function public.credit_hold_bcoin_image(uuid,text,text,integer,text,integer) from public,anon,authenticated;
grant execute on function public.credit_hold_bcoin_image(uuid,text,text,integer,text,integer) to service_role;

create or replace function public.credit_hold_bcoin_image(
  p_user_id uuid, p_idempotency_key text, p_service text, p_reference_count integer, p_size text default null
)
returns table (
  hold_id uuid, status text, estimated_amount integer,
  daily_balance integer, sub_balance integer, topup_balance integer, pricing_version integer
)
language sql security definer set search_path='' as $$
 select * from public.credit_hold_bcoin_image(p_user_id,p_idempotency_key,p_service,p_reference_count,p_size,null::integer);
$$;

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
    if p_layer_pixels is null or cardinality(p_layer_pixels) not between 1 and (price->>'max_outputs')::integer
      or exists(select 1 from unnest(p_layer_pixels) pixels where pixels is null or pixels<=0 or pixels>36000000) then
      raise exception 'valid output layer pixels required';
    end if;
    select coalesce((price->>'input_credits')::int,0) + sum(case when pixels<=(price->>'pixel_threshold')::int then (price->>'small_layer_cost')::int else (price->>'large_layer_cost')::int end)
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
