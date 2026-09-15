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
  for (const prefix of ["0001", "0002", "0003", "0004", "0009", "0015", "0018", "0023", "0058", "0061"]) {
    const file = fs.readdirSync("apps/cloud/supabase/migrations").find(file => file.startsWith(prefix));
    await db.exec(fs.readFileSync(`apps/cloud/supabase/migrations/${file}`, "utf8").replace("create extension if not exists pgcrypto with schema extensions;", ""));
  }
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
  console.log("PASS: inactive prices, activation guard, lease completion, MIME binding, idempotent settlement, failure refund, unknown hold, RPC privileges");
} finally { await db.close(); }
