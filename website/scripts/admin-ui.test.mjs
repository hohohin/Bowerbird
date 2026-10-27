import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../apps/html-renderer/node_modules/playwright/index.mjs";
import { startServer } from "../server.mjs";

const root = path.resolve(process.argv[2] || fileURLToPath(new URL("../", import.meta.url)));
const server = startServer({ root, host: "127.0.0.1", port: 1564 });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1512, height: 1040 } });
  const page = await context.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  let denied = false, failIssue = false, issues = 0, exports = 0;
  let failUserUpdate = false, userUpdates = 0, lastUpdatedUserId;
  let holdUserList = false, releaseUserList;
  const users = Array.from({ length: 52 }, (_, i) => ({ id: `33333333-3333-4333-8333-${String(i + 1).padStart(12, "0")}`,
    email: i === 0 ? '<img src=x onerror=alert(1)>@example.test' : `user${i}@example.test`, is_test_account: i === 1, is_admin: i === 0,
    nickname: i === 0 ? '<img src=x onerror=alert(1)>' : i === 1 || i === 2 ? "小鸟 Bird" : i === 3 ? null : `创作者 ${i}`,
    created_at: "2026-10-22T00:00:00Z", last_sign_in_at: i ? null : "2026-10-22T01:00:00Z" }));
  let batches = [{ id: "11111111-1111-4111-8111-111111111111", label: "九月内测 · 创作者邀请", code_count: 4 }];
  let rows = ["unused", "redeemed", "disabled", "expired"].map((status, i) => ({
    id: `22222222-2222-4222-8222-${String(i + 1).padStart(12, "0")}`, batch_id: batches[0].id, batch_label: batches[0].label,
    code_suffix: ["F72A803B", "B45C291E", "AD915E73", "820CB663"][i], status, can_reveal: true,
    created_at: "2026-09-14T00:00:00Z", expires_at: "2026-12-31T15:59:00Z",
    redeemed_by: i === 1 ? "test-recipient" : null, redeemed_email: i === 1 ? "creator@example.test" : null,
    redeemed_at: i === 1 ? "2026-09-14T03:12:00Z" : null,
  }));
  const issuedBatches = new Set();
  const plain = "A1B2C3D4-E5F60718-293A4B5C-6D7E8F90";
  await context.addInitScript(() => {
    let listener;
    let current = { access_token: "synthetic-token", user: { id: "admin-user", email: "admin@example.test" } };
    window.supabase = { createClient: () => ({ auth: {
      getSession: async () => ({ data: { session: current } }),
      refreshSession: async () => ({ data: { session: current } }),
      signInWithOtp: async () => ({ error: null }),
      onAuthStateChange: (fn) => { listener = fn; },
      signOut: async () => { current = null; listener?.("SIGNED_OUT", null); return {}; },
    } }) };
  });
  await context.route("https://cdn.jsdelivr.net/**", (route) => route.fulfill({ body: "", contentType: "application/javascript" }));
  await context.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ body: "", contentType: "text/css" }));
  await context.route("**/api/image-config", (route) => route.fulfill({ json: { supabaseUrl: "https://admin-fixture.supabase.co", supabasePublishableKey: "test-publishable" } }));
  await context.route("https://admin-fixture.supabase.co/**", async (route) => {
    const body = route.request().postDataJSON();
    assert.equal(route.request().headers().authorization, "Bearer synthetic-token");
    if (denied) return route.fulfill({ status: 403, json: { error: { message: "此账号没有兑换码管理权限" } } });
    if (body.action === "list_users") {
      if (holdUserList) await new Promise((resolve) => { releaseUserList = resolve; });
      const filtered = users.filter((u) => (!body.search || `${u.nickname || ""} ${u.email} ${u.id}`.toLowerCase().includes(body.search.toLowerCase()))
        && (!body.filter || u.is_test_account === (body.filter === "test")));
      return route.fulfill({ json: { rows: filtered.slice(body.page * 50, body.page * 50 + 50), total: filtered.length, page: body.page } });
    }
    if (body.action === "set_test_account") {
      assert.equal(typeof body.enabled, "boolean");
      assert.deepEqual(Object.keys(body).sort(), ["action", "enabled", "user_id"]);
      lastUpdatedUserId = body.user_id;
      users.find((u) => u.id === body.user_id).is_test_account = body.enabled; userUpdates++;
      if (failUserUpdate) { failUserUpdate = false; return route.abort("failed"); }
      return route.fulfill({ json: { status: "updated", user_id: body.user_id, is_test_account: body.enabled } });
    }
    if (body.action === "list") {
      const filtered = rows.filter((r) => (!body.status || r.status === body.status) && (!body.batch_id || r.batch_id === body.batch_id)
        && (!body.search || `${r.batch_label} ${r.code_suffix} ${r.redeemed_email}`.includes(body.search)));
      const stats = { total: rows.length, unused: 0, redeemed: 0, disabled: 0, expired: 0 };
      rows.forEach((r) => stats[r.status]++);
      return route.fulfill({ json: { rows: filtered.slice(body.page * 50, body.page * 50 + 50), stats, batches, total: filtered.length, page: body.page } });
    }
    if (body.action === "issue") {
      const created = !issuedBatches.has(body.batch_id);
      if (created) {
        issues++; issuedBatches.add(body.batch_id);
        const batch = { id: body.batch_id, label: body.label, code_count: body.count }; batches.unshift(batch);
        for (let i = 0; i < body.count; i++) rows.unshift({ ...rows[0], id: crypto.randomUUID(), batch_id: batch.id, batch_label: batch.label, code_suffix: "6D7E8F90", status: "unused" });
      }
      if (failIssue) { failIssue = false; return route.abort("failed"); }
      return route.fulfill({ json: { batch_id: body.batch_id, count: body.count, created } });
    }
    if (body.action === "reveal" || body.action === "export") {
      exports++;
      const available = rows.filter((r) => r.status === "unused" && (body.code_id ? r.id === body.code_id : r.batch_id === body.batch_id));
      return route.fulfill({ json: { codes: available.map((r) => ({ id: r.id, code: plain, expires_at: r.expires_at, batch_label: r.batch_label })) } });
    }
    if (body.action === "disable") {
      rows.find((r) => r.id === body.code_id).status = "disabled";
      return route.fulfill({ json: { status: "disabled" } });
    }
    throw new Error(`Unexpected action ${body.action}`);
  });
  const redirect = await fetch("http://127.0.0.1:1564/admin", { redirect: "manual" });
  assert.equal(redirect.status, 308);
  await page.goto("http://127.0.0.1:1564/admin/");
  await page.locator("#code-rows tr").first().waitFor();
  assert.equal(await page.locator("#code-rows tr").count(), 4);
  assert.equal(await page.locator("#export").isDisabled(), true);
  await mkdir(".tmp/pro-code-admin", { recursive: true });
  await page.screenshot({ path: ".tmp/pro-code-admin/dashboard.png", fullPage: true });
  await page.getByLabel("状态筛选").selectOption("redeemed");
  await page.waitForFunction(() => document.querySelectorAll("#code-rows tr").length === 1);
  assert.equal((await page.locator("#code-rows").textContent()).includes("creator@example.test"), true);
  await page.getByLabel("状态筛选").selectOption("");
  await page.locator("#batch-label").fill("=内测新批次 <img src=x onerror=alert(1)>");
  await page.locator("#batch-count").fill("2");
  failIssue = true;
  await page.locator("#issue-submit").click();
  await page.locator("#notice.error").waitFor();
  assert.equal(issues, 1);
  assert.equal(await page.locator("#batch-label").evaluate((el) => el.readOnly), true);
  await page.locator("#issue-submit").click();
  await page.locator("#codes-dialog[open]").waitFor();
  assert.equal(issues, 1, "lost issue response must retry the same batch ID");
  assert.equal(await page.locator("#codes-output").inputValue(), `${plain}\n${plain}`);
  const downloadWait = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 CSV", exact: true }).click();
  const download = await downloadWait;
  const csv = await readFile(await download.path(), "utf8");
  assert.equal(csv.includes("'="), true, "spreadsheet formula prefix is escaped");
  assert.equal(csv.includes(plain), true);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("codes-output").value === "");
  assert.equal(await page.locator("#codes-output").inputValue(), "");
  assert.equal(await page.locator("#code-rows img").count(), 0, "batch labels are text, never HTML");
  await page.getByRole("button", { name: "停用", exact: true }).first().click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "停用", exact: true }).first().click();
  await page.getByRole("button", { name: "确认停用", exact: true }).click();
  await page.locator("#notice").filter({ hasText: "已停用" }).waitFor();
  await page.getByRole("button", { name: "停用", exact: true }).first().click();
  await page.keyboard.press("Escape");
  await page.locator("#disable-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("button", { name: "停用", exact: true }).count(), 1, "Escape never reuses a previous confirmation");
  await page.locator("#export").click();
  await page.locator("#codes-dialog[open]").waitFor();
  assert.equal(await page.locator("#codes-output").inputValue(), plain, "export excludes disabled codes");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "用户管理", exact: true }).click();
  await page.locator("#user-rows tr").first().waitFor();
  assert.equal(await page.locator("#user-rows tr").count(), 50);
  assert.equal(await page.locator("#user-rows img").count(), 0);
  const firstIdentity = page.locator("#user-rows .user-identity").first();
  assert.equal(await firstIdentity.evaluate((el) => el.firstChild.textContent), users[0].nickname);
  assert.equal(await firstIdentity.locator("small").nth(0).textContent(), users[0].email);
  assert.equal(await firstIdentity.locator(".user-id").textContent(), `ID · ${users[0].id}`);
  assert.equal(await page.locator("#user-rows .user-identity").nth(3).evaluate((el) => el.firstChild.textContent), "未设置昵称");
  await page.getByLabel("搜索昵称、邮箱或用户 ID").fill("小鸟 bIRD");
  await page.locator("#users-filter-form").getByRole("button", { name: "查询" }).click();
  await page.waitForFunction(() => document.querySelectorAll("#user-rows tr").length === 2);
  await page.getByRole("button", { name: "设为测试账号", exact: true }).click();
  await page.locator("#test-account-dialog[open]").waitFor();
  const confirmation = await page.locator("#test-account-dialog").textContent();
  for (const identity of [users[2].nickname, users[2].email, users[2].id]) assert.equal(confirmation.includes(identity), true);
  await page.keyboard.press("Escape");
  assert.equal(userUpdates, 0);
  await page.locator("#users-search").fill("");
  await page.locator("#users-filter-form").getByRole("button", { name: "查询" }).click();
  await page.waitForFunction(() => document.querySelectorAll("#user-rows tr").length === 50);
  await page.locator("#users-next").click();
  await page.waitForFunction(() => document.querySelectorAll("#user-rows tr").length === 2);
  await page.locator("#users-filter").selectOption("test");
  await page.waitForFunction(() => document.querySelectorAll("#user-rows tr").length === 1);
  await page.getByRole("button", { name: "取消测试资格", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.locator("#test-account-dialog").waitFor({ state: "hidden" });
  assert.equal(userUpdates, 0);
  await page.getByRole("button", { name: "取消测试资格", exact: true }).click();
  await page.locator("#confirm-test-account").click();
  await page.locator("#users-empty").waitFor({ state: "visible" });
  assert.equal(userUpdates, 1);
  assert.equal(lastUpdatedUserId, users[1].id);
  assert.equal(users[2].is_test_account, false, "the other user with the same nickname is unchanged");
  await page.locator("#users-filter").selectOption("");
  await page.locator("#users-search").fill("user1@example.test");
  await page.locator("#users-filter-form").getByRole("button", { name: "查询" }).click();
  await page.waitForFunction(() => document.querySelectorAll("#user-rows tr").length === 1);
  failUserUpdate = true;
  await page.getByRole("button", { name: "设为测试账号", exact: true }).click();
  await page.locator("#confirm-test-account").click();
  await page.locator("#notice.error").waitFor();
  assert.equal(userUpdates, 2);
  await page.locator("#users-refresh").click();
  await page.getByRole("button", { name: "取消测试资格", exact: true }).waitFor();
  assert.equal(users[1].is_test_account, true, "refresh after lost response reads actual state without toggling again");
  await page.locator("#users-search").fill("");
  await page.locator("#users-filter-form").getByRole("button", { name: "查询" }).click();
  await page.waitForFunction(() => document.querySelectorAll("#user-rows tr").length === 50);
  await page.screenshot({ path: ".tmp/pro-code-admin/users.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.getByRole("button", { name: "用户管理", exact: true }).isVisible(), true);
  await page.screenshot({ path: ".tmp/pro-code-admin/users-mobile.png" });
  await page.setViewportSize({ width: 1512, height: 1040 });
  await page.getByRole("button", { name: "Kernel 技能" }).click();
  await page.locator("#skills-console").waitFor({ state: "visible" });
  assert.equal(await page.locator("#console").isHidden(), true);
  assert.equal(await page.locator("#skills-runner-rows tr").count(), 3);
  assert.equal(await page.locator("#skills-method-rows tr").count(), 4);
  assert.equal((await page.locator("#skills-method-rows").textContent()).includes("bowerbird-wechat-article-layout"), true);
  assert.equal((await page.locator("#skills-method-count").textContent()).includes("82cbe0f3"), true);
  assert.equal(await page.locator("#topbar-crumb").textContent(), "Kernel 技能");
  await page.screenshot({ path: ".tmp/pro-code-admin/kernel-skills.png", fullPage: true });
  await page.getByRole("button", { name: "兑换码管理" }).click();
  await page.locator("#console").waitFor({ state: "visible" });
  assert.equal(await page.locator("#skills-console").isHidden(), true);
  assert.equal(await page.locator("#topbar-crumb").textContent(), "兑换码");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: ".tmp/pro-code-admin/mobile.png", fullPage: true });
  denied = true;
  await page.locator("#refresh").click();
  await page.locator("#login-status").filter({ hasText: "没有兑换码管理权限" }).waitFor();
  assert.equal(await page.locator("#console").isHidden(), true);
  assert.equal(await page.locator("#code-rows tr").count(), 0);
  assert.equal(await page.locator("#user-rows tr").count(), 0);
  await page.getByRole("button", { name: "用户管理", exact: true }).click();
  assert.equal(await page.locator("#users-console").isHidden(), true, "navigation must not reauthorize a rejected session");
  await page.locator("#logout").click();
  await page.locator("#login-form").waitFor();
  assert.equal(await page.locator("#codes-output").inputValue(), "");
  await page.locator("#login-email").fill("admin@example.test");
  await page.locator("#login-submit").click();
  await page.locator("#login-status").filter({ hasText: "已发送" }).waitFor();
  denied = false;
  await page.reload();
  await page.locator("#code-rows tr").first().waitFor();
  holdUserList = true;
  const listRequest = page.waitForRequest((request) => request.postData()?.includes('"list_users"'));
  await page.getByRole("button", { name: "用户管理", exact: true }).click();
  await listRequest;
  await page.evaluate(() => window.supabase.createClient().auth.signOut());
  await page.locator("#login-form").waitFor();
  assert.equal(typeof releaseUserList, "function");
  releaseUserList();
  await page.waitForFunction(() => !document.getElementById("users-console").hasAttribute("aria-busy"));
  assert.equal(await page.locator("#user-rows tr").count(), 0, "late user response cannot repopulate data after logout");
  assert.equal(await page.locator("#users-console").isHidden(), true);
  assert.equal(exports >= 2, true); assert.deepEqual(errors, []);
  console.log("PASS: /admin redirect, vouchers, user search/filter/pagination, test access confirmation/cancel, lost response recovery, XSS safety, mobile navigation, revocation and logout clearing");
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
