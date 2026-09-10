import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const requireRenderer = createRequire(new URL("../../html-renderer/package.json", import.meta.url));
const { chromium } = process.env.BOWERBIRD_PLAYWRIGHT_MODULE ? await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE) : requireRenderer("playwright");
const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { host: "127.0.0.1", port: 1444, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(8000);
await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
const errors = []; page.on("pageerror", error => errors.push(error.message));
const modal = page.locator('[role="dialog"][aria-modal="true"]');
const center = page.getByRole("dialog", { name: "任务中心", exact: true });
const row = center.locator("[data-visual-task-id]");
const calls = command => page.evaluate(command => window.calls.filter(c => c.command === command).length, command);
const release = () => page.evaluate(() => { window.hold = null; window.pending.splice(0).forEach(resolve => resolve()); });
async function reset() {
  await page.goto("http://127.0.0.1:1444/scripts/fixtures/visual-profile/preview.html");
  await page.waitForFunction(() => document.querySelector("fieldset") && !document.querySelector("fieldset").disabled);
}
async function openCenter() {
  await page.getByRole("button", { name: /^任务中心 ·/ }).click();
  await center.getByRole("button", { name: "提炼", exact: true }).click();
}
try {
  await mkdir(".tmp", { recursive: true });
  await reset();
  await page.evaluate(() => window.hold = "visual_profile_cloud_extract");
  await modal.getByRole("button", { name: "开始提炼", exact: true }).evaluate(node => { node.click(); node.click(); });
  await page.waitForFunction(() => window.pending.length === 1);
  await modal.getByRole("button", { name: "后台继续" }).click();
  await modal.waitFor({ state: "detached" });
  await openCenter();
  assert.match(await row.innerText(), /提炼中/);
  assert.equal(await row.getByRole("button", { name: "停止提炼" }).count(), 0);
  await page.screenshot({ path: ".tmp/visual-profile-task-running.png" });
  await row.getByRole("button", { name: "查看进度" }).click();
  await modal.getByRole("button", { name: "后台继续" }).click();
  assert.equal(await calls("visual_profile_cloud_extract"), 1);
  assert.equal(await page.evaluate(() => window.taskStore.getState().tasks.length), 1);
  await release();
  await page.getByText("「自然生活品牌」视觉规范提炼完成", { exact: true }).waitFor();
  await openCenter();
  assert.match(await row.innerText(), /提炼完成，待确认规范/);
  await page.screenshot({ path: ".tmp/visual-profile-task-complete.png" });
  await row.getByRole("button", { name: "查看规范" }).click();
  await modal.getByRole("button", { name: "保存规范" }).waitFor();
  assert.equal(await calls("visual_profile_confirm"), 0);
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().activeProjectId), "p");
  assert.equal(await page.evaluate(() => window.notices.filter(n => n.message.includes("视觉规范提炼完成")).length), 1);
  await page.keyboard.press("Escape");
  await openCenter();
  await row.getByRole("button", { name: "清除提醒", exact: true }).click();
  await center.getByText("暂无提炼任务").waitFor();
  await center.getByRole("button", { name: "查看已清除" }).click();
  await row.getByRole("button", { name: "查看规范" }).waitFor();
  assert.equal(await page.evaluate(() => window.taskStore.getState().tasks.length), 1);
  assert.equal(await page.evaluate(() => window.profiles.length), 1);
  // Failure remains reviewable and never emits a success or confirms a profile.
  await reset();
  await page.evaluate(() => { window.hold = "visual_profile_cloud_extract"; window.fail = window.hold; });
  await modal.getByRole("button", { name: "开始提炼", exact: true }).click();
  await page.waitForFunction(() => window.pending.length === 1);
  await modal.getByRole("button", { name: "后台继续" }).click();
  await release();
  await page.waitForFunction(() => window.taskStore.getState().tasks[0].status === "failed");
  await openCenter();
  assert.match(await row.innerText(), /提炼失败/);
  assert.equal(await page.evaluate(() => window.notices.filter(n => n.tone === "success").length), 0);
  await row.getByRole("button", { name: "重新提炼" }).click();
  await modal.getByRole("button", { name: "开始提炼", exact: true }).waitFor();
  assert.equal(await calls("visual_profile_cloud_extract"), 1);
  // Closing during analysis keeps it alive; stopping from the task list prevents extraction.
  await reset();
  await page.evaluate(() => window.hold = "codex_describe_asset");
  await modal.getByRole("button", { name: "开始提炼", exact: true }).click();
  await page.waitForFunction(() => window.pending.length === 1);
  await page.keyboard.press("Escape");
  await openCenter();
  await row.getByRole("button", { name: "停止提炼" }).click();
  await release();
  await page.waitForFunction(() => window.taskStore.getState().tasks[0].status === "cancelled");
  assert.equal(await calls("visual_profile_cloud_extract"), 0);
  assert.equal(await page.evaluate(() => window.notices.filter(n => n.tone === "success").length), 0);
  // A task completing under a different account stays out of that account's list and notifications.
  await reset();
  await page.evaluate(() => window.hold = "visual_profile_cloud_extract");
  await modal.getByRole("button", { name: "开始提炼", exact: true }).click();
  await page.waitForFunction(() => window.pending.length === 1);
  await modal.getByRole("button", { name: "后台继续" }).click();
  await page.evaluate(() => window.fixtureStore.setState({ cloudAuth: { logged_in: true, user_id: "other-account" } }));
  await release();
  await page.waitForFunction(() => window.taskStore.getState().tasks[0].status === "succeeded");
  await openCenter();
  await center.getByText("暂无提炼任务").waitFor();
  assert.equal(await page.evaluate(() => window.notices.filter(n => n.tone === "success").length), 0);
  // Completing a background task must not replace a historical guide being viewed.
  await reset();
  await page.evaluate(() => window.hold = "visual_profile_cloud_extract");
  await modal.getByRole("button", { name: "开始提炼", exact: true }).click();
  await page.waitForFunction(() => window.pending.length === 1);
  await modal.getByRole("button", { name: "后台继续" }).click();
  await page.evaluate(() => {
    window.profiles.push(window.makeProfile("older", 1, "confirmed"));
    window.fixtureStore.getState().openVisualProfile({ id: "f", name: "自然生活品牌", profileId: "older" });
  });
  await modal.getByRole("button", { name: "完成", exact: true }).waitFor();
  await release();
  await page.waitForFunction(() => window.taskStore.getState().tasks[0].status === "succeeded");
  assert.equal(await modal.getByRole("button", { name: "完成", exact: true }).count(), 1);
  assert.equal(await modal.getByRole("button", { name: "保存规范", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: background extraction, single submission, reopen progress/result, completion toast, clear receipt, failure/retry entry, cancellation and account isolation.");
} finally { await browser.close(); await server.close(); }
