import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ cacheDir: ".tmp/app-updater-background/vite", optimizeDeps: { entries: ["scripts/fixtures/app-updater/preview.html"] },
  server: { host: "127.0.0.1", port: 1597, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1050, height: 700 } });
page.setDefaultTimeout(15_000);
page.setDefaultNavigationTimeout(60_000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const button = (name) => page.getByRole("button", { name, exact: true });
const fixture = "http://127.0.0.1:1597/scripts/fixtures/app-updater/preview.html";
const startupDialog = page.getByRole("dialog", { name: "发现新版本", exact: true });
const checkCount = () => page.evaluate(() => window.calls.filter(c => c === "plugin:updater|check").length);
const downloadCount = () => page.evaluate(() => window.calls.filter(c => c === "plugin:updater|download").length);
async function assertNoInstall() {
  const calls = await page.evaluate(() => window.calls);
  assert.ok(!calls.includes("plugin:updater|install") && !calls.includes("plugin:process|restart"));
}
try {
  for (const mode of ["current", "offline"]) {
    await page.goto(`${fixture}?startup&mode=${mode}`);
    await page.waitForFunction(() => window.updater.getState().startupChecked && window.updater.getState().phase !== "checking");
    assert.equal(await checkCount(), 1, "StrictMode must not duplicate the startup request");
    assert.equal(await startupDialog.count(), 0);
    assert.equal(await page.getByRole("alert").count(), 0, "startup failure is silent");
    if (mode === "offline") {
      await button("检查更新").click();
      await page.getByRole("alert").filter({ hasText: "网络不可用" }).waitFor();
    }
  }

  await page.clock.install();
  await page.goto(`${fixture}?startup&mode=current`);
  await page.waitForFunction(() => window.updater.getState().phase === "current");
  const cardStatus = page.getByText("当前已是最新版本。", { exact: true });
  const beforePoll = await cardStatus.boundingBox();
  await page.evaluate(() => { window.holdCheck = true; window.mode = "offline"; });
  await page.clock.fastForward(300_000);
  await page.waitForFunction(() => !!window.releaseCheck);
  assert.equal(await button("检查更新").isEnabled(), true);
  assert.deepEqual(await cardStatus.boundingBox(), beforePoll, "polling must not move or hide the visible version status");
  await page.evaluate(() => { window.holdCheck = false; window.releaseCheck(); });
  await page.waitForFunction(() => window.updater.getState().phase === "current");
  assert.deepEqual(await cardStatus.boundingBox(), beforePoll, "offline polling retains the last result");
  await page.evaluate(() => { window.mode = "available"; });
  await page.clock.fastForward(300_000);
  await page.getByText(/50%/).waitFor();
  assert.equal(await downloadCount(), 1, "background detection starts downloading");
  assert.equal(await startupDialog.count(), 0);
  await assertNoInstall();
  await page.clock.resume();

  await page.goto(`${fixture}?startup&notReady`);
  await button("初始化完成").waitFor();
  assert.equal(await checkCount(), 0, "wait for application initialization");
  await button("初始化完成").click();
  await page.getByText(/50%/).waitFor();
  assert.equal(await checkCount(), 1);
  assert.equal(await downloadCount(), 1);
  assert.equal(await startupDialog.count(), 0);
  await button("切换启动组件").click();
  await button("切换启动组件").click();
  await page.evaluate(() => window.updater.getState().check({ startup: true }));
  assert.equal(await checkCount(), 1);
  assert.equal(await downloadCount(), 1);
  await page.evaluate(() => { window.holdVerification = true; window.finishDownload(); });
  await page.waitForFunction(() => typeof window.finishVerification === "function");
  await page.getByText(/100%/).waitFor();
  assert.equal(await button("安装并重启").count(), 0, "network completion alone cannot enable installation");
  await page.evaluate(() => window.finishVerification());
  await button("安装并重启").waitFor();
  assert.equal(await startupDialog.count(), 0, "verification does not open a dialog");
  await assertNoInstall();

  await page.goto(`${fixture}?startup&blocked`);
  await page.getByText(/50%/).waitFor();
  assert.equal(await page.getByRole("dialog", { name: "素材库迁移" }).count(), 1);
  assert.equal(await startupDialog.count(), 0, "do not interrupt another modal or library migration");
  await button("迁移完成").click();
  assert.equal(await checkCount(), 1, "next app launch checks again");
  await page.evaluate(() => window.finishDownload());
  await button("安装并重启").waitFor();
  assert.equal(await startupDialog.count(), 0);
  await assertNoInstall();

  await page.goto(fixture);
  await page.evaluate(() => { window.mode = "offline"; });
  await button("检查更新").click();
  await page.getByRole("alert").filter({ hasText: "网络不可用" }).waitFor();
  await page.evaluate(() => { window.mode = "current"; });
  await button("检查更新").click();
  await page.getByText("当前已是最新版本。").waitFor();
  await page.evaluate(() => { window.mode = "available"; });
  await button("检查更新").click();
  await page.getByText(/50%/).waitFor();
  assert.equal(await button("正在下载…").isDisabled(), true);
  await page.evaluate(() => Promise.all([window.updater.getState().download(), window.updater.getState().check()]));
  assert.equal(await downloadCount(), 1);
  await button("切换设置").click();
  await button("切换设置").click();
  await page.getByText(/50%/).waitFor();
  await page.evaluate(() => { window.badSignature = true; window.finishDownload(); });
  await page.getByRole("alert").filter({ hasText: "签名校验失败" }).waitFor();
  assert.equal(await button("安装并重启").count(), 0);
  await page.evaluate(() => window.updater.getState().check({ background: true }));
  assert.equal(await downloadCount(), 1, "polling the same failed release preserves the retry action");
  await page.evaluate(() => { window.badSignature = false; window.unknownSize = true; });
  await button("重新下载").click();
  await button("正在下载…").waitFor();
  assert.equal(await page.getByRole("progressbar").getAttribute("value"), null);
  await page.evaluate(() => window.finishDownload());
  await button("安装并重启").waitFor();
  await assertNoInstall();
  await mkdir(".tmp/app-updater-background", { recursive: true });
  await page.screenshot({ path: ".tmp/app-updater-background/ready.png" });
  const confirm = page.getByRole("dialog", { name: "安装并重启", exact: true });
  await page.evaluate(() => window.store.setState({ genJobs: { image: { running: true, provider: "minimax-h3-image" } } }));
  await button("安装并重启").click();
  await confirm.getByText("目前仍有进行中的本地生成，安装新版本可能会导致生成不可取回，请确认是否要安装并重启", { exact: true }).waitFor();
  await confirm.getByRole("button", { name: "取消" }).click();
  await assertNoInstall();
  await page.evaluate(() => {
    window.store.setState({ genJobs: {} });
    window.queuedJobs = [{ running: true, provider: "minimax-h3-image" }];
  });
  await button("安装并重启").click();
  await confirm.waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent === "取消");
  await page.keyboard.press("Escape");
  await confirm.waitFor({ state: "hidden" });
  assert.equal(await button("安装并重启").evaluate(el => el === document.activeElement), true, "native queue confirmation restores the settings button");
  await assertNoInstall();
  await page.evaluate(() => { window.queuedJobs = []; window.holdFlush = true; });
  await button("安装并重启").click();
  await page.waitForFunction(() => !!window.releaseFlush);
  await page.evaluate(() => window.updater.getState().install());
  assert.equal(await page.evaluate(() => window.calls.filter(c => c === "flush").length), 2, "a second click cannot begin another install");
  await page.evaluate(() => {
    window.store.setState({ genJobs: { late: { running: true, provider: "codex" } } });
    window.holdFlush = false;
    window.releaseFlush();
  });
  await confirm.waitFor();
  await assertNoInstall();
  await page.evaluate(() => { window.flushFails = true; });
  await confirm.getByRole("button", { name: "安装并重启" }).click();
  await page.getByRole("alert").filter({ hasText: "保存失败" }).waitFor();
  await assertNoInstall();
  await page.evaluate(() => { window.store.setState({ genJobs: {}, colorRebuild: { done: 1, total: 3 } }); });
  await button("安装并重启").click();
  await page.getByRole("alert").filter({ hasText: "等待素材整理完成" }).waitFor();
  await assertNoInstall();
  await page.evaluate(() => {
    window.store.setState({ colorRebuild: null, generating: true, genJobs: {
      cloud: { running: true, provider: "bowerbird-cloud-image_hd" }, finished: { running: false, provider: "codex" },
    }, cloudAgentRuns: { remote: { status: "running" } } });
    window.flushFails = false; window.installFails = true;
  });
  await button("安装并重启").click();
  await page.getByRole("alert").filter({ hasText: "安装程序启动失败" }).waitFor();
  await page.evaluate(() => { window.installFails = false; window.restartFails = true; });
  await button("安装并重启").click();
  await page.getByRole("alert").filter({ hasText: "更新已安装" }).waitFor();
  await button("重启应用").click();
  const calls = await page.evaluate(() => window.calls);
  assert.ok(calls.indexOf("flush") < calls.indexOf("plugin:updater|install"));
  assert.equal(calls.filter(c => c === "plugin:updater|install").length, 2, "restart retries never install again");
  assert.deepEqual(errors, []);
  console.log("PASS updater: automatic download, verification, local generation confirmation before and after save, cancellation, save failure, install and restart retry");
} catch (error) { console.error(error, errors); throw error; } finally { await browser.close(); await server.close(); }
