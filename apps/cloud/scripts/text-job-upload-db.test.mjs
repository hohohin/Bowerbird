// Start a fresh loopback-only PostgreSQL cluster. Arguments: PostgreSQL bin directory, pg client entry point.
// For --file-speech-flow, run Node with --experimental-transform-types and FFmpeg/ffprobe on PATH.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [bin, driver, mode] = process.argv.slice(2);
const { default: pg } = await import(pathToFileURL(path.resolve(driver)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-text-job-"));
const data = path.join(root, "db");
const password = randomUUID();
const passwordFile = path.join(root, "pw");
const host = "127.0.0.1";
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, host, resolve));
const { port } = probe.address();
await new Promise(resolve => probe.close(resolve));
const run = (name, args) => execFileSync(path.join(bin, name), args, { windowsHide: true, timeout: 60000, stdio: args.includes("start") ? "ignore" : "pipe" });
const sessions = [];
let started = false;
try {
  fs.writeFileSync(passwordFile, password, { mode: 0o600 });
  run("initdb", ["-D", data, "-U", "fixture", "--encoding=UTF8", "--locale=C", "--auth=scram-sha-256", "--pwfile", passwordFile]);
  fs.unlinkSync(passwordFile);
  run("pg_ctl", ["-D", data, "-l", path.join(root, "server.log"), "-o", `-h ${host} -p ${port}`, "-w", "start"]);
  started = true;
  for (let i = 0; i < 2; i++) {
    const client = new pg.Client({ host, port, database: "postgres", user: "fixture", password, statement_timeout: 10000 });
    await client.connect();
    sessions.push(client);
  }
  const [db, rival] = sessions;
  const q = async (sql, args = [], conn = db) => (await conn.query(sql, args)).rows;
  await q(`create role anon; create role authenticated; create role service_role; create role supabase_auth_admin;
    create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create schema auth; create schema extensions;
    create table auth.users(id uuid primary key,email text,raw_app_meta_data jsonb default '{}',raw_user_meta_data jsonb default '{}',
      created_at timestamptz default now(), updated_at timestamptz, last_sign_in_at timestamptz,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('bb.fixture_user',true),'')::uuid $$;
    grant usage on schema auth to authenticated;`);
  const dir = "apps/cloud/supabase/migrations";
  const storageMimeMigration = "0093_file_speech_storage_mime.sql";
  // 0057 is reserved. 0068 is the undeployed GPT pricing migration.
  const migrations = fs.readdirSync(dir).sort().filter(name => /^\d{4}_.*\.sql$/.test(name) &&
    name <= storageMimeMigration && !name.startsWith("0068_"));
  for (const file of migrations) {
    try { await q(fs.readFileSync(path.join(dir, file), "utf8")); }
    catch (error) { throw new Error(`Migration ${file}: ${error.message}`, {cause: error}); }
  }
  console.log(migrations.length, "migrations applied to", (await q("show server_version"))[0].server_version);
  const productionMime = ["application/json", "image/png", "image/jpeg", "image/webp", "video/mp4", "video/quicktime"];
  const mimeSql = fs.readFileSync(path.join(dir, storageMimeMigration), "utf8");
  const getBuckets = () => q("select *,ctid::text as version from storage.buckets order by id");
  const getGenerationBucket = async () => (await getBuckets()).find(bucket => bucket.id === "generation-temp");
  const localBucket = await getGenerationBucket();
  // Local 0079 already permits both audio formats. 0093 must not alter that row.
  assert.equal(localBucket.allowed_mime_types.filter(mime => mime === "audio/mpeg").length, 1);
  assert.ok(localBucket.allowed_mime_types.includes("audio/wav"));
  await q(mimeSql);
  assert.deepEqual(await getGenerationBucket(), localBucket);

  await q("begin");
  try {
    await q(`create table storage.objects(bucket_id text, name text);
      alter table storage.objects enable row level security;
      create policy fixture_storage_read on storage.objects for select to authenticated using (false);
      insert into storage.objects values ('generation-temp','fixture-object');
      insert into storage.buckets values ('other-private','Other private bucket',false,1024,array['image/png']);`);
    const setRules = (mimes, isPublic = false) => q("update storage.buckets set public=$2,allowed_mime_types=$1 where id='generation-temp'", [mimes,isPublic]);
    const storageState = () => q(`select
      (select jsonb_agg(to_jsonb(object)) from storage.objects object) as objects,
      (select relrowsecurity from pg_class where oid='storage.objects'::regclass) as rls,
      (select jsonb_agg(to_jsonb(policy)) from pg_policies policy where schemaname='storage') as policies`);
    await setRules(productionMime);
    const before = await getBuckets();
    const storageBefore = await storageState();
    await q("savepoint before_storage_mime");
    await q(mimeSql);
    const baseline = before.find(bucket => bucket.id === "generation-temp");
    const updated = await getGenerationBucket();
    assert.deepEqual(updated, { ...baseline, allowed_mime_types:[...productionMime,"audio/mpeg"], version:updated.version });
    assert.deepEqual((await getBuckets()).filter(bucket => bucket.id !== "generation-temp"), before.filter(bucket => bucket.id !== "generation-temp"));
    assert.deepEqual(await storageState(), storageBefore);
    await q(mimeSql);
    assert.deepEqual(await getGenerationBucket(), updated);
    await q("rollback to before_storage_mime");
    assert.deepEqual(await getBuckets(), before);
    assert.deepEqual(await storageState(), storageBefore);
    await setRules([]);
    await q(mimeSql);
    assert.deepEqual((await getGenerationBucket()).allowed_mime_types,["audio/mpeg"]);
    for (const [mimes,isPublic] of [[null,false],[productionMime,true]]) {
      await setRules(mimes,isPublic);
      const unchanged = await getGenerationBucket();
      await q(mimeSql);
      assert.deepEqual(await getGenerationBucket(), unchanged);
    }
    await q("delete from storage.buckets where id='generation-temp'");
    const others = await getBuckets();
    await q(mimeSql);
    assert.deepEqual(await getBuckets(), others);
  } finally {
    await q("rollback");
  }
  console.log("file speech storage MIME six-entry production baseline, private-only scope, rollback, and idempotence passed");
  const user = randomUUID();
  await q("insert into auth.users(id) values($1)", [user]);
  await q("update service_costs set active=true,parameters=parameters||'{\"pricing_ready\":true}' where service='replication_speech_transcription'");
  const hash = "a".repeat(64);
  for (const table of ["understand_jobs", "visual_profile_jobs"]) {
    const understand = table === "understand_jobs";
    const service = understand ? "replication_speech_transcription" : "visual_profile_extract";
    const operation = understand ? "speech-transcription" : null;
    const key = randomUUID();
    const begin = async (c, k = key, h = hash, limit = 1000000000) => (await q(
      "select begin_text_upload($1,$2,$3,$4,$5,$6,1,100,$7,50) as j", [table,user,k,h,operation,service,limit], c))[0].j;
    const transition = async (c, j, enqueue) => (await q("select transition_text_upload($1,$2,$3,$4) as j", [table,j.id,hash,enqueue], c))[0].j;

    // Hold the first create transaction open; the other session shares its committed job.
    await db.query("begin");
    const job = await begin(db);
    const replay = begin(rival);
    // Establish the real blocking order before allowing the winner to commit.
    try {
      let blocked = false;
      const deadline = Date.now() + 3000;
      while (!blocked && Date.now() < deadline) {
        blocked = (await q("select pg_backend_pid()=any(pg_blocking_pids($1)) as blocked", [rival.processID]))[0].blocked;
      }
      assert.ok(blocked, "rival must block on the first transaction");
    } finally {
      await db.query("commit");
    }
    assert.equal((await replay).id, job.id);
    await assert.rejects(begin(rival, key, "b".repeat(64)), /different content/);
    assert.equal((await q("select status from credit_holds where id=$1", [job.hold_id]))[0].status, "held");
    const [qa,qb] = await Promise.all([transition(db,job,true),transition(rival,job,true)]);
    assert.equal(qa.status, "queued"); assert.equal(qb.status, "queued");
    const kind = understand ? "understand" : "visual_profile";
    const [claim] = await q(`select * from claim_${kind}_job('fixture')`);
    assert.equal(claim.id,job.id);
    assert.equal((await transition(rival,job,true)).status,"leased");
    await q(`select * from mark_${kind}_job_submitted($1,$2)`, [job.id,claim.lease_id]);
    const completed = await q(`select * from complete_${kind}_job($1,$2,'succeeded','result')`, [job.id,claim.lease_id]);
    assert.equal(completed[0].status,"succeeded");
    assert.equal((await begin(rival)).status,"succeeded");
    assert.equal((await q("select count(*)::int n from credit_transactions where hold_id=$1 and kind='confirm'", [job.hold_id]))[0].n,1);
    await assert.rejects(q(`update ${table} set result_text=null where id=$1`, [job.id]), /check constraint/);
    await assert.rejects(q(`update ${table} set result_text=null,deleted_at=now() where id=$1`, [job.id]), /check constraint/);
    await q("set role authenticated", [], rival);
    const direct = () => q(`select status,result_text,error_code,safe_message from ${table} where idempotency_key=$1 limit 1`, [key], rival);
    try {
      await q("select set_config('bb.fixture_user',$1,false)", [randomUUID()], rival);
      assert.deepEqual(await direct(), []);
      await q("select set_config('bb.fixture_user',$1,false)", [user], rival);
      assert.equal((await direct())[0].result_text, "result");
      await q(`update ${table} set content_expires_at=statement_timestamp() where id=$1`, [job.id]);
      assert.equal((await q(`select result_text from ${table} where id=$1`, [job.id]))[0].result_text, "result");
      assert.deepEqual(await direct(), []);
      await q(`update ${table} set result_text=null,deleted_at=now() where id=$1`, [job.id]);
      assert.deepEqual((await direct()).map(r => [r.status,r.result_text]), [["succeeded",null]]);
    } finally { await q("reset role", [], rival); }
    await q(`update ${table} set content_expires_at=now()-interval '1 minute',result_text=null,deleted_at=now() where id=$1`, [job.id]);
    assert.equal((await begin(rival)).result_text,null);

    const stalledKey = randomUUID(), stalled = await begin(db,stalledKey);
    await q(`update ${table} set created_at=now()-interval '11 minutes' where id=$1`, [stalled.id]);
    const outcomes = await Promise.all([transition(db,stalled,true),begin(rival,stalledKey)]);
    assert.ok(outcomes.every(row => row.status==="failed" && row.error_code==="upload_expired"));
    assert.equal((await q("select count(*)::int n from credit_transactions where hold_id=$1 and kind='rollback'", [stalled.hold_id]))[0].n,1);
    const abandoned = await begin(db,randomUUID());
    await q(`update ${table} set created_at=now()-interval '11 minutes' where id=$1`, [abandoned.id]);
    assert.equal((await q("select expire_unsubmitted_text_jobs($1) as n",[table]))[0].n,1);
    assert.equal((await q("select expire_unsubmitted_text_jobs($1) as n",[table]))[0].n,0);
    // An unsubmitted lease can expire and refund. A submitted worker retains
    // its settlement rights, while a late completion cannot restore erased text.
    for (const submitted of [false,true]) {
      const expiring = await begin(db,randomUUID());
      await transition(db,expiring,true);
      const [lease] = await q(`select * from claim_${kind}_job('fixture')`);
      assert.equal(lease.id,expiring.id);
      if (submitted) await q(`select * from mark_${kind}_job_submitted($1,$2)`, [lease.id,lease.lease_id]);
      await q(`update ${table} set content_expires_at=now()-interval '1 second' where id=$1`,[lease.id]);
      assert.equal((await q("select expire_unsubmitted_text_jobs($1) as n",[table]))[0].n,submitted ? 0 : 1);
      await q(`update ${table} set result_text=null,deleted_at=now() where id=$1`,[lease.id]);
      if (submitted) {
        const [late] = await q(`select * from complete_${kind}_job($1,$2,'succeeded','late result')`, [lease.id,lease.lease_id]);
        assert.equal(late.result_text,null); assert.equal(late.status,"succeeded");
      } else {
        await assert.rejects(q(`select * from mark_${kind}_job_submitted($1,$2)`, [lease.id,lease.lease_id]), /invalid/);
        assert.equal((await q("select status from credit_holds where id=$1",[lease.hold_id]))[0].status,"rolled_back");
      }
    }
    const rejectedKey = randomUUID();
    await assert.rejects(begin(db,rejectedKey,hash,1),/daily managed cost/);
    assert.equal((await q("select count(*)::int n from credit_holds where idempotency_key=$1",[rejectedKey]))[0].n,0);
    console.log(table, "concurrent create/enqueue, conflict, claimed replay, one settlement, TTL, abandoned upload and atomic budget failure passed");
  }
  const sync = async key => (await q("select begin_sync_understand($1,$2,100,1000000000,50) as h",[user,key]))[0].h;
  const asyncCaption = async key => q("select begin_text_upload('understand_jobs',$1,$2,$3,'autoname','caption',null,100,1000000000,50) as j",[user,key,hash]);
  const syncFirst = randomUUID(), asyncFirst = randomUUID();
  const owned = await sync(syncFirst);
  await assert.rejects(sync(syncFirst), /already accepted/);
  await assert.rejects(asyncCaption(syncFirst), /already accepted/);
  assert.equal((await q("select status from credit_holds where id=$1",[owned.hold_id]))[0].status,"held");
  const [{j}] = await asyncCaption(asyncFirst);
  await assert.rejects(sync(asyncFirst), /already accepted/);
  assert.equal((await q("select status from credit_holds where id=$1",[j.hold_id]))[0].status,"held");
  console.log("legacy synchronous and async caption key namespaces preserve the first caller's reservation");
  const image = async () => {
    const key = randomUUID();
    const [h] = await q("select * from credit_hold_bcoin_image($1,$2,'image_sd',0,null)", [user,key]);
    const [job] = await q(`insert into generation_jobs(user_id,idempotency_key,service,request_object_key,input_manifest_hash,
      input_count,hold_id,estimated_credits,pricing_version,content_expires_at) values($1,$2,'image_sd','fixture', $3,
      0,$4,$5,$6,now()+interval '1 day') returning *`, [user,key,hash,h.hold_id,h.estimated_amount,h.pricing_version]);
    return job;
  };
  const inspectImage = async (job, enqueue, c = db) => (await q("select * from inspect_image_upload($1,$2,$3)", [job.id,user,enqueue], c))[0];
  const fresh = await image();
  assert.equal((await inspectImage(fresh,false)).status,"uploading");
  assert.equal((await inspectImage(fresh,true)).status,"queued");
  await q("update generation_jobs set content_expires_at=now()-interval '1 second' where id=$1",[fresh.id]);
  assert.equal((await inspectImage(fresh,false)).status,"queued");
  assert.equal((await q("select status from credit_holds where id=$1",[fresh.hold_id]))[0].status,"held");
  for (const swept of [false,true]) {
    const stale = await image();
    if (swept) {
      await q("update credit_holds set expires_at=now()-interval '1 second' where id=$1",[stale.hold_id]);
      await q("select expire_stale_holds()");
    } else await q("update generation_jobs set content_expires_at=now()-interval '1 second' where id=$1",[stale.id]);
    await assert.rejects(q("select * from inspect_image_upload($1,$2,false)",[stale.id,randomUUID()]),/no rows/);
    const results = await Promise.all([inspectImage(stale,false),inspectImage(stale,true,rival)]);
    assert.ok(results.every(row=>row.status==="failed" && row.error_code==="image_upload_expired" && row.actual_credits===0));
    assert.equal((await q("select count(*)::int n from credit_transactions where hold_id=$1 and kind='rollback'",[stale.hold_id]))[0].n,1);
  }
  console.log("image upload GET/enqueue race, held and already-refunded expiry, queued and owner protection passed");

  const speechKey = () => `file-speech:${randomUUID()}`;
  const beginFileSpeech = async (key, price = 5, manifest = hash, conn = db, duration = 210_500) => (await q(
    "select begin_file_speech_upload($1,$2,$3,$4,100,1000000000,50,$5) as j", [user,key,manifest,price,duration], conn,
  ))[0].j;
  const finishSpeech = (job, lease, status, text = null, conn = db) => q(
    "select * from complete_understand_job($1,$2,$3,$4,null,null,true)", [job.id,lease.lease_id,status,text], conn,
  );
  const finishLegacy = (job, lease, status, text = null) => q(
    "select * from complete_understand_job($1,$2,$3,$4)", [job.id,lease.lease_id,status,text],
  );
  const transitionSpeech = (job) => q("select transition_text_upload('understand_jobs',$1,$2,true)", [job.id,hash]);
  const claimSpeech = async (worker, conn = db) => (await q("select * from claim_understand_job($1,90,true)", [worker], conn))[0];
  const claimLegacy = async (worker, conn = db) => (await q("select * from claim_understand_job($1)", [worker], conn))[0];
  const submitSpeech = (job, lease) => q("select * from mark_understand_job_submitted($1,$2)", [job.id,lease.lease_id]);
  const deferSpeech = (job, lease) => q("select defer_file_speech_job($1,$2)", [job.id,lease.lease_id]);
  const ledger = async (job) => (await q("select kind from credit_transactions where hold_id=$1 and kind in ('confirm','rollback')", [job.hold_id])).map(row => row.kind);
  const missingPriceKey = speechKey();
  await assert.rejects(beginFileSpeech(missingPriceKey), error => error.detail === "price_unavailable");
  for (const duration of [null, 0, 7_200_001]) {
    await assert.rejects(beginFileSpeech(missingPriceKey,5,hash,db,duration), error => error.code === "22023");
  }
  const [rpcPermissions] = await q(`select
    has_function_privilege('anon','claim_understand_job(text,integer,boolean)','execute') as anon_claim,
    has_function_privilege('authenticated','complete_understand_job(uuid,uuid,text,text,text,text,boolean)','execute') as user_finish,
    has_function_privilege('service_role','claim_understand_job(text,integer,boolean)','execute') as service_claim,
    has_function_privilege('service_role','complete_understand_job(uuid,uuid,text,text,text,text,boolean)','execute') as service_finish`);
  assert.deepEqual(rpcPermissions, {anon_claim:false,user_finish:false,service_claim:true,service_finish:true});
  await q(`insert into service_costs(service,unit_cost,active,pricing_version,parameters)
      values('library_file_speech',5,true,1,'{"pricing_ready":true}')`);
  await assert.rejects(beginFileSpeech(missingPriceKey,4), error => error.detail === "stale_quote");
  assert.equal((await q("select count(*)::int n from credit_holds where idempotency_key=$1", [missingPriceKey]))[0].n,0);

  const fileKey = speechKey();
  const [fileJob,replay] = await Promise.all([beginFileSpeech(fileKey),beginFileSpeech(fileKey,5,hash,rival)]);
  assert.equal(replay.id,fileJob.id);
  assert.equal(replay.hold_id,fileJob.hold_id);
  assert.equal(replay.file_speech_source_duration_ms,210_500);
  await assert.rejects(beginFileSpeech(fileKey,5,hash,db,210_501), error => error.detail === "manifest_conflict");
  assert.equal(fileJob.request_object_key,`understand/${fileJob.id}/inputs/request.json`);
  await assert.rejects(beginFileSpeech(fileKey,5,"b".repeat(64)), error => error.detail === "manifest_conflict");
  await q("update service_costs set unit_cost=6,pricing_version=2 where service='library_file_speech'");
  assert.equal((await beginFileSpeech(fileKey,6)).estimated_credits,5);
  await transitionSpeech(fileJob);

  assert.equal((await claimLegacy("old-worker-cannot-start-file-speech",rival))?.id ?? null,null);
  const firstLease = await claimSpeech("file-speech-first");
  assert.equal(firstLease.id,fileJob.id);
  assert.equal(firstLease.file_speech_source_duration_ms,210_500);
  assert.equal(firstLease.upstream_submitted_at,null);
  await assert.rejects(deferSpeech(fileJob,firstLease),/invalid file speech/);
  await submitSpeech(fileJob,firstLease);
  await assert.rejects(submitSpeech(fileJob,firstLease),/already submitted/);
  await assert.rejects(finishSpeech(fileJob,firstLease,"outcome_unknown"),/invalid file speech terminal/);
  await deferSpeech(fileJob,firstLease);
  assert.equal((await claimSpeech("file-speech-too-early"))?.id ?? null,null);
  await q("update understand_jobs set queued_at=now()-interval '1 second' where id=$1", [fileJob.id]);
  assert.equal((await claimLegacy("old-worker-cannot-claim-submitted-file-speech",rival))?.id ?? null,null);
  const secondLease = await claimSpeech("file-speech-query");
  assert.equal(secondLease.id,fileJob.id);
  assert.ok(secondLease.upstream_submitted_at);
  assert.notEqual(secondLease.lease_id,firstLease.lease_id);
  await assert.rejects(submitSpeech(fileJob,secondLease),/already submitted/);
  await q("update understand_jobs set lease_expires_at=now()-interval '1 second' where id=$1", [fileJob.id]);
  assert.equal((await q("select reconcile_stale_understand_jobs() as n"))[0].n,0);
  assert.equal((await claimLegacy("old-worker-cannot-recover-file-speech"))?.id ?? null,null);
  const reconnected = await claimSpeech("file-speech-reconnected", rival);
  assert.equal(reconnected.id,fileJob.id);
  assert.equal(reconnected.file_speech_source_duration_ms,210_500);
  await assert.rejects(finishLegacy(fileJob,reconnected,"failed"),/worker cannot settle/);
  await assert.rejects(finishLegacy(fileJob,reconnected,"succeeded","legacy response"),/worker cannot settle/);
  assert.deepEqual(await ledger(fileJob),[]);
  await assert.rejects(finishSpeech(fileJob,secondLease,"succeeded","stale"),/invalid understand lease/);
  await assert.rejects(finishSpeech(fileJob,reconnected,"succeeded","声".repeat(1398102)),/bounded result/);
  const transcript = "声".repeat(100000);
  const [fileResult] = await finishSpeech(fileJob,reconnected,"succeeded",transcript);
  assert.equal(fileResult.result_text,transcript);
  assert.equal(fileResult.actual_credits,5);
  assert.equal((await finishSpeech(fileJob,reconnected,"succeeded",transcript))[0].status,"succeeded");
  assert.deepEqual(await ledger(fileJob),["confirm"]);

  const parked = await beginFileSpeech(speechKey(),6);
  await transitionSpeech(parked);
  const parkedLease = await claimSpeech("file-speech-before-expiry");
  await submitSpeech(parked,parkedLease);
  await deferSpeech(parked,parkedLease);
  await q("update understand_jobs set content_expires_at=now()-interval '1 second' where id=$1", [parked.id]);
  const expiry = await Promise.all([q("select reconcile_stale_understand_jobs() as n"),q("select reconcile_stale_understand_jobs() as n", [], rival)]);
  assert.equal(expiry.flat().reduce((count,row) => count + row.n,0),1);
  assert.equal((await q("select status from understand_jobs where id=$1", [parked.id]))[0].status,"outcome_unknown");
  assert.equal((await q("select status from credit_holds where id=$1", [parked.hold_id]))[0].status,"pending_settlement");
  assert.deepEqual(await ledger(parked),[]);

  const lateSpeech = await beginFileSpeech(speechKey(),6);
  await transitionSpeech(lateSpeech);
  const liveLease = await claimSpeech("file-speech-after-expiry");
  await submitSpeech(lateSpeech,liveLease);
  await q("update understand_jobs set content_expires_at=now()-interval '1 second' where id=$1", [lateSpeech.id]);
  await assert.rejects(finishSpeech(lateSpeech,liveLease,"succeeded","too late to deliver"),/invalid file speech terminal/);
  assert.equal((await q("select reconcile_stale_understand_jobs() as n"))[0].n,1);
  assert.equal((await q("select status from understand_jobs where id=$1", [lateSpeech.id]))[0].status,"outcome_unknown");
  assert.deepEqual(await ledger(lateSpeech),[]);

  const unsubmitted = await beginFileSpeech(speechKey(),6);
  await transitionSpeech(unsubmitted);
  const unsubmittedLease = await claimSpeech("file-speech-expired-before-submit");
  await q("update understand_jobs set content_expires_at=now()-interval '1 second' where id=$1", [unsubmitted.id]);
  await assert.rejects(submitSpeech(unsubmitted,unsubmittedLease),/already submitted, expired or cancelled/);
  assert.equal((await q("select expire_unsubmitted_text_jobs('understand_jobs') as n"))[0].n,1);
  assert.equal((await q("select status from understand_jobs where id=$1", [unsubmitted.id]))[0].status,"failed");
  assert.deepEqual(await ledger(unsubmitted),["rollback"]);

  const legacyKey = randomUUID();
  const [legacy] = await q("select begin_text_upload('understand_jobs',$1,$2,$3,'speech-transcription','replication_speech_transcription',null,100,1000000000,50) as j", [user,legacyKey,hash]);
  assert.equal(legacy.j.file_speech_source_duration_ms,null);
  await assert.rejects(q("update understand_jobs set file_speech_source_duration_ms=42 where id=$1", [legacy.j.id]), error => error.code === "23514");
  await transitionSpeech(legacy.j);
  const legacyLease = await claimLegacy("legacy-sync");
  assert.equal(legacyLease.id,legacy.j.id);
  await submitSpeech(legacy.j,legacyLease);
  await assert.rejects(finishSpeech(legacy.j,legacyLease,"failed"),/worker cannot settle/);
  await assert.rejects(finishLegacy(legacy.j,legacyLease,"succeeded","x".repeat(65537)),/bounded result/);
  await q("update understand_jobs set lease_expires_at=now()-interval '1 second' where id=$1", [legacy.j.id]);
  assert.equal((await claimSpeech("legacy-sync-must-not-resubmit"))?.id ?? null,null);
  assert.equal((await q("select reconcile_stale_understand_jobs() as n"))[0].n,1);
  assert.equal((await q("select status from understand_jobs where id=$1", [legacy.j.id]))[0].status,"outcome_unknown");
  assert.deepEqual(await ledger(legacy.j),[]);
  console.log("file speech quote and duration, retained pricing, old worker isolation, query-only leases, byte limit, one settlement, and expiry passed");
  if (mode === "--file-speech-flow") {
    const { verifyFileSpeechFlow } = await import("./file-speech-flow.fixture.mjs");
    await verifyFileSpeechFlow(q, root);
  }
} finally {
  try {
    await Promise.all(sessions.map(client => client.end()));
    if (started || fs.existsSync(path.join(data,"postmaster.pid"))) run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
  } finally {
    assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root),/^bb-text-job-[\w-]+$/);
    assert.equal(fs.existsSync(path.join(data, "postmaster.pid")),false);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  }
}
