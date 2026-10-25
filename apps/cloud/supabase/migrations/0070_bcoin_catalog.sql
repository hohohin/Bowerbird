-- Bcoin v1: Pro is software access; managed compute is purchased separately.
-- Preserve all existing lots, receipts and accepted holds. Never rescale balances.
create table public.billing_products (
  product text primary key,
  kind text not null check (kind in ('subscription','credits')),
  amount_minor integer not null check (amount_minor > 0),
  credits integer not null default 0 check (credits >= 0),
  months integer not null default 0 check (months in (0,1,12)),
  pricing_version integer not null default 20261023,
  active boolean not null default true,
  check ((kind='credits' and months=0 and credits*5=amount_minor)
    or (kind='subscription' and credits=0 and months in (1,12)))
);
alter table public.billing_products enable row level security;
revoke all on public.billing_products from public,anon,authenticated;
grant select on public.billing_products to service_role;
insert into public.billing_products(product,kind,amount_minor,credits,months) values
 ('pro_monthly','subscription',3900,0,1),
 ('pro_yearly','subscription',35900,0,12),
 ('bcoin_100','credits',500,100,0),
 ('bcoin_400','credits',2000,400,0),
 ('bcoin_1000','credits',5000,1000,0),
 ('bcoin_2000','credits',10000,2000,0);
alter table public.orders add column product_snapshot jsonb;
alter table public.orders add column entitlement_before jsonb;
alter table public.orders add column entitlement_after_version bigint;
alter table public.orders add column refund_event_id text;
create unique index orders_refund_event on public.orders(provider,refund_event_id) where refund_event_id is not null;

-- Old callers may still send DAILY_FREE_CREDITS=30. The database is authoritative.
create or replace function public.grant_daily_credits(
 p_user_id uuid,p_business_date date default (timezone('Asia/Shanghai',now())::date),p_amount integer default 30
) returns table(lot_id uuid,granted boolean,daily_balance integer,sub_balance integer,topup_balance integer)
language plpgsql security definer set search_path='' as $$
declare s public.user_credits;
begin
 s:=public.refresh_user_credit_snapshot(p_user_id);
 return query select null::uuid,false,s.daily_balance,s.sub_balance,s.topup_balance;
end $$;

create or replace function public.initialize_bowerbird_user() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into public.billing_accounts(id,auth_user_id) values(new.id,new.id)
 on conflict(id) do update set auth_user_id=excluded.auth_user_id,detached_at=null;
 insert into public.subscriptions(user_id,tier,status) values(new.id,'free','active') on conflict(user_id) do nothing;
 insert into public.user_credits(user_id) values(new.id) on conflict(user_id) do nothing;
 return new;
end $$;

-- New paid Bcoin never expires. Keep old lot expiry and all financial history intact.
create function public.apply_bcoin_order(p_order_id uuid,p_event_id text) returns void
language plpgsql security definer set search_path='' as $$
declare o public.orders; s public.subscriptions; cfg jsonb; start_at timestamptz; end_at timestamptz;
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
  start_at:=now();
  end_at:=((case when s.tier='pro' and s.status in ('active','canceled') and s.current_period_end>now()
   then s.current_period_end else start_at end) at time zone 'Asia/Shanghai'
   +make_interval(months=>(cfg->>'months')::integer)) at time zone 'Asia/Shanghai';
  update public.subscriptions set tier='pro',status='active',provider=o.provider,provider_subscription_id=null,
   period=case when (cfg->>'months')::integer=12 then 'yearly' else 'monthly' end,
   current_period_start=start_at,current_period_end=end_at,entitlement_version=entitlement_version+1,updated_at=now()
   where user_id=o.user_id;
 else raise exception 'invalid Bcoin product'; end if;
 update public.orders set status='paid',updated_at=now() where id=o.id;
end $$;
revoke all on function public.apply_bcoin_order(uuid,text) from public,anon,authenticated;
grant execute on function public.apply_bcoin_order(uuid,text) to service_role;

