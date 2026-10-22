import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
const server = await createServer({ server: { host: "127.0.0.1", port: 1707, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(10000);
try {
  await page.goto("http://127.0.0.1:1707/scripts/fixtures/file-colors/preview.html");
  await page.waitForFunction(() => window.setSnapshot);
  const snapshot = async (files, revision = 0) => {
    await page.evaluate(({ files, revision }) => window.setSnapshot({ revision,
      entries: files.map(([path, version]) => ({ path, version, name: path, directory: false })) }), { files, revision });
    await page.waitForFunction(files => { const state = JSON.parse(document.querySelector("output").textContent);
      return !state.pending && files.every(([path]) => state.colors[path]); }, files);
  };
  const calls = () => page.evaluate(() => window.calls.slice());
  await snapshot([["a", "1"], ["b", "1"]]);
  assert.equal((await calls()).length, 2);
  await snapshot([["a", "1"]]);
  await snapshot([["a", "1"], ["b", "1"], ["c", "1"]]);
  assert.deepEqual(await calls(), ["a", "b", "c"], "filter changes reuse successful colors and read new members only");
  await snapshot([["a", "2"], ["b", "1"], ["c", "1"]]);
  assert.deepEqual(await calls(), ["a", "b", "c", "a"], "changed version invalidates only that file");
  await snapshot([["a", "2"], ["b", "1"]], 1);
  assert.deepEqual(await calls(), ["a", "b", "c", "a", "a", "b"], "explicit snapshot refresh rereads visible entries");
  await page.evaluate(() => { window.hold = "old"; window.setSnapshot({ revision: 2, entries: [{ path: "old", name: "old", directory: false, version: "1" }] }); });
  await page.waitForFunction(() => window.release);
  await snapshot([["new", "1"]], 3);
  await page.evaluate(() => window.release());
  await page.waitForTimeout(50);
  assert.deepEqual(await page.locator("output").evaluate(el => JSON.parse(el.textContent).colors), { new: ["red"] }, "late reads from an old directory cannot replace the current snapshot");
  console.log("PASS file color cache: filter reuse, newly exposed entries, version changes, explicit refresh and stale response isolation");
} finally { await browser.close(); await server.close(); }
