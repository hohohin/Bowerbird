// Offline PostgreSQL gift/financial regression. No live database, payment, or model calls.
// Usage: node apps/cloud/scripts/bcoin-gifts-db.test.mjs <pglite/dist/index.js> [--baseline]
// --baseline intentionally fails against the pre-0078 registration behavior.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const { PGlite } = await import(pathToFileURL(path.resolve(process.argv[2])).href);
const db = new PGlite();
const dir = 'apps/cloud/supabase/migrations';
const baseline = process.argv.includes('--baseline');
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const one = async (sql, args = []) => (await q(sql, args))[0];
const migration = prefix => {
  const file = fs.readdirSync(dir).find(name => name.startsWith(prefix));
  assert.ok(file, `missing migration ${prefix}`);
  return fs.readFileSync(path.join(dir, file), 'utf8')
    .replace('create extension if not exists pgcrypto with schema extensions;', '');
};
const user = async () => {
  const id = randomUUID();
  await q('insert into auth.users(id) values ($1)', [id]);
  return id;
};
const order = async (userId, product = 'pro_monthly') => (await one(`
  insert into orders(user_id,provider,provider_order_id,product,amount_minor,currency,status,product_snapshot)
  select $1,'mock',$2,product,amount_minor,'CNY','pending',to_jsonb(p)
  from billing_products p where product=$3 returning id`, [userId, randomUUID(), product])).id;
const pay = id => q('select apply_bcoin_order($1,$2)', [id, `paid:${id}`]);
const refund = id => q('select refund_bcoin_order($1,$2)', [id, `refund:${id}`]);
const ensure = userId => one('select * from ensure_daily_credits($1)', [userId]);
const grants = id => q('select * from subscription_credit_grants where order_id=$1 order by month_index', [id]);
const wallet = userId => one('select daily_balance,sub_balance,topup_balance from user_credits where user_id=$1', [userId]);
const lots = userId => q('select id,bucket,source_key,original_amount,remaining_amount,expires_at::text from credit_lots where user_id=$1 order by id', [userId]);
const voucher = async () => {
  const hash = createHash('sha256').update(randomUUID()).digest('hex');
  const row = await one("insert into pro_redemption_codes(code_hash,expires_at) values($1,now()+interval '1 year') returning id", [hash]);
  return { ...row, hash };
};
const redeem = async (userId, code) => (await one('select redeem_pro_code($1,$2) result', [userId, code.hash])).result;
let passed = 0;
const check = label => console.log(`ok ${++passed} - ${label}`);

