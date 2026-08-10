-- Atomically claim a held request before calling a managed upstream, then enforce
-- the per-user request rate and the project-wide daily cost ceiling.

alter table public.credit_holds
  add column if not exists reserved_cost_micros bigint
  check (reserved_cost_micros is null or reserved_cost_micros >= 0);

create table if not exists public.usage_minute (
  user_id uuid not null references public.billing_accounts(id) on delete restrict,
  minute_start timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  primary key (user_id, minute_start)
);

alter table public.usage_minute enable row level security;
alter table public.usage_minute force row level security;
revoke all on table public.usage_minute from public, anon, authenticated;

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

revoke execute on function public.reserve_managed_usage(uuid, uuid, bigint, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_managed_usage(uuid, uuid, bigint, bigint, integer)
  to service_role;

comment on function public.reserve_managed_usage(uuid, uuid, bigint, bigint, integer) is
  'Service-only idempotent upstream claim with per-user rate and project daily cost guards.';

-- The managed guard now owns request_count. The free understand quota RPC only owns its
-- dimension counter, so one understand request is not counted twice in usage_daily.
create or replace function public.consume_understand_quota(
  p_user_id uuid,
  p_limit integer,
  p_business_date date default (timezone('Asia/Shanghai', now())::date)
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_count integer;
begin
  if p_limit < 1 then
    raise exception 'limit must be positive' using errcode = '22023';
  end if;

  insert into public.usage_daily (user_id, business_date, understand_count)
  values (p_user_id, p_business_date, 1)
  on conflict (user_id, business_date) do update
    set understand_count = public.usage_daily.understand_count + 1
    where public.usage_daily.understand_count < p_limit
  returning understand_count into next_count;

  if next_count is null then
    raise exception 'daily understand limit reached'
      using errcode = 'P0001', detail = 'understand_daily_limit';
  end if;
  return next_count;
end;
$$;

create or replace function public.undo_understand_quota(
  p_user_id uuid,
  p_business_date date default (timezone('Asia/Shanghai', now())::date)
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.usage_daily
  set understand_count = greatest(0, understand_count - 1)
  where user_id = p_user_id and business_date = p_business_date;
end;
$$;

revoke execute on function public.consume_understand_quota(uuid, integer, date)
  from public, anon, authenticated;
revoke execute on function public.undo_understand_quota(uuid, date)
  from public, anon, authenticated;
grant execute on function public.consume_understand_quota(uuid, integer, date) to service_role;
grant execute on function public.undo_understand_quota(uuid, date) to service_role;
