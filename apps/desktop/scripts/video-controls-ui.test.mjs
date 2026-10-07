import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ configFile: false, root: process.cwd(), server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 560, height: 400 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const waitText = text => page.waitForFunction(value => document.body.innerText.includes(value), text);
try {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/video-controls/preview.html`);
  await waitText("即梦剩余：9,434 积分");
  await waitText("本次消耗：240 积分");
  await page.getByLabel("视频时长（秒）").fill("30");
  await page.getByLabel("视频分辨率", { exact: true }).selectOption("1080p");
  await page.getByLabel("视频模型", { exact: true }).selectOption("seedance2.0fast");
  assert.deepEqual(await page.evaluate(() => [window.options.duration, window.options.video_resolution]), [15, "720p"]);
  await page.getByLabel("视频模型", { exact: true }).selectOption("seedance2.0_vip");
  await page.getByLabel("视频分辨率", { exact: true }).selectOption("4k");
  await page.getByLabel("视频生成渠道").selectOption("cloud");
  assert.deepEqual(await page.evaluate(() => [window.options.model_version, window.options.video_resolution]), ["seedance2.5", "720p"]);
  assert.equal(await page.getByLabel("刷新即梦剩余积分").count(), 0);
  await page.getByLabel("视频生成渠道").selectOption("jimeng");
  await page.getByLabel("视频生成模式").selectOption("image2video");
  await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="视频模型"] option')].some(option => option.value === "seedance1.0fast"));
  await page.getByLabel("视频模型", { exact: true }).selectOption("seedance1.0fast");
  assert.equal(await page.getByLabel("视频时长（秒）").getAttribute("max"), "10");

  await page.evaluate(() => { window.balance = 9000; window.store.setState({ genJobs: { job: { id: "job", provider: "jimeng", submitId: "submitted", running: true } } }); });
  await waitText("即梦剩余：9,000 积分");
  await page.evaluate(() => { window.balance = 8800; window.store.setState({ genJobs: { job: { id: "job", provider: "jimeng", submitId: "submitted", running: false } } }); });
  await waitText("即梦剩余：8,800 积分");
  await page.evaluate(() => { window.fail = true; });
  await page.getByLabel("刷新即梦剩余积分").click();
  await waitText("即梦剩余：查询失败");
  assert.equal((await page.locator("body").innerText()).includes("8,800"), false);
  await page.evaluate(() => { window.fail = false; window.balance = 0; window.cost = null; });
  await page.getByLabel("刷新即梦剩余积分").click();
  await waitText("即梦剩余：0 积分");
  await page.getByLabel("刷新本次消耗积分").click();
  await waitText("本次消耗：官方暂未返回");
  await page.evaluate(() => { window.setBill({ submitId: "slow", busy: false }); });
  await page.waitForFunction(() => !!window.resolveSlow);
  await page.evaluate(() => { window.cost = 12; window.setBill({ submitId: "new", busy: false }); });
  await waitText("本次消耗：12 积分");
  await page.evaluate(() => { window.resolveSlow(999); });
  await page.waitForTimeout(100);
  await waitText("本次消耗：12 积分");
  for (const width of [380, 560, 900]) {
    await page.setViewportSize({ width, height: 400 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  mkdirSync(".tmp/video-controls", { recursive: true });
  await page.screenshot({ path: ".tmp/video-controls/controls.png" });
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.calls.some(call => /create|generate/.test(call.command))), false);
  // Exercise the actual canvas composer and per-turn inspector, with synthetic IPC only.
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-reference/preview.html`);
  await page.waitForFunction(() => document.querySelector('.canvas-workspace[aria-busy="false"]'));
  await page.evaluate(() => {
    const previous = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "dreamina_video_models") return [{ model_version: "seedance2.5", resolutions: ["480p", "720p", "1080p"], min_duration: 4, max_duration: 30 }];
      if (command === "dreamina_credit_balance") return 9434;
      if (command === "dreamina_task_credit") return args.submitId === "old-task" ? 120 : 240;
      return previous(command, args);
    };
    window.store.setState({ activeGenProvider: "jimeng", dreaminaHealth: { ok: true },
      cloudEntitlement: { plan: "pro", policy: { can_use_byo: true }, balances: { daily: 100, sub: 0, topup: 0 } } });
  });
  await page.locator('.creation-dock .ProseMirror').click();
  await page.getByLabel("生成媒体", { exact: true }).selectOption("video");
  await waitText("即梦剩余：9,434 积分");
  await page.getByLabel("视频分辨率", { exact: true }).selectOption("1080p");
  await page.evaluate(() => {
    const options = { kind: "text2video", model_version: "seedance2.5", duration: 5, video_resolution: "720p" };
    const job = { id: "video-job", projectId: "p", threadId: "t", sessionId: "video-session", provider: "jimeng", media: "video", videoOptions: options,
      running: false, streaming: "", createdAt: Date.now(), lastPrompt: "video", lastRefs: [], refAssets: [], lastRatio: "16:9",
      turns: [{ id: 1, turnKey: "old-turn", submitId: "old-task", prompt: "第一轮视频", images: [], provider: "jimeng", media: "video", videoOptions: options },
        { id: 2, turnKey: "new-turn", submitId: "new-task", prompt: "第二轮视频", images: [], provider: "jimeng", media: "video", videoOptions: options }] };
    window.store.setState({ genJobs: { "video-job": job }, genJobOrder: ["video-job"], activeJobId: "video-job", activeSessionKind: "generation", genPanelOpen: true, boardOpen: false });
  });
  await page.locator('[data-generation-turn-key="old-turn"]').getByText("本次消耗：120 积分").waitFor();
  await page.locator('[data-generation-turn-key="new-turn"]').getByText("本次消耗：240 积分").waitFor();
  assert.deepEqual(errors, []);
  await page.waitForTimeout(400);
  await page.screenshot({ path: ".tmp/video-controls/canvas.png" });
  console.log("PASS: official-model selection, limits, channel switch, balance refresh, task identity, missing/error/zero credits, and narrow layout");
} finally {
  await browser.close();
  await server.close();
}
