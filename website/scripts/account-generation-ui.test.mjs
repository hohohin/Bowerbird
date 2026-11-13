import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chromium } from "../../apps/html-renderer/node_modules/playwright/index.mjs";

const cloud = "https://fixture.supabase.co";
process.env.SUPABASE_URL = cloud;
process.env.SUPABASE_PUBLISHABLE_KEY = "fixture-key";
const { startServer } = await import("../server.mjs");
const owner = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBeUAAAAASUVORK5CYII=", "base64");
const path = "/storage/v1/object/sign/generation-temp/jobs/" + jobId + "/outputs/result.png";
const artifact = { url: cloud + path + "?token=fixture", bytes: image.length, mime: "image/png",
  sha256: createHash("sha256").update(image).digest("hex") };
const expiry = Math.floor(Date.now() / 1000) + 3600;
const jwt = [{ alg: "HS256", typ: "JWT" }, { sub: owner, role: "authenticated", exp: expiry }, "fixture"]
  .map(part => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".");
const session = { access_token: jwt, refresh_token: "fixture", expires_at: expiry, expires_in: 3600,
  token_type: "bearer", user: { id: owner, email: "fixture@example.test", user_metadata: {} } };
const actions = [];
let key, ready = false, corrupt = true;
let independent = false, archivedFinished = false, missing = false, createAttempts = 0;
const intents = new Map(), historyReads = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  assert.equal(url.origin, cloud);
  if (url.pathname === path) {
    actions.push("download");
    return new Response(corrupt ? Buffer.alloc(image.length) : image, { headers: { "Content-Type": "image/png" } });
  }
  assert.equal(url.pathname, "/functions/v1/generate-proxy");
  const body = JSON.parse(options.body);
  actions.push(body.action || "create");
  if (independent) {
    assert.ok(body.idempotency_key);
    if (!body.action) {
      createAttempts++;
      assert.ok(!intents.has(body.idempotency_key));
      intents.set(body.idempotency_key, body.prompt);
    } else {
      assert.equal(body.action, "get_by_key");
      assert.ok(intents.has(body.idempotency_key));
      historyReads.push(body.idempotency_key);
      if (missing) return Response.json({ status: "not_found" }, { status: 404 });
    }
    const first = intents.keys().next().value;
    return Response.json({ status: archivedFinished && body.idempotency_key === first ? "failed" : "outcome_unknown" });
  }
  if (!body.action) {
    assert.equal(key, undefined, "exactly one paid create");
    assert.ok(body.prompt && Array.isArray(body.reference_images));
    key = body.idempotency_key;
    assert.match(key, /^[a-f0-9-]{36}$/);
    return Response.json({ status: "queued", job_id: jobId }, { status: 202 });
  }
  if (body.action === "get_by_key") assert.equal(body.idempotency_key, key);
  else assert.equal(body.job_id, jobId);
  if (body.action === "artifact_received") return Response.json({ status: "received", job_id: jobId });
  return ready ? Response.json({ status: "succeeded", job_id: jobId, artifact })
    : Response.json({ status: "running", job_id: jobId }, { status: 202 });
};
const server = startServer({ host: "127.0.0.1", port: 0, root: fileURLToPath(new URL("../dist", import.meta.url)) });
await once(server, "listening");
const origin = "http://127.0.0.1:" + server.address().port;
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext();
  await context.addInitScript(session => {
    if (!sessionStorage.seeded) {
      localStorage.setItem("sb-fixture-auth-token", JSON.stringify({ ...session, expires_at: 1 }));
      sessionStorage.seeded = "1";
    }
  }, session);
  let signouts = 0, refreshes = 0;
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.origin === cloud && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      refreshes++;
      return route.fulfill({ json: session });
    }
    if (url.origin === cloud && url.pathname === "/auth/v1/logout") {
      signouts++;
      return route.fulfill({ status: 204 });
    }
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(origin);
  await page.getByText(/已登录 · fixture/).waitFor();
  await page.locator("#generate-image").click();
  await page.waitForResponse(r => r.url().includes("/api/cloud/functions/"));
  ready = true;
  await page.reload();
  await page.getByText("暂未获得生成结果", { exact: false }).waitFor();
  assert.ok(actions.includes("get_by_key"));
  assert.ok(!actions.includes("artifact_received"));
  corrupt = false;
  await page.locator("#generate-image").click();
  await page.waitForFunction(() => document.querySelector("#generated-image")?.naturalWidth === 1);
  await page.waitForFunction(() => !document.querySelector("#generate-image").disabled);
  assert.equal(actions.filter(x => x === "create").length, 1);
  assert.equal(actions.filter(x => x === "artifact_received").length, 1);
  await page.reload();
  await page.waitForFunction(() => document.querySelector(".generated-asset img")?.naturalWidth === 1);
  assert.ok(refreshes > 0);
  independent = true;
  const create = page.getByRole("button", { name: /按当前输入另建/ });
  await page.locator("#generate-image").click();
  await create.waitFor();
  const original = intents.keys().next().value;
  const stale = await context.newPage();
  await stale.goto(origin);
  await stale.getByRole("button", { name: /按当前输入另建/ }).waitFor();
  await page.locator(".ProseMirror").first().fill("a different image");
  missing = true;
  await page.locator("#generate-image").click();
  await page.waitForFunction(() => !document.querySelector("#generate-image").disabled);
  assert.equal(intents.size, 1, "ordinary retry after editing only queries the original");
  assert.equal(createAttempts, 1, "even a missing lookup for a previously accepted intent must not resubmit");
  missing = false;
  await create.click();
  await page.getByRole("button", { name: /查询旧任务/ }).waitFor();
  assert.equal(intents.size, 2);
  const successor = [...intents.keys()][1];
  assert.match(intents.get(successor), /a different image/);
  assert.notEqual(successor, original);
  await stale.getByRole("button", { name: /按当前输入另建/ }).click();
  await stale.getByRole("button", { name: /查询旧任务/ }).waitFor();
  assert.equal(intents.size, 2, "a stale tab cannot create a third billable request");
  await stale.close();
  await page.reload();
  const archived = page.getByRole("button", { name: /查询旧任务/ });
  await archived.waitFor();
  await archived.click();
  await page.waitForFunction(() => !document.querySelector("#generate-image").disabled);
  assert.equal(historyReads.at(-1), original);
  archivedFinished = true;
  await archived.click();
  await archived.waitFor({ state: "detached" });
  await page.locator("#generate-image").click();
  await page.waitForFunction(() => !document.querySelector("#generate-image").disabled);
  assert.equal(historyReads.at(-1), successor);
  assert.equal(intents.size, 2, "refresh and old task lookups must never create");
  assert.equal(createAttempts, 2);
  await page.getByRole("button", { name: "我的账号" }).click();
  assert.equal(await page.locator("dialog .account-gift").isVisible(), false);
  await page.keyboard.press("Escape");
  await page.locator("#account-state").click();
  await page.getByText("登录后使用云端积分").waitFor();
  assert.equal(await page.getByRole("button", { name: "登录 / 注册" }).isVisible(), true);
  assert.equal(signouts, 1);
  assert.equal(await page.locator(".generated-asset").count(), 0);
  assert.equal(await create.count(), 0);
  console.log("PASS unknown-job retry, explicit independently billed intent, stale tab, archived lookup, refresh and owner isolation");
  console.log("PASS frozen SDK, session refresh, one create, refresh recovery, artifact rejection, persistent delivery, receipt, sign-out isolation");
} finally {
  await browser?.close();
  globalThis.fetch = originalFetch;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
