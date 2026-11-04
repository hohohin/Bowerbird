import test from "node:test";
import assert from "node:assert/strict";
import { runWechatMaintenance, previousChinaDay } from "./wechatpay-maintenance.mjs";
const env = { SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", WECHAT_PAY_RECONCILE_TOKEN: "x".repeat(32) };
test("maintenance uses only fixed official endpoint, auth and no redirects", async () => {
  const requests = [];
  const result = await runWechatMaintenance({ env, transport: async (url, init) => {
    requests.push({ url: String(url), init }); return Response.json({ processed: 3, failed: 0, secret: "must-not-appear" });
  } });
  assert.equal(requests[0].url, "https://abcdefghijklmnopqrst.supabase.co/functions/v1/payment-reconcile?forceFunctionRegion=ap-northeast-1");
  assert.equal(requests[0].init.headers.authorization, `Bearer ${env.WECHAT_PAY_RECONCILE_TOKEN}`);
  assert.equal(requests[0].init.redirect, "error"); assert.equal(requests[0].init.body, "{}");
  assert.deepEqual(result, { task: "reconcile", processed: 3, failed: 0 });
});
test("daily date uses Beijing yesterday and supports explicit backfill", async () => {
  const now = new Date("2026-11-04T02:30:00Z");
  assert.equal(previousChinaDay(new Date("2026-11-03T16:00:01Z")), "2026-11-03");
  for (const date of [undefined, "2026-11-01"]) {
    const expected = date ?? "2026-11-03";
    const result = await runWechatMaintenance({ env, now, mode: "bill", date, transport: async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body), { bill_date: expected });
      return Response.json({ bill_date: expected, status: "matched", payment_count: 2, refund_count: 0, difference_count: 0 });
    } });
    assert.equal(result.bill_date, expected);
  }
});
test("invalid URLs, credentials, modes and calendar dates never call transport", async () => {
  const transport = () => { assert.fail("must not make a request"); };
  for (const options of [
    { env: { ...env, SUPABASE_URL: "https://supabase.co.evil.invalid" } },
    { env: { ...env, SUPABASE_URL: `${env.SUPABASE_URL}/other` } },
    { env: { ...env, WECHAT_PAY_RECONCILE_TOKEN: "short" } },
    { mode: "refund" }, { mode: "bill", date: "2026-02-30" }, { mode: "bill", date: "2099-01-01" },
  ]) await assert.rejects(runWechatMaintenance({ env, transport, ...options }));
});
test("errors and response payloads cannot expose credentials; failed jobs exit as attention", async () => {
  for (const transport of [
    async () => { throw new Error(env.WECHAT_PAY_RECONCILE_TOKEN); },
    async () => new Response(env.WECHAT_PAY_RECONCILE_TOKEN, { status: 500 }),
    async () => Response.json({ processed: 0, failed: 1, token: env.WECHAT_PAY_RECONCILE_TOKEN }),
    async () => new Response("x".repeat(32769)),
  ]) await assert.rejects(runWechatMaintenance({ env, transport }), error => !JSON.stringify(error).includes(env.WECHAT_PAY_RECONCILE_TOKEN));
  await assert.rejects(runWechatMaintenance({ env, mode: "bill", date: "2026-11-01", now: new Date("2026-11-04"),
    transport: async () => Response.json({ bill_date: "2026-11-01", status: "differences", payment_count: 1, refund_count: 0, difference_count: 1 }) }),
    { code: "PAYMENT_BILL_NEEDS_ATTENTION" });
});
