-- Fix credit_confirm when an estimate refund exhausts one allocation exactly.
-- The previous UPDATE wrote amount=0 before the following DELETE, violating
-- credit_hold_allocations_amount_check (amount > 0) at the UPDATE statement.

create or replace function public.credit_confirm(
  p_hold_id uuid,
  p_actual_amount integer
)
returns table (
  hold_id uuid,
  status text,
  actual_amount integer,
  daily_balance integer,
  sub_balance integer,
  topup_balance integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_hold public.credit_holds;
  held_total integer;
  difference integer;
  remaining bigint;
  take_amount integer;
  refund_amount integer;
  allocation record;
  lot record;
  snapshot public.user_credits;
begin
  if p_actual_amount < 0 then
    raise exception 'actual amount cannot be negative' using errcode = '22023';
  end if;

  select hold.user_id into locked_hold.user_id
  from public.credit_holds as hold
  where hold.id = p_hold_id;
  if not found then
    raise exception 'unknown hold' using errcode = 'P0002';
  end if;
  perform 1 from public.user_credits where user_id = locked_hold.user_id for update;

  select hold.* into locked_hold
  from public.credit_holds as hold
  where hold.id = p_hold_id
  for update;

  if not found then
    raise exception 'unknown hold' using errcode = 'P0002';
  end if;

  if locked_hold.status = 'confirmed' then
    if locked_hold.actual_amount <> p_actual_amount then
      raise exception 'confirmed hold actual amount mismatch' using errcode = '55000';
    end if;
    snapshot := public.refresh_user_credit_snapshot(locked_hold.user_id);
    return query select locked_hold.id, locked_hold.status, locked_hold.actual_amount,
      snapshot.daily_balance, snapshot.sub_balance, snapshot.topup_balance;
    return;
  end if;

  if locked_hold.status not in ('held', 'pending_settlement') then
    raise exception 'hold cannot be confirmed from status %', locked_hold.status using errcode = '55000';
  end if;

  select coalesce(sum(allocated.amount), 0)::integer into held_total
  from public.credit_hold_allocations as allocated
  where allocated.hold_id = p_hold_id;

  difference := p_actual_amount - held_total;
  if difference > 0 then
    select coalesce(sum(credits.remaining_amount), 0) into remaining
    from public.credit_lots as credits
    where credits.user_id = locked_hold.user_id
      and credits.remaining_amount > 0
      and credits.expires_at > now();

    if remaining < difference then
      raise exception 'insufficient credits for actual amount'
        using errcode = 'P0001', detail = 'insufficient_credits';
    end if;

    remaining := difference;
    for lot in
      select credits.id, credits.remaining_amount
      from public.credit_lots as credits
      where credits.user_id = locked_hold.user_id
        and credits.remaining_amount > 0
        and credits.expires_at > now()
      order by case credits.bucket when 'daily' then 0 when 'sub' then 1 else 2 end,
        credits.expires_at, credits.created_at, credits.id
      for update
    loop
      exit when remaining = 0;
      take_amount := least(remaining, lot.remaining_amount);

      update public.credit_lots
        set remaining_amount = remaining_amount - take_amount
        where id = lot.id;
      insert into public.credit_hold_allocations (user_id, hold_id, lot_id, amount)
        values (locked_hold.user_id, p_hold_id, lot.id, take_amount)
        on conflict on constraint credit_hold_allocations_pkey do update
          set amount = public.credit_hold_allocations.amount + excluded.amount;
      insert into public.credit_transactions (user_id, hold_id, lot_id, kind, amount, service)
        values (locked_hold.user_id, p_hold_id, lot.id, 'hold', -take_amount, locked_hold.service);

      remaining := remaining - take_amount;
    end loop;
  elsif difference < 0 then
    -- Refund newest/longest-lived allocations first so the originally consumed FIFO remains stable.
    remaining := -difference;
    for allocation in
      select allocated.lot_id, allocated.amount
      from public.credit_hold_allocations as allocated
      join public.credit_lots as credits on credits.id = allocated.lot_id
      where allocated.hold_id = p_hold_id
      order by case credits.bucket when 'topup' then 0 when 'sub' then 1 else 2 end,
        credits.expires_at desc, credits.created_at desc, credits.id desc
      for update of allocated, credits
    loop
      exit when remaining = 0;
      refund_amount := least(remaining, allocation.amount);

      update public.credit_lots
        set remaining_amount = remaining_amount + refund_amount
        where id = allocation.lot_id;
      if refund_amount = allocation.amount then
        delete from public.credit_hold_allocations as row_alloc
        where row_alloc.hold_id = p_hold_id
          and row_alloc.lot_id = allocation.lot_id;
      else
        update public.credit_hold_allocations as row_alloc
        set amount = row_alloc.amount - refund_amount
        where row_alloc.hold_id = p_hold_id
          and row_alloc.lot_id = allocation.lot_id;
      end if;
      insert into public.credit_transactions (user_id, hold_id, lot_id, kind, amount, service, meta)
        values (
          locked_hold.user_id,
          p_hold_id,
          allocation.lot_id,
          'confirm',
          refund_amount,
          locked_hold.service,
          jsonb_build_object('adjustment', 'estimate_refund')
        );

      remaining := remaining - refund_amount;
    end loop;
  end if;

  insert into public.credit_transactions (user_id, hold_id, kind, amount, service, meta)
  values (
    locked_hold.user_id,
    p_hold_id,
    'confirm',
    0,
    locked_hold.service,
    jsonb_build_object('estimated', held_total, 'actual', p_actual_amount)
  );

  update public.credit_holds
    set status = 'confirmed', actual_amount = p_actual_amount, updated_at = now()
    where id = p_hold_id
    returning * into locked_hold;

  snapshot := public.refresh_user_credit_snapshot(locked_hold.user_id);
  return query select locked_hold.id, locked_hold.status, locked_hold.actual_amount,
    snapshot.daily_balance, snapshot.sub_balance, snapshot.topup_balance;
end;
$$;

comment on function public.credit_confirm(uuid, integer) is
  'Confirms actual usage, including safe full-row refunds when an allocation is exhausted exactly.';
