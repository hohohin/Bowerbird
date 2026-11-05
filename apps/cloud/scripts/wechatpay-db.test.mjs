// Isolated PostgreSQL financial tests. No provider calls, real users, or live database.
// node apps/cloud/scripts/wechatpay-db.test.mjs <pglite/dist/index.js> [--baseline]
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const db = new PGlite();
const q = async (sql,args=[]) => (await db.query(sql,args)).rows;
const one = async (sql,args=[]) => (await q(sql,args))[0];
const rpc = async (name,args) => (await one(`select ${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) result`,args)).result;
const migration = prefix => readFileSync(`apps/cloud/supabase/migrations/${readdirSync('apps/cloud/supabase/migrations').find(n=>n.startsWith(prefix))}`,'utf8').replace('create extension if not exists pgcrypto with schema extensions;','');
const mchid='1900000109', appid='wx1234567890abcdef';
const user = async (admin=false) => { const id=randomUUID(); await q('insert into auth.users(id,raw_app_meta_data) values($1,$2)',[id,admin?{bowerbird_admin:true}:{}]); return id; };
const create = (id,product='bcoin_100',custom=null,key=randomUUID()) => rpc('create_wechatpay_order',[id,key,product,custom,mchid,appid]);
const wallet = id => one('select sub_balance,topup_balance from user_credits where user_id=$1',[id]);
const transaction = (bundle,state='SUCCESS',id=randomUUID().replaceAll('-','')) => ({mchid,appid,out_trade_no:bundle.payment.out_trade_no,transaction_id:id,trade_state:state,amount:{total:bundle.order.amount_minor,currency:'CNY'},success_time:state==='SUCCESS'?'2026-11-04T12:00:00+08:00':undefined});
const apply = (value,event=randomUUID()) => rpc('apply_wechatpay_transaction',[event,value]);
const refund = (admin,bundle,key=randomUUID()) => rpc('prepare_wechatpay_refund',[admin,bundle.order.id,key]);
const refundPayload = (bundle,state='SUCCESS',id=randomUUID().replaceAll('-','')) => ({out_refund_no:bundle.refund.out_refund_no,refund_id:id,out_trade_no:bundle.payment.out_trade_no,transaction_id:bundle.payment.transaction_id,status:state,amount:{total:bundle.order.amount_minor,refund:bundle.order.amount_minor,currency:'CNY'},success_time:state==='SUCCESS'?'2026-11-04T12:01:00+08:00':undefined});
const applyRefund = (value,event=randomUUID()) => rpc('apply_wechatpay_refund',[event,value,mchid]);
let passed=0;
const check = message => console.log(`ok ${++passed} - ${message}`);
try {
  await db.exec(`create role anon; create role authenticated; create role service_role; create role supabase_auth_admin;
    create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create schema auth; create schema extensions;
    create table auth.users(id uuid primary key,email text,raw_app_meta_data jsonb not null default '{}'::jsonb,
      raw_user_meta_data jsonb not null default '{}'::jsonb,created_at timestamptz default now(),
      updated_at timestamptz default now(),last_sign_in_at timestamptz,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
    create function extensions.gen_random_uuid() returns uuid language sql as $$ select gen_random_uuid() $$;`);
  for(const prefix of ['0001','0002','0003','0004','0005','0006','0009','0010','0011','0015','0016','0017','0018','0019','0023','0058','0059','0060','0061','0062','0063','0064','0065','0066','0067','0069','0070','0071','0072','0073','0074','0075','0076','0078']) await db.exec(migration(prefix));
  const old=await user(), before=await wallet(old);
  const originalFunctions=await q("select proname,pg_get_functiondef(oid) definition from pg_proc where proname in ('credit_hold','credit_hold_bcoin_image','credit_hold_bcoin_video','credit_confirm','credit_rollback','apply_bcoin_order','refund_bcoin_order') order by proname");
  if(!process.argv.includes('--baseline')) await db.exec(`begin;${migration('0080')}commit;`);
  const admin=await user(true), a=await user();
  const key=randomUUID(), topup=await create(a,'bcoin_100',null,key);
  assert.equal(topup.order.amount_minor,500);
  assert.equal(topup.payment.out_trade_no,topup.order.id.replaceAll('-',''));
  assert.deepEqual(await create(a,'bcoin_100',null,key),topup);
  const reconfigured=await rpc('create_wechatpay_order',[a,key,'bcoin_100',null,mchid,appid,'https://bowerbird.cn/api/pay/wechat/new-notify']);
  assert.deepEqual(reconfigured.payment.native_request,topup.payment.native_request);
  assert.equal(topup.payment.native_request.notify_url,'https://bowerbird.cn/api/pay/wechat/notify');
  assert.equal(Date.parse(topup.payment.native_request.time_expire),Date.parse(topup.payment.time_expire));
  assert.match(topup.payment.native_request.time_expire,/T\d{2}:\d{2}:\d{2}\+00:00$/);
  await assert.rejects(()=>create(a,'bcoin_200',null,key),/idempotency conflict/);
  assert.deepEqual(await wallet(old),before);
  assert.deepEqual(await q("select proname,pg_get_functiondef(oid) definition from pg_proc where proname in ('credit_hold','credit_hold_bcoin_image','credit_hold_bcoin_video','credit_confirm','credit_rollback','apply_bcoin_order','refund_bcoin_order') order by proname"),originalFunctions);
  check('server quote and same-order recovery; existing financial functions and wallet unchanged');

  assert.equal((await create(a,'bcoin_200')).order.amount_minor,1000);
  assert.equal((await create(a,'bcoin_10000')).order.amount_minor,50000);
  assert.equal((await create(a,'bcoin_custom',1234)).order.product_snapshot.credits,24680);
  for(const value of [0,-1,21474837,1.2]) await assert.rejects(()=>create(a,'bcoin_custom',value));
  assert.equal((await create(a,'bcoin_custom',21474836)).order.amount_minor,2147483600);
  await assert.rejects(()=>create(a,'pro_monthly',39),/custom amount only/);
  await assert.rejects(()=>create(randomUUID()),/account unavailable/);
  const limited=await user(); for(let i=0;i<10;i++) await create(limited);
  await assert.rejects(()=>create(limited),/rate limited/);
  check('10/500 yuan SKUs and custom integer amount including 1234; bounds, account, rate limit');

  const t=transaction(topup), event=randomUUID();
  for(const change of [{mchid:'1900000110'},{appid:'wxaaaaaaaaaaaaaaaa'},{amount:{total:1,currency:'CNY'}},{amount:{total:500,currency:'USD'}},{amount:{total:500.1,currency:'CNY'}}]) {
    const badId=randomUUID(); assert.equal((await apply({...t,...change},badId)).accepted,false);
    assert.equal((await one('select status from wechatpay_events where event_id=$1',[badId])).status,'failed');
  }
  assert.equal((await wallet(a)).topup_balance,0);
  assert.equal((await apply(t,event)).accepted,true);
  assert.equal((await apply(t,event)).accepted,true);
  assert.equal((await apply(t)).accepted,true);
  assert.equal((await wallet(a)).topup_balance,100);
  assert.equal((await apply({...t,transaction_id:'other_transaction'})).accepted,false);
  await assert.rejects(()=>apply({...t,amount:{total:1,currency:'CNY'}},event),/event identity conflict/);
  const duplicate=await create(await user()); assert.equal((await apply(transaction(duplicate,'SUCCESS',t.transaction_id))).accepted,false);
  assert.equal((await one('select expires_at::text e from credit_lots where source_key=$1',['topup:wechatpay:'+topup.payment.out_trade_no])).e,'infinity');
  check('amount/merchant/currency/transaction checks, durable failure inbox, payment idempotency, permanent topup');

  const late=await create(await user()), lateT=transaction(late);
  assert.equal((await apply({...lateT,trade_state:'NOTPAY',amount:undefined})).accepted,true);
  assert.equal((await apply({...lateT,amount:undefined})).accepted,false);
  assert.equal((await apply({...lateT,trade_state:'NOTPAY'})).accepted,true);
  assert.equal((await apply({...lateT,trade_state:'CLOSED'})).accepted,true);
  assert.equal((await apply({...lateT,trade_state:'NOTPAY'})).accepted,true);
  assert.equal((await apply(lateT)).accepted,false);
  assert.equal((await one('select status from orders where id=$1',[late.order.id])).status,'canceled');
  assert.equal((await apply({...t,trade_state:'NOTPAY'})).accepted,true);
  assert.equal((await one('select payment_state from wechatpay_payments where order_id=$1',[topup.order.id])).payment_state,'SUCCESS');
  check('out-of-order unpaid/closed states never regress paid or silently accept contradictory late payment');

  const proUser=await user(), annual=await create(proUser,'pro_yearly');
  assert.equal((await apply(transaction(annual))).accepted,true);
  assert.deepEqual(await wallet(proUser),{sub_balance:1000,topup_balance:0});
  assert.equal((await one('select count(*)::int n from subscription_credit_grants where order_id=$1',[annual.order.id])).n,12);
  assert.equal((await one('select count(*)::int n from subscription_credit_grants where order_id=$1 and issued_at is not null',[annual.order.id])).n,1);
  const renewal=await create(proUser,'pro_monthly'); await apply(transaction(renewal));
  assert.equal((await one('select count(*)::int n from subscription_credit_grants where order_id=$1 and issued_at is not null',[renewal.order.id])).n,0);
  await assert.rejects(()=>refund(admin,annual),/later entitlement/);
  check('existing monthly gift and annual 12 installment semantics; renewal does not issue early');

  await assert.rejects(()=>refund(a,topup),/admin/);
  const reserved=await refund(admin,topup);
  assert.equal(reserved.refund.state,'reserved');
  assert.deepEqual(await wallet(a),{sub_balance:200,topup_balance:0});
  assert.equal((await refund(admin,topup,reserved.refund.request_key)).refund.id,reserved.refund.id);
  const changedRefundConfig=await rpc('prepare_wechatpay_refund',[admin,topup.order.id,reserved.refund.request_key,'https://bowerbird.cn/api/pay/wechat/new-refund-notify']);
  assert.deepEqual(changedRefundConfig.refund.request_payload,reserved.refund.request_payload);
  assert.equal(reserved.refund.request_payload.notify_url,'https://bowerbird.cn/api/pay/wechat/refund-notify');
  assert.equal(reserved.refund.request_payload.out_refund_no,reserved.refund.out_refund_no);
  await assert.rejects(()=>refund(admin,topup),/already exists/);
  const processing=refundPayload(reserved,'PROCESSING');
  processing.create_time='2026-11-04T12:00:30+08:00';
  await applyRefund(processing); assert.equal((await wallet(a)).topup_balance,0);
  const success={...processing,status:'SUCCESS'};
  assert.equal((await applyRefund(success)).accepted,true);
  assert.equal((await applyRefund(success)).accepted,true);
  assert.equal((await applyRefund(processing)).accepted,true);
  assert.equal((await one('select status from orders where id=$1',[topup.order.id])).status,'refunded');
  assert.deepEqual(await wallet(a),{sub_balance:200,topup_balance:0});
  assert.equal((await apply(t)).accepted,true);
  assert.equal((await wallet(a)).topup_balance,0);
  assert.ok((await one('select create_time from wechatpay_refunds where id=$1',[reserved.refund.id])).create_time);
  check('admin-only refund, target-only freeze, unknown/processing retains funds, success/replays single refund');

  const closedUser=await user(), closedOrder=await create(closedUser); await apply(transaction(closedOrder));
  const closedRefund=await refund(admin,closedOrder), closedPayload=refundPayload(closedRefund,'CLOSED');
  assert.equal((await applyRefund({...closedPayload,amount:{...closedPayload.amount,refund:1}})).accepted,false);
  assert.equal((await wallet(closedUser)).topup_balance,0);
  assert.equal((await applyRefund(closedPayload)).accepted,true);
  assert.equal((await wallet(closedUser)).topup_balance,100);
  assert.equal((await applyRefund({...closedPayload,status:'SUCCESS'})).accepted,false);
  check('only verified CLOSED releases frozen funds; partial or contradictory refunds require review');

  const annualUser=await user(), annualOrder=await create(annualUser,'pro_yearly'); await apply(transaction(annualOrder));
  const frozenAnnual=await refund(admin,annualOrder);
  assert.deepEqual(await wallet(annualUser),{sub_balance:200,topup_balance:0});
  assert.equal((await one('select count(*)::int n from subscription_credit_grants where order_id=$1 and cancelled_at is not null',[annualOrder.order.id])).n,12);
  await assert.rejects(()=>q('update subscriptions set entitlement_version=entitlement_version+1 where user_id=$1',[annualUser]),/refund pending/);
  await assert.rejects(()=>create(annualUser,'pro_monthly'),/refund pending/);
  const codeHash=createHash('sha256').update(randomUUID()).digest('hex');
  await q("insert into pro_redemption_codes(code_hash,expires_at) values($1,now()+interval '1 day')",[codeHash]);
  await assert.rejects(()=>rpc('redeem_pro_code',[annualUser,codeHash]),/refund pending/);
  const held=await one("select * from credit_hold($1,$2,'caption')",[annualUser,randomUUID()]);
  await q('select credit_confirm($1,1)',[held.hold_id]);
  assert.equal((await wallet(annualUser)).sub_balance,199);
  assert.equal((await applyRefund(refundPayload(frozenAnnual))).accepted,true);
  assert.equal((await one('select tier from subscriptions where user_id=$1',[annualUser])).tier,'free');
  assert.equal((await wallet(annualUser)).sub_balance,199);
  assert.equal((await rpc('issue_due_subscription_credit_grants',[annualUser])),0);
  check('annual refund freezes own gifts/future grants and Pro mutations; unrelated signup funds still usable');

  const releaseUser=await user(), releaseOrder=await create(releaseUser,'pro_yearly'); await apply(transaction(releaseOrder));
  const releaseRefund=await refund(admin,releaseOrder); await applyRefund(refundPayload(releaseRefund,'CLOSED'));
  assert.equal((await wallet(releaseUser)).sub_balance,1000);
  assert.equal((await one('select count(*)::int n from subscription_credit_grants where order_id=$1 and cancelled_at is null',[releaseOrder.order.id])).n,12);
  assert.equal((await create(releaseUser,'pro_monthly')).order.status,'pending');
  const spentUser=await user(), spentOrder=await create(spentUser); await apply(transaction(spentOrder));
  await q("update credit_lots set remaining_amount=0 where user_id=$1 and bucket='sub'",[spentUser]);
  const spentHold=await one("select * from credit_hold($1,$2,'caption')",[spentUser,randomUUID()]);
  await assert.rejects(()=>refund(admin,spentOrder),/spent or held/);
  assert.equal((await one('select count(*)::int n from wechatpay_refunds where order_id=$1',[spentOrder.order.id])).n,0);
  await q('select credit_rollback($1)',[spentHold.hold_id]);
  assert.equal((await refund(admin,spentOrder)).refund.state,'reserved');
  check('CLOSED restores original gift plan; held funds reject atomically and rollback makes refund possible');

  const interruptedUser=await user(), first=await create(interruptedUser,'pro_monthly'); await apply(transaction(first));
  const second=await create(interruptedUser,'pro_monthly'), frozen=await refund(admin,first);
  const deferredEvent=randomUUID(), deferredTx=transaction(second);
  assert.equal((await apply(deferredTx,deferredEvent)).accepted,false);
  assert.equal((await one('select status from wechatpay_events where event_id=$1',[deferredEvent])).status,'failed');
  assert.equal((await one('select status from orders where id=$1',[second.order.id])).status,'pending');
  await applyRefund(refundPayload(frozen,'CLOSED'));
  assert.equal((await apply(deferredTx,deferredEvent)).accepted,true);
  assert.equal((await one('select count(*)::int n from subscription_credit_grants where order_id=$1',[second.order.id])).n,1);
  assert.equal((await one('select attempts from wechatpay_events where event_id=$1',[deferredEvent])).attempts,2);
  check('verified payment persists through fulfillment failure and replays after refund lock release');

  const notifyUser=await user(), notifyOrder=await create(notifyUser); await apply(transaction(notifyOrder));
  const notifyRefund=await refund(admin,notifyOrder), notifyPayload=refundPayload(notifyRefund);
  delete notifyPayload.status; delete notifyPayload.amount.currency; notifyPayload.refund_status='SUCCESS';
  assert.equal((await applyRefund({...notifyPayload,amount:{...notifyPayload.amount,currency:'USD'}})).accepted,false);
  assert.equal((await applyRefund(notifyPayload)).accepted,true);
  assert.ok((await one('select success_time from wechatpay_refunds where id=$1',[notifyRefund.refund.id])).success_time);
  assert.ok((await one('select success_time from wechatpay_payments where order_id=$1',[notifyOrder.order.id])).success_time);
  assert.equal((await applyRefund({...notifyPayload,out_refund_no:'external_platform_refund'})).accepted,false);
  check('official refund notification without currency, verified success timestamps, external refunds require review');

  const corruptUser=await user(), corruptOrder=await create(corruptUser,'pro_yearly'); await apply(transaction(corruptOrder));
  const corruptRefund=await refund(admin,corruptOrder);
  await q('update credit_lots set remaining_amount=1 where id in (select lot_id from wechatpay_refund_lots where refund_id=$1)',[corruptRefund.refund.id]);
  assert.equal((await applyRefund(refundPayload(corruptRefund))).accepted,false);
  assert.equal((await one('select state from wechatpay_refunds where id=$1',[corruptRefund.refund.id])).state,'reserved');
  await q('update credit_lots set remaining_amount=0 where id in (select lot_id from wechatpay_refund_lots where refund_id=$1)',[corruptRefund.refund.id]);
  await q('update subscription_credit_grants set cancelled_at=null where order_id=$1',[corruptOrder.order.id]);
  assert.equal((await applyRefund(refundPayload(corruptRefund))).accepted,false);
  check('unexpected frozen lot or gift-plan mutation fails atomically without inventing restoration ledger');

  const leaseOrder=await create(await user());
  assert.ok(await rpc('claim_wechatpay_order',[leaseOrder.order.id]));
  assert.equal(await rpc('claim_wechatpay_order',[leaseOrder.order.id]),null);
  const batch=await rpc('claim_wechatpay_reconciliation',[100]);
  assert.equal(batch.orders.some(x=>x.order.id===leaseOrder.order.id),false);
  const next=await rpc('claim_wechatpay_reconciliation',[100]);
  assert.equal(next.orders.length,0); assert.equal(next.refunds.length,0);
  const perms=await one("select has_function_privilege('authenticated','public.create_wechatpay_order(uuid,text,text,integer,text,text,text)','execute') client,has_function_privilege('service_role','public.create_wechatpay_order(uuid,text,text,integer,text,text,text)','execute') server");
  assert.deepEqual(perms,{client:false,server:true});
  assert.equal((await one("select count(*)::int n from pg_class where relname like 'wechatpay_%' and relkind='r' and relrowsecurity and relforcerowsecurity")).n,6);
  check('database leases throttle concurrent upstream work; financial RPCs and all tables service-only');
  console.log(`${passed} isolated WeChat Pay database groups passed (PGlite serial connection; not a live concurrency test).`);
} catch(error) {
  console.error(error.message, error.where || '', error.actual === undefined ? '' : {actual:error.actual,expected:error.expected});
  process.exitCode=1;
} finally { await db.close(); }
