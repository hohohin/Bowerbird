import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1566, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, reducedMotion: "reduce" });
const errors = []; page.on("pageerror", error => errors.push(error.message));
const bubble = page.locator(".explorer-capture-feedback");
async function drop(id = "a".repeat(32)) {
  await page.locator(".explore-main").evaluate((el, dragId) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("application/x-bowerbird-explorer", JSON.stringify({ version: 1, ...(dragId ? { dragId } : {}),
      imageUrl: "https://image.test/a.png", pageUrl: "https://www.pinterest.com/pin/1" }));
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer, clientX: 700, clientY: 400 }));
  }, id);
}
try {
  await page.goto("http://127.0.0.1:1566/scripts/fixtures/explorer/preview.html");
  await page.getByRole("button", { name: "探索", exact: true }).click();
  await page.evaluate(() => { window.analyse = true; window.holdAnalysis = true; });
  await drop();
  await bubble.getByText("已采集，正在识别标签…", { exact: true }).waitFor();
  assert.equal(await page.locator(".explore-capture-status").count(), 0, "classification does not block more captures");
  await page.waitForFunction(() => window.finishAnalysis);
  await page.evaluate(() => window.finishAnalysis());
  await bubble.getByText("已添加到 #插画 #柔光", { exact: true }).waitFor();
  await page.waitForTimeout(80);
  const rects = await page.evaluate(() => ({
    bubble: document.querySelector(".explorer-capture-feedback").getBoundingClientRect().toJSON(),
    image: document.querySelector('[data-asset-id="captured"]').getBoundingClientRect().toJSON(),
    panel: document.querySelector(".explore-main").getBoundingClientRect().toJSON(),
    pointer: getComputedStyle(document.querySelector(".explorer-capture-feedback")).pointerEvents,
    motion: getComputedStyle(document.querySelector(".explorer-capture-feedback")).animationName,
  }));
  assert.equal(rects.pointer, "none"); assert.equal(rects.motion, "none");
  const expectedCenter = Math.max(rects.panel.left + 8 + rects.bubble.width / 2,
    Math.min(rects.panel.right - 8 - rects.bubble.width / 2, rects.image.x + rects.image.width / 2));
  assert.ok(Math.abs(rects.bubble.x + rects.bubble.width / 2 - expectedCenter) < 5, `bubble follows image within panel: ${JSON.stringify(rects)}`);
  await mkdir(".tmp/explorer-feedback", { recursive: true });
  await page.screenshot({ path: ".tmp/explorer-feedback/light.png" });
  await page.waitForTimeout(1100);
  assert.equal(await bubble.count(), 1, "confirmation remains visible after one second");
  await page.waitForTimeout(1000);
  assert.equal(await bubble.count(), 0, "confirmation disappears after two seconds");

  await page.evaluate(() => { window.holdAnalysis = false; window.failAnalysis = true; });
  await drop();
  await bubble.getByText("已采集，标签识别未完成", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-asset-id="captured"]').count(), 1, "analysis failure preserves capture");

  await page.evaluate(() => { window.failAnalysis = false; window.holdAnalysis = true; window.finishAnalysis = null; });
  await drop();
  await page.waitForFunction(() => window.finishAnalysis);
  await page.evaluate(() => window.store.setState({ activeProjectId: "another", projectRouteRevision: 1 }));
  await page.evaluate(() => window.finishAnalysis());
  await page.waitForTimeout(100);
  assert.equal(await bubble.count(), 0, "late labels do not appear over another project");

  await page.evaluate(() => { window.store.setState({ activeProjectId: null, projectRouteRevision: 2 }); window.holdAnalysis = false; document.documentElement.dataset.theme = "dark"; });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await drop("b".repeat(32));
  await bubble.getByText("已添加到 #插画 #柔光", { exact: true }).waitFor();
  await page.waitForTimeout(180);
  assert.equal(await bubble.evaluate(el => getComputedStyle(el).animationDuration), "2s");
  await page.screenshot({ path: ".tmp/explorer-feedback/dark.png" });

  // An older completion cannot overwrite feedback for a newer capture.
  await page.evaluate(() => { window.holdAnalysis = true; window.finishAnalysis = null; });
  await drop("d".repeat(32));
  await page.waitForFunction(() => window.finishAnalysis);
  await page.evaluate(() => { window.oldFinish = window.finishAnalysis; window.finishAnalysis = null; });
  await drop("e".repeat(32));
  await page.waitForFunction(() => window.finishAnalysis);
  await page.evaluate(() => window.oldFinish());
  await page.waitForTimeout(50);
  await bubble.getByText("已采集，正在识别标签…", { exact: true }).waitFor();
  await page.evaluate(() => { window.analysisTags = []; window.finishAnalysis(); });
  await bubble.getByText("已采集，暂无匹配标签", { exact: true }).waitFor();

  await page.setViewportSize({ width: 900, height: 650 });
  await page.evaluate(() => { window.holdAnalysis = false; window.analysisTags = ["较长的插画作品分类标签", "梦幻柔光风格", "自然风景"]; });
  await drop("f".repeat(32));
  await bubble.getByText("已添加到 #较长的插画作品分类标签 #梦幻柔光风格 #自然风景", { exact: true }).waitFor();
  const box = await bubble.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 900 && box.y >= 0, "long labels stay inside narrow window");

  await page.evaluate(() => { window.analysisTags = ["插画"]; });
  await drop(null);
  await bubble.getByText("已添加到 #插画", { exact: true }).waitFor();
  const fallback = await page.evaluate(() => window.calls.filter(c => c.command === "claim_source_browser_analysis").at(-1).args.dragId);
  assert.match(fallback, /^[a-f0-9]{32}$/, "missing dragstart ID starts classification on drop");
  assert.ok(await page.evaluate(id => window.calls.some(c => c.command === "finish_source_browser_analysis" && c.args.dragId === id), fallback));

  for (const reason of ["分类任务忙，请稍后重试", "请先在自动分类中应用 Jev 云端分类", "请先在自动分类中保存 Jev API Key"]) {
    await page.evaluate(value => { window.claimError = value; }, reason);
    const finishes = await page.evaluate(() => window.calls.filter(c => c.command === "finish_source_browser_analysis").length);
    await drop();
    await bubble.getByText(`已采集；${reason}`, { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === "finish_source_browser_analysis").length), finishes);
    assert.equal(await page.locator('[data-asset-id="captured"]').count(), 1);
  }
  await page.evaluate(() => { window.claimError = "Command claim_source_browser_analysis not found"; });
  await drop();
  await bubble.getByText("已采集；分类服务未连接，请重启开发程序", { exact: true }).waitFor();
  await page.evaluate(() => { window.claimError = null; });

  await page.evaluate(() => { window.analyse = false; });
  const finishesBeforeDisabled = await page.evaluate(() => window.calls.filter(c => c.command === "finish_source_browser_analysis").length);
  await drop();
  await bubble.getByText("已采集", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === "finish_source_browser_analysis").length), finishesBeforeDisabled,
    "disabled automatic processing captures without finishing classification");
  await page.waitForTimeout(2100);
  assert.equal(await bubble.count(), 0);
  await page.evaluate(() => { window.analyse = true; });

  await page.evaluate(() => { window.fail = true; });
  await drop("c".repeat(32));
  await page.waitForFunction(() => window.calls.some(c => c.command === "release_source_browser_analysis" && c.args.dragId === "c".repeat(32)));
  assert.equal(await bubble.count(), 0, "capture failure never claims success");
  assert.deepEqual(errors, []);
  console.log("PASS explorer feedback: delayed tags, saved confirmation, 2s lifetime, anchor, reduced motion, failure, route isolation and cleanup");
} finally { await browser.close(); await server.close(); }
