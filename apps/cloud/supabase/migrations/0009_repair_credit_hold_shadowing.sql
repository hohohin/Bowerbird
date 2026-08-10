-- Repair PL/pgSQL record-variable shadowing in credit_hold.

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
  if p_estimated_amount is not null and p_estimated_amount <> charge then
    raise exception 'stale client estimate' using errcode = '22023';
  end if;

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

revoke execute on function public.credit_hold(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.credit_hold(uuid, text, text, integer) to service_role;

comment on function public.credit_hold(uuid, text, text, integer) is
  'Idempotent FIFO pre-authorization. Only service_role may call it.';
