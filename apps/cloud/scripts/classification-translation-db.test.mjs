// Isolated PostgreSQL engine; no network or existing user database.
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";
const { PGlite } = await import(pathToFileURL(path.resolve(process.argv[2])).href);
const db = new PGlite();
try {
  await db.exec(`create role anon; create role authenticated; create role service_role; create role supabase_auth_admin;
    create schema auth; create schema extensions; create table auth.users(id uuid primary key);
    create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
    create function extensions.gen_random_uuid() returns uuid language sql as $$ select gen_random_uuid() $$;`);
  for (const prefix of ["0001", "0002", "0003", "0004", "0005", "0006", "0009", "0010", "0011", "0015", "0016", "0017", "0018", "0019", "0023", "0058", "0059", "0061", "0062", "0063", "0064", "0065", "0066", "0067", "0070", "0075"]) {
    const file = fs.readdirSync("apps/cloud/supabase/migrations").find((f) => f.startsWith(prefix));
    await db.exec(fs.readFileSync(`apps/cloud/supabase/migrations/${file}`, "utf8").replace("create extension if not exists pgcrypto with schema extensions;", ""));
  }
  const q = async (sql, args = []) => (await db.query(sql, args)).rows;
  const user = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  await q("insert into auth.users values($1),($2)", [user, other]);
  await q("insert into credit_lots(user_id,bucket,source_key,original_amount,remaining_amount,expires_at) values($1,'topup','test',100,100,now()+interval '1 year')", [user]);
  const begin = async (key) => (await q("select begin_classification($1,$2,'input','image',true,300,1000000,null,null) r", [user, key]))[0].r.request;
  const start = async (r, batch, uid = user) => (await q("select start_classification_translation_usage($1,$2,$3,'ark','endpoint-test') ok", [uid, r.id, batch]))[0].ok;
  const usage = { response_id: "translation-test", model: "vision-test", prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cached_tokens: 0 };
  const record = (r, batch, value = usage, uid = user) => q("select record_classification_translation_usage($1,$2,$3,$4)", [uid, r.id, batch, JSON.stringify(value)]);
  const ledger = async (r, batch) => (await q("select * from classification_translation_usage where classification_id=$1 and batch_index=$2", [r.id, batch]))[0];
  const r = await begin("translations-then-discovery");
  await assert.rejects(() => start(r, 0, other));
  await assert.rejects(() => start(r, -1));
  await assert.rejects(() => start(r, 254));
  assert.equal(await start(r, 0), true);
  assert.equal(await start(r, 0), false);
  assert.equal(await start(r, 1), true);
  assert.equal((await ledger(r, 1)).usage_status, "pending");
  assert.equal((await ledger(r, 1)).total_tokens, null);
  await assert.rejects(() => record(r, 0, usage, other));
  await assert.rejects(() => record(r, 0, { ...usage, prompt: "must not persist" }));
  await record(r, 0); await record(r, 0);
  await assert.rejects(() => record(r, 0, { ...usage, total_tokens: 200 }));
  assert.equal((await ledger(r, 0)).usage_status, "recorded");
  await record(r, 1, {});
  assert.equal((await ledger(r, 1)).usage_status, "missing");
  assert.equal(Number((await q("select count(*) n from credit_holds"))[0].n), 1); // No per-label hold/charge.
  await q("select advance_classification($1,$2,'await_discovery',null,null,'{}',false)", [user, r.id]);
  await assert.rejects(() => start(r, 2));
  await q("select advance_classification($1,$2,'claim_discovery','image','catalogue')", [user, r.id]);
  await q("select start_classification_usage($1,$2,'ark','endpoint-test')", [user, r.id]);
  await q("select record_classification_usage($1,$2,$3)", [user, r.id, JSON.stringify({ ...usage, total_tokens: 300, completion_tokens: 200 })]);
  assert.equal(Number((await q("select total_tokens from classification_usage where classification_id=$1", [r.id]))[0].total_tokens), 300);
  assert.equal(Number((await ledger(r, 0)).total_tokens), 150); // Discovery cannot overwrite translation.
  await q("select advance_classification($1,$2,'fail')", [user, r.id]);
  assert.equal((await q("select status from credit_holds where id=$1", [r.hold_id]))[0].status, "rolled_back");
  await q("update classification_requests set created_at=now()-interval '2 days',judge_response='{}' where id=$1", [r.id]);
  await q("select cleanup_classification()");
  assert.equal(Number((await ledger(r, 0)).total_tokens), 150);
  assert.equal((await q("select judge_response from classification_requests where id=$1", [r.id]))[0].judge_response, null);
  const late = await begin("timeout"); await start(late, 0);
  await q("select advance_classification($1,$2,'fail')", [user, late.id]);
  await record(late, 0);
  assert.equal((await ledger(late, 0)).usage_status, "recorded"); // Late evidence survives failure/expiry.
  for (const role of ["anon", "authenticated"]) {
    assert.equal((await q("select has_table_privilege($1,'classification_translation_usage','SELECT') allowed", [role]))[0].allowed, false);
    assert.equal((await q("select has_function_privilege($1,'start_classification_translation_usage(uuid,uuid,integer,text,text)','EXECUTE') allowed", [role]))[0].allowed, false);
    assert.equal((await q("select has_function_privilege($1,'record_classification_translation_usage(uuid,uuid,integer,jsonb)','EXECUTE') allowed", [role]))[0].allowed, false);
  }
  const staged = await begin("254-rules");
  const claim = async (r, count = 64, uid = user) => (await q("select claim_classification_preparation($1,$2,$3,'ark','endpoint-test') r", [uid, r.id, count]))[0].r;
  const finish = async (r, batch, values) => (await q("select finish_classification_preparation($1,$2,$3,$4) r", [user, r.id, batch, JSON.stringify(values)]))[0].r;
  await assert.rejects(() => claim(staged, 64, other));
  let expected = [];
  for (let batch = 0; batch < 64; batch++) {
    const step = await claim(staged);
    assert.equal(step.phase, "translate"); assert.equal(step.batch, batch);
    assert.equal((await claim(staged)).phase, "busy");
    await record(staged, batch);
    const values = Array.from({ length: batch === 63 ? 2 : 4 }, (_, index) => ({ key: `label_${batch * 4 + index}`, name: "Poster", description: "A complete poster." }));
    expected.push(...values);
    assert.equal((await finish(staged, batch, values)).length, expected.length);
    assert.equal((await finish(staged, batch, values)).length, expected.length);
    await assert.rejects(() => finish(staged, batch, [{ ...values[0], name: "Changed" }]));
  }
  const ready = await claim(staged);
  assert.equal(ready.phase, "judge"); assert.equal(ready.translations.length, 254);
  assert.equal((await claim(staged)).phase, "busy");
  const holdsBefore = Number((await q("select count(*) n from credit_holds"))[0].n);
  // Long actively progressing preparation still permits Cloud fallback.
  await q("update classification_requests set created_at=now()-interval '1 hour' where id=$1", [staged.id]);
  await q("update credit_holds set expires_at=now()-interval '30 minutes' where id=$1", [staged.hold_id]);
  await q("select expire_stale_holds()");
  const reserved = (await q("select status,reserved_cost_micros from credit_holds where id=$1", [staged.hold_id]))[0];
  assert.equal(reserved.status, "pending_settlement"); assert.equal(Number(reserved.reserved_cost_micros), 300);
  await q("select advance_classification($1,$2,'await_discovery',null,null,'{}',false)", [user, staged.id]);
  assert.equal(Number((await q("select count(*) n from classification_preparations where classification_id=$1", [staged.id]))[0].n), 0);
  assert.equal((await q("select advance_classification($1,$2,'claim_discovery','image','catalogue') r", [user, staged.id]))[0].r.claimed, true);
  const paid = (await q("select advance_classification($1,$2,'discovery_done',null,null,'{}',true) r", [user, staged.id]))[0].r;
  assert.equal(paid.charged, 1); // 0070 current per-image price survives the TTL patch.
  assert.equal((await q("select advance_classification($1,$2,'discovery_done',null,null,'{}',true) r", [user, staged.id]))[0].r.charged, 1);
  assert.equal(Number((await q("select count(*) n from credit_holds"))[0].n), holdsBefore);
  const stalled = await begin("stalled"); await claim(stalled, 1);
  await q("update classification_requests set updated_at=now()-interval '11 minutes' where id=$1", [stalled.id]);
  await assert.rejects(() => claim(stalled, 1));
  await q("select cleanup_classification()");
  assert.equal(Number((await q("select count(*) n from classification_preparations where classification_id=$1", [stalled.id]))[0].n), 0);
  assert.equal((await q("select status from credit_holds where id=$1", [stalled.hold_id]))[0].status, "rolled_back");
  assert.equal((await ledger(stalled, 0)).usage_status, "pending");
  for (const role of ["anon", "authenticated"]) {
    assert.equal((await q("select has_table_privilege($1,'classification_preparations','SELECT') allowed", [role]))[0].allowed, false);
    assert.equal((await q("select has_function_privilege($1,'claim_classification_preparation(uuid,uuid,integer,text,text)','EXECUTE') allowed", [role]))[0].allowed, false);
    assert.equal((await q("select has_function_privilege($1,'finish_classification_preparation(uuid,uuid,integer,jsonb)','EXECUTE') allowed", [role]))[0].allowed, false);
  }
  console.log("classification translation ledger: migration, isolation, idempotency, retained usage, refunds and RPC permissions passed");
} finally { await db.close(); }