try {
  await db.exec(`create role anon; create role authenticated; create role service_role; create role supabase_auth_admin;
    create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create schema auth; create schema extensions;
    create table auth.users(id uuid primary key,email text,raw_app_meta_data jsonb not null default '{}'::jsonb,
      raw_user_meta_data jsonb not null default '{}'::jsonb,created_at timestamptz default now(),
      updated_at timestamptz default now(),last_sign_in_at timestamptz,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
    create function extensions.gen_random_uuid() returns uuid language sql as $$ select gen_random_uuid() $$;`);
  for (const prefix of ['0001','0002','0003','0004','0005','0006','0009','0010','0011','0015','0016','0017','0018','0019','0023','0058','0059','0060','0061','0062','0063','0064','0065','0066','0067']) {
    await db.exec(migration(prefix));
  }
  const legacyVoucher = await voucher(); // 0070 preserves this voucher's original 1100 promise.
  const legacyExportVoucher = await voucher();
  for (const prefix of ['0069','0070','0071','0072','0073','0074','0075','0076']) await db.exec(migration(prefix));
  const preservedDefinitions = async () => q(`select oid::regprocedure::text signature,pg_get_functiondef(oid) definition
    from pg_proc where oid in ('public.advance_classification(uuid,uuid,text,text,text,jsonb,boolean)'::regprocedure,
      'public.admin_list_users(uuid,text,text,integer)'::regprocedure) order by 1`);
  const beforeDefinitions = await preservedDefinitions();
  const initializationPermissions = async () => one(`select proowner::regrole::text owner,proacl::text acl,prosecdef,proconfig
    from pg_proc where oid='public.initialize_bowerbird_user()'::regprocedure`);
  const beforeInitialization = await initializationPermissions();
  const authTriggers = async () => q("select oid,tgname,tgenabled,pg_get_triggerdef(oid) definition from pg_trigger where tgrelid='auth.users'::regclass and not tgisinternal order by oid");
  const beforeAuthTriggers = await authTriggers();
  const oldFree = await user();
  const oldPro = await user();
  const oldPaid = await order(oldPro);
  await pay(oldPaid);
  const oldPendingUser = await user();
  const oldPending = await order(oldPendingUser);
  const oldZeroVoucher = await voucher();
  const zeroExportVoucher = await voucher();
  const oldRedeemedUser = await user();
  const oldRedeemedVoucher = await voucher();
  const oldReceipt = await redeem(oldRedeemedUser, oldRedeemedVoucher);
  const oldReceiptRow = await one('select code_id,user_id,redeemed_at::text,period_end::text,credits,credits_expires_at::text from pro_code_redemptions where code_id=$1', [oldRedeemedVoucher.id]);
  const oldWallets = await q('select user_id,daily_balance,sub_balance,topup_balance from user_credits order by user_id');
  const oldLots = await q('select id,remaining_amount,expires_at::text from credit_lots order by id');

  if (!baseline) {
    const sql = migration('0078');
    const interrupted = sql.replace('create table public.subscription_credit_grants', () =>
      "do $$ begin raise exception 'test migration interruption'; end $$;\ncreate table public.subscription_credit_grants");
    await assert.rejects(() => db.exec(`begin;\n${interrupted}\ncommit;`), /test migration interruption/);
    await db.exec('rollback');
    assert.equal((await one("select to_regclass('public.subscription_credit_grants') table_name")).table_name, null);
    assert.equal((await one("select count(*)::int n from information_schema.columns where table_schema='public' and table_name='billing_products' and column_name='monthly_bonus_credits'")).n, 0);
    assert.deepEqual(await q('select user_id,daily_balance,sub_balance,topup_balance from user_credits order by user_id'), oldWallets);
    await db.exec(`begin;\n${sql}\ncommit;`);
    assert.deepEqual(await preservedDefinitions(), beforeDefinitions);
    assert.deepEqual(await initializationPermissions(), beforeInitialization);
    assert.deepEqual(await authTriggers(), beforeAuthTriggers);
    check('interrupted migration rolls back; 0075/0076 definitions and auth trigger permissions stay intact');
  }

  const fresh = await user();
  assert.deepEqual(await wallet(fresh), { daily_balance: 0, sub_balance: 200, topup_balance: 0 }, 'new registration must receive exactly 200 Bcoin');
  assert.equal((await lots(fresh)).length, 1);
  const signup = await one(`select l.*,t.meta,
    abs(extract(epoch from (l.expires_at-l.created_at))-2592000)<5 correct_expiry
    from credit_lots l join credit_transactions t on t.lot_id=l.id where l.user_id=$1`, [fresh]);
  assert.equal(signup.source_key, 'registration:v1');
  assert.equal(signup.bucket, 'sub');
  assert.equal(signup.meta.source, 'signup');
  assert.equal(signup.correct_expiry, true);
  await ensure(fresh); await ensure(fresh);
  await q('select grant_daily_credits($1,current_date,30)', [fresh]);
  assert.equal((await lots(fresh)).length, 1);
  assert.equal((await wallet(fresh)).sub_balance, 200);
  check('new registration grants 200 once in sub, expires after 30 days, no daily gifts');

  assert.deepEqual(await q('select id,remaining_amount,expires_at::text from credit_lots where user_id<>$1 order by id', [fresh]), oldLots);
  for (const id of [oldFree, oldPro, oldRedeemedUser]) {
    await ensure(id);
    assert.equal((await wallet(id)).sub_balance, 0);
  }
  await pay(oldPending);
  assert.equal((await grants(oldPending)).length, 0);
  assert.equal((await wallet(oldPendingUser)).sub_balance, 0);
  assert.equal((await grants(oldPaid)).length, 0);
  const replay = await redeem(oldRedeemedUser, oldRedeemedVoucher);
  assert.equal(replay.credits, oldReceipt.credits);
  assert.equal(replay.period_end, oldReceipt.period_end);
  assert.equal(replay.credits_expires_at, oldReceipt.credits_expires_at);
  assert.equal(replay.already_redeemed, true);
  assert.deepEqual(await one('select code_id,user_id,redeemed_at::text,period_end::text,credits,credits_expires_at::text from pro_code_redemptions where code_id=$1', [oldRedeemedVoucher.id]), oldReceiptRow);
  check('old accounts, paid orders, pending old snapshots and redeemed receipts receive no retroactive gift');

  await q('select start_pro_feature_trial($1)', [fresh]);
  await q('select start_pro_feature_trial($1)', [fresh]);
  await ensure(fresh);
  assert.equal((await wallet(fresh)).sub_balance, 200);
  assert.equal((await one('select count(*)::int n from subscription_credit_grants where user_id=$1', [fresh])).n, 0);
  check('free seven-day Pro trial grants no extra Bcoin');

  const monthlyUser = await user();
  const monthly = await order(monthlyUser);
  assert.equal((await one('select product_snapshot from orders where id=$1', [monthly])).product_snapshot.monthly_bonus_credits, 800);
  await q("update billing_products set monthly_bonus_credits=0 where product='pro_monthly'");
  await pay(monthly); await pay(monthly);
  await q("update billing_products set monthly_bonus_credits=800 where product='pro_monthly'");
  assert.equal((await wallet(monthlyUser)).sub_balance, 1000);
  const monthlyGrants = await grants(monthly);
  assert.equal(monthlyGrants.length, 1);
  assert.ok(monthlyGrants[0].lot_id);
  assert.equal((await one('select count(*)::int n from credit_transactions where lot_id=$1 and kind=\'grant\'', [monthlyGrants[0].lot_id])).n, 1);
  assert.equal((await one("select l.expires_at=g.issued_at+interval '30 days' correct_expiry from credit_lots l join subscription_credit_grants g on g.lot_id=l.id where l.id=$1", [monthlyGrants[0].lot_id])).correct_expiry, true);
  assert.equal((await one('select source_key from credit_lots where id=$1', [monthlyGrants[0].lot_id])).source_key, `sub:subscription-month:order:${monthly}:0`);
  check('monthly purchase freezes gift in order snapshot and pays exactly one 800 grant');

  const renewal = await order(monthlyUser);
  const priorEnd = (await one('select current_period_end from subscriptions where user_id=$1', [monthlyUser])).current_period_end;
  await pay(renewal);
  assert.equal((await grants(renewal))[0].due_at.getTime(), priorEnd.getTime());
  assert.equal((await grants(renewal))[0].issued_at, null);
  await ensure(monthlyUser);
  assert.equal((await wallet(monthlyUser)).sub_balance, 1000);
  await assert.rejects(() => refund(monthly), /later entitlement/);
  await refund(renewal); await refund(renewal);
  assert.ok((await grants(renewal))[0].cancelled_at);
  await q("update subscription_credit_grants set due_at=now()-interval '1 day' where order_id=$1", [renewal]);
  await ensure(monthlyUser);
  assert.equal((await grants(renewal))[0].issued_at, null);
  assert.equal((await wallet(monthlyUser)).sub_balance, 1000);
  check('renewal starts at prior entitlement end; refunded future gift stays canceled');

  const annualUser = await user();
  const annual = await order(annualUser, 'pro_yearly');
  await pay(annual);
  assert.equal((await grants(annual)).length, 12);
  assert.equal((await grants(annual)).filter(g => g.issued_at).length, 1);
  assert.equal((await wallet(annualUser)).sub_balance, 1000);
  assert.equal((await ensure(annualUser)).granted, false);
  await q("update subscription_credit_grants set due_at=now()-interval '45 days' where order_id=$1 and month_index in (1,2)", [annual]);
  assert.equal((await ensure(annualUser)).granted, true);
  assert.equal((await ensure(annualUser)).granted, false);
  assert.equal((await wallet(annualUser)).sub_balance, 2600);
  assert.equal((await grants(annual)).filter(g => g.issued_at).length, 3);
  assert.equal((await one(`select count(*)::int n from subscription_credit_grants g join credit_lots l on l.id=g.lot_id
    where g.order_id=$1 and g.month_index in(1,2) and l.expires_at=g.issued_at+interval '30 days'
      and l.expires_at>clock_timestamp()+interval '29 days'`, [annual])).n, 2);
  check('annual plan has 12 installments; overdue installments issue once with a fresh 30-day expiry');

  const anchorUser = await user();
  await q("update subscriptions set tier='pro',current_period_start=now(),current_period_end='2090-01-31 10:20:00+08',period='monthly' where user_id=$1", [anchorUser]);
  const anchored = await order(anchorUser, 'pro_yearly');
  await pay(anchored);
  const anchors = await q("select to_char(due_at at time zone 'Asia/Shanghai','YYYY-MM-DD HH24:MI') due from subscription_credit_grants where order_id=$1 order by month_index", [anchored]);
  assert.deepEqual(anchors.map(g => g.due), ['2090-01-31 10:20','2090-02-28 10:20','2090-03-31 10:20','2090-04-30 10:20','2090-05-31 10:20','2090-06-30 10:20','2090-07-31 10:20','2090-08-31 10:20','2090-09-30 10:20','2090-10-31 10:20','2090-11-30 10:20','2090-12-31 10:20']);
  assert.equal((await grants(anchored)).filter(g => g.issued_at).length, 0);
  check('annual renewal uses original Shanghai month-end anchor without cumulative drift or early gifts');

  const codeUser = await user();
  const redeemedZero = await redeem(codeUser, oldZeroVoucher);
  assert.equal(redeemedZero.credits, 800);
  assert.equal(redeemedZero.scheduled_credits, 0);
  const newVoucher = await voucher();
  assert.equal((await one('select bonus_credits from pro_redemption_codes where id=$1', [newVoucher.id])).bonus_credits, 800);
  const codeEnd = (await one('select current_period_end from subscriptions where user_id=$1', [codeUser])).current_period_end;
  const redeemedNew = await redeem(codeUser, newVoucher);
  assert.equal(redeemedNew.credits, 0);
  assert.equal(redeemedNew.scheduled_credits, 800);
  assert.equal(new Date(redeemedNew.credits_scheduled_at).getTime(), codeEnd.getTime());
  assert.equal((await wallet(codeUser)).sub_balance, 1000);
  await q("update subscription_credit_grants set due_at=now()-interval '1 second' where redemption_code_id=$1", [newVoucher.id]);
  await ensure(codeUser); await ensure(codeUser);
  assert.equal((await wallet(codeUser)).sub_balance, 1800);
  const codeReplay = await redeem(codeUser, newVoucher);
  assert.deepEqual(codeReplay, { ...redeemedNew, already_redeemed: true });
  assert.equal((await one("select count(*)::int n from credit_lots where source_key=$1", [`sub:subscription-month:redemption:${newVoucher.id}:0`])).n, 1);
  check('previous zero-bonus and new vouchers grant 800; renewal receipt remains stable after scheduled issuance');

  const legacyUser = await user();
  const legacyResult = await redeem(legacyUser, legacyVoucher);
  assert.equal(legacyResult.credits, 1100);
  assert.equal(legacyResult.scheduled_credits, 0);
  await redeem(legacyUser, legacyVoucher); await ensure(legacyUser);
  assert.equal((await wallet(legacyUser)).sub_balance, 1300);
  assert.equal((await one('select count(*)::int n from subscription_credit_grants where redemption_code_id=$1', [legacyVoucher.id])).n, 0);
  check('legacy 1100 voucher honors its original gift once without an additional 800');

  const detached = await user();
  const detachedOrder = await order(detached, 'pro_yearly');
  await pay(detachedOrder);
  await q("update subscription_credit_grants set due_at=now()-interval '1 day' where order_id=$1 and month_index=1", [detachedOrder]);
  await q('update billing_accounts set auth_user_id=null,detached_at=now() where id=$1', [detached]);
  assert.equal((await one('select issue_due_subscription_credit_grants($1) n', [detached])).n, 0);
  await q("update subscription_credit_grants set due_at=now()-interval '1 day' where order_id=$1 and month_index in (3,4)", [annual]);
  assert.equal((await one('select issue_due_subscription_credit_grants_batch(1) n')).n, 2);
  assert.equal((await one('select issue_due_subscription_credit_grants_batch(100) n')).n, 0);
  assert.equal((await grants(detachedOrder))[1].issued_at, null);
  await assert.rejects(() => q('select issue_due_subscription_credit_grants_batch(0)'), /invalid grant batch limit/);
  await assert.rejects(() => q('select issue_due_subscription_credit_grants_batch(1001)'), /invalid grant batch limit/);
  check('bounded batch issues all due installments for eligible users once and skips detached accounts');

  const refundUser = await user();
  const topup = await order(refundUser, 'bcoin_100');
  await pay(topup);
  const refundable = await order(refundUser, 'pro_yearly');
  await pay(refundable);
  const unrelatedBefore = (await lots(refundUser)).filter(l => !l.source_key.includes(refundable));
  await refund(refundable); await refund(refundable);
  assert.deepEqual((await lots(refundUser)).filter(l => !l.source_key.includes(refundable)), unrelatedBefore);
  assert.deepEqual(await wallet(refundUser), { daily_balance: 0, sub_balance: 200, topup_balance: 100 });
  assert.equal((await grants(refundable)).filter(g => g.cancelled_at).length, 12);
  assert.equal((await one('select remaining_amount from credit_lots where id=$1', [(await grants(refundable))[0].lot_id])).remaining_amount, 0);
  await q("update subscription_credit_grants set due_at=now()-interval '1 day' where order_id=$1", [refundable]);
  await ensure(refundUser);
  assert.equal((await grants(refundable)).filter(g => g.issued_at).length, 1);
  assert.equal((await one('select tier from subscriptions where user_id=$1', [refundUser])).tier, 'free');
  check('full refund reverses only its intact gift, cancels future installments and preserves signup/topup');

  const heldUser = await user();
  const heldOrder = await order(heldUser, 'pro_yearly');
  await pay(heldOrder);
  await q("update subscription_credit_grants set due_at=now()-interval '1 second' where order_id=$1 and month_index=1", [heldOrder]);
  await ensure(heldUser);
  // A later gift fails after the refund loop has touched an earlier intact lot.
  await q("update credit_lots set expires_at=now()+interval '1 day' where id=$1", [(await grants(heldOrder))[1].lot_id]);
  const hold = await one("select * from credit_hold($1,'gift-refund-hold','classification',1)", [heldUser]);
  assert.equal((await one('select lot_id from credit_hold_allocations where hold_id=$1', [hold.hold_id])).lot_id, (await grants(heldOrder))[1].lot_id);
  const heldLots = await lots(heldUser);
  await assert.rejects(() => refund(heldOrder), /gift spent or held/);
  assert.deepEqual(await lots(heldUser), heldLots);
  assert.equal((await grants(heldOrder)).filter(g => g.cancelled_at).length, 0);
  assert.equal((await one('select status from orders where id=$1', [heldOrder])).status, 'paid');
  assert.equal((await one("select count(*)::int n from credit_transactions where user_id=$1 and kind='refund'", [heldUser])).n, 0);
  await q("select credit_rollback($1,'test')", [hold.hold_id]);
  const spent = await one("select * from credit_hold($1,'gift-refund-spent','classification',1)", [heldUser]);
  await q('select credit_confirm($1,1)', [spent.hold_id]);
  await assert.rejects(() => refund(heldOrder), /gift spent or held/);
  assert.equal((await one("select remaining_amount from credit_lots where user_id=$1 and source_key='registration:v1'", [heldUser])).remaining_amount, 200);
  assert.equal((await grants(heldOrder)).filter(g => g.cancelled_at).length, 0);
  check('held or consumed subscription gifts reject automatic refunds without draining unrelated balance');

  const rollbackUser = await user();
  const rollbackOrder = await order(rollbackUser, 'pro_yearly');
  const rollbackVoucher = await voucher();
  await db.exec(`create function reject_test_gift() returns trigger language plpgsql as $$ begin
    if new.original_amount in(200,800) then raise exception 'injected gift failure'; end if; return new; end $$;
    create trigger reject_test_gift before insert on credit_lots for each row execute function reject_test_gift();`);
  const failedSignup = randomUUID();
  await assert.rejects(() => q('insert into auth.users(id) values($1)', [failedSignup]), /injected gift failure/);
  assert.equal((await one('select count(*)::int n from auth.users where id=$1', [failedSignup])).n, 0);
  assert.equal((await one('select count(*)::int n from billing_accounts where id=$1', [failedSignup])).n, 0);
  await assert.rejects(() => pay(rollbackOrder), /injected gift failure/);
  assert.equal((await one('select status from orders where id=$1', [rollbackOrder])).status, 'pending');
  assert.equal((await one('select tier from subscriptions where user_id=$1', [rollbackUser])).tier, 'free');
  assert.equal((await grants(rollbackOrder)).length, 0);
  assert.equal((await lots(rollbackUser)).length, 1);
  await assert.rejects(() => redeem(rollbackUser, rollbackVoucher), /injected gift failure/);
  assert.equal((await one('select count(*)::int n from pro_code_redemptions where code_id=$1', [rollbackVoucher.id])).n, 0);
  assert.equal((await one('select tier from subscriptions where user_id=$1', [rollbackUser])).tier, 'free');
  await q("update subscription_credit_grants set due_at=now()-interval '1 day' where order_id=$1 and month_index=5", [annual]);
  await assert.rejects(() => ensure(annualUser), /injected gift failure/);
  assert.equal((await grants(annual))[5].issued_at, null);
  await db.exec('drop trigger reject_test_gift on credit_lots; drop function reject_test_gift()');
  await pay(rollbackOrder);
  assert.equal((await wallet(rollbackUser)).sub_balance, 1000);
  await ensure(annualUser); await ensure(annualUser);
  assert.ok((await grants(annual))[5].issued_at);
  check('issuance failures roll back signup, payment, entitlement, redemption receipt and installment; safe retry succeeds');

  const admin = await user();
  await q("update auth.users set raw_app_meta_data=jsonb_build_object('bowerbird_admin',true) where id=$1", [admin]);
  const newExportVoucher = await voucher();
  for (const [code, expected] of [[newExportVoucher, 800], [zeroExportVoucher, 800], [legacyExportVoucher, 1100]]) {
    await q("update pro_redemption_codes set code_ciphertext=repeat('offline-fixture-',5) where id=$1", [code.id]);
    const exported = (await one('select admin_read_pro_codes($1,null,$2) result', [admin, code.id])).result;
    assert.equal(exported.length, 1);
    assert.equal(exported[0].id, code.id);
    assert.equal(exported[0].bonus_credits, expected);
    await assert.rejects(() => q('select admin_read_pro_codes($1,null,$2)', [fresh, code.id]), /admin required/);
  }
  assert.equal((await one('select count(*)::int n from pro_code_admin_events where actor_id=$1', [admin])).n, 3);
  assert.equal((await one('select count(*)::int n from pro_code_admin_events where actor_id=$1', [fresh])).n, 0);
  check('admin export reports new/legacy zero vouchers as 800, preserves 1100 and rejects non-admin actors');

  for (const role of ['anon', 'authenticated']) {
    for (const fn of ['issue_due_subscription_credit_grants(uuid)','issue_due_subscription_credit_grants_batch(integer)','ensure_daily_credits(uuid,integer)','admin_read_pro_codes(uuid,uuid,uuid)']) {
      assert.equal((await one('select has_function_privilege($1,$2,\'execute\') allowed', [role, fn])).allowed, false);
    }
    assert.equal((await one("select has_table_privilege($1,'subscription_credit_grants','select,insert,update,delete') allowed", [role])).allowed, false);
  }
  for (const fn of ['issue_due_subscription_credit_grants(uuid)','issue_due_subscription_credit_grants_batch(integer)']) {
    assert.equal((await one('select has_function_privilege(\'service_role\',$1,\'execute\') allowed', [fn])).allowed, true);
  }
  assert.equal((await one("select has_function_privilege('supabase_auth_admin','initialize_bowerbird_user()','execute') allowed")).allowed, true);
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await one("select has_function_privilege($1,'initialize_bowerbird_user()','execute') allowed", [role])).allowed, false);
  }
  assert.deepEqual(await one("select relrowsecurity,relforcerowsecurity from pg_class where oid='subscription_credit_grants'::regclass"), { relrowsecurity: true, relforcerowsecurity: true });
  check('gift schedule and issuance RPCs remain service-only with forced RLS');
  console.log(`PASS ${passed} offline Bcoin gift regression groups`);
} finally {
  await db.close();
}
