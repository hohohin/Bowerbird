-- Service-only daily usage accounting. Free-tier limit is checked before upstream invocation.

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

  insert into public.usage_daily (user_id, business_date, understand_count, request_count)
  values (p_user_id, p_business_date, 1, 1)
  on conflict (user_id, business_date) do update
    set understand_count = public.usage_daily.understand_count + 1,
        request_count = public.usage_daily.request_count + 1
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
  set understand_count = greatest(0, understand_count - 1),
      request_count = greatest(0, request_count - 1)
  where user_id = p_user_id and business_date = p_business_date;
end;
$$;

revoke execute on function public.consume_understand_quota(uuid, integer, date) from public, anon, authenticated;
revoke execute on function public.undo_understand_quota(uuid, date) from public, anon, authenticated;
grant execute on function public.consume_understand_quota(uuid, integer, date) to service_role;
grant execute on function public.undo_understand_quota(uuid, date) to service_role;
