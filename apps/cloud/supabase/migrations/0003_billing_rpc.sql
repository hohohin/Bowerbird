-- Atomic credit estimation, grants and holds.
-- These functions are service-only; Edge Functions derive p_user_id from a verified JWT.

create or replace function public.refresh_user_credit_snapshot(p_user_id uuid)
returns public.user_credits
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.user_credits;
begin
  insert into public.user_credits (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;
  perform 1 from public.user_credits where user_id = p_user_id for update;

  update public.user_credits as balance
  set daily_balance = totals.daily_balance,
      sub_balance = totals.sub_balance,
      topup_balance = totals.topup_balance,
      updated_at = now()
  from (
    select
      coalesce(sum(lot.remaining_amount) filter (where lot.bucket = 'daily' and lot.expires_at > now()), 0)::integer as daily_balance,
      coalesce(sum(lot.remaining_amount) filter (where lot.bucket = 'sub' and lot.expires_at > now()), 0)::integer as sub_balance,
      coalesce(sum(lot.remaining_amount) filter (where lot.bucket = 'topup' and lot.expires_at > now()), 0)::integer as topup_balance
    from public.credit_lots as lot
    where lot.user_id = p_user_id
  ) as totals
  where balance.user_id = p_user_id
  returning balance.* into result;

  return result;
end;
$$;

create or replace function public.estimate_cost(p_service text, p_params jsonb default '{}'::jsonb)
returns table (service text, amount integer, pricing_version integer)
language sql
stable
security definer
set search_path = ''
as $$
  select cost.service, cost.unit_cost, cost.pricing_version
  from public.service_costs as cost
  where cost.service = p_service
    and cost.active
    and jsonb_typeof(coalesce(p_params, '{}'::jsonb)) = 'object';
$$;

create or replace function public.grant_daily_credits(
  p_user_id uuid,
  p_business_date date default (timezone('Asia/Shanghai', now())::date),
  p_amount integer default 30
)
returns table (lot_id uuid, granted boolean, daily_balance integer, sub_balance integer, topup_balance integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_key text := 'daily:' || p_business_date::text;
  expiry timestamptz := ((p_business_date + 1)::timestamp at time zone 'Asia/Shanghai');
  inserted_id uuid;
  was_inserted boolean := false;
  snapshot public.user_credits;
begin
  if p_amount <= 0 then
    raise exception 'grant amount must be positive' using errcode = '22023';
  end if;

  -- Serialize grants/holds for one user on the aggregate row.
  insert into public.user_credits (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;
  perform 1 from public.user_credits where user_id = p_user_id for update;

  insert into public.credit_lots (
    user_id, bucket, source_key, original_amount, remaining_amount, expires_at
  ) values (
    p_user_id, 'daily', v_source_key, p_amount, p_amount, expiry
  )
  on conflict (user_id, source_key) do nothing
  returning id into inserted_id;

  was_inserted := inserted_id is not null;
  if was_inserted then
    insert into public.credit_transactions (user_id, lot_id, kind, amount, meta)
    values (
      p_user_id,
      inserted_id,
      'grant',
      p_amount,
      jsonb_build_object('source', 'daily', 'business_date', p_business_date)
    );
  else
    select lot.id into inserted_id
    from public.credit_lots as lot
    where lot.user_id = p_user_id and lot.source_key = v_source_key;
  end if;

  snapshot := public.refresh_user_credit_snapshot(p_user_id);
  return query select inserted_id, was_inserted,
    snapshot.daily_balance, snapshot.sub_balance, snapshot.topup_balance;
end;
$$;

create or replace function public.grant_subscription_credits(
  p_user_id uuid,
  p_period_key text,
  p_amount integer,
  p_expires_at timestamptz
)
returns table (lot_id uuid, granted boolean, daily_balance integer, sub_balance integer, topup_balance integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_key text := 'sub:' || p_period_key;
  inserted_id uuid;
  was_inserted boolean := false;
  snapshot public.user_credits;
begin
  if p_amount <= 0 or p_period_key is null or btrim(p_period_key) = '' or p_expires_at <= now() then
    raise exception 'invalid subscription grant' using errcode = '22023';
  end if;

  insert into public.user_credits (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;
  perform 1 from public.user_credits where user_id = p_user_id for update;

  insert into public.credit_lots (
    user_id, bucket, source_key, original_amount, remaining_amount, expires_at
  ) values (
    p_user_id, 'sub', v_source_key, p_amount, p_amount, p_expires_at
  )
  on conflict (user_id, source_key) do nothing
  returning id into inserted_id;

  was_inserted := inserted_id is not null;
  if was_inserted then
    insert into public.credit_transactions (user_id, lot_id, kind, amount, meta)
    values (
      p_user_id,
      inserted_id,
      'grant',
      p_amount,
      jsonb_build_object('source', 'subscription', 'period_key', p_period_key)
    );
  else
    select lot.id into inserted_id
    from public.credit_lots as lot
    where lot.user_id = p_user_id and lot.source_key = v_source_key;
  end if;

  snapshot := public.refresh_user_credit_snapshot(p_user_id);
  return query select inserted_id, was_inserted, snapshot.daily_balance, snapshot.sub_balance, snapshot.topup_balance;
end;
$$;

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
  lot record;
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
  if p_estimated_amount is not null and p_estimated_amount <> charge then
    raise exception 'stale client estimate' using errcode = '22023';
  end if;

  -- Expired lots are excluded; daily/sub/topup priority is explicit, then earliest expiry/creation.
  select coalesce(sum(lot.remaining_amount), 0) into available
  from public.credit_lots as lot
  where lot.user_id = p_user_id and lot.remaining_amount > 0 and lot.expires_at > now();

  if available < charge then
    raise exception 'insufficient credits' using errcode = 'P0001', detail = 'insufficient_credits';
  end if;

  insert into public.credit_holds (user_id, idempotency_key, service, pricing_version, estimated_amount)
  values (p_user_id, p_idempotency_key, p_service, price_version, charge)
  returning id into created_hold_id;

  needed := charge;
  for lot in
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
    take_amount := least(needed, lot.remaining_amount);

    update public.credit_lots
      set remaining_amount = remaining_amount - take_amount
      where id = lot.id;
    insert into public.credit_hold_allocations (user_id, hold_id, lot_id, amount)
      values (p_user_id, created_hold_id, lot.id, take_amount);
    insert into public.credit_transactions (user_id, hold_id, lot_id, kind, amount, service)
      values (p_user_id, created_hold_id, lot.id, 'hold', -take_amount, p_service);

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

-- No client role can call the service-side billing functions directly.
revoke execute on function public.refresh_user_credit_snapshot(uuid) from public, anon, authenticated;
revoke execute on function public.estimate_cost(text, jsonb) from public, anon, authenticated;
revoke execute on function public.grant_daily_credits(uuid, date, integer) from public, anon, authenticated;
revoke execute on function public.grant_subscription_credits(uuid, text, integer, timestamptz) from public, anon, authenticated;
revoke execute on function public.credit_hold(uuid, text, text, integer) from public, anon, authenticated;

grant execute on function public.refresh_user_credit_snapshot(uuid) to service_role;
grant execute on function public.estimate_cost(text, jsonb) to service_role;
grant execute on function public.grant_daily_credits(uuid, date, integer) to service_role;
grant execute on function public.grant_subscription_credits(uuid, text, integer, timestamptz) to service_role;
grant execute on function public.credit_hold(uuid, text, text, integer) to service_role;

comment on function public.credit_hold(uuid, text, text, integer) is
  'Service-only idempotent hold. Edge Functions must derive p_user_id from a verified JWT.';
