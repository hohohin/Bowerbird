import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
const server = await createServer({ cacheDir: ".tmp/media-import/vite", server: { host: "127.0.0.1", port: 17924, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
page.setDefaultTimeout(10000);
const errors = []; page.on("pageerror", error => errors.push(error.message));
const video = await readFile("src-tauri/tests/fixtures/media/fragmented.mp4");
await page.route("**/test-media.mp4", route => route.fulfill({ contentType: "video/mp4", body: video }));
const imports = () => page.evaluate(() => window.mediaImports);
async function canvasAsset(id) {
  await page.waitForFunction(id => window.snapshot().nodes.some(node => node.assetId === id), id);
  const nodeId = await page.evaluate(id => window.snapshot().nodes.find(node => node.assetId === id).id, id);
  return page.locator(`[data-canvas-node-id="${nodeId}"].is-video`);
}
async function drop(selector, files, point) {
  await page.locator(selector).first().evaluate((element, { files, point }) => {
    const dt = new DataTransfer();
    for (const { name, size = 12, type = "" } of files) dt.items.add(new File([new Uint8Array(size)], name, { type }));
    const rect = element.getBoundingClientRect();
    const coords = point ?? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    for (const type of ["dragenter", "dragover", "drop"]) element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: coords.x, clientY: coords.y }));
  }, { files, point });
  await page.getByText("正在导入素材…", { exact: true }).waitFor({ state: "hidden" });
}
async function picker(paths) {
  await page.evaluate(paths => { window.pickedFiles = paths; }, paths);
  await page.locator("[data-import-trigger]").click();
  await page.getByRole("menuitem", { name: "导入图片或视频" }).click();
  await page.waitForFunction(() => !window.store.getState().loading);
}
try {
  await mkdir(".tmp/media-import", { recursive: true });
  await page.goto("http://127.0.0.1:17924/scripts/fixtures/canvas-reference/preview.html?media-import&source-library&canvas-library&strict");
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  // A drop freezes canvas coordinates and project before reading the first chunk.
  const rect = await page.locator(".canvas-stage").boundingBox();
  const point = { x: rect.x + rect.width * .7, y: rect.y + rect.height * .55 };
  await drop(".canvas-stage", [{ name: "中文视频.MP4", size: 2 * 1024 * 1024 + 7 }], point);
  const first = (await imports())[0];
  assert.equal(first.projectId, "p");
  const firstCard = await canvasAsset("media-0"); await firstCard.waitFor();
  const bounds = await firstCard.boundingBox();
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - point.x) < 3, JSON.stringify({ bounds, point }));
  assert.deepEqual(await page.evaluate(() => window.mediaCalls.filter(c => c.command === "video_import_append").map(c => [c.args.offset, c.args.length])), [[0,1048576],[1048576,1048576],[2097152,7]]);
  assert.equal(await page.evaluate(() => window.pendingUploads()), 0);
  // File picker accepts all six backend-supported video formats and creates a canvas card.
  await picker(["/picked/选择视频.mov"]);
  assert.equal((await imports()).at(-1).projectId, "p");
  await (await canvasAsset("media-1")).waitFor();
  const extensions = await page.evaluate(() => window.mediaCalls.find(c => c.command === "plugin:dialog|open").args.options.filters[0].extensions);
  for (const ext of ["mp4", "mov", "m4v", "webm", "mkv", "avi"]) assert.ok(extensions.includes(ext));
  const beforeCancel = (await imports()).length;
  await picker(null); assert.equal((await imports()).length, beforeCancel);
  // Global library drop remains enabled while the source drawer is open; no canvas instance.
  await page.evaluate(async () => { const { useLocalFileMode } = await import("/src/lib/localFileMode.ts"); useLocalFileMode.getState().openSource("global"); });
  await page.locator(".categorized-library").waitFor();
  const nodesBefore = await page.evaluate(() => window.snapshot().nodes.length);
  await drop(".categorized-library", [{ name: "素材库视频.webm", size: 51 * 1024 * 1024 }]);
  assert.equal((await imports()).at(-1).projectId, null);
  assert.equal(await page.evaluate(() => window.snapshot().nodes.length), nodesBefore);
  await page.getByRole("region", { name: "平铺浏览视频" }).waitFor();
  await page.locator('.catalog-virtual [data-asset-id="media-2"]').waitFor();
  // A failed chunk is cleaned up and a later file still imports.
  await page.evaluate(() => { window.failChunk = true; });
  await drop(".categorized-library", [{ name: "failed.mp4" }, { name: "图片.png", type: "image/png" }]);
  assert.equal(await page.evaluate(() => window.pendingUploads()), 0);
  assert.equal((await imports()).at(-1).asset.name, "图片.png");
  await page.evaluate(() => { window.failChunk = false; });
  const beforeBad = (await imports()).length;
  await drop(".categorized-library", [{ name: "bad.mp4" }, { name: "不支持.txt" }, { name: "恢复.avi" }]);
  assert.equal((await imports()).length, beforeBad + 1);
  assert.equal(await page.evaluate(() => window.pendingUploads()), 0);
  await page.screenshot({ path: ".tmp/media-import/library-videos.png" });
  // Project library drop links membership without adding a canvas instance.
  await page.evaluate(async () => { const { useLocalFileMode } = await import("/src/lib/localFileMode.ts"); useLocalFileMode.getState().openSource("project"); });
  await page.locator('.categorized-library[data-file-import-project-id="p"]').waitFor();
  await drop(".categorized-library", [{ name: "项目视频.mkv" }]);
  assert.equal((await imports()).at(-1).projectId, "p");
  assert.equal(await page.evaluate(() => window.snapshot().nodes.length), nodesBefore);
  // Existing video assets still use the internal drag path, without a second upload.
  const uploadCount = (await imports()).length;
  await page.locator('.catalog-virtual [data-asset-id="media-2"]').evaluate(async element => {
    const dataTransfer = new DataTransfer();
    element.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
    await new Promise(resolve => requestAnimationFrame(resolve));
    const stage = document.querySelector(".canvas-stage");
    const rect = stage.getBoundingClientRect();
    for (const type of ["dragover", "drop"]) stage.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, clientX: rect.left + 600, clientY: rect.top + 360 }));
  });
  await page.waitForFunction(count => window.snapshot().nodes.length === count + 1, nodesBefore);
  assert.equal((await imports()).length, uploadCount);
  await page.evaluate(() => window.store.getState().setCanvasLibraryOpen(false));
  await page.screenshot({ path: ".tmp/media-import/canvas-videos.png" });
  // Route changes during upload preserve the original target and do not alter the new library view.
  await page.evaluate(() => { window.holdMedia = true; });
  const late = drop(".canvas-stage", [{ name: "迟到视频.m4v" }]);
  await page.waitForFunction(() => window.releaseMedia);
  await page.evaluate(() => { const state = window.store.getState(); window.store.setState({ activeProjectId: "q", projectRouteRevision: state.projectRouteRevision + 1 }); window.holdMedia = false; window.releaseMedia(); });
  await late;
  assert.equal((await imports()).at(-1).projectId, "p");
  const lateAsset = (await imports()).at(-1).asset.id;
  assert.equal(await page.evaluate(id => window.snapshot().nodes.find(node => node.assetId === id)?.projectId, lateAsset), "p");
  // Main library supports both picker and drag with the actual current LibraryHome.
  await page.goto("http://127.0.0.1:17924/scripts/fixtures/canvas-reference/preview.html?media-import&media-home&canvas-library&strict");
  await page.locator(".library-home").waitFor();
  await picker(["/picked/首页视频.mp4"]);
  assert.equal((await imports()).at(-1).projectId, null);
  await page.locator('.catalog-virtual [data-asset-id="media-0"]').waitFor();
  await drop(".categorized-library", [{ name: "首页拖入.mov" }]);
  assert.equal((await imports()).at(-1).projectId, null);
  await page.locator('.catalog-virtual [data-asset-id="media-1"]').waitFor();
  assert.equal(await page.evaluate(() => window.snapshot().nodes.length), 2);
  await page.setViewportSize({ width: 560, height: 800 });
  await page.screenshot({ path: ".tmp/media-import/home-narrow.png" });
  assert.deepEqual(errors, []);
  console.log("PASS: video picker/drop, library and canvas targets, chunk bounds, >50 MB, batch failures, cleanup, cancellation and frozen project/coordinates.");
} catch (error) {
  await page.screenshot({ path: ".tmp/media-import/failure.png" });
  console.error(await page.evaluate(() => ({ imports: window.mediaImports, nodes: window.snapshot().nodes, text: document.body.innerText.slice(-1500) })));
  throw error;
} finally { await browser.close(); await server.close(); }
