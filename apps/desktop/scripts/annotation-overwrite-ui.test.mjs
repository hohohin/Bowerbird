import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ cacheDir: ".tmp/annotation-overwrite-vite", server: { host: "127.0.0.1", port: 1587, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const dialog = page.getByRole("dialog", { name: "图片标注", exact: true });
try {
  await page.goto("http://127.0.0.1:1587/scripts/fixtures/canvas-reference/preview.html?source-library&canvas-library");
  await page.waitForFunction(() => window.store);
  await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 800; canvas.height = 400;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "red"; ctx.fillRect(0, 0, 400, 400); ctx.fillStyle = "blue"; ctx.fillRect(400, 0, 400, 400);
    window.originalImage = window.currentImage = canvas.toDataURL();
    window.replacement = { ...window.store.getState().assets.find(a => a.id === "existing"), ext: "png", store_path: "/annotation-source.png", thumb_path: "/annotation-thumb-before.png", width: 800, height: 400 };
    window.savedAnnotations = [];
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "read_image_data_url" && args.path === window.replacement.store_path) return window.currentImage;
      if (command === "canvas_image_preview" && args.path === window.replacement.store_path) return window.replacement.store_path;
      if (command === "save_annotated_image" && args.overwrite) {
        if (window.failOverwrite) throw "原图片已变化，请重新打开后再保存";
        const meta = JSON.parse(args.annotationJson);
        window.savedAnnotations.push({ ...args, meta });
        window.currentImage = args.dataUrl;
        window.replacement = { ...window.replacement, width: meta.image.width, height: meta.image.height, thumb_path: `/annotation-thumb-${window.savedAnnotations.length}.png` };
        window.emitAssetsChanged();
        return window.replacement;
      }
      const result = await invoke(command, args);
      if (Array.isArray(result)) return result.map(a => a.id === "existing" ? window.replacement : a);
      return result;
    };
    window.store.setState(state => ({ assets: state.assets.map(a => a.id === "existing" ? window.replacement : a) }));
    window.emitAssetsChanged();
  });
  await page.route(/\/annotation-(source|thumb[^/]*)\.png(?:\?.*)?$/, async route => {
    const data = await page.evaluate(() => window.currentImage);
    await route.fulfill({ contentType: "image/png", body: Buffer.from(data.split(",")[1], "base64"), headers: { "cache-control": "public, max-age=3600" } });
  });
  const node = page.locator('[data-canvas-node-id="old"]');
  await node.waitFor();
  await page.getByRole("button", { name: "展开画板素材库", exact: true }).click();
  const libraryImage = page.locator('.canvas-source-panel [data-asset-id="existing"] img');
  await libraryImage.waitFor();
  await page.evaluate(() => window.store.getState().openAnnotator("existing"));
  await dialog.locator("svg.cursor-crosshair").waitFor();
  assert.equal(await dialog.getByRole("button", { name: "覆盖原文件", exact: true }).isDisabled(), true);
  await dialog.getByTitle("右转 90°", { exact: true }).click();
  await dialog.getByRole("button", { name: "覆盖原文件", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const saved = await page.evaluate(() => window.savedAnnotations[0]);
  assert.equal(saved.overwrite.assetId, "existing");
  assert.match(saved.overwrite.sourceHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(saved.meta.transform, [{ kind: "rotate", dir: 1 }]);
  assert.deepEqual(saved.meta.image, { width: 400, height: 800 });
  assert.deepEqual(saved.meta.shapes, []);
  await page.waitForFunction(() => { const el = document.querySelector('[data-canvas-node-id="old"]'); return el && el.getBoundingClientRect().height > el.getBoundingClientRect().width * 1.8; });
  await page.waitForFunction(() => { const img = document.querySelector('[data-canvas-node-id="old"] img'); return img?.complete && img.naturalWidth === 400 && img.naturalHeight === 800; });
  await page.waitForFunction(() => { const img = document.querySelector('.canvas-source-panel [data-asset-id="existing"] img'); return img?.complete && img.naturalWidth === 400 && img.naturalHeight === 800; });
  const libraryBox = await libraryImage.boundingBox();
  assert.ok(libraryBox.height > libraryBox.width * 1.8, "library geometry follows portrait dimensions");
  const firstSrc = await node.locator(":scope > img").getAttribute("src");
  assert.equal(await page.evaluate(() => window.snapshot().nodes.filter(n => n.assetId === "existing").length), 1);
  await page.evaluate(() => { window.failOverwrite = true; window.store.getState().openAnnotator("existing"); });
  await dialog.locator("svg.cursor-crosshair").waitFor();
  await dialog.getByRole("button", { name: "垂直镜像", exact: true }).click();
  await dialog.getByRole("button", { name: "覆盖原文件", exact: true }).click();
  await page.getByText("原图片已变化，请重新打开后再保存", { exact: false }).first().waitFor();
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await page.evaluate(() => window.savedAnnotations.length), 1);
  await page.evaluate(() => { window.failOverwrite = false; });
  await dialog.getByRole("button", { name: "覆盖原文件", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const second = await page.evaluate(() => window.savedAnnotations[1]);
  assert.notEqual(second.overwrite.sourceHash, saved.overwrite.sourceHash);
  assert.deepEqual(second.meta.transform, [{ kind: "flip", axis: "vertical" }]);
  await page.waitForFunction(first => {
    const img = document.querySelector('[data-canvas-node-id="old"] img');
    if (!img?.complete || !img.naturalWidth || img.getAttribute("src") === first) return false;
    const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
    return ctx.getImageData(10,10,1,1).data[2] > 240;
  }, firstSrc);
  await page.waitForFunction(() => {
    const img = document.querySelector('.canvas-source-panel [data-asset-id="existing"] img');
    return img?.complete && img.getAttribute("src").includes("thumb-2");
  });
  assert.deepEqual(errors, []);
  console.log("PASS annotation overwrite: transform-only save, stable identity, portrait canvas pixels/layout, source revision, failed save retains editor, retry");
} finally { await browser.close(); await server.close(); }
