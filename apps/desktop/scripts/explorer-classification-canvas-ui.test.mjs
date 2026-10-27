import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1572, strictPort: true, hmr: false, watch: null } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(10000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1") return route.continue();
    if (url.hostname === "image.test") return route.fulfill({ contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="190" height="150"><rect width="190" height="150" fill="#648774"/></svg>' });
    return route.abort();
  });
  const dragId = number => number.toString(16).padStart(32, "0");
  const cards = page.locator("[data-classification-id]");
  const card = number => page.locator(`[data-classification-id^="${dragId(number)}:"]`);
  const nodes = () => page.evaluate(() => window.snapshot().nodes.filter(node => node.assetId === "collected"));
  const settled = () => page.locator(".explore-capture-status").waitFor({ state: "detached" });
  const calls = (command, number) => page.evaluate(({ command, id }) => window.calls.filter(call => call.command === command && call.args?.dragId === id).length, { command, id: dragId(number) });
  const pending = number => page.waitForFunction(id => Boolean(window.classificationFinishes[id]), dragId(number));
  const finish = number => page.evaluate(id => window.classificationFinishes[id].resolve(["插画", "柔光"]), dragId(number));
  const releaseCapture = () => page.evaluate(() => { window.holdCapture = false; window.releaseCapture(); window.releaseCapture = null; });
  function atPoint(node, point) {
    assert.ok(Math.abs(node.x + node.width / 2 - point.x) < .01, `x remains frozen: ${JSON.stringify({ node, point })}`);
    assert.ok(Math.abs(node.y + node.height / 2 - point.y) < .01, `y remains frozen: ${JSON.stringify({ node, point })}`);
    assert.equal(node.projectId, "p"); assert.equal(node.threadId, null);
  }
  async function drop(number) {
    await page.waitForFunction(() => {
      const plane = document.querySelector(".canvas-plane"), shown = new DOMMatrix(getComputedStyle(plane).transform), target = new DOMMatrix(plane.style.transform);
      return ["a", "d", "e", "f"].every(key => Math.abs(shown[key] - target[key]) < .001);
    });
    return page.locator("[data-canvas-stage]").evaluate((element, id) => {
      const rect = element.getBoundingClientRect();
      const clientX = Math.floor(rect.left + rect.width * .35), clientY = Math.floor(rect.top + rect.height * .3);
      const matrix = new DOMMatrix(getComputedStyle(document.querySelector(".canvas-plane")).transform);
      const point = { x: (clientX - rect.left - matrix.e) / matrix.a, y: (clientY - rect.top - matrix.f) / matrix.d };
      const dataTransfer = new DataTransfer();
      dataTransfer.setData("application/x-bowerbird-explorer", JSON.stringify({ version: 1, dragId: id,
        imageUrl: `https://image.test/${id}.png`, pageUrl: "https://www.pinterest.com/pin/1" }));
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer, clientX, clientY }));
      return point;
    }, dragId(number));
  }
  await page.goto("http://127.0.0.1:1572/scripts/fixtures/canvas-reference/preview.html?explorer");
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.waitForFunction(() => {
    const matrix = new DOMMatrix(getComputedStyle(document.querySelector(".canvas-plane")).transform), view = window.snapshot().view;
    return Math.abs(matrix.a - view.zoom) < .001 && Math.abs(matrix.e - view.panX) < .01 && Math.abs(matrix.f - view.panY) < .01;
  });
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.classificationFinishes = {};
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "claim_source_browser_analysis" || command === "finish_source_browser_analysis") {
        window.calls.push({ command, args });
        if (command === "claim_source_browser_analysis") return true;
        return new Promise(resolve => { window.classificationFinishes[args.dragId] = { args, resolve }; });
      }
      if (command === "project_canvas_node_create" && window.failClassificationNode) {
        window.calls.push({ command, args }); throw new Error("模拟画板卡片保存失败");
      }
      return invoke(command, args);
    };
    window.holdCapture = true;
  });
  const first = await drop(1);
  await page.waitForFunction(() => window.releaseCapture); await card(1).waitFor();
  const beforeZoom = await page.locator(".canvas-plane").evaluate(element => element.style.transform);
  await page.getByRole("button", { name: "放大", exact: true }).click();
  assert.notEqual(await page.locator(".canvas-plane").evaluate(element => element.style.transform), beforeZoom);
  await releaseCapture(); await settled(); await pending(1);
  const [firstNode] = await nodes(); atPoint(firstNode, first);
  await page.locator(`[data-canvas-node-id="${firstNode.id}"]`).waitFor();
  assert.equal(await card(1).getAttribute("data-outcome"), null, "canvas insertion does not wait for classification");
  const second = await drop(2); await settled(); await pending(2);
  const twoNodes = await nodes(); assert.equal(twoNodes.length, 2); atPoint(twoNodes[1], second);
  assert.notEqual(twoNodes[0].id, twoNodes[1].id, "deduplicated assets keep separate canvas instances");
  assert.equal(await cards.count(), 2, "a new drop preserves the previous pending classification");
  await finish(2); await finish(1);
  await page.waitForFunction(() => document.querySelectorAll('[data-outcome="matched"]').length === 2);
  await page.waitForFunction(() => !document.querySelector("[data-classification-id]"));

  async function failedDrop(number, failure, expectedNodes) {
    await page.evaluate(failure => { window[failure] = true; window.holdCapture = true; }, failure);
    await drop(number); await page.waitForFunction(() => window.releaseCapture); await card(number).waitFor();
    await releaseCapture(); await settled(); await card(number).waitFor({ state: "detached" });
    assert.equal((await nodes()).length, expectedNodes, `${failure} must not create a canvas node`);
    assert.equal(await calls("finish_source_browser_analysis", number), 0, `${failure} cannot hand off classification`);
    assert.equal(await calls("release_source_browser_analysis", number), 1, `${failure} releases its preview`);
    await page.evaluate(failure => { window[failure] = false; }, failure);
  }
  await failedDrop(3, "failCapture", 2);
  await page.evaluate(() => { window.holdCapture = true; });
  const third = await drop(5); await page.waitForFunction(() => window.releaseCapture); await card(5).waitFor();
  await page.evaluate(() => window.store.setState({ activeProjectId: "q", projectRouteRevision: 1 }));
  await page.locator('[data-canvas-node-id="old"]').waitFor({ state: "detached" });
  await card(5).waitFor({ state: "detached" });
  await releaseCapture(); await settled(); await pending(5);
  const finalNodes = await nodes(); assert.equal(finalNodes.length, 3); atPoint(finalNodes[2], third);
  assert.equal(await page.locator(`[data-canvas-node-id="${finalNodes[2].id}"]`).count(), 0, "the old drop cannot insert into the new project");
  await finish(5);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await cards.count(), 0, "late old-project results cannot resurrect a dock card");
  for (const number of [1, 2, 5]) assert.equal(await calls("finish_source_browser_analysis", number), 1, "one handoff per captured drop");
  await page.evaluate(() => window.store.setState({ activeProjectId: "p", projectRouteRevision: 2 }));
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  // Keep the save fault last: the real canvas journal retries failed writes on the next flush.
  await failedDrop(4, "failClassificationNode", 3);
  await page.evaluate(() => window.save()); await page.reload();
  await page.locator(`[data-canvas-node-id="${finalNodes[2].id}"]`).waitFor();
  assert.deepEqual(await nodes(), finalNodes, "the original project's frozen positions survive reload");
  assert.deepEqual(errors, []);
  console.log("PASS explorer classification canvas: pending insertion, frozen zoom coordinates, duplicate instances, capture/node failure cleanup, single handoff, project isolation and persisted positions");
} finally { await browser?.close(); await server.close(); }
