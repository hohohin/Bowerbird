// Start a fresh loopback-only PostgreSQL cluster. Arguments: PostgreSQL bin directory, pg client entry point.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [bin, driver] = process.argv.slice(2);
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
  // 0057 is reserved. 0068 is the undeployed GPT pricing migration.
  const migrations = fs.readdirSync(dir).sort().filter(name => /^\d{4}_.*\.sql$/.test(name) && name < "0088" && !name.startsWith("0068_"));
  for (const file of migrations) {
    try { await q(fs.readFileSync(path.join(dir, file), "utf8")); }
    catch (error) { throw new Error(`Migration ${file}: ${error.message}`, {cause: error}); }
  }
  console.log(migrations.length, "migrations applied to", (await q("show server_version"))[0].server_version);
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
