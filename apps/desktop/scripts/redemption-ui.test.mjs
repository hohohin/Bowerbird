import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
const server = await createServer({ server: { host: "127.0.0.1", port: 1563, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:1563/scripts/fixtures/redemption/preview.html");
  await page.getByRole("button", { name: "账号管理", exact: true }).click();
  const input = page.getByLabel("兑换 Pro", { exact: true });
  const button = page.getByRole("button", { name: "兑换", exact: true });
  assert.equal(await button.isDisabled(), true);
  await input.fill("   "); assert.equal(await button.isDisabled(), true);
  await page.evaluate(() => { window.mode = "error"; });
  await input.fill("01234567-89abcdef-01234567-89abcdef");
  await button.click();
  await page.getByRole("alert").filter({ hasText: "兑换码无效" }).waitFor();
  assert.notEqual(await input.inputValue(), "");
  assert.equal(await page.evaluate(() => window.store.getState().cloudEntitlement.tier), "free");

  await page.evaluate(() => { window.mode = "hold"; });
  await button.click();
  await page.waitForFunction(() => typeof window.release === "function");
  assert.equal(await input.isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "兑换中…" }).isDisabled(), true);
  const calls = await page.evaluate(() => window.calls.filter((c) => c.command === "cloud_redeem_code").length);
  await input.evaluate((element) => element.closest("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(await page.evaluate(() => window.calls.filter((c) => c.command === "cloud_redeem_code").length), calls);
  await page.evaluate(() => { window.mode = "success"; window.release(); });
  await page.getByRole("status").filter({ hasText: "兑换成功！" }).waitFor();
  assert.equal(await input.inputValue(), "");
  assert.deepEqual(await page.evaluate(() => ({ tier: window.store.getState().cloudEntitlement.tier,
    credits: window.store.getState().cloudEntitlement.balances.sub,
    provider: window.store.getState().activeGenProvider })), { tier: "pro", credits: 1100, provider: "codex" });

  await page.evaluate(() => { window.mode = "replay"; });
  await input.fill("01234567-89abcdef-01234567-89abcdef"); await input.press("Enter");
  await page.getByRole("status").filter({ hasText: "未重复发放" }).waitFor();
  await page.evaluate(() => { window.mode = "pending"; });
  await input.fill("01234567-89abcdef-01234567-89abcdef"); await button.click();
  await page.getByRole("status").filter({ hasText: "权益暂未同步" }).waitFor();
  await page.getByRole("button", { name: "刷新权益", exact: true }).click();
  await page.waitForFunction(() => window.store.getState().cloudBusy === false);
  await mkdir(".tmp", { recursive: true });
  await page.screenshot({ path: ".tmp/redemption-settings.png" });
  await page.evaluate(() => window.store.setState({ cloudAuth: { ...window.store.getState().cloudAuth, logged_in: false } }));
  await input.waitFor({ state: "hidden" });
  await assert.rejects(page.evaluate(() => window.store.getState().redeemCloudCode("unused")), /请先登录/);
  assert.deepEqual(errors, []);
  console.log("PASS: settings UI, validation, failure retention, double-submit guard, Pro/balance/provider refresh, replay, pending sync and login gate");
} finally { await browser.close(); await server.close(); }
