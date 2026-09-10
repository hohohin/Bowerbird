// Run from the repository root. Pass an isolated PGlite module path; no application database is used.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const modulePath = process.argv[2];
if (!modulePath) throw new Error('Pass the path to @electric-sql/pglite/dist/index.js');
const { PGlite } = await import(pathToFileURL(path.resolve(modulePath)).href);
import fs from 'node:fs';
import assert from 'node:assert/strict';
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role; create role supabase_auth_admin; create schema auth; create schema extensions; create schema storage;
create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
create function extensions.gen_random_uuid() returns uuid language sql as $$ select gen_random_uuid() $$;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
for (const prefix of ['0001','0002','0003','0004','0009','0015','0023','0058']) {
 const file=fs.readdirSync('apps/cloud/supabase/migrations').find(f=>f.startsWith(prefix));
 const sql=fs.readFileSync('apps/cloud/supabase/migrations/'+file,'utf8').replace('create extension if not exists pgcrypto with schema extensions;','-- Test adapter: core gen_random_uuid supplies the extension wrapper.');
 try { await db.exec(sql); } catch(e) { console.error('migration',file,e.message);process.exit(1); }
}
const q=async(sql,params=[]) => (await db.query(sql,params)).rows;
const user='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
await q('insert into auth.users values($1)',[user]);
await db.exec(`insert into public.credit_lots(user_id,bucket,source_key,original_amount,remaining_amount,expires_at) values('${user}','topup','isolated-video-test',100000,100000,now()+interval '1 year');`);
assert.equal((await q('select count(*)::int n from video_service_pricing'))[0].n,0);
await db.exec(`insert into service_costs(service,unit_cost,pricing_version,active) values('video_seedance25_480p',1,1,true);
insert into video_service_pricing values('video_seedance25_480p','480p',1,500,800,70,42,true);`);
async function create(key='case-'+Math.random()) {
 const [hold]=await q(`select * from credit_hold_video($1,$2,'video_seedance25_480p',4,false)`,[user,key]);
 const id=hold.hold_id;
 await q(`insert into generation_jobs(id,user_id,idempotency_key,service,request_object_key,input_manifest_hash,input_count,hold_id,estimated_credits,pricing_version,content_expires_at) values($1,$2,$3,'video_seedance25_480p',$4,$5,0,$1,$6,1,now()+interval '1 day')`,[id,user,key,`jobs/${id}/inputs/request.json`,'a'.repeat(64),hold.estimated_amount]);
 return {id,hold,key};
}
async function claim(id) { await q('select enqueue_generation_job($1,$2)',[id,user]); return (await q(`select * from claim_generation_job('offline-test',90)`))[0]; }
async function submit(j,id='ark-test') { await q('select mark_generation_job_submitted($1,$2,$3)',[j.id,j.lease_id,id]); }
const a=await create('idempotency');
assert.equal((await q(`select * from credit_hold_video($1,'idempotency','video_seedance25_480p',4,false)`,[user]))[0].hold_id,a.id);
await assert.rejects(()=>q(`select * from credit_hold_video($1,'idempotency','video_seedance25_480p',30,false)`,[user]));
let j=await claim(a.id); await submit(j);
await assert.rejects(()=>submit(j,'another-task'));
await q(`select cancel_generation_job($1,$2)`,[a.id,user]);
assert.equal((await q('select status from credit_holds where id=$1',[a.id]))[0].status,'pending_settlement');
await q(`update generation_jobs set lease_expires_at=now()-interval '1 second' where id=$1`,[a.id]);
j=(await q(`select * from claim_generation_job('restart',90)`))[0];
assert.equal(j.provider_request_id,'ark-test'); assert.equal(j.status,'cancel_requested');
const [done]=await q(`select * from complete_generation_video_job($1,$2,'succeeded',38430,$3,'video/mp4',100,$4)`,[a.id,j.lease_id,`jobs/${a.id}/outputs/result.mp4`,'a'.repeat(64)]);
assert.equal(done.actual_credits,77); assert.equal(done.provider_usage.completion_tokens,38430);
const before=await q('select count(*)::int n from credit_transactions');
await q(`select complete_generation_video_job($1,$2,'succeeded',38430,$3,'video/mp4',100,$4)`,[a.id,j.lease_id,`jobs/${a.id}/outputs/result.mp4`,'a'.repeat(64)]);
assert.deepEqual(await q('select count(*)::int n from credit_transactions'),before);
const b=await create(); j=await claim(b.id); await submit(j,null);
await q(`update generation_jobs set lease_expires_at=now()-interval '1 second' where id=$1`,[b.id]);
assert.equal((await q(`select * from claim_generation_job('must-not-repost',90)`))[0]?.id,null);
await q('select reconcile_stale_generation_jobs()');
assert.equal((await q('select status from generation_jobs where id=$1',[b.id]))[0].status,'outcome_unknown');
assert.equal((await q('select status from credit_holds where id=$1',[b.id]))[0].status,'pending_settlement');
const c=await create(); j=await claim(c.id); await submit(j,'expensive');
const [over]=await q(`select * from complete_generation_video_job($1,$2,'succeeded',999999,$3,'video/mp4',100,$4)`,[c.id,j.lease_id,`jobs/${c.id}/outputs/result.mp4`,'a'.repeat(64)]);
assert.equal(over.status,'outcome_unknown'); assert.equal(over.provider_usage.completion_tokens,999999); assert.ok(over.output_object_key);
await assert.rejects(()=>q(`select reconcile_video_usage($1,99999,'approved isolated test reconciliation')`,[c.id]));
const [reconciled]=await q(`select * from reconcile_video_usage($1,80,'approved isolated test reconciliation')`,[c.id]);
assert.equal(reconciled.status,'succeeded'); assert.equal(reconciled.actual_credits,80);
assert.ok(new Date(done.content_expires_at).getTime()>Date.now()+23*60*60*1000);
const d=await create(); await claim(d.id); await q('select fail_uploading_generation_job($1,$2)',[d.id,user]);
assert.equal((await q('select status from credit_holds where id=$1',[d.id]))[0].status,'pending_settlement');
const e=await create(); await q('select fail_uploading_generation_job($1,$2)',[e.id,user]);
assert.equal((await q('select status from credit_holds where id=$1',[e.id]))[0].status,'rolled_back');
const f=await create(); await q(`update credit_holds set expires_at=now()-interval '1 second' where id=$1`,[f.id]);
await assert.rejects(()=>q('select enqueue_generation_job($1,$2)',[f.id,user]));
await q(`update generation_jobs set content_expires_at=now()-interval '1 second' where id=$1`,[f.id]);
await q('select expire_video_uploads()');
assert.equal((await q('select status from generation_jobs where id=$1',[f.id]))[0].status,'failed');
await q(`update credit_holds set expires_at=now()-interval '1 second' where id=$1`,[d.id]);
await q('select expire_stale_holds()');
assert.equal((await q('select status from credit_holds where id=$1',[d.id]))[0].status,'pending_settlement');
assert.equal((await q(`select has_function_privilege('authenticated','public.reconcile_video_usage(uuid,integer,text)','EXECUTE') as allowed`))[0].allowed,false);
await assert.rejects(()=>q(`select credit_hold_video($1,'null-duration','video_seedance25_480p',null,false)`,[user]));
console.log('PASS: migration, inactive defaults, isolated pricing, key conflict, immutable task ID, cancellation/restart, actual settlement, duplicate finish, unknown submission, over-reservation evidence, atomic upload failure');
await db.close();
