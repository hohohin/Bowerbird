// Isolated real PostgreSQL semantics via an existing local PGlite module; no production connection.
import { readFileSync, readdirSync, mkdtempSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
const { PGlite } = await import(pathToFileURL(path.resolve(process.argv[2])).href);
const db = new PGlite();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const user = async () => { const id = randomUUID(); await q("insert into auth.users values($1)", [id]); return id; };
const issue = async (expiry = "1 day") => {
  const hash = createHash("sha256").update(randomUUID()).digest("hex");
  const [row] = await q("insert into pro_redemption_codes(code_hash, expires_at) values($1, now() + $2::interval) returning id", [hash, expiry]);
  return { ...row, hash };
};
const redeem = async (id, hash) => (await q("select redeem_pro_code($1,$2) as result", [id, hash]))[0].result;
const sub = async (id) => (await q("select * from subscriptions where user_id=$1", [id]))[0];
try {
  await db.exec(`create role anon; create role authenticated; create role service_role; create role supabase_auth_admin;
    create schema auth; create schema extensions;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
    create function extensions.gen_random_uuid() returns uuid language sql as $$ select gen_random_uuid() $$;`);
  const migrations = new URL("../supabase/migrations/", import.meta.url);
  for (const prefix of ["0001", "0002", "0003", "0008", "0059"]) {
    const file = readdirSync(migrations).find((name) => name.startsWith(prefix));
    await db.exec(readFileSync(new URL(file, migrations), "utf8").replace("create extension if not exists pgcrypto with schema extensions;", ""));
  }
  mkdirSync(".tmp", { recursive: true });
  const issuanceDir = mkdtempSync(path.resolve(".tmp/pro-redemption-test-"));
  const issuer = new URL("./create-pro-codes.mjs", import.meta.url);
  const { fileURLToPath } = await import("node:url");
  const output = execFileSync(process.execPath, [fileURLToPath(issuer), "3", "2030-01-01T00:00:00Z", issuanceDir], { encoding: "utf8" });
  const files = readdirSync(issuanceDir);
  const issued = JSON.parse(readFileSync(path.join(issuanceDir, files.find((f) => f.endsWith(".json"))), "utf8"));
  const sql = readFileSync(path.join(issuanceDir, files.find((f) => f.endsWith(".sql"))), "utf8");
  assert.equal(new Set(issued.codes.map((c) => c.code)).size, 3);
  for (const item of issued.codes) {
    assert.equal(item.hash, createHash("sha256").update(item.code.replaceAll("-", "")).digest("hex"));
    assert.equal(output.includes(item.code), false); assert.equal(sql.includes(item.code), false);
  }
  await db.exec(sql); await db.exec(sql);
  assert.equal((await q("select count(*)::int n from pro_redemption_codes"))[0].n, 3);
  assert.equal((await redeem(await user(), issued.codes[0].hash)).status, "redeemed");
  const a = await user(), b = await user(), code = await issue();
  const first = await redeem(a, code.hash);
  assert.equal(first.status, "redeemed"); assert.equal(first.credits, 1100); assert.equal(first.already_redeemed, false);
  assert.equal((await sub(a)).tier, "pro"); assert.equal((await sub(a)).provider, "redemption");
  assert.equal((await sub(a)).entitlement_version, 2);
  assert.equal((await q("select sub_balance from user_credits where user_id=$1", [a]))[0].sub_balance, 1100);
  assert.equal((await q("select original_amount from credit_lots where user_id=$1 and bucket='sub'", [a]))[0].original_amount, 1100);
  assert.equal((await q("select round(extract(epoch from (credits_expires_at-redeemed_at))/86400)::int as days from pro_code_redemptions where user_id=$1", [a]))[0].days, 30);
  const replay = await redeem(a, code.hash);
  assert.equal(replay.already_redeemed, true); assert.equal(replay.period_end, first.period_end);
  assert.equal((await sub(a)).entitlement_version, 2);
  assert.equal((await redeem(b, code.hash)).status, "invalid_code");
  await q("update pro_redemption_codes set disabled_at=now(), expires_at=now()-interval '1 day' where id=$1", [code.id]);
  assert.equal((await redeem(a, code.hash)).already_redeemed, true);
  const second = await issue();
  await q("update subscriptions set current_period_end='2028-01-31T04:00:00Z', provider='paddle', provider_subscription_id='paid-existing', period='yearly' where user_id=$1", [a]);
  const extended = await redeem(a, second.hash);
  assert.equal(new Date(extended.period_end).toISOString(), "2028-02-29T04:00:00.000Z");
  assert.equal((await sub(a)).provider_subscription_id, "paid-existing"); assert.equal((await sub(a)).period, "yearly");
  assert.equal((await q("select sub_balance from user_credits where user_id=$1", [a]))[0].sub_balance, 2200);
  assert.equal((await q("select count(*)::int as n from credit_transactions where user_id=$1 and amount=1100", [a]))[0].n, 2);

  const expired = await issue("-1 day"), disabled = await issue();
  await q("update pro_redemption_codes set disabled_at=now() where id=$1", [disabled.id]);
  for (const hash of [expired.hash, disabled.hash, "f".repeat(64)]) assert.equal((await redeem(b, hash)).status, "invalid_code");
  await q("update subscriptions set tier='studio',current_period_end=now()+interval '1 year' where user_id=$1", [b]);
  const studioCode = await issue();
  assert.equal((await redeem(b, studioCode.hash)).status, "studio_active");
  assert.equal((await sub(b)).tier, "studio");
  await q("update subscriptions set tier='pro',current_period_end=null where user_id=$1", [b]);
  assert.equal((await redeem(b, studioCode.hash)).status, "permanent_pro");
  await q("update subscriptions set status='expired' where user_id=$1", [b]);
  assert.equal((await redeem(b, studioCode.hash)).status, "redeemed");

  // PostgreSQL exception during credit grant must roll back subscription and voucher consumption.
  const c = await user(), rollback = await issue();
  await db.exec(`create function fail_test_grant() returns trigger language plpgsql as $$ begin
    if new.amount=1100 then raise exception 'injected grant failure'; end if; return new; end $$;
    create trigger fail_test_grant before insert on credit_transactions for each row execute function fail_test_grant();`);
  await assert.rejects(redeem(c, rollback.hash), /injected grant failure/);
  assert.equal((await sub(c)).tier, "free");
  assert.equal((await q("select count(*)::int n from pro_code_redemptions where code_id=$1", [rollback.id]))[0].n, 0);
  assert.equal((await q("select sub_balance from user_credits where user_id=$1", [c]))[0].sub_balance, 0);
  await db.exec("drop trigger fail_test_grant on credit_transactions");
  assert.equal((await redeem(c, rollback.hash)).status, "redeemed");

  const limited = await user(), limitCode = await issue();
  for (let i = 0; i < 10; i++) assert.equal((await redeem(limited, "0".repeat(64))).status, "invalid_code");
  assert.equal((await redeem(limited, limitCode.hash)).status, "rate_limited");
  await q("update pro_redemption_attempts set window_start=now()-interval '16 minutes' where user_id=$1", [limited]);
  assert.equal((await redeem(limited, limitCode.hash)).status, "redeemed");

  // PGlite queues these calls on one connection; real multi-connection races still need staging PG.
  const contenders = [await user(), await user()], contested = await issue();
  const results = await Promise.all(contenders.map((id) => redeem(id, contested.hash)));
  assert.equal(results.filter((r) => r.status === "redeemed").length, 1);
  assert.equal(results.filter((r) => r.status === "invalid_code").length, 1);
  assert.equal((await redeem(randomUUID(), contested.hash)).status, "unauthorized");
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    await assert.rejects(q("select * from pro_redemption_codes"), /permission denied/);
    await assert.rejects(q("select * from pro_code_redemptions"), /permission denied/);
    await assert.rejects(redeem(a, code.hash), /permission denied/);
    await assert.rejects(q("update subscriptions set tier='pro' where user_id=$1", [a]), /permission denied/);
    await db.exec("reset role");
  }
  console.log("PASS: issuance, Pro + 1100 credits, replay, renewal/month-end, expiry, Studio protection, atomic rollback, rate limit, single winner and client permissions");
} finally { await db.close(); }
