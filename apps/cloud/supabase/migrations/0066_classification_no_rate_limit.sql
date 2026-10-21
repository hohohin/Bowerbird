-- Classification no longer consumes the per-user minute request allowance.
-- Other managed services retain their existing positive rate limits.
create or replace function public.reserve_managed_usage(
  p_user_id uuid,
  p_hold_id uuid,
  p_cost_micros bigint,
  p_daily_cost_limit_micros bigint,
  p_per_user_per_min integer
)
returns table (
  already_reserved boolean,
  daily_cost_micros bigint,
  minute_request_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_hold public.credit_holds;
  v_business_date date := timezone('Asia/Shanghai', now())::date;
  v_minute_bucket timestamptz := date_trunc('minute', now());
  new_daily_cost bigint;
  new_minute_count integer;
begin
  if p_cost_micros < 0 or p_daily_cost_limit_micros <= 0 or p_per_user_per_min <= 0 then
    raise exception 'invalid managed usage limits' using errcode = '22023';
  end if;
  if p_cost_micros > p_daily_cost_limit_micros then
    raise exception 'daily managed cost limit reached'
      using errcode = 'P0001', detail = 'daily_cost_limit';
  end if;

  select hold.* into locked_hold
  from public.credit_holds as hold
  where hold.id = p_hold_id and hold.user_id = p_user_id
  for update;

  if not found then
    raise exception 'unknown credit hold' using errcode = '22023';
  end if;

  -- The first caller claims the hold. Replays never call the upstream or consume
  -- another rate/cost reservation, including while the first caller is in flight.
  if locked_hold.reserved_cost_micros is not null then
    select coalesce(usage.cost_micros, 0) into new_daily_cost
    from public.system_usage_daily as usage
    where usage.business_date = v_business_date;
    select coalesce(usage.request_count, 0) into new_minute_count
    from public.usage_minute as usage
    where usage.user_id = p_user_id and usage.minute_start = v_minute_bucket;
    return query select true, coalesce(new_daily_cost, 0), coalesce(new_minute_count, 0);
    return;
  end if;

  if locked_hold.status <> 'held' then
    raise exception 'credit hold is not active'
      using errcode = '55000', detail = 'hold_not_active';
  end if;

  -- NULL explicitly opts out of the per-user minute gate and its shared bucket.
  new_minute_count := 0;
  if p_per_user_per_min is not null then
    insert into public.usage_minute as usage (user_id, minute_start, request_count)
    values (p_user_id, v_minute_bucket, 1)
    on conflict (user_id, minute_start) do update
      set request_count = usage.request_count + 1
      where usage.request_count < p_per_user_per_min
    returning usage.request_count into new_minute_count;

    if new_minute_count is null then
      raise exception 'per-user managed request rate reached'
        using errcode = 'P0001', detail = 'rate_limit_per_minute';
    end if;
  end if;

  insert into public.system_usage_daily as usage (
    business_date, request_count, cost_micros, updated_at
  ) values (
    v_business_date, 1, p_cost_micros, now()
  )
  on conflict (business_date) do update
    set request_count = usage.request_count + 1,
        cost_micros = usage.cost_micros + p_cost_micros,
        updated_at = now()
    where usage.cost_micros + p_cost_micros <= p_daily_cost_limit_micros
  returning usage.cost_micros into new_daily_cost;

  if new_daily_cost is null then
    raise exception 'daily managed cost limit reached'
      using errcode = 'P0001', detail = 'daily_cost_limit';
  end if;

  insert into public.usage_daily as usage (
    user_id, business_date, request_count, cost_micros
  ) values (
    p_user_id, v_business_date, 1, p_cost_micros
  )
  on conflict (user_id, business_date) do update
    set request_count = usage.request_count + 1,
        cost_micros = usage.cost_micros + p_cost_micros;

  update public.credit_holds
  set reserved_cost_micros = p_cost_micros,
      updated_at = now()
  where id = p_hold_id;

  return query select false, new_daily_cost, new_minute_count;
end;
$$;
