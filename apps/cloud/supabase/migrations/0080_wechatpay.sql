-- Native API v3. All RPC callers are trusted server code after signature verification.
-- Existing Mock receipts, purchase snapshots and gift schedules remain unchanged.
alter table public.orders drop constraint orders_provider_check;
alter table public.orders add constraint orders_provider_check check(provider in ('mock','superun','paddle','wechatpay'));
alter table public.subscriptions drop constraint subscriptions_provider_check;
alter table public.subscriptions add constraint subscriptions_provider_check check(provider is null or provider in ('mock','superun','paddle','redemption','wechatpay'));
insert into public.billing_products(product,kind,amount_minor,credits,months,pricing_version)
values('bcoin_200','credits',1000,200,0,20261104),('bcoin_10000','credits',50000,10000,0,20261104);

create table public.wechatpay_payments (
  order_id uuid primary key references public.orders(id),
  user_id uuid not null references public.billing_accounts(id),
  request_key text not null check(length(request_key) between 8 and 128),
  mchid text not null, appid text not null,
  out_trade_no text not null unique check(out_trade_no ~ '^[a-zA-Z0-9_-]{1,32}$'),
  transaction_id text unique, success_time timestamptz,
  code_url text,
  native_request jsonb not null,
  time_expire timestamptz not null,
  payment_state text not null default 'CREATED' check(payment_state in ('CREATED','NOTPAY','USERPAYING','SUCCESS','CLOSED','REVOKED','PAYERROR')),
  reconcile_after timestamptz not null default now(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(user_id,request_key)
);
create table public.wechatpay_refunds (
  id uuid primary key default extensions.gen_random_uuid(),
  order_id uuid not null references public.wechatpay_payments(order_id),
  actor_id uuid not null references public.billing_accounts(id),
  request_key text not null check(length(request_key) between 8 and 128),
  out_refund_no text not null unique, refund_id text unique, create_time timestamptz, success_time timestamptz,
  amount_minor integer not null check(amount_minor>0),
  request_payload jsonb not null,
  state text not null default 'reserved' check(state in ('reserved','processing','succeeded','closed','abnormal')),
  subscription_version bigint,
  reconcile_after timestamptz not null default now(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(order_id,request_key)
);
create unique index wechatpay_refund_active_order on public.wechatpay_refunds(order_id) where state<>'closed';
create table public.wechatpay_refund_lots (
  refund_id uuid not null references public.wechatpay_refunds(id),
  lot_id uuid not null references public.credit_lots(id),
  amount integer not null check(amount>0), primary key(refund_id,lot_id)
);
create table public.wechatpay_refund_grants (
  refund_id uuid not null references public.wechatpay_refunds(id),
  grant_id uuid not null references public.subscription_credit_grants(id),
  cancelled_before timestamptz, frozen_at timestamptz not null, primary key(refund_id,grant_id)
);
create table public.wechatpay_events (
  event_id text primary key check(length(event_id) between 1 and 160),
  kind text not null check(kind in ('transaction','refund')),
  mchid text not null,
  payload jsonb not null,
  status text not null default 'pending' check(status in ('pending','applied','failed')),
  error text, attempts integer not null default 0,
  reconcile_after timestamptz not null default now(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index wechatpay_events_pending on public.wechatpay_events(reconcile_after) where status<>'applied';
create table public.wechatpay_bill_audits (
  bill_date date not null, mchid text not null, appid text not null,
  hash_value text not null, status text not null check(status in ('matched','differences')),
  report jsonb not null, checked_at timestamptz not null default now(),
  primary key(bill_date,mchid,appid)
);

create function public.wechatpay_order_json(p_order_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('order',to_jsonb(o),'payment',to_jsonb(p))
  from public.orders o join public.wechatpay_payments p on p.order_id=o.id where o.id=p_order_id
$$;

create function public.create_wechatpay_order(p_user_id uuid,p_request_key text,p_product text,p_custom_yuan integer,p_mchid text,p_appid text,
  p_notify_url text default 'https://bowerbird.cn/api/pay/wechat/notify')
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.wechatpay_payments; cfg jsonb; s public.subscriptions; oid uuid; n integer; expiry timestamptz; native jsonb;
begin
  if p_request_key is null or length(p_request_key) not between 8 and 128
    or coalesce(p_mchid,'')!~'^[0-9]{6,32}$' or coalesce(p_appid,'')!~'^wx[a-zA-Z0-9]{16}$'
    or coalesce(p_notify_url,'')!~'^https://[^/?#@]+/[^?#]*$' or length(p_notify_url)>2048 then raise exception 'invalid checkout parameters'; end if;
  if not exists(select 1 from public.billing_accounts where id=p_user_id and auth_user_id=p_user_id and detached_at is null) then raise exception 'account unavailable'; end if;
  perform 1 from public.user_credits where user_id=p_user_id for update;
  select * into p from public.wechatpay_payments where user_id=p_user_id and request_key=p_request_key;
  if found then
    select product_snapshot into cfg from public.orders where id=p.order_id;
    if cfg->>'product' is distinct from p_product or (cfg->>'custom_yuan')::integer is distinct from p_custom_yuan
      or p.mchid<>p_mchid or p.appid<>p_appid then raise exception 'checkout idempotency conflict'; end if;
    return public.wechatpay_order_json(p.order_id);
  end if;
  select count(*) into n from public.wechatpay_payments where user_id=p_user_id and created_at>now()-interval '1 minute';
  if n>=10 then raise exception 'checkout rate limited'; end if;
  select count(*) into n from public.wechatpay_payments where user_id=p_user_id and time_expire>now() and payment_state in ('CREATED','NOTPAY','USERPAYING');
  if n>=10 then raise exception 'too many pending checkouts'; end if;
  if p_product='bcoin_custom' then
    if p_custom_yuan is null or p_custom_yuan not between 1 and 21474836 then raise exception 'custom topup must be 1 to 21474836 integer yuan'; end if;
    cfg:=jsonb_build_object('product',p_product,'kind','credits','amount_minor',p_custom_yuan*100,'credits',p_custom_yuan*20,'months',0,'pricing_version',20261104,'custom_yuan',p_custom_yuan);
  else
    if p_custom_yuan is not null then raise exception 'custom amount only allowed for custom topup'; end if;
    select to_jsonb(b) into cfg from public.billing_products b where product=p_product and active;
    if cfg is null then raise exception 'unknown product'; end if;
  end if;
  if cfg->>'kind'='subscription' then
    select * into strict s from public.subscriptions where user_id=p_user_id;
    if s.status in ('active','canceled') and ((s.tier='studio' and (s.current_period_end is null or s.current_period_end>now())) or (s.tier='pro' and s.current_period_end is null)) then raise exception 'existing entitlement cannot be extended'; end if;
    if exists(select 1 from public.wechatpay_refunds r join public.orders o on o.id=r.order_id where o.user_id=p_user_id and o.product_snapshot->>'kind'='subscription' and r.state in ('reserved','processing','abnormal')) then raise exception 'subscription refund pending'; end if;
  end if;
  oid:=extensions.gen_random_uuid();
  expiry:=date_trunc('second',clock_timestamp())+interval '15 minutes';
  native:=jsonb_build_object('appid',p_appid,'mchid',p_mchid,'out_trade_no',replace(oid::text,'-',''),
    'description',case when cfg->>'kind'='credits' then 'Bowerbird '||(cfg->>'credits')||' Bcoin'
      when (cfg->>'months')::integer=12 then 'Bowerbird Pro 年付' else 'Bowerbird Pro 月付' end,
    'amount',jsonb_build_object('total',(cfg->>'amount_minor')::integer,'currency','CNY'),
    'time_expire',to_char(expiry at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"+00:00"'),'notify_url',p_notify_url);
  insert into public.orders(id,user_id,provider,provider_order_id,product,amount_minor,currency,product_snapshot)
    values(oid,p_user_id,'wechatpay',replace(oid::text,'-',''),p_product,(cfg->>'amount_minor')::integer,'CNY',cfg);
  insert into public.wechatpay_payments(order_id,user_id,request_key,mchid,appid,out_trade_no,time_expire,native_request)
    values(oid,p_user_id,p_request_key,p_mchid,p_appid,replace(oid::text,'-',''),expiry,native);
  return public.wechatpay_order_json(oid);
end $$;

create function public.update_wechatpay_checkout(p_order_id uuid,p_code_url text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  if p_code_url is null or p_code_url!~'^weixin://wxpay/' or length(p_code_url)>2048 then raise exception 'invalid payment QR'; end if;
  update public.wechatpay_payments set code_url=p_code_url,updated_at=now() where order_id=p_order_id and payment_state in ('CREATED','NOTPAY','USERPAYING');
  return public.wechatpay_order_json(p_order_id);
end $$;

create function public.claim_wechatpay_order(p_order_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  update public.wechatpay_payments set reconcile_after=now()+interval '1 minute'
    where order_id=p_order_id and reconcile_after<=now();
  if not found then return null; end if;
  return public.wechatpay_order_json(p_order_id);
end $$;

create function public.release_wechatpay_reconciliation(p_order_id uuid default null,p_refund_id uuid default null) returns void
language plpgsql security definer set search_path='' as $$
begin
  if p_order_id is not null then update public.wechatpay_payments set reconcile_after=now()+interval '5 seconds' where order_id=p_order_id; end if;
  if p_refund_id is not null then update public.wechatpay_refunds set reconcile_after=now()+interval '5 seconds' where id=p_refund_id; end if;
end $$;

-- This guard uses service-owned refund rows, never a caller-controlled session flag.
create function public.guard_wechatpay_subscription_refund() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if (to_jsonb(new)-'updated_at') is distinct from (to_jsonb(old)-'updated_at') and exists(
    select 1 from public.wechatpay_refunds r join public.orders o on o.id=r.order_id
    where o.user_id=old.user_id and o.product_snapshot->>'kind'='subscription' and r.state in ('reserved','processing','abnormal'))
  then raise exception 'subscription refund pending'; end if;
  return new;
end $$;
create trigger wechatpay_subscription_refund_guard before update on public.subscriptions
for each row execute function public.guard_wechatpay_subscription_refund();

create function public.apply_wechatpay_transaction(p_event_id text,p_transaction jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.wechatpay_events; p public.wechatpay_payments; o public.orders; body jsonb; state text; failure text;
begin
  -- Keep only financial fields; payer identifiers are unnecessary for account ownership.
  body:=jsonb_build_object('mchid',p_transaction->'mchid','appid',p_transaction->'appid','out_trade_no',p_transaction->'out_trade_no',
    'transaction_id',p_transaction->'transaction_id','trade_state',p_transaction->'trade_state','amount',p_transaction->'amount','success_time',p_transaction->'success_time');
  insert into public.wechatpay_events(event_id,kind,mchid,payload) values(p_event_id,'transaction',coalesce(body->>'mchid',''),body) on conflict do nothing;
  select * into strict e from public.wechatpay_events where event_id=p_event_id for update;
  if e.kind<>'transaction' or e.payload<>body then raise exception 'payment event identity conflict'; end if;
  if e.status='applied' then return jsonb_build_object('accepted',true,'status','applied'); end if;
  begin
    select * into strict p from public.wechatpay_payments where out_trade_no=body->>'out_trade_no';
    select * into strict o from public.orders where id=p.order_id for update;
    select * into strict p from public.wechatpay_payments where order_id=o.id for update;
    state:=body->>'trade_state';
    if body->>'mchid' is distinct from p.mchid or body->>'appid' is distinct from p.appid
      or state is null or state not in ('NOTPAY','USERPAYING','SUCCESS','CLOSED','REVOKED','PAYERROR') then raise exception 'payment details mismatch'; end if;
    -- Unpaid queries may omit amount. Never infer a successful payment's amount.
    if (state='SUCCESS' or body#>>'{amount,total}' is not null) and
      (coalesce(body#>>'{amount,total}','')!~'^[0-9]+$' or (body#>>'{amount,total}')::bigint is distinct from o.amount_minor) then raise exception 'payment amount mismatch'; end if;
    if (state='SUCCESS' or body#>>'{amount,currency}' is not null) and body#>>'{amount,currency}' is distinct from o.currency then raise exception 'payment currency mismatch'; end if;
    if state='SUCCESS' then
      if coalesce(body->>'transaction_id','')!~'^[a-zA-Z0-9_-]{1,64}$' then raise exception 'invalid transaction id'; end if;
      if p.transaction_id is not null and p.transaction_id<>body->>'transaction_id' then raise exception 'transaction identity conflict'; end if;
      if p.payment_state in ('CLOSED','REVOKED') then raise exception 'closed order received payment: manual reconciliation'; end if;
      update public.wechatpay_payments set transaction_id=body->>'transaction_id',payment_state='SUCCESS',success_time=coalesce(success_time,(body->>'success_time')::timestamptz),updated_at=now() where order_id=o.id;
      if o.status<>'refunded' then perform public.apply_bcoin_order(o.id,'wechatpay:'||(body->>'transaction_id')); end if;
    elsif p.payment_state<>'SUCCESS' then
      -- Terminal states never regress to an old unpaid query result.
      if p.payment_state not in ('CLOSED','REVOKED','PAYERROR') then
        update public.wechatpay_payments set payment_state=state,updated_at=now() where order_id=o.id;
        if state in ('CLOSED','REVOKED','PAYERROR') then update public.orders set status='canceled',updated_at=now() where id=o.id and status='pending'; end if;
      end if;
    end if;
  exception when others then failure:=SQLERRM;
  end;
  update public.wechatpay_events set status=case when failure is null then 'applied' else 'failed' end,error=failure,attempts=attempts+1,
    reconcile_after=now()+interval '1 minute',updated_at=now() where event_id=p_event_id;
  return jsonb_build_object('accepted',failure is null,'status',case when failure is null then 'applied' else 'failed' end,'error',failure);
end $$;

create function public.prepare_wechatpay_refund(p_actor uuid,p_order_id uuid,p_request_key text,
  p_notify_url text default 'https://bowerbird.cn/api/pay/wechat/refund-notify') returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.orders; p public.wechatpay_payments; r public.wechatpay_refunds; s public.subscriptions; l public.credit_lots; g public.subscription_credit_grants; refund_no text;
begin
  perform public.assert_pro_code_admin(p_actor);
  if p_request_key is null or length(p_request_key) not between 8 and 128 then raise exception 'refund request key required'; end if;
  if coalesce(p_notify_url,'')!~'^https://[^/?#@]+/[^?#]*$' or length(p_notify_url)>2048 then raise exception 'invalid refund notification URL'; end if;
  select * into strict o from public.orders where id=p_order_id and provider='wechatpay' for update;
  select * into strict p from public.wechatpay_payments where order_id=o.id for update;
  select * into r from public.wechatpay_refunds where order_id=o.id and request_key=p_request_key;
  if found then return public.wechatpay_order_json(o.id)||jsonb_build_object('refund',to_jsonb(r)); end if;
  if o.status<>'paid' or p.payment_state<>'SUCCESS' or p.transaction_id is null then raise exception 'paid order required'; end if;
  perform 1 from public.user_credits where user_id=o.user_id for update;
  if exists(select 1 from public.wechatpay_refunds where order_id=o.id and state<>'closed') then raise exception 'refund already exists'; end if;
  if o.product_snapshot->>'kind'='subscription' then
    select * into strict s from public.subscriptions where user_id=o.user_id for update;
    if s.entitlement_version is distinct from o.entitlement_after_version or o.entitlement_before is null then raise exception 'later entitlement: manual refund required'; end if;
  end if;
  refund_no:=replace(extensions.gen_random_uuid()::text,'-','');
  insert into public.wechatpay_refunds(order_id,actor_id,request_key,out_refund_no,amount_minor,subscription_version,request_payload)
    values(o.id,p_actor,p_request_key,refund_no,o.amount_minor,s.entitlement_version,
      jsonb_build_object('out_trade_no',p.out_trade_no,'out_refund_no',refund_no,'notify_url',p_notify_url,
        'amount',jsonb_build_object('refund',o.amount_minor,'total',o.amount_minor,'currency','CNY'))) returning * into r;
  if o.product_snapshot->>'kind'='credits' then
    select * into strict l from public.credit_lots where user_id=o.user_id and source_key='topup:wechatpay:'||o.provider_order_id for update;
    if l.remaining_amount<>l.original_amount then raise exception 'Bcoin spent or held: manual refund required'; end if;
    insert into public.wechatpay_refund_lots values(r.id,l.id,l.remaining_amount);
    update public.credit_lots set remaining_amount=0 where id=l.id;
    insert into public.credit_transactions(user_id,lot_id,kind,amount,meta) values(o.user_id,l.id,'adjust',-l.remaining_amount,jsonb_build_object('source','wechatpay_refund_reserved','refund_id',r.id));
  else
    for g in select * from public.subscription_credit_grants where order_id=o.id order by due_at,id for update loop
      insert into public.wechatpay_refund_grants values(r.id,g.id,g.cancelled_at,r.created_at);
      update public.subscription_credit_grants set cancelled_at=r.created_at where id=g.id;
      if g.lot_id is not null then
        select * into strict l from public.credit_lots where id=g.lot_id and user_id=o.user_id for update;
        if l.remaining_amount<>l.original_amount then raise exception 'subscription gift spent or held: manual refund required'; end if;
        insert into public.wechatpay_refund_lots values(r.id,l.id,l.remaining_amount);
        update public.credit_lots set remaining_amount=0 where id=l.id;
        insert into public.credit_transactions(user_id,lot_id,kind,amount,meta) values(o.user_id,l.id,'adjust',-l.remaining_amount,jsonb_build_object('source','wechatpay_refund_reserved','refund_id',r.id));
      end if;
    end loop;
  end if;
  perform public.refresh_user_credit_snapshot(o.user_id);
  return public.wechatpay_order_json(o.id)||jsonb_build_object('refund',to_jsonb(r));
end $$;

create function public.apply_wechatpay_refund(p_event_id text,p_refund jsonb,p_mchid text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.wechatpay_events; r public.wechatpay_refunds; p public.wechatpay_payments; o public.orders; body jsonb; v_state text; failure text;
begin
  body:=jsonb_build_object('out_refund_no',p_refund->'out_refund_no','refund_id',p_refund->'refund_id','out_trade_no',p_refund->'out_trade_no',
    'transaction_id',p_refund->'transaction_id','status',coalesce(p_refund->'refund_status',p_refund->'status'),'amount',p_refund->'amount','success_time',p_refund->'success_time','create_time',p_refund->'create_time');
  -- Official refund notifications omit currency; this integration only creates CNY orders.
  -- Query/API responses must carry currency. An explicitly supplied wrong currency still fails.
  if p_refund ? 'refund_status' and not (coalesce(p_refund->'amount','{}'::jsonb) ? 'currency') then
    body:=jsonb_set(body,'{amount,currency}','"CNY"'::jsonb);
  end if;
  insert into public.wechatpay_events(event_id,kind,mchid,payload) values(p_event_id,'refund',coalesce(p_mchid,''),body) on conflict do nothing;
  select * into strict e from public.wechatpay_events where event_id=p_event_id for update;
  if e.kind<>'refund' or e.mchid is distinct from p_mchid or e.payload<>body then raise exception 'refund event identity conflict'; end if;
  if e.status='applied' then return jsonb_build_object('accepted',true,'status','applied'); end if;
  begin
    select * into strict r from public.wechatpay_refunds where out_refund_no=body->>'out_refund_no';
    select * into strict o from public.orders where id=r.order_id for update;
    select * into strict p from public.wechatpay_payments where order_id=o.id for update;
    perform 1 from public.user_credits where user_id=o.user_id for update;
    select * into strict r from public.wechatpay_refunds where id=r.id for update;
    v_state:=body->>'status';
    if p_mchid is distinct from p.mchid or body->>'out_trade_no' is distinct from p.out_trade_no
      or body->>'transaction_id' is distinct from p.transaction_id or (body#>>'{amount,total}')::bigint is distinct from o.amount_minor
      or coalesce(body#>>'{amount,total}','')!~'^[0-9]+$' or coalesce(body#>>'{amount,refund}','')!~'^[0-9]+$'
      or (body#>>'{amount,refund}')::bigint is distinct from r.amount_minor or body#>>'{amount,currency}' is distinct from 'CNY'
      or coalesce(body->>'refund_id','')!~'^[a-zA-Z0-9_-]{1,64}$' or v_state is null or v_state not in ('SUCCESS','CLOSED','PROCESSING','ABNORMAL')
      or (r.refund_id is not null and r.refund_id<>body->>'refund_id') then raise exception 'refund details mismatch'; end if;
    if r.state='succeeded' then
      if v_state in ('CLOSED','ABNORMAL') then raise exception 'refund terminal state conflict'; end if;
    elsif r.state='closed' then
      if v_state='SUCCESS' then raise exception 'released refund later succeeded: manual reconciliation'; end if;
    elsif v_state in ('SUCCESS','CLOSED') then
      if exists(select 1 from public.wechatpay_refund_lots f join public.credit_lots l on l.id=f.lot_id
        where f.refund_id=r.id and (l.user_id<>o.user_id or l.remaining_amount<>0 or l.original_amount<>f.amount)) then raise exception 'frozen refund balance changed: manual reconciliation'; end if;
      if exists(select 1 from public.wechatpay_refund_grants f join public.subscription_credit_grants g on g.id=f.grant_id
        where f.refund_id=r.id and (g.user_id<>o.user_id or g.order_id is distinct from o.id or g.cancelled_at is distinct from f.frozen_at)) then raise exception 'frozen refund grant changed: manual reconciliation'; end if;
      -- Release the service-owned guard only within this atomic finalization.
      update public.wechatpay_refunds set state=case when v_state='SUCCESS' then 'succeeded' else 'closed' end,
        refund_id=body->>'refund_id',updated_at=now() where id=r.id;
      update public.credit_lots l set remaining_amount=f.amount from public.wechatpay_refund_lots f where f.refund_id=r.id and l.id=f.lot_id and l.remaining_amount=0;
      insert into public.credit_transactions(user_id,lot_id,kind,amount,meta)
        select o.user_id,f.lot_id,'adjust',f.amount,jsonb_build_object('source','wechatpay_refund_released','refund_id',r.id) from public.wechatpay_refund_lots f where f.refund_id=r.id;
      update public.subscription_credit_grants g set cancelled_at=f.cancelled_before from public.wechatpay_refund_grants f where f.refund_id=r.id and g.id=f.grant_id;
      if v_state='SUCCESS' then perform public.refund_bcoin_order(o.id,'wechatpay:'||(body->>'refund_id'));
      else perform public.refresh_user_credit_snapshot(o.user_id); end if;
    else
      update public.wechatpay_refunds set state=case when v_state='ABNORMAL' then 'abnormal' else 'processing' end,
        refund_id=body->>'refund_id',updated_at=now() where id=r.id;
    end if;
    update public.wechatpay_refunds set create_time=coalesce(create_time,(body->>'create_time')::timestamptz),
      success_time=coalesce(success_time,case when v_state='SUCCESS' then (body->>'success_time')::timestamptz end) where id=r.id;
  exception when others then failure:=SQLERRM;
  end;
  update public.wechatpay_events set status=case when failure is null then 'applied' else 'failed' end,error=failure,attempts=attempts+1,
    reconcile_after=now()+interval '1 minute',updated_at=now() where event_id=p_event_id;
  return jsonb_build_object('accepted',failure is null,'status',case when failure is null then 'applied' else 'failed' end,'error',failure);
end $$;

create function public.claim_wechatpay_reconciliation(p_limit integer default 20) returns jsonb
language plpgsql security definer set search_path='' as $$
declare row record; result jsonb:='{"orders":[],"refunds":[],"events":[]}'::jsonb;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid reconciliation limit'; end if;
  for row in select p.order_id from public.wechatpay_payments p join public.orders o on o.id=p.order_id
    where o.status='pending' and p.reconcile_after<=now() order by p.reconcile_after,p.order_id limit p_limit for update of p skip locked loop
    update public.wechatpay_payments set reconcile_after=now()+interval '1 minute' where order_id=row.order_id;
    result:=jsonb_set(result,'{orders}',result->'orders'||jsonb_build_array(public.wechatpay_order_json(row.order_id)));
  end loop;
  for row in select * from public.wechatpay_refunds where state in ('reserved','processing','abnormal') and reconcile_after<=now()
    order by reconcile_after,id limit p_limit for update skip locked loop
    update public.wechatpay_refunds set reconcile_after=now()+interval '1 minute' where id=row.id;
    result:=jsonb_set(result,'{refunds}',result->'refunds'||jsonb_build_array(public.wechatpay_order_json(row.order_id)||jsonb_build_object('refund',to_jsonb(row))));
  end loop;
  for row in select * from public.wechatpay_events where status<>'applied' and reconcile_after<=now()
    order by reconcile_after,event_id limit p_limit for update skip locked loop
    update public.wechatpay_events set reconcile_after=now()+interval '1 minute' where event_id=row.event_id;
    result:=jsonb_set(result,'{events}',result->'events'||jsonb_build_array(to_jsonb(row)));
  end loop;
  return result;
end $$;

-- Financial records remain service-only, including triggers and helper RPCs.
do $$ declare name text; signature regprocedure; begin
  foreach name in array array['wechatpay_payments','wechatpay_refunds','wechatpay_refund_lots','wechatpay_refund_grants','wechatpay_events','wechatpay_bill_audits'] loop
    execute format('alter table public.%I enable row level security',name);
    execute format('alter table public.%I force row level security',name);
    execute format('revoke all on public.%I from public,anon,authenticated',name);
    execute format('grant all on public.%I to service_role',name);
  end loop;
  for signature in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
    ('wechatpay_order_json','create_wechatpay_order','update_wechatpay_checkout','claim_wechatpay_order','release_wechatpay_reconciliation','guard_wechatpay_subscription_refund','apply_wechatpay_transaction','prepare_wechatpay_refund','apply_wechatpay_refund','claim_wechatpay_reconciliation') loop
    execute format('revoke all on function %s from public,anon,authenticated',signature);
    execute format('grant execute on function %s to service_role',signature);
  end loop;
end $$;
