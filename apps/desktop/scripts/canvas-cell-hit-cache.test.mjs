import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ cacheDir: ".tmp/canvas-cell-hit-cache-vite", optimizeDeps: { noDiscovery: true, include: [] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") return route.abort();
    if (url.pathname === "/cell-hit-test") return route.fulfill({ contentType: "text/html", body: `<!doctype html>
      <style>body{margin:0}#stage{position:relative;margin:20px;width:900px;height:700px}#world{transform-origin:0 0}
      [data-canvas-node-id]{position:absolute;width:200px;height:160px}#content{left:100px;top:80px}
      [data-canvas-cell]{width:100%;height:80px}#material{left:600px;top:100px}
      #scroller{height:100px;overflow:auto}#inside{height:200px}</style>
      <div id="stage"><div id="world"><div id="content" data-canvas-node-id="content"><div id="scroller"><div id="inside">
      <div data-canvas-cell="a"></div><div data-canvas-cell="b"></div></div></div></div>
      <div id="material" data-canvas-node-id="material"></div></div></div>` });
    return route.continue();
  });
  await page.goto(`${server.resolvedUrls.local[0]}cell-hit-test`);
  await page.evaluate(async () => {
    const { createCanvasCellHitCache } = await import("/src/lib/canvasCellHitCache.ts");
    const stage = document.querySelector("#stage"), world = document.querySelector("#world");
    window.camera = { x: 0, y: 0, zoom: 1 };
    window.measurements = 0;
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.hasAttribute("data-canvas-cell")) window.measurements++;
      return original.call(this);
    };
    window.cache = createCanvasCellHitCache(stage, (clientX, clientY) => {
      const bounds = stage.getBoundingClientRect();
      return { x: (clientX - bounds.left - camera.x) / camera.zoom, y: (clientY - bounds.top - camera.y) / camera.zoom };
    }, () => camera.zoom);
    window.read = (fresh = false) => cache.get(fresh).map(({ targetId, cellId, rect }) => ({ targetId, cellId, rect }));
    window.cameraMove = () => { Object.assign(camera, { x: 73, y: 29, zoom: 2 }); world.style.transform = `translate(${camera.x}px,${camera.y}px) scale(${camera.zoom})`; };
    window.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const first = await page.evaluate(() => read());
  assert.deepEqual(first.map(entry => entry.rect), [{ x: 100, y: 80, width: 200, height: 80 }, { x: 100, y: 160, width: 200, height: 80 }]);
  await page.evaluate(async () => { await settle(); read(); measurements = 0; });
  assert.deepEqual(await page.evaluate(() => { for (let i = 0; i < 100; i++) read(); return { measurements, result: read() }; }), { measurements: 0, result: first });

  // Direct camera transforms and unrelated material motion must not invalidate stationary cells.
  await page.evaluate(async () => { cameraMove(); document.querySelector("#material").style.transform = "translateX(50px)"; await settle(); });
  assert.deepEqual(await page.evaluate(() => ({ measurements, result: read() })), { measurements: 0, result: first });
  assert.deepEqual(await page.evaluate(() => read(true)), first, "fresh measurement agrees after camera transform");

  // takeRecords also catches a geometry edit before the observer callback has run.
  const moved = await page.evaluate(() => { document.querySelector("#content").style.left = "140px"; return read(); });
  assert.equal(moved[0].rect.x, 140);
  const replaced = await page.evaluate(() => { document.querySelector("[data-canvas-cell=a]").dataset.canvasCell = "replacement"; return read(); });
  assert.equal(replaced[0].cellId, "replacement");

  // A class outside the card can change its CSS size; ResizeObserver catches the resulting geometry.
  await page.evaluate(async () => {
    const sheet = document.createElement("style"); sheet.textContent = "body.wide #content{width:240px}";
    document.head.append(sheet); document.body.classList.add("wide"); await settle();
  });
  assert.equal((await page.evaluate(() => read()))[0].rect.width, 240);
  const inserted = await page.evaluate(() => {
    const cell = document.createElement("div"); cell.dataset.canvasCell = "new";
    document.querySelector("#inside").append(cell); return read();
  });
  assert.deepEqual(inserted.map(entry => entry.cellId), ["replacement", "b", "new"]);
  await page.evaluate(async () => { document.querySelector("#scroller").scrollTop = 35; await settle(); });
  assert.equal((await page.evaluate(() => read()))[0].rect.y, 45);
  const removed = await page.evaluate(() => { document.querySelector("[data-canvas-cell=b]").remove(); return read(); });
  assert.deepEqual(removed.map(entry => entry.cellId), ["replacement", "new"]);
  await page.evaluate(() => { cache.invalidate(); read(); measurements = 0; cache.dispose(); document.querySelector("#content").style.left = "400px"; });
  assert.deepEqual(await page.evaluate(async () => { await settle(); return { measurements, result: read(true) }; }), { measurements: 0, result: [] });
  assert.deepEqual(errors, []);
  console.log("canvas cell hit cache: reuse, camera, material drag, fresh hit, cell/card edits, resize, scroll, insertion/removal and disposal passed");
} finally {
  await browser.close();
  await server.close();
}
