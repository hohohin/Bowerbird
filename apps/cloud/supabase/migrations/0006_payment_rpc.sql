-- Service-only topup grant for credit packs. Mirrors grant_subscription_credits with a topup bucket.

create or replace function public.grant_topup_credits(
  p_user_id uuid,
  p_order_id text,
  p_amount integer,
  p_expires_at timestamptz default (now() + interval '2 years')
)
returns table (lot_id uuid, granted boolean, daily_balance integer, sub_balance integer, topup_balance integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_key text := 'topup:' || p_order_id;
  inserted_id uuid;
  was_inserted boolean := false;
  snapshot public.user_credits;
begin
  if p_amount <= 0 or p_order_id is null or btrim(p_order_id) = '' or p_expires_at <= now() then
    raise exception 'invalid topup grant' using errcode = '22023';
  end if;

  insert into public.user_credits (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;
  perform 1 from public.user_credits where user_id = p_user_id for update;

  insert into public.credit_lots (user_id, bucket, source_key, original_amount, remaining_amount, expires_at)
  values (p_user_id, 'topup', v_source_key, p_amount, p_amount, p_expires_at)
  on conflict (user_id, source_key) do nothing
  returning id into inserted_id;

  was_inserted := inserted_id is not null;
  if was_inserted then
    insert into public.credit_transactions (user_id, lot_id, kind, amount, meta)
    values (p_user_id, inserted_id, 'grant', p_amount, jsonb_build_object('source', 'topup', 'order_id', p_order_id));
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

revoke execute on function public.grant_topup_credits(uuid, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.grant_topup_credits(uuid, text, integer, timestamptz) to service_role;
