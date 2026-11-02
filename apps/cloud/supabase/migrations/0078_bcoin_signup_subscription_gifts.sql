-- New registrations receive 200 Bcoin. New Pro periods receive 800 per month.
-- Existing balances, orders without the new snapshot fields, and redeemed vouchers stay intact.
alter table public.billing_products
  add column monthly_bonus_credits integer not null default 0 check (monthly_bonus_credits in (0,800)),
  add column bonus_valid_days integer not null default 30 check (bonus_valid_days=30);
update public.billing_products set monthly_bonus_credits=800,pricing_version=20261102
  where kind='subscription' and product in ('pro_monthly','pro_yearly');
alter table public.pro_redemption_codes alter column bonus_credits set default 800;
alter table public.pro_code_redemptions
  add column scheduled_credits integer not null default 0 check (scheduled_credits>=0),
  add column credits_scheduled_at timestamptz;

create table public.subscription_credit_grants (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.billing_accounts(id) on delete restrict,
  order_id uuid references public.orders(id) on delete restrict,
  redemption_code_id uuid references public.pro_redemption_codes(id) on delete restrict,
  month_index integer not null check (month_index between 0 and 11),
  amount integer not null check (amount=800),
  due_at timestamptz not null,
  valid_days integer not null default 30 check (valid_days=30),
  lot_id uuid unique,
  issued_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  check ((order_id is not null)::integer+(redemption_code_id is not null)::integer=1),
  check (redemption_code_id is null or month_index=0),
  check ((lot_id is null)=(issued_at is null)),
  unique (order_id,month_index),
  unique (redemption_code_id,month_index),
  foreign key (lot_id,user_id) references public.credit_lots(id,user_id) on delete restrict
);
create index subscription_credit_grants_due_idx on public.subscription_credit_grants(due_at,user_id)
  where issued_at is null and cancelled_at is null;
alter table public.subscription_credit_grants enable row level security;
alter table public.subscription_credit_grants force row level security;
revoke all on public.subscription_credit_grants from public,anon,authenticated;
grant all on public.subscription_credit_grants to service_role;

-- Every issuer and refund takes the wallet lock before touching a schedule or lot.
-- Missed installments remain claimable; their 30 days start at actual issuance.
create function public.issue_due_subscription_credit_grants(p_user_id uuid) returns integer
language plpgsql security definer set search_path='' as $$
declare g public.subscription_credit_grants; issued timestamptz; result record; count_issued integer:=0;
begin
  perform 1 from public.user_credits where user_id=p_user_id for update;
  if not found then raise exception 'billing wallet missing'; end if;
  if not exists(select 1 from public.billing_accounts where id=p_user_id
    and auth_user_id is not null and detached_at is null) then return 0; end if;
  for g in select * from public.subscription_credit_grants
    where user_id=p_user_id and issued_at is null and cancelled_at is null and due_at<=clock_timestamp()
    order by due_at,id for update
  loop
    issued:=clock_timestamp();
    select * into strict result from public.grant_subscription_credits(p_user_id,
      'subscription-month:'||case when g.order_id is not null then 'order:'||g.order_id::text
        else 'redemption:'||g.redemption_code_id::text end||':'||g.month_index::text,
      g.amount,issued+make_interval(days=>g.valid_days));
    update public.subscription_credit_grants set lot_id=result.lot_id,issued_at=issued where id=g.id;
    if result.granted then count_issued:=count_issued+1; end if;
  end loop;
  return count_issued;
end $$;
revoke all on function public.issue_due_subscription_credit_grants(uuid) from public,anon,authenticated;
grant execute on function public.issue_due_subscription_credit_grants(uuid) to service_role;

