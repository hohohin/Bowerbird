-- Issue the current Asia/Shanghai daily allowance on demand.
--
-- The registration trigger only grants the registration day's lot. Without a cron job, the
-- cached user_credits row can keep showing yesterday's expired balance while credit_hold correctly
-- rejects it. Edge Functions call this idempotent service-only RPC before reading or spending.

create or replace function public.ensure_daily_credits(
  p_user_id uuid,
  p_amount integer default 30
)
returns table (
  lot_id uuid,
  granted boolean,
  daily_balance integer,
  sub_balance integer,
  topup_balance integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select daily.*
  from public.grant_daily_credits(
    p_user_id,
    timezone('Asia/Shanghai', now())::date,
    p_amount
  ) as daily;
end;
$$;

revoke execute on function public.ensure_daily_credits(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.ensure_daily_credits(uuid, integer) to service_role;

comment on function public.ensure_daily_credits(uuid, integer) is
  'Idempotently grants and snapshots the current Asia/Shanghai daily allowance for an active request.';
