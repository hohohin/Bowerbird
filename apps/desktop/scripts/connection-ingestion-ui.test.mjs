import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 17874, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
const calls = command => page.evaluate(command => window.calls.filter(call => call.command === command), command);
try {
  await page.goto("http://127.0.0.1:17874/scripts/fixtures/connection-ingestion/preview.html");
  await page.locator("[data-test-target]").waitFor();
  const paste = options => page.evaluate(async options => {
    window.clipboardPaths = options.paths ?? [];
    window.clipboardError = options.error ?? false;
    const file = new File([new Uint8Array([1, 2, 3])], options.name ?? "picture.png", { type: "image/png" });
    try { return { asset: await window.importDroppedMedia(file, "p", "clipboard") }; }
    catch (error) { return { error: String(error) }; }
  }, options);
  assert.equal((await paste({ paths: ["D:/素材/picture.png"] })).asset.store_path, "D:/素材/picture.png");
  assert.equal((await calls("import_image_bytes")).length, 0);
  assert.equal((await paste({ paths: ["/Users/example/素材/picture.png"] })).asset.source, "external");
  assert.match((await paste({ paths: ["D:/a.png", "D:/b.png"] })).error, /原文件位置/);
  assert.match((await paste({ error: true })).error, /剪贴板/);
  assert.equal((await calls("import_image_bytes")).length, 0, "failed clipboard inspection must not copy pixels from an existing file");
  assert.equal((await paste({})).asset.id, "first-save");
  assert.equal((await calls("import_image_bytes")).length, 1, "bitmap-only paste forms its original once");
  assert.equal((await calls("import_image_bytes"))[0].args.source, "clipboard");

  async function drop(path) {
    await page.locator("[data-test-target]").evaluate((target, path) => {
      const file = new File([new Uint8Array([1, 2, 3])], "drop.png", { type: "image/png" });
      if (path) Object.defineProperty(file, "path", { value: path });
      const data = new DataTransfer(); data.items.add(file);
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
    }, path);
  }
  const before = (await calls("import_files")).length;
  await drop(null);
  await page.getByText(/无法取得原文件位置/).waitFor();
  assert.equal((await calls("import_files")).length, before);
  assert.equal((await calls("import_image_bytes")).length, 1);
  assert.equal((await calls("video_import_begin")).length, 0);
  await drop("D:/素材/drop.png");
  await page.waitForFunction(() => window.calls.some(call => call.command === "create_material_references"));
  assert.deepEqual((await calls("import_files")).at(-1).args, { sources: ["D:/素材/drop.png"], projectId: "p" });
  assert.deepEqual((await calls("create_material_references")).at(-1).args, { assetIds: ["D:/素材/drop.png"], folderId: "folder" });
  assert.equal((await calls("import_image_bytes")).length, 1, "local drops never upload the existing bytes");
  await page.getByRole("button", { name: "预览 HEIC" }).click();
  await page.waitForFunction(() => { const img = document.querySelector('.media-lightbox img'); return img?.complete && img.naturalWidth > 0; });
  assert.equal((await calls("external_files_media"))[0].args.path, "D:/素材/original.heic");
  assert.match(await page.locator(".media-lightbox img").getAttribute("src"), /^data:image/);
  assert.equal((await calls("import_image_bytes")).length, 1, "display decoding does not import another original");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "查看 HEIC 详情" }).click();
  const detail = page.locator("[data-test-detail]"); await detail.waitFor();
  await detail.evaluate(img => img.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true })));
  await page.waitForFunction(() => !document.querySelector('[data-test-detail]').style.transform.endsWith('scale(1)'));
  assert.match(await detail.getAttribute("style"), /scale\(1\./, "late decoded detail image keeps wheel zoom");
  assert.deepEqual(errors, []);
  console.log("PASS: Windows/macOS file paste stays linked, bitmap first save, clipboard failure and pathless drop cannot copy, directory drop creates a reference.");
} finally { await browser.close(); await server.close(); }