-- The limit counts users, each with all of their due installments. SKIP LOCKED
-- lets concurrent invocations skip wallets another request is processing.
create function public.issue_due_subscription_credit_grants_batch(p_limit integer default 100) returns integer
language plpgsql security definer set search_path='' as $$
declare account record; count_issued integer:=0;
begin
  if p_limit is null or p_limit not between 1 and 1000 then raise exception 'invalid grant batch limit'; end if;
  for account in select wallet.user_id from public.user_credits wallet
    where exists(select 1 from public.billing_accounts a where a.id=wallet.user_id
      and a.auth_user_id is not null and a.detached_at is null)
    and exists(select 1 from public.subscription_credit_grants g where g.user_id=wallet.user_id
      and g.issued_at is null and g.cancelled_at is null and g.due_at<=clock_timestamp())
    order by wallet.user_id limit p_limit for update of wallet skip locked
  loop
    count_issued:=count_issued+public.issue_due_subscription_credit_grants(account.user_id);
  end loop;
  return count_issued;
end $$;
revoke all on function public.issue_due_subscription_credit_grants_batch(integer) from public,anon,authenticated;
grant execute on function public.issue_due_subscription_credit_grants_batch(integer) to service_role;

-- Keep the legacy RPC signature. There is still no daily allowance.
create or replace function public.ensure_daily_credits(p_user_id uuid,p_amount integer default 30)
returns table(lot_id uuid,granted boolean,daily_balance integer,sub_balance integer,topup_balance integer)
language plpgsql security definer set search_path='' as $$
declare s public.user_credits; count_issued integer;
begin
  count_issued:=public.issue_due_subscription_credit_grants(p_user_id);
  s:=public.refresh_user_credit_snapshot(p_user_id);
  return query select null::uuid,count_issued>0,s.daily_balance,s.sub_balance,s.topup_balance;
end $$;
comment on function public.ensure_daily_credits(uuid,integer) is
  'Issues due Pro monthly gifts and refreshes the wallet; never grants a daily allowance.';

-- Only the existing AFTER INSERT auth trigger calls this: no historical backfill.
create or replace function public.initialize_bowerbird_user() returns trigger
language plpgsql security definer set search_path='' as $$
declare gift_id uuid; issued timestamptz:=clock_timestamp();
begin
  insert into public.billing_accounts(id,auth_user_id) values(new.id,new.id)
    on conflict(id) do update set auth_user_id=excluded.auth_user_id,detached_at=null;
  insert into public.subscriptions(user_id,tier,status) values(new.id,'free','active') on conflict(user_id) do nothing;
  insert into public.user_credits(user_id) values(new.id) on conflict(user_id) do nothing;
  perform 1 from public.user_credits where user_id=new.id for update;
  insert into public.credit_lots(user_id,bucket,source_key,original_amount,remaining_amount,expires_at)
    values(new.id,'sub','registration:v1',200,200,issued+interval '30 days')
    on conflict(user_id,source_key) do nothing returning id into gift_id;
  if gift_id is not null then
    insert into public.credit_transactions(user_id,lot_id,kind,amount,meta)
      values(new.id,gift_id,'grant',200,jsonb_build_object('source','signup','valid_days',30));
  end if;
  perform public.refresh_user_credit_snapshot(new.id);
  return new;
end $$;

create or replace function public.apply_bcoin_order(p_order_id uuid,p_event_id text) returns void
language plpgsql security definer set search_path='' as $$
declare o public.orders; s public.subscriptions; cfg jsonb; start_at timestamptz; end_at timestamptz;
  period_start timestamptz; bonus integer; valid_days integer;
