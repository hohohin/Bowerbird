import assert from "node:assert/strict";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
import { createServer } from "vite";

const entry = "scripts/fixtures/canvas-reference/preview.html";
const server = await createServer({ cacheDir: ".tmp/canvas-refresh-burst-vite", optimizeDeps: { entries: [entry] },
  server: { host: "127.0.0.1", port: 17193, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls.local[0] + entry);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { api } = await import("/src/lib/api.ts");
    const read = api.projectCanvasGet;
    window.reads = 0;
    api.projectCanvasGet = async (...args) => {
      const number = ++window.reads;
      const snapshot = structuredClone(await read(...args));
      if (number === 1) await new Promise(resolve => { window.releaseFirst = resolve; });
      else snapshot.nodes.push({ ...snapshot.nodes.find(node => node.id === "old"), id: "latest-added" });
      return snapshot;
    };
    window.emitChange();
  });
  await page.waitForFunction(() => !!window.releaseFirst);
  await page.evaluate(async () => {
    for (let i = 0; i < 4; i++) {
      window.emitChange();
      await new Promise(resolve => setTimeout(resolve, 90));
    }
  });
  assert.equal(await page.evaluate(() => window.reads), 1, "card updates share the in-flight snapshot");
  await page.evaluate(() => window.releaseFirst());
  await page.locator('[data-canvas-node-id="latest-added"]').waitFor();
  assert.equal(await page.evaluate(() => window.reads), 2, "one trailing refresh includes the latest batch");
  console.log("PASS queued canvas refreshes coalesce and display the latest changes");
} finally {
  await browser.close();
  await server.close();
}
