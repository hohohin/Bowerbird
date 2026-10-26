import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
const { PGlite } = await import(pathToFileURL(path.resolve(process.argv[2])).href);
const db = new PGlite();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const actor = randomUUID(), customer = randomUUID(), other = randomUUID();
const codes = (count) => Array.from({ length: count }, () => ({ id: randomUUID(), hash: createHash("sha256").update(randomUUID()).digest("hex"), suffix: "ABCD1234", ciphertext: "encrypted-fixture-".repeat(5) }));
const issue = async (batch, label, items, who = actor) => (await q("select admin_issue_pro_codes($1,$2,$3,'2027-01-01T00:00:00Z',$4::jsonb) r", [who, batch, label, JSON.stringify(items)]))[0].r;
const list = async (status = "", search = "", batch = null, page = 0, who = actor) => (await q("select admin_list_pro_codes($1,$2,$3,$4,$5) r", [who, status, search, batch, page]))[0].r;
const disable = async (id) => (await q("select admin_disable_pro_code($1,$2) r", [actor, id]))[0].r;
const reveal = async (batch, code) => (await q("select admin_read_pro_codes($1,$2,$3) r", [actor, batch, code]))[0].r;
const users = async (search = "", filter = "", page = 0, who = actor) => (await q("select admin_list_users($1,$2,$3,$4) r", [who, search, filter, page]))[0].r;
const setTest = async (id, enabled, who = actor) => (await q("select admin_set_test_account($1,$2,$3) r", [who, id, enabled]))[0].r;
try {
  await db.exec(`create role anon; create role authenticated; create role service_role; create role supabase_auth_admin;
    create schema auth; create schema extensions;
    create table auth.users(id uuid primary key, email text, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
      created_at timestamptz default now(), updated_at timestamptz default now(), last_sign_in_at timestamptz, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
    create function extensions.gen_random_uuid() returns uuid language sql as $$ select gen_random_uuid() $$;`);
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const prefix of ["0001", "0002", "0003", "0008", "0059", "0060", "0069", "0076"]) {
    await db.exec(readFileSync(new URL(readdirSync(dir).find((n) => n.startsWith(prefix)), dir), "utf8").replace("create extension if not exists pgcrypto with schema extensions;", ""));
  }
  await q("insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values($1,'admin@example.test','{\"bowerbird_admin\":true}','{}'),($2,'reader@example.test','{}','{\"bowerbird_admin\":true}'),($3,'other@example.test','{\"bowerbird_admin\":\"true\"}','{}')", [actor, customer, other]);
  for (const who of [customer, other]) {
    await assert.rejects(users("", "", 0, who), /admin required/);
    await assert.rejects(setTest(customer, true, who), /admin required/);
  }
  assert.equal((await users("READER@")).total, 1);
  assert.equal((await users(customer)).rows[0].id, customer);
  assert.equal((await users("%_")).total, 0, "search treats SQL wildcards as literal text");
  await q("update auth.users set raw_user_meta_data = raw_user_meta_data || $1::jsonb where id in ($2,$3)",
    [JSON.stringify({ nickname: "  小鸟 Bird  ", unionid: "private-provider-identifier" }), customer, other]);
  const namesakes = await users("小鸟 bIRD");
  assert.equal(namesakes.total, 2);
  assert.equal(new Set(namesakes.rows.map((r) => r.id)).size, 2, "duplicate nicknames never merge identities");
  assert.equal(namesakes.rows.every((r) => r.nickname === "小鸟 Bird"), true);
  assert.equal(JSON.stringify(namesakes).includes("private-provider-identifier"), false);
  assert.equal(JSON.stringify(namesakes).includes("raw_user_meta_data"), false);
  assert.equal((await users(actor)).rows[0].nickname, null);
  for (const nickname of ["   ", 123, { name: "object" }, null]) {
    await q("update auth.users set raw_user_meta_data = $1::jsonb where id=$2", [JSON.stringify({ nickname }), actor]);
    assert.equal((await users(actor)).rows[0].nickname, null);
  }
  await q("update auth.users set raw_user_meta_data = $1::jsonb where id=$2", [JSON.stringify({ nickname: "literal%_name" }), actor]);
  assert.equal((await users("%_")).rows[0].id, actor);
  assert.equal((await users("' OR 1=1 --")).total, 0);
  assert.equal((await users("", "test")).total, 0);
  await q("update auth.users set raw_app_meta_data = '{\"provider\":\"email\",\"bowerbird_test\":\"true\"}' where id=$1", [customer]);
  assert.equal((await users("", "test")).total, 0, "string true is not a test account");
  assert.equal((await setTest(customer, true)).is_test_account, true);
  await setTest(customer, true);
  assert.equal((await users("", "test")).total, 1);
  assert.equal((await users(other)).rows[0].is_test_account, false, "changing one UUID leaves its namesake unchanged");
  assert.equal((await users("", "regular")).total, 2);
  assert.equal((await q("select raw_app_meta_data->>'provider' p from auth.users where id=$1", [customer]))[0].p, "email");
  assert.equal((await q("select count(*)::int n from user_admin_events"))[0].n, 1, "retries do not duplicate audit events");
  await setTest(customer, false);
  assert.equal((await users("", "test")).total, 0);
  assert.deepEqual((await q("select raw_app_meta_data m from auth.users where id=$1", [customer]))[0].m, { provider: "email" });
  assert.equal((await setTest(randomUUID(), true)).status, "not_found");
  await assert.rejects(setTest(customer, null), /invalid test account/);
  await assert.rejects(users("", "invalid"), /invalid user filter/);
  await assert.rejects(users("", "", -1), /invalid user filter/);
  assert.equal(JSON.stringify(await users()).includes("raw_app_meta_data"), false);
  const billingBefore = await q("select * from subscriptions where user_id=$1", [actor]);
  const creditsBefore = await q("select * from user_credits where user_id=$1", [actor]);
  await setTest(actor, true); await setTest(actor, false);
  assert.equal((await users(actor)).rows[0].is_admin, true, "changing own test access preserves admin authorization");
  assert.deepEqual(await q("select * from subscriptions where user_id=$1", [actor]), billingBefore);
  assert.deepEqual(await q("select * from user_credits where user_id=$1", [actor]), creditsBefore);
  for (let i = 0; i < 51; i++) await q("insert into auth.users(id,email) values($1,$2)", [randomUUID(), `paged-${i}@example.test`]);
  const userFirst = await users("paged-"), userSecond = await users("paged-", "", 1);
  assert.equal(userFirst.rows.length, 50); assert.equal(userSecond.rows.length, 1);
  assert.equal(new Set([...userFirst.rows, ...userSecond.rows].map((r) => r.id)).size, 51);
  await assert.rejects(list("", "", null, 0, customer), /admin required/);
  await assert.rejects(list("", "", null, 0, other), /admin required/);
  const batch = randomUUID(), items = codes(53);
  assert.equal((await issue(batch, "September invites", items)).created, true);
  assert.equal((await issue(batch, "September invites", codes(53))).created, false);
  assert.equal((await list()).stats.total, 53);
  await assert.rejects(issue(batch, "different contents", items), /batch request conflict/);
  const first = await list(), second = await list("", "", batch, 1);
  assert.equal(first.rows.length, 50); assert.equal(second.rows.length, 3);
  assert.equal(new Set([...first.rows, ...second.rows].map((r) => r.id)).size, 53);
  assert.equal(JSON.stringify(first).includes("ciphertext"), false);
  assert.equal(JSON.stringify(first).includes(items[0].hash), false);
  assert.equal((await list("", "September")).total, 53);
  assert.equal((await list("", "ABCD1234")).total, 53);
  assert.equal((await list("", "nomatch")).total, 0);
  assert.equal((await reveal(batch, null)).length, 53);
  assert.equal((await reveal(null, items[0].id))[0].ciphertext, items[0].ciphertext);
  await assert.rejects(reveal(batch, items[0].id), /one target required/);
  assert.equal((await disable(items[0].id)).status, "disabled");
  assert.equal((await disable(items[0].id)).status, "disabled");
  assert.equal((await reveal(null, items[0].id)).length, 0);
  assert.equal((await q("select redeem_pro_code($1,$2) r", [customer, items[0].hash]))[0].r.status, "invalid_code");
  assert.equal((await q("select redeem_pro_code($1,$2) r", [customer, items[1].hash]))[0].r.status, "redeemed");
  assert.equal((await disable(items[1].id)).status, "already_redeemed");
  assert.equal((await reveal(null, items[1].id)).length, 0);
  assert.equal((await list("redeemed", "reader@example.test")).rows[0].redeemed_by, customer);
  assert.equal((await q("select tier from subscriptions where user_id=$1", [customer]))[0].tier, "pro");
  await q("update pro_redemption_codes set expires_at=now()-interval '1 day' where id=$1", [items[2].id]);
  assert.equal((await list("expired")).total, 1);
  assert.equal((await reveal(batch, null)).length, 50);
  const audit = await q("select action,count(*)::int n from pro_code_admin_events group by action");
  assert.equal(audit.find((r) => r.action === "issue").n, 1); assert.equal(audit.find((r) => r.action === "disable").n, 1);
  const bad = codes(2); bad[1].hash = bad[0].hash;
  await assert.rejects(issue(randomUUID(), "rollback", bad), /unique constraint/);
  assert.equal((await q("select count(*)::int n from pro_code_batches where label='rollback'"))[0].n, 0);
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    await assert.rejects(users(), /permission denied/); await assert.rejects(setTest(customer, true), /permission denied/);
    await assert.rejects(q("select * from user_admin_events"), /permission denied/);
    for (const table of ["pro_code_batches", "pro_code_admin_events", "pro_code_admin_inventory", "pro_redemption_codes"]) await assert.rejects(q(`select * from ${table}`), /permission denied/);
    await assert.rejects(list(), /permission denied/); await assert.rejects(disable(items[3].id), /permission denied/);
    await assert.rejects(reveal(batch, null), /permission denied/); await assert.rejects(issue(randomUUID(), "forged", codes(1)), /permission denied/);
    await db.exec("reset role");
  }
  await q("update auth.users set raw_app_meta_data='{}' where id=$1", [actor]);
  await assert.rejects(users(), /admin required/); await assert.rejects(setTest(customer, true), /admin required/);
  await assert.rejects(list(), /admin required/); await assert.rejects(disable(items[3].id), /admin required/);
  await assert.rejects(reveal(batch, null), /admin required/); await assert.rejects(issue(randomUUID(), "revoked", codes(1)), /admin required/);
  console.log("PASS: voucher regression; user search/filter/pagination, strict claims, narrow metadata changes, idempotent audit, unchanged billing, RLS and immediate revocation");
} finally { await db.close(); }
