import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1603, strictPort: true, hmr: false, watch: null } });
await server.listen();
const port = server.httpServer.address().port;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 950 } });
page.setDefaultTimeout(6000);
const fixture = `http://127.0.0.1:${port}/scripts/fixtures/quick-transfer-desktop/preview.html`;
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const button = name => page.getByRole("button", { name, exact: true });
const row = name => page.getByRole("list", { name: "接收队列" }).getByRole("listitem").filter({ has: page.locator(".quick-transfer-file-name", { hasText: name }) });
const file = (id, name, assetId, status = "complete") => ({ id, name, assetId, status, size: 100, received: status === "receiving" ? 40 : 100, error: null, retryable: false });
const count = command => page.evaluate(command => window.calls.filter(call => call.command === command).length, command);
async function color(name) {
  const img = row(name).getByRole("img", { name: `${name} 缩略图`, exact: true });
  await img.waitFor();
  return img.evaluate(async image => {
    await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 24;
    const context = canvas.getContext("2d"); context.drawImage(image, 0, 0, 32, 24);
    return [...context.getImageData(8, 12, 1, 1).data];
  });
}
async function emit(files) { await page.evaluate(transfers => window.emit({ transfers }), files); }
async function open(files) { await page.goto(fixture); await emit(files); await button("快传").click(); }
try {
  const red = file("red", "红色照片.heic", "asset-red");
  const blue = file("blue", "蓝色视频.mp4", "asset-blue");
  const pending = file("pending", "接收中.jpg", null, "receiving");
  await open([red, blue, pending]);
  assert.deepEqual(await color(red.name), [227, 38, 54, 255], "a received HEIC uses its actual generated preview");
  assert.deepEqual(await color(blue.name), [37, 85, 217, 255], "reversed asset replies still map the right poster to the video");
  assert.equal(await row(pending.name).locator("img").count(), 0);
  assert.equal(await page.locator("video").count(), 0, "queue previews never start video decoding/playback");
  assert.equal(await count("get_assets_by_ids"), 1, "completed assets are hydrated as one batch");
  assert.equal(await count("external_files_preview"), 2);
  for (let received = 41; received < 50; received++) await emit([red, blue, { ...pending, received }]);
  assert.equal(await count("get_assets_by_ids"), 1, "progress events do not fetch asset metadata again");
  assert.equal(await count("external_files_preview"), 2, "progress events do not decode the previews again");
  await emit([blue, red, pending]);
  assert.deepEqual(await color(red.name), [227, 38, 54, 255]);
  assert.deepEqual(await color(blue.name), [37, 85, 217, 255]);
  assert.equal(await count("get_assets_by_ids"), 1, "reordering the same IDs does not fetch again");
  await mkdir(".tmp/quick-transfer-thumbnails", { recursive: true });
  await page.screenshot({ path: ".tmp/quick-transfer-thumbnails/received-dark.png", animations: "disabled" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.screenshot({ path: ".tmp/quick-transfer-thumbnails/received-light.png", animations: "disabled" });
  await button("收起快传面板").click();
  await button("快传").click();
  assert.deepEqual(await color(red.name), [227, 38, 54, 255]);
  assert.deepEqual(await color(blue.name), [37, 85, 217, 255]);
  assert.equal(await count("external_files_preview"), 4, "reopening releases the old queue and uses the backend preview cache");

  await open([file("restored", "恢复照片.heic", null, "indexing")]);
  await emit([file("restored", "恢复照片.heic", "asset-red")]);
  assert.deepEqual(await color("恢复照片.heic"), [227, 38, 54, 255], "recovery becomes previewable once its durable asset ID arrives");
  await emit([file("restored", "恢复照片.heic", "asset-red"), blue]);
  assert.deepEqual(await color(blue.name), [37, 85, 217, 255]);
  assert.deepEqual(await page.evaluate(() => window.calls.filter(call => call.command === "get_assets_by_ids").map(call => call.args.assetIds)), [["asset-red"], ["asset-blue"]], "new completion hydrates only the new asset ID");

  // A delayed old metadata reply must not bind to a reused transfer-row component.
  await page.goto(fixture);
  await page.evaluate(() => { window.holdAssetIds = ["asset-red"]; });
  await emit([file("same-row", "旧照片.heic", "asset-red")]);
  await button("快传").click();
  await page.waitForFunction(() => window.assetWaiters.length === 1);
  await emit([file("same-row", "新视频.mp4", "asset-blue")]);
  assert.deepEqual(await color("新视频.mp4"), [37, 85, 217, 255]);
  await page.evaluate(() => window.assetWaiters[0].resolve());
  assert.deepEqual(await color("新视频.mp4"), [37, 85, 217, 255]);
  assert.equal(await count("external_files_preview"), 1, "stale removed assets do not start new preview jobs");

  await open([file("same-row", "旧照片.heic", "asset-red")]);
  assert.deepEqual(await color("旧照片.heic"), [227, 38, 54, 255]);
  await page.evaluate(() => { window.holdPreviewPaths = ["D:\\快传\\蓝色视频.mp4"]; });
  await emit([file("same-row", "新视频.mp4", "asset-blue")]);
  await page.waitForFunction(() => window.previewWaiters.length === 1);
  assert.equal(await row("新视频.mp4").locator("img").count(), 0, "a reused row must not show its previous asset while the new preview is pending");
  await page.evaluate(() => window.previewWaiters[0].resolve());
  assert.deepEqual(await color("新视频.mp4"), [37, 85, 217, 255]);

  // A started preview may finish after closing; it can warm only its own cache key.
  await page.goto(fixture);
  await page.evaluate(() => { window.holdPreviewPaths = ["D:\\快传\\红色照片.heic"]; });
  await emit([file("same-row", "旧照片.heic", "asset-red")]);
  await button("快传").click();
  await page.waitForFunction(() => window.previewWaiters.length === 1);
  await button("收起快传面板").click();
  await emit([file("same-row", "新视频.mp4", "asset-blue")]);
  await button("快传").click();
  assert.deepEqual(await color("新视频.mp4"), [37, 85, 217, 255]);
  await page.evaluate(() => window.previewWaiters[0].resolve());
  assert.deepEqual(await color("新视频.mp4"), [37, 85, 217, 255]);

  await open([file("missing", "已移走.jpg", "not-found"), file("text", "笔记.txt", "asset-text"), file("broken", "坏图.jpg", "asset-broken")]);
  await page.waitForFunction(() => window.convertedPaths.includes("D:\\cache\\broken.jpg"));
  await row("坏图.jpg").locator("svg").waitFor();
  assert.equal(await row("已移走.jpg").locator("img").count(), 0);
  assert.equal(await row("笔记.txt").locator("img").count(), 0);
  assert.equal(await row("坏图.jpg").locator("img").count(), 0, "decode failure restores the type icon, not a broken-image frame");
  assert.equal(await page.getByText("已入库", { exact: true }).count(), 3, "preview failures never downgrade import status");
  assert.equal(await count("external_files_preview"), 1, "text files do not enter the image decoder queue");

  await page.goto(fixture);
  await page.evaluate(() => { window.failures = { get_assets_by_ids: "library unavailable" }; });
  await emit([red]);
  await button("快传").click();
  await page.waitForFunction(() => window.calls.some(call => call.command === "get_assets_by_ids"));
  assert.equal(await row(red.name).locator("img").count(), 0);
  assert.equal(await row(red.name).getByText("已入库", { exact: true }).count(), 1);
  await button("收起快传面板").click();
  await page.evaluate(() => { window.failures = {}; });
  await button("快传").click();
  assert.deepEqual(await color(red.name), [227, 38, 54, 255], "reopening retries failed metadata lookup without changing import state");

  await page.goto(fixture);
  await page.evaluate(() => {
    window.holdPreviewPaths = [];
    const transfers = Array.from({ length: 100 }, (_, index) => {
      const id = `many-${index}`, path = `D:\\快传\\${id}.jpg`;
      window.assets[id] = { ...window.assets["asset-red"], id, store_path: path };
      window.previewResults[path] = "D:\\cache\\red.jpg";
      window.holdPreviewPaths.push(path);
      return { id, name: `${id}.jpg`, assetId: id, size: 100, received: 100, status: "complete", error: null, retryable: false };
    });
    window.emit({ transfers });
  });
  await button("快传").click();
  await page.waitForFunction(() => window.previewWaiters.length === 4);
  assert.equal(await page.evaluate(() => window.maxPreviews), 4, "a large queue has at most four concurrent preview requests");
  await button("收起快传面板").click();
  await page.evaluate(() => window.previewWaiters.forEach(waiter => waiter.resolve()));
  await page.waitForFunction(() => window.activePreviews === 0);
  assert.equal(await count("external_files_preview"), 4, "closing cancels unstarted jobs and never drains hidden history");
  await page.evaluate(() => { window.holdPreviewPaths = []; });
  await button("快传").click();
  assert.deepEqual(await color("many-0.jpg"), [227, 38, 54, 255]);
  assert.equal(await page.evaluate(() => window.calls.some(call => call.command === "external_files_preview" && call.args.path.endsWith("many-99.jpg"))), false, "offscreen history is not decoded at panel open");
  await row("many-99.jpg").scrollIntoViewIfNeeded();
  assert.deepEqual(await color("many-99.jpg"), [227, 38, 54, 255], "scrolling a distant row into view loads its thumbnail");
  assert.deepEqual(errors, []);
  console.log("PASS thumbnails: decoded HEIC/video colors, exact ID mapping, incremental batched metadata, progress dedupe, reorder/reopen/recovery, late metadata/preview protection, missing/text/broken fallbacks, four-request limit, close cancellation and visible-only loading");
} finally { await browser.close(); await server.close(); }