-- Full refunds only: never reverse a spent/held lot or overwrite a later entitlement.
-- Partial refunds require a separate reviewed settlement, not a forged full refund event.
create function public.refund_bcoin_order(p_order_id uuid,p_event_id text) returns void
language plpgsql security definer set search_path='' as $$
declare o public.orders; l public.credit_lots; s public.subscriptions; prior public.subscriptions;
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
  perform public.refresh_user_credit_snapshot(o.user_id);
 else
  select * into strict s from public.subscriptions where user_id=o.user_id for update;
  if s.entitlement_version is distinct from o.entitlement_after_version or o.entitlement_before is null then
   raise exception 'later entitlement exists: manual refund reconciliation required';
  end if;
  prior:=jsonb_populate_record(null::public.subscriptions,o.entitlement_before);
  update public.subscriptions set tier=prior.tier,status=prior.status,provider=prior.provider,provider_subscription_id=prior.provider_subscription_id,period=prior.period,
   current_period_start=prior.current_period_start,current_period_end=prior.current_period_end,
   entitlement_version=s.entitlement_version+1,updated_at=now() where user_id=o.user_id;
 end if;
 update public.orders set status='refunded',refund_event_id=p_event_id,updated_at=now() where id=o.id;
end $$;
revoke all on function public.refund_bcoin_order(uuid,text) from public,anon,authenticated;
grant execute on function public.refund_bcoin_order(uuid,text) to service_role;

-- Snapshot the old five-images tariff for requests already accepted before this migration.
alter table public.classification_requests add column images_per_credit integer not null default 5 check(images_per_credit>0);
alter table public.classification_requests alter column images_per_credit set default 1;
update public.service_costs set unit_cost=1,pricing_version=20261023,
 parameters=parameters||'{"images_per_credit":1,"currency":"Bcoin","cny_per_credit":0.05}'::jsonb,updated_at=now()
 where service='classification';

-- Legacy vouchers keep the promised 1100 credits. Newly issued vouchers contain no Bcoin.
alter table public.pro_redemption_codes add column bonus_credits integer not null default 1100 check(bonus_credits>=0);
alter table public.pro_redemption_codes alter column bonus_credits set default 0;
alter table public.pro_code_redemptions drop constraint pro_code_redemptions_credits_check;
alter table public.pro_code_redemptions add constraint pro_code_redemptions_credits_check check(credits>=0);

