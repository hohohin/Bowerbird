// Isolated PostgreSQL transaction/lease/billing verification. No production connection.
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";
const { PGlite } = await import(pathToFileURL(path.resolve(process.argv[2])).href);
const db = new PGlite();
try {
  await db.exec(`create role anon; create role authenticated; create role service_role; create role supabase_auth_admin; create schema auth; create schema extensions; create schema storage;
    create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
    create function extensions.gen_random_uuid() returns uuid language sql as $$ select gen_random_uuid() $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  const migrate = async prefix => {
    const file = fs.readdirSync("apps/cloud/supabase/migrations").find(file => file.startsWith(prefix));
    await db.exec(fs.readFileSync(`apps/cloud/supabase/migrations/${file}`, "utf8").replace("create extension if not exists pgcrypto with schema extensions;", ""));
  };
  for (const prefix of ["0001", "0002", "0003", "0004", "0005", "0006", "0009", "0010", "0011", "0015",
    "0016", "0017", "0018", "0019", "0023", "0058", "0059", "0061", "0062", "0063", "0064", "0065", "0066", "0067"]) await migrate(prefix);
  const q = async (sql, values = []) => (await db.query(sql, values)).rows;
  const user = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  await q("insert into auth.users values($1)", [user]);
  await q("insert into credit_lots(user_id,bucket,source_key,original_amount,remaining_amount,expires_at) values($1,'topup','test',10000,10000,now()+interval '1 year')", [user]);
  assert.equal((await q("select count(*)::int n from service_costs where service like 'image_layer_%' and active"))[0].n, 0);
  await assert.rejects(() => q("update service_costs set active=true where service='image_layer_decompose'"));
  await assert.rejects(() => q("select credit_hold($1,'inactive','image_layer_decompose',null)", [user]));
  await q("update service_costs set active=true,unit_cost=23,parameters=parameters || '{\"pricing_ready\":true}' where service='image_layer_decompose'"); // fixture price only
  const create = async key => {
    const [hold] = await q("select * from credit_hold($1,$2,'image_layer_decompose',null)", [user, key]);
    await q("insert into generation_jobs(id,user_id,idempotency_key,service,request_object_key,input_manifest_hash,input_count,hold_id,estimated_credits,pricing_version,content_expires_at) values($1,$2,$3,'image_layer_decompose',$4,$5,1,$1,$6,1,now()+interval '1 day')", [hold.hold_id, user, key, `jobs/${hold.hold_id}/inputs/request.json`, "a".repeat(64), hold.estimated_amount]);
    await q("select enqueue_generation_job($1,$2)", [hold.hold_id, user]);
    return (await q("select * from claim_generation_job('layer-test',90)"))[0];
  };
  const first = await create("once");
  assert.equal((await q("select * from credit_hold($1,'once','image_layer_decompose',null)", [user]))[0].hold_id, first.id);
  const complete = (job, status, mime = "application/json") => q("select * from complete_generation_job($1,$2,$3,$4,$5,100,$6)", [job.id, job.lease_id, status, `jobs/${job.id}/outputs/result.json`, mime, "a".repeat(64)]);
  await q("select mark_generation_job_submitted($1,$2,null)", [first.id, first.lease_id]);
  await assert.rejects(() => complete(first, "succeeded", "image/png"));
  await assert.rejects(() => complete(first, "succeeded", null));
  const [done] = await complete(first, "succeeded");
  assert.equal(done.actual_credits, 23);
  const [again] = await complete(first, "succeeded");
  assert.equal(again.actual_credits, 23);
  const failed = await create("failed"); await complete(failed, "failed");
  assert.equal((await q("select status from credit_holds where id=$1", [failed.id]))[0].status, "rolled_back");
  const unknown = await create("unknown"); await complete(unknown, "outcome_unknown");
  assert.equal((await q("select status from credit_holds where id=$1", [unknown.id]))[0].status, "pending_settlement");
  assert.equal((await q("select has_function_privilege('authenticated','public.complete_generation_job(uuid,uuid,text,text,text,bigint,text,text,text)','EXECUTE') allowed"))[0].allowed, false);

  await migrate("0070");
  await migrate("0071");
  const holdLayers = async (key, maxImages) => {
    const args = maxImages === undefined ? "" : ",$3";
    const [hold] = await q(`select * from credit_hold_bcoin_image($1,$2,'image_layer_decompose',1,'auto'${args})`,
      maxImages === undefined ? [user, key] : [user, key, maxImages]);
    return hold;
  };
  const startBcoinJob = async (hold, key, service = "image_layer_decompose", inputCount = 1) => {
    await q(`insert into generation_jobs(id,user_id,idempotency_key,service,request_object_key,input_manifest_hash,input_count,
      hold_id,estimated_credits,pricing_version,content_expires_at,status,lease_id,lease_expires_at,lease_owner)
      values($1,$2,$3,$4,'input',repeat('a',64),$5,$1,$6,$7,now()+interval '1 day',
      'running',$1,now()+interval '1 hour','test')`, [hold.hold_id, user, key, service, inputCount, hold.estimated_amount, hold.pricing_version]);
  };
  const finishBcoinJob = async (hold, pixels) => {
    const [job] = await q(`select * from complete_bcoin_image_job($1,$1,'succeeded','out','application/json',100,
      repeat('a',64),null,null,$2)`, [hold.hold_id, pixels]);
    return job;
  };
  const balance = async () => (await q("select topup_balance from user_credits where user_id=$1", [user]))[0].topup_balance;
  const legacyHold = await holdLayers("legacy-layer");
  await startBcoinJob(legacyHold, "legacy-layer");
  await migrate("0102");
  assert.equal((await holdLayers("legacy-layer")).hold_id, legacyHold.hold_id);
  assert.equal(legacyHold.estimated_amount, 170);
  await assert.rejects(() => finishBcoinJob(legacyHold, Array(18).fill(1_000_000)));
  assert.equal((await finishBcoinJob(legacyHold, [1_000_000, 4_194_304])).actual_credits, 15);

  const beforeLegacyProtocol = await balance();
  const legacyProtocol = await holdLayers("legacy-client-new-job");
  assert.equal(legacyProtocol.pricing_version, 20261124);
  assert.equal(legacyProtocol.estimated_amount, 170);
  assert.equal(await balance(), beforeLegacyProtocol - 170);
  await startBcoinJob(legacyProtocol, "legacy-client-new-job");
  await assert.rejects(() => finishBcoinJob(legacyProtocol, Array(18).fill(1_000_000)));
  assert.equal((await finishBcoinJob(legacyProtocol, [2_610_000, 2_610_001, 4_194_304])).actual_credits, 25);
  assert.equal(await balance(), beforeLegacyProtocol - 25);

  await q("update service_costs set active=true where service='image_layer_edit'");
  for (const [key, refs, size, expected] of [
    ["old-client-single-layer", 1, "2K", 20], ["edit-with-context", 2, "1K", 12], ["generate-transparent", 0, "1K", 10],
  ]) {
    const beforeEdit = await balance();
    const [hold] = await q("select * from credit_hold_bcoin_image($1,$2,'image_layer_edit',$3,$4)", [user, key, refs, size]);
    assert.equal(hold.estimated_amount, expected);
    await startBcoinJob(hold, key, "image_layer_edit", refs);
    assert.equal((await finishBcoinJob(hold, null)).actual_credits, expected);
    assert.equal(await balance(), beforeEdit - expected);
  }

  const before = await balance();
  const dynamic = await holdLayers("layer-dynamic", 30);
  assert.equal(dynamic.estimated_amount, 242);
  assert.equal(await balance(), before - 242);
  assert.equal((await holdLayers("layer-dynamic", 30)).hold_id, dynamic.hold_id);
  await assert.rejects(() => holdLayers("layer-dynamic", 60));
  assert.equal(await balance(), before - 242);
  await startBcoinJob(dynamic, "layer-dynamic");
  await assert.rejects(() => finishBcoinJob(dynamic, Array(31).fill(1_000_000)));
  assert.equal((await finishBcoinJob(dynamic, [2_610_000, 2_610_001, 4_194_304])).actual_credits, 23);
  assert.equal((await finishBcoinJob(dynamic, [2_610_000, 2_610_001, 4_194_304])).actual_credits, 23);
  assert.equal(await balance(), before - 23);

  const ceiling = await holdLayers("layer-ceiling", 100);
  assert.equal(ceiling.estimated_amount, 802);
  await startBcoinJob(ceiling, "layer-ceiling");
  await assert.rejects(() => finishBcoinJob(ceiling, Array(101).fill(1_000_000)));
  assert.equal((await finishBcoinJob(ceiling, Array(100).fill(4_194_304))).actual_credits, 802);
  assert.equal(await balance(), before - 23 - 802);
  console.log("PASS: legacy activation and lease states, 5.5 price snapshot, dynamic preauthorization, replay, 100 images, and exact Bcoin refund");
} finally { await db.close(); }
