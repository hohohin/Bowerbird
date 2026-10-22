// Isolated PGlite only. Pass the local @electric-sql/pglite/dist/index.js path.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
if (!process.argv[2]) throw new Error('Pass the path to @electric-sql/pglite/dist/index.js');
const { PGlite } = await import(pathToFileURL(path.resolve(process.argv[2])).href);
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role; create role supabase_auth_admin;
create schema auth; create schema extensions; create schema storage;
create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
create function extensions.gen_random_uuid() returns uuid language sql as $$ select gen_random_uuid() $$;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
for (const prefix of ['0001','0002','0003','0004','0009','0015','0018','0023','0058','0061','0068']) {
  const file = fs.readdirSync('apps/cloud/supabase/migrations').find(f => f.startsWith(prefix));
  await db.exec(fs.readFileSync('apps/cloud/supabase/migrations/' + file, 'utf8')
    .replace('create extension if not exists pgcrypto with schema extensions;', '-- PGlite uses core gen_random_uuid.'));
}
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const user = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
await q('insert into auth.users values($1)', [user]);
await q(`insert into credit_lots(user_id,bucket,source_key,original_amount,remaining_amount,expires_at)
  values($1,'topup','isolated-gpt-test',10000,10000,now()+interval '1 year')`, [user]);
const services = ['image_gpt25_sunburst','image_gpt25_flare'];
for (const [index, service] of services.entries()) {
  const [row] = await q('select * from service_costs where service=$1', [service]);
  assert.equal(row.active, false); assert.equal(row.unit_cost, 0); assert.equal(row.parameters.pricing_ready, false);
  await assert.rejects(() => q('select * from credit_hold($1,$2,$3)', [user, 'inactive-' + service, service]));
  await assert.rejects(() => q('update service_costs set active=true where service=$1', [service]));
  await assert.rejects(() => q('update service_costs set active=true,unit_cost=17 where service=$1', [service]));
  await assert.rejects(() => q(`update service_costs set active=true,parameters=parameters||'{"pricing_ready":true}' where service=$1`, [service]));
  // Synthetic prices only, not product pricing decisions.
  await q(`update service_costs set unit_cost=$2,active=true,parameters=parameters||'{"pricing_ready":true}' where service=$1`, [service, 17 + index]);
}
const menu = await q(`select service,parameters->>'label' as label from service_costs
  where active and service like 'image_gpt%' order by (parameters->>'sort')::int`);
assert.deepEqual(menu.map(r => r.service), services);
assert.ok(menu.every(r => r.label.includes('GPT Image 2.5')));
async function create(service, key) {
  const [hold] = await q('select * from credit_hold($1,$2,$3)', [user, key, service]);
  assert.equal((await q('select * from credit_hold($1,$2,$3)', [user, key, service]))[0].hold_id, hold.hold_id);
  await q(`insert into generation_jobs(id,user_id,idempotency_key,service,request_object_key,input_manifest_hash,input_count,hold_id,estimated_credits,pricing_version,content_expires_at)
    values($1,$2,$3,$4,$5,$6,0,$1,$7,1,now()+interval '1 day')`,
    [hold.hold_id, user, key, service, `jobs/${hold.hold_id}/inputs/request.json`, 'a'.repeat(64), hold.estimated_amount]);
  await q('select enqueue_generation_job($1,$2)', [hold.hold_id, user]);
  const [job] = await q(`select * from claim_generation_job('gpt-offline',90)`);
  assert.equal(job.id, hold.hold_id);
  await q('select mark_generation_job_submitted($1,$2)', [job.id, job.lease_id]);
  return job;
}
for (const service of services) {
  const job = await create(service, 'success-' + service);
  const finish = () => q(`select * from complete_generation_job($1,$2,'succeeded',$3,'image/png',68,$4)`,
    [job.id, job.lease_id, `jobs/${job.id}/outputs/result.png`, 'b'.repeat(64)]);
  const [done] = await finish(); assert.equal(done.actual_credits, job.estimated_credits);
  const before = await q('select count(*)::int as n from credit_transactions');
  await finish(); assert.deepEqual(await q('select count(*)::int as n from credit_transactions'), before);
  const rejected = await create(service, 'rejected-' + service);
  await q(`select complete_generation_job($1,$2,'failed',null,null,null,null,'content_moderation','safe')`, [rejected.id, rejected.lease_id]);
  assert.equal((await q('select status from credit_holds where id=$1', [rejected.id]))[0].status, 'rolled_back');
  const unknown = await create(service, 'unknown-' + service);
  await q(`select complete_generation_job($1,$2,'outcome_unknown',null,null,null,null,'openai_outcome_unknown','safe')`, [unknown.id, unknown.lease_id]);
  assert.equal((await q('select status from credit_holds where id=$1', [unknown.id]))[0].status, 'pending_settlement');
  const [next] = await q(`select * from claim_generation_job('restart',90)`);
  assert.ok(!next?.id, 'unknown image must not be resubmitted');
}
console.log('PASS: both GPT tiers, inactive defaults, price gates, menu metadata, hold replay, single settlement, rejection refund and unknown-result preservation');
await db.close();