create or replace function public.advance_classification(p_user_id uuid,p_id uuid,p_action text,p_image_hash text default null,
  p_hash text default null,p_response jsonb default null,p_success boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.classification_requests; n bigint; amount integer:=0;
begin
  perform 1 from public.user_credits where user_id=p_user_id for update;
  select * into r from public.classification_requests where id=p_id and user_id=p_user_id for update;
  if not found then raise exception 'classification missing' using detail='classification_conflict'; end if;
  if p_action='claim_discovery' then
    if r.image_hash<>p_image_hash or not r.allow_discovery or
      (r.discovery_hash is not null and r.discovery_hash<>p_hash) then
      raise exception 'classification input changed' using detail='classification_conflict';
    end if;
    if r.status<>'needs_discovery' then return jsonb_build_object('claimed',false,'request',to_jsonb(r)); end if;
    if r.created_at<now()-interval '10 minutes' then raise exception 'classification expired' using detail='classification_conflict'; end if;
    update public.classification_requests set status='discovering',discovery_hash=p_hash,updated_at=now() where id=r.id returning * into r;
    return jsonb_build_object('claimed',true,'request',to_jsonb(r));
  end if;
  if r.status in ('succeeded','undetermined','failed') then return to_jsonb(r); end if;
  if p_action='await_discovery' and r.status='judging' and r.allow_discovery then
    update public.classification_requests set status='needs_discovery',judge_response=p_response,updated_at=now() where id=r.id returning * into r;
    return to_jsonb(r);
  end if;
  if p_action not in ('judge_done','discovery_done','fail') or
    (p_action='judge_done' and r.status<>'judging') or (p_action='discovery_done' and r.status<>'discovering') then
    raise exception 'invalid classification transition' using detail='classification_conflict';
  end if;
  if p_action<>'fail' and p_success then
    if r.images_per_credit=5 then
    insert into public.classification_meters as m(user_id,successful_images) values(p_user_id,1)
    on conflict(user_id) do update set successful_images=m.successful_images+1 returning successful_images into n;
    amount:=case when n%5=0 then 1 else 0 end;
    else amount:=1; end if;
    perform public.credit_confirm(r.hold_id,amount);
  else
    -- The generic hold sweeper may already have refunded an abandoned request.
    if exists(select 1 from public.credit_holds where id=r.hold_id and status in ('held','pending_settlement')) then
      perform public.credit_rollback(r.hold_id,'classification_without_labels');
    end if;
    if r.quota_date is not null then perform public.undo_understand_quota(p_user_id,r.quota_date); end if;
  end if;
  update public.classification_requests set
    status=case when p_action='fail' then 'failed' when p_success then 'succeeded' else 'undetermined' end,
    judge_response=case when p_action='judge_done' then p_response else judge_response end,
    discovery_response=case when p_action='discovery_done' then p_response else discovery_response end,
    charged=amount,updated_at=now() where id=r.id returning * into r;
  return to_jsonb(r);
end $$;


create or replace function public.redeem_pro_code(p_user_id uuid, p_code_hash text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_attempts integer;
  v_code public.pro_redemption_codes;
  v_receipt public.pro_code_redemptions;
  v_subscription public.subscriptions;
  v_active boolean;
  v_end timestamptz;
begin
  if not exists (select 1 from public.billing_accounts where id = p_user_id and auth_user_id = p_user_id) then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  -- Return business failures instead of raising: the attempt counter must commit on invalid codes.
  insert into public.pro_redemption_attempts as attempts (user_id, window_start, attempts)
  values (p_user_id, v_now, 1)
  on conflict (user_id) do update set
    attempts = case when attempts.window_start <= v_now - interval '15 minutes' then 1
      else least(attempts.attempts + 1, 11) end,
    window_start = case when attempts.window_start <= v_now - interval '15 minutes' then v_now
      else attempts.window_start end
  returning attempts into v_attempts;
  if v_attempts > 10 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  select * into v_code from public.pro_redemption_codes where code_hash = p_code_hash for update;
  if not found then return jsonb_build_object('status', 'invalid_code'); end if;

  select * into v_receipt from public.pro_code_redemptions where code_id = v_code.id;
  if found then
    if v_receipt.user_id <> p_user_id then
      return jsonb_build_object('status', 'invalid_code');
    end if;
    -- A lost HTTP response can be retried, even after the voucher expires or is disabled.
    return jsonb_build_object('status', 'redeemed', 'already_redeemed', true,
      'period_end', v_receipt.period_end, 'credits', v_receipt.credits,
      'credits_expires_at', v_receipt.credits_expires_at);
  end if;
  if v_code.disabled_at is not null or v_code.expires_at <= v_now then
    return jsonb_build_object('status', 'invalid_code');
  end if;

  -- Follow the credit-grant lock order, serializing different vouchers for the same account too.
  perform 1 from public.user_credits where user_id = p_user_id for update;
  select * into strict v_subscription from public.subscriptions where user_id = p_user_id for update;
  v_active := v_subscription.status in ('active','canceled') and
    (v_subscription.current_period_end is null or v_subscription.current_period_end > v_now);
  if v_active and v_subscription.tier = 'studio' then
    return jsonb_build_object('status', 'studio_active');
  end if;
  if v_active and v_subscription.tier = 'pro' and v_subscription.current_period_end is null then
    return jsonb_build_object('status', 'permanent_pro');
  end if;
  v_end := ((case when v_active and v_subscription.tier = 'pro'
    then v_subscription.current_period_end else v_now end) at time zone 'Asia/Shanghai'
    + interval '1 month') at time zone 'Asia/Shanghai';

  update public.subscriptions set tier = 'pro', status = 'active',
    period = case when v_active and v_subscription.tier = 'pro' then v_subscription.period else 'monthly' end,
    provider = case when v_active and v_subscription.tier = 'pro' then v_subscription.provider else 'redemption' end,
    provider_subscription_id = case when v_active and v_subscription.tier = 'pro' then v_subscription.provider_subscription_id else null end,
    current_period_start = case when v_active and v_subscription.tier = 'pro' then v_subscription.current_period_start else v_now end,
    current_period_end = v_end, entitlement_version = entitlement_version + 1, updated_at = v_now
  where user_id = p_user_id;

  if v_code.bonus_credits>0 then
    perform public.grant_subscription_credits(p_user_id, 'redemption:' || v_code.id::text, v_code.bonus_credits, v_now + interval '30 days');
  end if;
  insert into public.pro_code_redemptions(code_id, user_id, period_end, credits, credits_expires_at)
    values (v_code.id, p_user_id, v_end, v_code.bonus_credits, v_now + interval '30 days');
  return jsonb_build_object('status', 'redeemed', 'already_redeemed', false,
    'period_end', v_end, 'credits', v_code.bonus_credits, 'credits_expires_at', v_now + interval '30 days');
end;
$$;
