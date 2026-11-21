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

  // The metering migration applies to a pre-0094 database.
  await q(fs.readFileSync(path.join(dir,"0095_chat_model_usage.sql"),"utf8"));
  const paidChatMigration = fs.readFileSync(path.join(dir,"0096_chat_paid_billing.sql"),"utf8");
  await q("begin");
  try {
    await q(paidChatMigration);
    await q(`update service_costs set active=true,unit_cost=70,parameters=parameters||'{"max_output_tokens":8192}' where service='chat_paid_flash_v1'`);
    assert.equal((await q("select quote_chat_paid_turn('deepseek-flash') as value"))[0].value.available,false);
  } finally { await q("rollback"); }
  const [chatOwner, anotherOwner] = [randomUUID(), randomUUID()];
  await q("insert into auth.users(id) values($1),($2)", [chatOwner, anotherOwner]);
  const createChat = async (key, owner, cap, connection = db) => (await q(
    "select * from begin_chat_session_turn($1,$2,$3,$4,$5,30,false,$2)",
    [owner, key, hash, `chat/${owner}/${key}/request.json`, cap], connection,
  ))[0];
  const businessDay = (await q("select timezone('Asia/Shanghai',now())::date::text as day"))[0].day;
  const totals = async table => (await q(
    `select request_count::int as requests, cost_micros::int as cost from ${table} where business_date=$1`, [businessDay],
  ))[0];
  const nonChatBefore = await totals("system_usage_daily");
  const legacyChat = await createChat("legacy-dsh", chatOwner, 500_000_000);
  const perTurn = Number((await q("select reserved_cost_micros from credit_holds where id=$1", [legacyChat.hold_id]))[0].reserved_cost_micros);
  assert.equal(perTurn,24_000_000);
  const mixed = await totals("system_usage_daily");
  assert.deepEqual(mixed,{ requests:nonChatBefore.requests+1,cost:nonChatBefore.cost+perTurn });

  const chatMigration = fs.readFileSync(path.join(dir,"0094_chat_daily_limits.sql"),"utf8");
  await q("begin");
  try {
    await q("update credit_holds set reserved_cost_micros=null where id=$1", [legacyChat.hold_id]);
    await assert.rejects(q(chatMigration), /history cannot be attributed/);
  } finally {
    await q("rollback");
  }
  assert.deepEqual(await totals("system_usage_daily"), mixed);
  await q(chatMigration);
  assert.deepEqual(await totals("system_usage_daily"), nonChatBefore);
  assert.deepEqual(await totals("system_chat_usage_daily"), {requests:1,cost:perTurn});
  assert.equal((await q("select chat_request_count from usage_daily where user_id=$1 and business_date=$2", [chatOwner,businessDay]))[0].chat_request_count,1);
  assert.equal((await q("select has_table_privilege('authenticated','system_chat_usage_daily','select') as allowed"))[0].allowed,false);
  assert.equal((await createChat("legacy-dsh",chatOwner,1)).id,legacyChat.id);
  await q("select * from enqueue_chat_completion($1,$2,true)",[legacyChat.id, hash]);
  const [oldLease] = await q("select * from claim_chat_session_turn('pre-migration-job')");
  assert.equal(oldLease.id,legacyChat.id);
  const [settled] = await q("select * from finish_chat_completion($1,$2,'succeeded',$3,null)",[oldLease.id,oldLease.lease_id,
    {message:{role:"assistant",content:"fixture"},usage:{input_tokens:2,output_tokens:1},model:"fixture"}]);
  assert.equal(settled.actual_credits,0);
  assert.deepEqual(await ledger(legacyChat),["confirm"]);

  // From two native PG connections in different session timezones, give the
  // same owner one remaining turn and race two distinct conversation IDs.
  await q("update service_costs set parameters=jsonb_set(parameters,'{free_turns_per_day}','2') where service='chat_deepseek'");
  await q("set timezone='Pacific/Honolulu'", [], rival);
  const keys = ["race-a","race-b"];
  const race = await Promise.allSettled(keys.map((key,index) => createChat(key,chatOwner,3*perTurn,sessions[index])));
  const winners = race.filter(entry => entry.status === "fulfilled");
  const losers = race.filter(entry => entry.status === "rejected");
  assert.equal(winners.length,1);
  assert.equal(losers.length,1);
  assert.equal(losers[0].reason.code,"P0001");
  assert.equal(losers[0].reason.detail,"chat_daily_turn_limit");
  assert.equal((await createChat(winners[0].value.idempotency_key,chatOwner,1,rival)).id,winners[0].value.id);
  assert.deepEqual(await totals("system_chat_usage_daily"),{requests:2,cost:2*perTurn});
  assert.equal((await q("select count(*)::int as count from credit_holds where user_id=$1 and service='chat_deepseek'", [chatOwner]))[0].count,2);
  assert.equal((await q("select sum(request_count)::int as requests from usage_minute where user_id=$1",[chatOwner]))[0].requests,2);

  const reserveText = cap => q("select begin_sync_understand($1,$2,100,$3,30)",[user,randomUUID(),cap]);
  await assert.rejects(reserveText(nonChatBefore.cost), error => error.detail === "daily_cost_limit");
  await createChat("other-owner",anotherOwner,3*perTurn,rival);
  await assert.rejects(createChat("chat-cap-stop",anotherOwner,3*perTurn),error => error.detail === "daily_cost_limit");
  await reserveText(nonChatBefore.cost+100);
  assert.deepEqual(await totals("system_usage_daily"),{requests:nonChatBefore.requests+1,cost:nonChatBefore.cost+100});
  assert.deepEqual(await totals("system_chat_usage_daily"),{requests:3,cost:3*perTurn});

  // Preserve the capped data as a prior Shanghai date and confirm a fresh
  // business-day row is used, without advancing the host clock.
  await q("update system_chat_usage_daily set business_date=business_date-1 where business_date=$1",[businessDay]);
  await q("update usage_daily set business_date=business_date-1 where user_id=$1 and business_date=$2",[chatOwner,businessDay]);
  await createChat("new-day",chatOwner,perTurn,rival);
  assert.deepEqual(await totals("system_chat_usage_daily"),{requests:1,cost:perTurn});
  assert.equal((await q("select chat_request_count from usage_daily where user_id=$1 and business_date=$2",[chatOwner,businessDay]))[0].chat_request_count,1);
  console.log("chat daily limits: same-day cutover, rollback on unattributed cost, old order settlement, concurrent quota, replay, dual bucket isolation, and Shanghai day reset passed");

  const metered = await createChat("metered", anotherOwner, 500_000_000);
  await q("select * from enqueue_chat_completion($1,$2,true)", [metered.id, hash]);
  const [meteredLease] = await q("select * from claim_chat_session_turn('usage-fixture')");
  assert.equal(meteredLease.id, metered.id);
  const call = (callId, observation=null, connection=db, lease=meteredLease.lease_id, model="deepseek-v4-pro") => q(
    "select record_chat_model_call($1,$2,$3,$4,$5) as recorded", [metered.id,lease,callId,model,observation], connection,
  ).then(([row]) => row.recorded);
  const [firstCall, secondCall, thirdCall] = ["a","b","c"].map(value => value.repeat(64));
  const usage = {status:"observed",input_tokens:40,output_tokens:8,cache_hit_tokens:13,cache_miss_tokens:27,
    provider_model:"DeepSeek-V4-Pro-0813",provider_request_id:"fixture-request"};
  await assert.rejects(call(firstCall,usage), /not submitted/);
  await assert.rejects(call(firstCall,null,db,randomUUID()), /invalid chat model lease/);
  assert.deepEqual((await Promise.all([call(firstCall), call(firstCall,null,rival)])).sort(),[false,true]);
  await assert.rejects(call(firstCall,null,db,meteredLease.lease_id,"deepseek-flash"), /conflicting chat model identity/);
  await assert.rejects(call(firstCall,{...usage,input_tokens:"40"}), /invalid chat token/);
  await assert.rejects(call(firstCall,{...usage,cache_hit_tokens:99}), /invalid chat cache/);
  await assert.rejects(call(firstCall,{...usage,prompt:"private"}), /invalid chat model observation/);
  assert.equal(await call(firstCall,usage),true);
  assert.equal(await call(firstCall,usage,rival),true);
  await assert.rejects(call(firstCall,{...usage,output_tokens:9}), /conflicting chat model observation/);
  assert.equal(await call(secondCall),true);
  assert.equal(await call(secondCall,{status:"http_error",http_status:429}),true);
  assert.equal(await call(thirdCall),true);
  // Exercise a receipt on a pre-midnight submission while keeping the day of the upstream authorization.
  await q("update chat_model_calls set submitted_at=($2::date::timestamp at time zone 'Asia/Shanghai')-interval '1 second' where job_id=$1 and call_id=$3",
    [metered.id,businessDay,thirdCall]);
  for (const index of [0,1,2,3,4,5,6,7,8]) assert.equal(await call(index.toString().repeat(64)),true);
  await assert.rejects(call("9".repeat(64)), /call count exceeded/);
  const [stoppedChat] = await q("select * from cancel_chat_dsh($1,$2,null)", [anotherOwner,metered.id]);
  assert.equal(stoppedChat.status,"outcome_unknown");
  await assert.rejects(call("d".repeat(64)), /inactive chat model lease/);
  assert.equal(await call(thirdCall,{status:"unknown"}),true);
  assert.equal(await call(thirdCall,{status:"unknown"},rival),true);
  assert.equal(await call("0".repeat(64),{...usage,provider_request_id:"late-known-usage"},rival),true);
  const [observations] = await q(`select
    count(*)::int as total,
    count(*) filter (where observation is null)::int as pending,
    count(*) filter (where observation->>'status'='unknown')::int as unknown,
    count(*) filter (where business_date = $2::date-1)::int as previous_day,
    sum((observation->>'input_tokens')::int)::int as input,
    sum((observation->>'output_tokens')::int)::int as output
    from chat_model_calls where job_id=$1`, [metered.id,businessDay]);
  assert.deepEqual(observations,{total:12,pending:8,unknown:1,previous_day:1,input:80,output:16});
  assert.deepEqual(await ledger(metered),[]);
  assert.deepEqual(await ledger(legacyChat),["confirm"]);
  const success = await createChat("metered-success",chatOwner,500_000_000);
  await q("select * from enqueue_chat_completion($1,$2,true)",[success.id,hash]);
  const [successLease] = await q("select * from claim_chat_session_turn('usage-fixture')");
  assert.equal(successLease.id,success.id);
  const recordSuccess = receipt => q("select record_chat_model_call($1,$2,$3,'deepseek-flash',$4)",
    [success.id,successLease.lease_id,firstCall,receipt]);
  await recordSuccess(null);
  await recordSuccess({status:"observed",input_tokens:10,output_tokens:2,cache_hit_tokens:5});
  const [finishedUsage] = await q("select * from finish_chat_completion($1,$2,'succeeded',$3,null)",[success.id,successLease.lease_id,
    {message:{role:"assistant",content:"fixture"},usage:{input_tokens:10,output_tokens:2},model:"deepseek-flash"}]);
  assert.equal(finishedUsage.actual_credits,0);
  assert.deepEqual(await ledger(success),["confirm"]);
  const [meteringRights] = await q(`select
    has_table_privilege('authenticated','chat_model_calls','select') as user_read,
    has_table_privilege('service_role','chat_model_calls','insert') as service_write,
    has_function_privilege('authenticated','record_chat_model_call(uuid,uuid,text,text,jsonb)','execute') as user_rpc,
    has_function_privilege('service_role','record_chat_model_call(uuid,uuid,text,text,jsonb)','execute') as service_rpc`);
  assert.deepEqual(meteringRights,{user_read:false,service_write:false,user_rpc:false,service_rpc:true});
  console.log("chat model usage: 0095 before 0094, worker-only lease, concurrent submit, immutable receipt, unknown/cancel, cross-day attribution, 12-call limit, and unchanged billing passed");

  await q(paidChatMigration);
  const { verifyChatPaidBilling } = await import("./chat-paid-db.fixture.mjs");
  await verifyChatPaidBilling(q,db,rival);

  const currentCostPolicy = async () => (await q(`select qual from pg_policies where schemaname='public'
    and tablename='service_costs' and policyname='service_costs_select_active'`))[0].qual;
  const pricePolicyBeforePilot = await currentCostPolicy();
  await q(fs.readFileSync(path.join(dir, "0098_file_speech_pilot.sql"), "utf8"));
  assert.equal(await currentCostPolicy(), pricePolicyBeforePilot);
  assert.match(pricePolicyBeforePilot, /chat_paid_flash_v1/);
  assert.match(pricePolicyBeforePilot, /chat_paid_pro_v1/);
  const pilotAccount = randomUUID();
  await q("insert into auth.users(id) values($1)", [pilotAccount]);
  const readCatalog = async role => {
    await q("begin");
    try {
      await q(`set local role ${role}`);
      return (await q("select service from service_costs order by service")).map(row => row.service);
    } finally {
      await q("rollback");
    }
  };
  const publicCatalog = await readCatalog("authenticated");
  assert.ok(publicCatalog.includes("library_file_speech"));
  assert.ok(publicCatalog.includes("chat_deepseek"));
  assert.equal(publicCatalog.includes("chat_paid_flash_v1") || publicCatalog.includes("chat_paid_pro_v1"), false);
  const startPilot = async (key, mode, conn = db, price = 1, manifest = hash,
    { account = pilotAccount, dailyLimit = 1_000_000_000, rateLimit = 50, duration = 7_200_000 } = {}) => (await q(
    "select begin_file_speech_upload($1,$2,$3,$4,50000,$5,$6,$7,$8::boolean) as job",
    [account, key, manifest, price, dailyLimit, rateLimit, duration, mode], conn,
  ))[0].job;
  await assert.rejects(startPilot(speechKey(), true), error => error.detail === "price_unavailable");
  await q(`update service_costs set unit_cost=1,pricing_version=9001,parameters=parameters||'{"pilot_only":true}'
    where service='library_file_speech'`);
  for (const role of ["anon", "authenticated"]) {
    assert.deepEqual(await readCatalog(role), publicCatalog.filter(service => service !== "library_file_speech"));
    const [{ allowed }] = await q(`select has_function_privilege($1,
      'begin_file_speech_upload(uuid,text,text,integer,numeric,bigint,integer,integer,boolean)','execute') as allowed`, [role]);
    assert.equal(allowed, false);
  }
  const [{ allowed }] = await q(`select has_function_privilege('service_role',
    'begin_file_speech_upload(uuid,text,text,integer,numeric,bigint,integer,integer,boolean)','execute') as allowed`);
  assert.equal(allowed, true);
  await assert.rejects(beginFileSpeech(speechKey(), 1), error => error.detail === "price_unavailable");
  await assert.rejects(startPilot(speechKey(), null), error => error.detail === "file_speech_closed");
  await assert.rejects(startPilot(speechKey(), true, db, 2), error => error.detail === "stale_quote");

  const acceptedPilotKey = speechKey();
  const extraPilotKey = speechKey();
  let approvedPilot;
  let competingPilot;
  await q("begin");
  try {
    approvedPilot = await startPilot(acceptedPilotKey, true);
    competingPilot = assert.rejects(startPilot(extraPilotKey, true, rival), error => error.detail === "file_speech_pilot_used");
    let blocked = false;
    for (let attempt = 0; !blocked && attempt < 20; attempt++) {
      blocked = (await q("select pg_backend_pid()=any(pg_blocking_pids($1)) as blocked", [rival.processID]))[0].blocked;
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, "different keys for one account wait on the pilot admission lock");
    await q("commit");
  } catch (error) {
    await q("rollback");
    throw error;
  }
  await competingPilot;
  assert.equal(approvedPilot.file_speech_pilot, true);
  assert.equal(approvedPilot.file_speech_source_duration_ms, 7_200_000);
  assert.equal(approvedPilot.estimated_credits, 1);
  assert.deepEqual((await q("select reserved_cost_micros::int as micro from credit_holds where user_id=$1", [pilotAccount])), [{ micro: 2_000_000 }]);
  assert.equal((await startPilot(acceptedPilotKey, null)).id, approvedPilot.id);
  await assert.rejects(startPilot(acceptedPilotKey, null, db, 1, "b".repeat(64)), error => error.detail === "manifest_conflict");
  await q("update service_costs set unit_cost=2,pricing_version=9002 where service='library_file_speech'");
  await assert.rejects(startPilot(extraPilotKey, true, db, 2), error => error.detail === "file_speech_pilot_used");
  assert.equal((await startPilot(acceptedPilotKey, null)).hold_id, approvedPilot.hold_id);
  console.log("file speech pilot 0098 baseline: private catalog, one concurrent two-hour job, stable original hold, and ¥2 provider reserve passed");

  await q(fs.readFileSync(path.join(dir, "0099_file_speech_repeat_test_account.sql"), "utf8"));
  await q("update service_costs set unit_cost=1,pricing_version=9001 where service='library_file_speech'");
  for (const role of ["anon", "authenticated"]) {
    assert.deepEqual(await readCatalog(role), publicCatalog.filter(service => service !== "library_file_speech"));
  }
  assert.deepEqual((await q(`select to_regclass('public.understand_jobs_single_file_speech_pilot') is null as lifetime_index_gone,
    has_function_privilege('authenticated','begin_file_speech_upload(uuid,text,text,integer,numeric,bigint,integer,integer,boolean)','execute') as user_execute,
    has_function_privilege('service_role','begin_file_speech_upload(uuid,text,text,integer,numeric,bigint,integer,integer,boolean)','execute') as service_execute`))[0],
    { lifetime_index_gone: true, user_execute: false, service_execute: true });
  const rejectedKey = speechKey();
  await assert.rejects(startPilot(rejectedKey, null, db, 1, hash, { account: user }), error => error.detail === "file_speech_closed");
  await assert.rejects(startPilot(rejectedKey, false), error => error.detail === "price_unavailable");
  await assert.rejects(startPilot(rejectedKey, true, db, 2), error => error.detail === "stale_quote");
  await assert.rejects(startPilot(rejectedKey, true, db, 1, hash, { duration: 7_200_001 }), error => error.code === "22023");
  const differentKey = speechKey();
  const [repeat, shortRepeat] = await Promise.all([
    startPilot(extraPilotKey, true),
    startPilot(differentKey, true, rival, 1, hash, { duration: 54_264 }),
  ]);
  assert.equal(new Set([approvedPilot, repeat, shortRepeat].map(job => job.id)).size, 3);
  assert.equal(new Set([approvedPilot, repeat, shortRepeat].map(job => job.hold_id)).size, 3);
  assert.equal(repeat.file_speech_source_duration_ms, 7_200_000);
  assert.equal(shortRepeat.file_speech_source_duration_ms, 54_264);
  for (const [key, expected] of [[acceptedPilotKey, approvedPilot], [extraPilotKey, repeat], [differentKey, shortRepeat]]) {
    const replayed = await startPilot(key, null, db, 1, hash, { duration: expected.file_speech_source_duration_ms });
    assert.equal(replayed.id, expected.id);
    assert.equal(replayed.hold_id, expected.hold_id);
    assert.equal((await q("select $1::timestamptz=$2::timestamptz as same",
      [replayed.content_expires_at, expected.content_expires_at]))[0].same, true);
  }
  await assert.rejects(startPilot(extraPilotKey, null, db, 1, "b".repeat(64)), error => error.detail === "manifest_conflict");
  await assert.rejects(startPilot(differentKey, null), error => error.detail === "manifest_conflict");
  await assert.rejects(startPilot(rejectedKey, null), error => error.detail === "file_speech_closed");
  assert.deepEqual(await q(`select held.estimated_amount as credits,held.reserved_cost_micros::int as micro
    from credit_holds held join understand_jobs job on held.id=job.hold_id where job.file_speech_pilot and job.user_id=$1`, [pilotAccount]),
    Array.from({ length: 3 }, () => ({ credits: 1, micro: 2_000_000 })));
  const [{ micros }] = await q("select cost_micros::int as micros from system_usage_daily where business_date=timezone('Asia/Shanghai', now())::date");
  await assert.rejects(startPilot(rejectedKey, true, db, 1, hash, { dailyLimit: micros + 1_999_999 }),
    error => error.detail === "daily_cost_limit");
  await q("begin");
  try {
    await startPilot(speechKey(), true);
    await assert.rejects(startPilot(rejectedKey, true, db, 1, hash, { rateLimit: 1 }), error => error.detail === "rate_limit_per_minute");
  } finally { await q("rollback"); }
  await q("begin");
  try {
    await q("update credit_lots set remaining_amount=0 where user_id=$1", [pilotAccount]);
    await assert.rejects(startPilot(rejectedKey, true), error => error.detail === "insufficient_credits");
  } finally { await q("rollback"); }
  assert.equal((await q("select count(*)::int n from credit_holds where idempotency_key=$1", [rejectedKey]))[0].n, 0);
  for (const [key, job] of [[extraPilotKey, repeat], [differentKey, shortRepeat]]) {
    await transitionSpeech(job);
    const lease = await claimSpeech("repeat-pilot-fixture");
    assert.equal(lease.id, job.id);
    await submitSpeech(job, lease);
    assert.equal((await finishSpeech(job, lease, "succeeded", '{"text":"fixture"}'))[0].actual_credits, 1);
    assert.equal((await startPilot(key, null, db, 1, hash, { duration: job.file_speech_source_duration_ms })).status, "succeeded");
    assert.deepEqual(await ledger(job), ["confirm"]);
  }

  await q("update service_costs set unit_cost=6,pricing_version=2,parameters=parameters-'pilot_only' where service='library_file_speech'");
  assert.deepEqual(await readCatalog("authenticated"), publicCatalog);
  const unchangedPublic = await beginFileSpeech(speechKey(), 6);
  assert.equal(unchangedPublic.file_speech_pilot, false);
  assert.equal((await q("select reserved_cost_micros::int as micro from credit_holds where id=$1", [unchangedPublic.hold_id]))[0].micro, 600);
  console.log("file speech pilot 0099: private catalog and admission, repeated jobs at 1 Bcoin and ¥2 reserve each, stable original TTL and hold, existing usage guards, and public reservation passed");

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