begin
  select * into strict o from public.orders where id=p_order_id for update;
  if o.status='paid' then return; end if;
  if o.status<>'pending' or o.product_snapshot is null or nullif(btrim(p_event_id),'') is null then
    raise exception 'invalid Bcoin payment transition';
  end if;
  if o.provider_event_id is not null and o.provider_event_id<>p_event_id then raise exception 'payment event conflict'; end if;
  cfg:=o.product_snapshot;
  if (cfg->>'amount_minor')::integer<>o.amount_minor or cfg->>'product'<>o.product or o.currency<>'CNY' then
    raise exception 'payment snapshot mismatch';
  end if;
  update public.orders set provider_event_id=p_event_id where id=o.id;
  perform 1 from public.user_credits where user_id=o.user_id for update;
  if cfg->>'kind'='credits' then
    if (cfg->>'credits')::integer*5<>o.amount_minor then raise exception 'invalid Bcoin face value'; end if;
    perform public.grant_topup_credits(o.user_id,o.provider||':'||o.provider_order_id,(cfg->>'credits')::integer,'infinity'::timestamptz);
  elsif cfg->>'kind'='subscription' and (cfg->>'months')::integer in (1,12) and (cfg->>'credits')::integer=0 then
    select * into strict s from public.subscriptions where user_id=o.user_id for update;
    update public.orders set entitlement_before=to_jsonb(s),entitlement_after_version=s.entitlement_version+1 where id=o.id;
    if s.tier='studio' and s.status in ('active','canceled') and (s.current_period_end is null or s.current_period_end>now()) then
      raise exception 'existing Studio entitlement requires manual transition';
    end if;
    if s.tier='pro' and s.status in ('active','canceled') and s.current_period_end is null then raise exception 'permanent Pro cannot be extended'; end if;
    start_at:=clock_timestamp();
    period_start:=case when s.tier='pro' and s.status in ('active','canceled') and s.current_period_end>start_at
      then s.current_period_end else start_at end;
    end_at:=((period_start at time zone 'Asia/Shanghai')+make_interval(months=>(cfg->>'months')::integer)) at time zone 'Asia/Shanghai';
    update public.subscriptions set tier='pro',status='active',provider=o.provider,provider_subscription_id=null,
      period=case when (cfg->>'months')::integer=12 then 'yearly' else 'monthly' end,
      current_period_start=start_at,current_period_end=end_at,entitlement_version=entitlement_version+1,updated_at=now()
      where user_id=o.user_id;
    bonus:=coalesce((cfg->>'monthly_bonus_credits')::integer,0);
    valid_days:=coalesce((cfg->>'bonus_valid_days')::integer,30);
    if bonus not in (0,800) or valid_days<>30 then raise exception 'invalid subscription bonus snapshot'; end if;
    if bonus>0 then
      insert into public.subscription_credit_grants(user_id,order_id,month_index,amount,due_at,valid_days)
        select o.user_id,o.id,i,bonus,
          ((period_start at time zone 'Asia/Shanghai')+make_interval(months=>i)) at time zone 'Asia/Shanghai',valid_days
        from generate_series(0,(cfg->>'months')::integer-1) i;
      perform public.issue_due_subscription_credit_grants(o.user_id);
    end if;
  else raise exception 'invalid Bcoin product'; end if;
  update public.orders set status='paid',updated_at=now() where id=o.id;
end $$;

-- Refunding a subscription cancels its future installments and reverses only its
-- intact issued gifts. Spent or reserved gifts require manual reconciliation.
create or replace function public.refund_bcoin_order(p_order_id uuid,p_event_id text) returns void
language plpgsql security definer set search_path='' as $$
declare o public.orders; l public.credit_lots; s public.subscriptions; prior public.subscriptions;
  g public.subscription_credit_grants;
