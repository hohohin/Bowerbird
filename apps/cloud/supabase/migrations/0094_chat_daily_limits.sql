-- Split chat day reservations from the managed generation/understanding cap.
-- Apply while new chat admission is closed. Existing jobs can still settle.
set local lock_timeout = '5s';
-- Managed usage writers take their system bucket before their per-user row.
lock table public.system_usage_daily in share row exclusive mode;

alter table public.usage_daily
  add column chat_request_count integer not null default 0 check (chat_request_count >= 0);

create table public.system_chat_usage_daily (
  business_date date primary key,
  request_count bigint not null check (request_count >= 0),
  cost_micros bigint not null check (cost_micros >= 0),
  updated_at timestamptz not null default now()
);
alter table public.system_chat_usage_daily enable row level security;
alter table public.system_chat_usage_daily force row level security;
revoke all on public.system_chat_usage_daily from public, anon, authenticated;
grant select on public.system_chat_usage_daily to service_role;

-- Migrate only the current business day. A job and its original reservation
-- were committed together, including for jobs that later failed or expired.
do $$
declare
  business_day date := timezone('Asia/Shanghai', now())::date;
  day_start timestamptz := business_day::timestamp at time zone 'Asia/Shanghai';
  day_end timestamptz := (business_day + 1)::timestamp at time zone 'Asia/Shanghai';
  accepted bigint;
  attributed bigint;
  chat_cost bigint;
begin
  select count(*), count(h.reserved_cost_micros), sum(h.reserved_cost_micros)
    into accepted, attributed, chat_cost
  from public.chat_completion_jobs j
  join public.credit_holds h on h.id = j.hold_id
  where j.created_at >= day_start and j.created_at < day_end;

  if accepted = 0 then return; end if;
  if attributed <> accepted then
    raise exception 'chat day reservation history cannot be attributed';
  end if;

  update public.system_usage_daily
     set request_count = request_count - accepted, cost_micros = cost_micros - chat_cost,
         updated_at = now()
   where business_date = business_day and request_count >= accepted and cost_micros >= chat_cost;
  if not found then raise exception 'chat day reservations exceed the existing managed bucket'; end if;

  insert into public.system_chat_usage_daily (business_date, request_count, cost_micros)
    values (business_day, accepted, chat_cost);

  insert into public.usage_daily (user_id, business_date, chat_request_count)
  select user_id, business_day, count(*)::integer
  from public.chat_completion_jobs
  where created_at >= day_start and created_at < day_end
  group by user_id
  on conflict (user_id, business_date) do update
    set chat_request_count = excluded.chat_request_count;
end;
$$;

update public.service_costs
set parameters = jsonb_set(parameters, '{free_turns_per_day}', '5'::jsonb)
where service = 'chat_deepseek' and not (parameters ? 'free_turns_per_day');

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
  chat_turn_limit integer;
  new_chat_turns integer;
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

  -- Keep the hold as the single reservation identity for every service.
  if locked_hold.reserved_cost_micros is not null then
    if locked_hold.service = 'chat_deepseek' then
      select cost_micros into new_daily_cost
      from public.system_chat_usage_daily where business_date = v_business_date;
    else
      select cost_micros into new_daily_cost
      from public.system_usage_daily where business_date = v_business_date;
    end if;
    select usage.request_count into new_minute_count
    from public.usage_minute as usage
    where usage.user_id = p_user_id and usage.minute_start = v_minute_bucket;
    return query select true, coalesce(new_daily_cost, 0), coalesce(new_minute_count, 0);
    return;
  end if;

  if locked_hold.status <> 'held' then
    raise exception 'credit hold is not active'
      using errcode = '55000', detail = 'hold_not_active';
  end if;

  -- Classification retains its existing explicit opt-out from the minute bucket.
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

  -- Lock each system day bucket before touching the per-user day row, matching
  -- other managed usage writers. A quota failure rolls back both reservations.
  if locked_hold.service = 'chat_deepseek' then
    select (parameters->>'free_turns_per_day')::integer into chat_turn_limit
    from public.service_costs where service = locked_hold.service;
    if chat_turn_limit is null or chat_turn_limit <= 0 then
      raise exception 'invalid chat daily turn limit' using errcode = '22023', detail = 'chat_daily_turn_limit_invalid';
    end if;

    insert into public.system_chat_usage_daily as usage (business_date, request_count, cost_micros)
    values (v_business_date, 1, p_cost_micros)
    on conflict (business_date) do update
      set request_count = usage.request_count + 1,
          cost_micros = usage.cost_micros + p_cost_micros,
          updated_at = now()
      where usage.cost_micros <= p_daily_cost_limit_micros - p_cost_micros
    returning usage.cost_micros into new_daily_cost;
  else
    insert into public.system_usage_daily as usage (business_date, request_count, cost_micros, updated_at)
    values (v_business_date, 1, p_cost_micros, now())
    on conflict (business_date) do update
      set request_count = usage.request_count + 1,
          cost_micros = usage.cost_micros + p_cost_micros,
          updated_at = now()
      where usage.cost_micros + p_cost_micros <= p_daily_cost_limit_micros
    returning usage.cost_micros into new_daily_cost;
  end if;

  if new_daily_cost is null then
    raise exception 'daily managed cost limit reached'
      using errcode = 'P0001', detail = 'daily_cost_limit';
  end if;

  if locked_hold.service = 'chat_deepseek' then
    insert into public.usage_daily as usage (user_id, business_date, request_count, cost_micros, chat_request_count)
    values (p_user_id, v_business_date, 1, p_cost_micros, 1)
    on conflict (user_id, business_date) do update
      set request_count = usage.request_count + 1,
          cost_micros = usage.cost_micros + p_cost_micros,
          chat_request_count = usage.chat_request_count + 1
      where usage.chat_request_count < chat_turn_limit
    returning usage.chat_request_count into new_chat_turns;

    if new_chat_turns is null then
      raise exception 'per-user daily chat turn limit reached'
        using errcode = 'P0001', detail = 'chat_daily_turn_limit';
    end if;
  else
    insert into public.usage_daily as usage (user_id, business_date, request_count, cost_micros)
    values (p_user_id, v_business_date, 1, p_cost_micros)
    on conflict (user_id, business_date) do update
      set request_count = usage.request_count + 1,
          cost_micros = usage.cost_micros + p_cost_micros;
  end if;

  update public.credit_holds
  set reserved_cost_micros = p_cost_micros, updated_at = now()
  where id = p_hold_id;

  return query select false, new_daily_cost, new_minute_count;
end;
$$;
