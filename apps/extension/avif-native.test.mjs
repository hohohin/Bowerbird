import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "../html-renderer/node_modules/playwright/index.mjs";

// Generated with FFmpeg: color=c=blue:s=16x16, libaom-av1, one still frame.
const avif = await readFile(new URL("../desktop/src-tauri/tests/fixtures/image/blue-16.avif", import.meta.url));
const pageUrl = "https://fixture.example/page";
const avifUrl = "https://fixture.example/source.avif";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.route(pageUrl, route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.route(avifUrl, route => route.fulfill({ contentType: "application/octet-stream", body: avif }));
  await page.goto(pageUrl);
  await page.evaluate(() => {
    globalThis.importScripts = () => {};
    globalThis.BowerbirdCollection = {
      MAX_IMAGE_BYTES: 50 * 1024 * 1024,
      FETCH_TIMEOUT_MS: 45000,
      uploadBytes: async (bytes, metadata) => {
        const png = new Uint8Array(bytes);
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        try {
          return { ok: true, metadata, signature: [...png.subarray(0, 8)], size: [bitmap.width, bitmap.height] };
        } finally { bitmap.close(); }
      },
    };
    globalThis.BowerbirdImageBatch = { listen() {} };
    chrome.runtime = { onMessage: { addListener(listener) { globalThis.testBackgroundMessage = listener; } } };
  });
  for (const name of ["video-utils.js", "background.js"]) {
    await page.addScriptTag({ content: await readFile(new URL(name, import.meta.url), "utf8") });
  }
  const result = await page.evaluate(({avifUrl, pageUrl}) => new Promise(resolve => {
    testBackgroundMessage({ type: "save_image", url: avifUrl, pageUrl }, {}, resolve);
  }), { avifUrl, pageUrl });
  assert.equal(result.ok, true);
  assert.equal(result.metadata.requested_url, avifUrl);
  assert.equal(result.metadata.effective_url, avifUrl);
  assert.equal(result.metadata.page_url, pageUrl);
  assert.equal(result.metadata.content_type, "image/png");
  assert.equal(result.metadata.file_name, "source.png");
  assert.deepEqual(result.signature, [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(result.size, [16, 16]);
  console.log("Chromium decodes octet-stream AVIF and hands a valid PNG to the desktop upload path");
} finally { await browser.close(); }