begin
  select * into strict o from public.orders where id=p_order_id for update;
  if o.status='refunded' then
    if o.refund_event_id is distinct from p_event_id then raise exception 'refund event conflict'; end if;
    return;
  end if;
  if o.status<>'paid' or o.product_snapshot is null or nullif(btrim(p_event_id),'') is null then raise exception 'invalid refund transition'; end if;
  perform 1 from public.user_credits where user_id=o.user_id for update;
  if o.product_snapshot->>'kind'='credits' then
    select * into strict l from public.credit_lots where user_id=o.user_id and source_key='topup:'||o.provider||':'||o.provider_order_id for update;
    if l.remaining_amount<>l.original_amount then raise exception 'Bcoin spent or held: full refund unavailable'; end if;
    update public.credit_lots set remaining_amount=0 where id=l.id;
    insert into public.credit_transactions(user_id,lot_id,kind,amount,meta)
      values(o.user_id,l.id,'refund',-l.remaining_amount,jsonb_build_object('order_id',o.id,'event_id',p_event_id));
  else
    select * into strict s from public.subscriptions where user_id=o.user_id for update;
    if s.entitlement_version is distinct from o.entitlement_after_version or o.entitlement_before is null then
      raise exception 'later entitlement exists: manual refund reconciliation required';
    end if;
    for g in select * from public.subscription_credit_grants where order_id=o.id order by due_at,id for update
    loop
      if g.lot_id is not null then
        select * into strict l from public.credit_lots where id=g.lot_id and user_id=o.user_id for update;
        if l.remaining_amount<>l.original_amount then raise exception 'subscription gift spent or held: full refund unavailable'; end if;
        update public.credit_lots set remaining_amount=0 where id=l.id;
        insert into public.credit_transactions(user_id,lot_id,kind,amount,meta)
          values(o.user_id,l.id,'refund',-l.remaining_amount,
            jsonb_build_object('source','subscription','order_id',o.id,'event_id',p_event_id,'subscription_credit_grant_id',g.id));
      end if;
      update public.subscription_credit_grants set cancelled_at=clock_timestamp() where id=g.id;
    end loop;
    prior:=jsonb_populate_record(null::public.subscriptions,o.entitlement_before);
    update public.subscriptions set tier=prior.tier,status=prior.status,provider=prior.provider,provider_subscription_id=prior.provider_subscription_id,period=prior.period,
      current_period_start=prior.current_period_start,current_period_end=prior.current_period_end,
      entitlement_version=s.entitlement_version+1,updated_at=now() where user_id=o.user_id;
  end if;
  perform public.refresh_user_credit_snapshot(o.user_id);
  update public.orders set status='refunded',refund_event_id=p_event_id,updated_at=now() where id=o.id;
end $$;

