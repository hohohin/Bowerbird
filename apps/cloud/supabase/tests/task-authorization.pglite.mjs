import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
// The caller supplies a local PGlite install; no network or production connection is used.
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const id = "11111111-1111-4111-8111-111111111111";
const lease = "22222222-2222-4222-8222-222222222222";
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key, raw_app_meta_data jsonb);
    create table billing_accounts(id uuid primary key, auth_user_id uuid);
    create table user_credits(user_id uuid primary key);
    create table credit_holds(id uuid primary key, user_id uuid, status text, service text, estimated_amount integer, reserved_cost_micros bigint, updated_at timestamptz);
    create table credit_lots(id uuid primary key, user_id uuid, remaining_amount integer, expires_at timestamptz, created_at timestamptz, bucket text);
    create table credit_hold_allocations(user_id uuid, hold_id uuid, lot_id uuid, amount integer, primary key(hold_id,lot_id));
    create table credit_transactions(user_id uuid, hold_id uuid, lot_id uuid, kind text, amount integer, service text);
    create table system_usage_daily(business_date date primary key, request_count integer, cost_micros bigint, updated_at timestamptz);
    create table usage_daily(user_id uuid, business_date date, request_count integer, cost_micros bigint, primary key(user_id,business_date));
    create function refresh_user_credit_snapshot(uuid) returns void language sql as 'select';
    create table agent_runs(id uuid primary key, user_id uuid, skill_id text, status text, approved_plan_hash text,
      budget_credits integer, hold_id uuid, lease_id uuid, lease_expires_at timestamptz);
    create table agent_approvals(id uuid primary key, run_id uuid, proposal_hash text, status text, requested_at timestamptz);
    create table agent_tool_calls(run_id uuid, call_id text, phase text, tool_name text, primary key(run_id,call_id));
    create table agent_usage_items(run_id uuid, credits integer);
  `);
  for (const migration of ["0055_agent_task_authorization.sql", "0056_agent_test_variable_budget.sql"]) {
    await db.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  await db.exec(`
    insert into auth.users values ('${id}', '{"bowerbird_test":true}');
    insert into billing_accounts values ('${id}','${id}'); insert into user_credits values ('${id}');
    insert into credit_holds values ('${id}','${id}','held','agent_unified_test',30,1410000,now());
    insert into credit_lots values ('${id}','${id}',1000,now()+interval '1 day',now(),'sub');
    insert into agent_runs values ('${id}','${id}','bowerbird-unified-agent','running','approved',30,'${id}','${lease}',now()+interval '1 hour');
    insert into agent_approvals values ('${id}','${id}','approved','approved',now(),
      '{"modelTurns":2,"outputCount":10,"capabilities":[{"tool":"generate_image","maxCalls":11}]}');
  `);
  const extend = (budget) => db.query("select extend_agent_test_budget($1,$2,$3,47000,500000000) as budget", [id, lease, budget]);
  assert.equal((await extend(80)).rows[0].budget, 80);
  await extend(80);
  assert.equal((await db.query("select remaining_amount from credit_lots")).rows[0].remaining_amount, 950);
  assert.equal((await db.query("select sum(amount) as amount from credit_transactions")).rows[0].amount, -50);
  await assert.rejects(extend(2000), /insufficient credits/);
  assert.equal((await db.query("select remaining_amount from credit_lots")).rows[0].remaining_amount, 950);
  await db.exec(`update auth.users set raw_app_meta_data='{}';`);
  await assert.rejects(extend(100), /test account required/);
  await db.exec(`update auth.users set raw_app_meta_data='{"bowerbird_test":true}';`);
  const insert = (call, tool) => db.query("insert into agent_tool_calls values ($1,$2,'execute_approved_plan',$3,null)", [id, call, tool]);
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => insert(`image-${index}`, "generate_image")));
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 11);
  assert.equal(attempts.filter((item) => item.status === "rejected").length, 1);
  await assert.rejects(insert("html-1", "compose_html"), /capability_denied/);
  await insert("model-1", "model_turn"); await insert("model-2", "model_turn");
  await assert.rejects(insert("model-3", "model_turn"), /quota_exhausted/);
  await db.query("insert into agent_usage_items values ($1,79)", [id]);
  await assert.rejects(db.query("insert into agent_usage_items values ($1,2)", [id]), /budget_exceeded/);
  await db.query("insert into agent_usage_items values ($1,1)", [id]);
  assert.equal((await db.query("select sum(credits) as total from agent_usage_items")).rows[0].total, 80);
  await db.exec("update agent_approvals set task_policy = null");
  await insert("legacy-html", "compose_html");
  console.log("PASS: migrations, variable test budget, idempotent extension, rollback, non-test denial, quotas, model ceiling, atomic usage and legacy compatibility");
} finally { await db.close(); }