create or replace function public.redeem_pro_code(p_user_id uuid,p_code_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_now timestamptz:=clock_timestamp(); v_attempts integer; v_code public.pro_redemption_codes;
  v_receipt public.pro_code_redemptions; v_subscription public.subscriptions; v_active boolean;
  v_start timestamptz; v_end timestamptz; v_credits integer:=0; v_expiry timestamptz;
  v_scheduled integer:=0; v_scheduled_at timestamptz; v_grant public.subscription_credit_grants;
begin
  if not exists(select 1 from public.billing_accounts where id=p_user_id and auth_user_id=p_user_id) then
    return jsonb_build_object('status','unauthorized');
  end if;
  insert into public.pro_redemption_attempts as attempts(user_id,window_start,attempts) values(p_user_id,v_now,1)
    on conflict(user_id) do update set
      attempts=case when attempts.window_start<=v_now-interval '15 minutes' then 1 else least(attempts.attempts+1,11) end,
      window_start=case when attempts.window_start<=v_now-interval '15 minutes' then v_now else attempts.window_start end
    returning attempts into v_attempts;
  if v_attempts>10 then return jsonb_build_object('status','rate_limited'); end if;
  select * into v_code from public.pro_redemption_codes where code_hash=p_code_hash for update;
  if not found then return jsonb_build_object('status','invalid_code'); end if;
  select * into v_receipt from public.pro_code_redemptions where code_id=v_code.id;
  if found then
    if v_receipt.user_id<>p_user_id then return jsonb_build_object('status','invalid_code'); end if;
    return jsonb_build_object('status','redeemed','already_redeemed',true,'period_end',v_receipt.period_end,
      'credits',v_receipt.credits,'credits_expires_at',v_receipt.credits_expires_at,
      'scheduled_credits',v_receipt.scheduled_credits,'credits_scheduled_at',v_receipt.credits_scheduled_at);
  end if;
  if v_code.disabled_at is not null or v_code.expires_at<=v_now then return jsonb_build_object('status','invalid_code'); end if;
  perform 1 from public.user_credits where user_id=p_user_id for update;
  select * into strict v_subscription from public.subscriptions where user_id=p_user_id for update;
  v_now:=clock_timestamp();
  v_active:=v_subscription.status in ('active','canceled') and
    (v_subscription.current_period_end is null or v_subscription.current_period_end>v_now);
  if v_active and v_subscription.tier='studio' then return jsonb_build_object('status','studio_active'); end if;
  if v_active and v_subscription.tier='pro' and v_subscription.current_period_end is null then return jsonb_build_object('status','permanent_pro'); end if;
  v_start:=case when v_active and v_subscription.tier='pro' then v_subscription.current_period_end else v_now end;
  v_end:=((v_start at time zone 'Asia/Shanghai')+interval '1 month') at time zone 'Asia/Shanghai';
  update public.subscriptions set tier='pro',status='active',
    period=case when v_active and v_subscription.tier='pro' then v_subscription.period else 'monthly' end,
    provider=case when v_active and v_subscription.tier='pro' then v_subscription.provider else 'redemption' end,
    provider_subscription_id=case when v_active and v_subscription.tier='pro' then v_subscription.provider_subscription_id else null end,
    current_period_start=case when v_active and v_subscription.tier='pro' then v_subscription.current_period_start else v_now end,
    current_period_end=v_end,entitlement_version=entitlement_version+1,updated_at=now() where user_id=p_user_id;

  if v_code.bonus_credits not in (0,800) then
    -- Pre-0070 vouchers promised 1100 immediately, including when renewing.
    -- This replaces this voucher's monthly gift; never also schedule 800.
    v_credits:=v_code.bonus_credits;
    v_expiry:=clock_timestamp()+interval '30 days';
    perform public.grant_subscription_credits(p_user_id,'redemption:'||v_code.id::text,v_credits,v_expiry);
  else
    -- Includes previously issued, unredeemed zero-bonus vouchers. Already
    -- redeemed vouchers returned their original receipt above without a grant.
    insert into public.subscription_credit_grants(user_id,redemption_code_id,month_index,amount,due_at)
      values(p_user_id,v_code.id,0,800,v_start) returning * into v_grant;
    perform public.issue_due_subscription_credit_grants(p_user_id);
    select * into strict v_grant from public.subscription_credit_grants where id=v_grant.id;
    if v_grant.issued_at is not null then
      v_credits:=v_grant.amount;
      select expires_at into strict v_expiry from public.credit_lots where id=v_grant.lot_id;
    else
      v_scheduled:=v_grant.amount;
      v_scheduled_at:=v_grant.due_at;
      v_expiry:=v_grant.due_at+interval '30 days';
    end if;
  end if;
  insert into public.pro_code_redemptions(code_id,user_id,period_end,credits,credits_expires_at,scheduled_credits,credits_scheduled_at)
    values(v_code.id,p_user_id,v_end,v_credits,v_expiry,v_scheduled,v_scheduled_at);
  return jsonb_build_object('status','redeemed','already_redeemed',false,'period_end',v_end,
    'credits',v_credits,'credits_expires_at',v_expiry,'scheduled_credits',v_scheduled,'credits_scheduled_at',v_scheduled_at);
end $$;

-- Export the entitlement an unused code will provide now, including zero-bonus
-- codes issued before this rule. Do not rewrite the original code or receipt.
create or replace function public.admin_read_pro_codes(p_actor uuid,p_batch_id uuid default null,p_code_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_codes jsonb;
begin
  perform public.assert_pro_code_admin(p_actor);
  if (p_batch_id is null)=(p_code_id is null) then raise exception 'one target required' using errcode='22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'ciphertext',c.code_ciphertext,
    'expires_at',c.expires_at,'batch_label',i.batch_label,
    'bonus_credits',case when c.bonus_credits=0 then 800 else c.bonus_credits end)),'[]'::jsonb) into v_codes
    from public.pro_redemption_codes c join public.pro_code_admin_inventory i on i.id=c.id
    where ((p_batch_id is not null and c.batch_id=p_batch_id) or c.id=p_code_id)
      and i.status='unused' and c.code_ciphertext is not null;
  if jsonb_array_length(v_codes)>0 then
    insert into public.pro_code_admin_events(actor_id,action,batch_id,code_id)
      values(p_actor,case when p_code_id is null then 'export' else 'reveal' end,p_batch_id,p_code_id);
  end if;
  return v_codes;
end $$;
