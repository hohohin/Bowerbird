import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
const server = await createServer({ server: { host: "127.0.0.1", port: 1556, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
const errors = []; page.on("pageerror", error => errors.push(error.message));
const capturedNodes = () => page.evaluate(() => window.snapshot().nodes.filter(node => node.assetId === "collected"));
async function drop(selector = "[data-canvas-stage]") {
  return page.locator(selector).evaluate(element => {
    const rect = element.getBoundingClientRect();
    const clientX = Math.floor(rect.left + rect.width * 0.35), clientY = Math.floor(rect.top + rect.height * 0.3);
    const matrix = new DOMMatrix(getComputedStyle(document.querySelector(".canvas-plane")).transform);
    const point = { x: (clientX - rect.left - matrix.e) / matrix.a, y: (clientY - rect.top - matrix.f) / matrix.d };
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("application/x-bowerbird-explorer", JSON.stringify({ version: 1, imageUrl: "https://i.pinimg.com/image.png", pageUrl: "https://www.pinterest.com/pin/1" }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer, clientX, clientY }));
    return point;
  });
}
async function settled() { await page.waitForFunction(() => !document.querySelector(".explore-capture-status")); }
function atPoint(node, point) {
  assert.ok(Math.abs(node.x + node.width / 2 - point.x) < 0.01);
  assert.ok(Math.abs(node.y + node.height / 2 - point.y) < 0.01);
  assert.equal(node.projectId, "p"); assert.equal(node.threadId, null);
}
try {
  await page.goto("http://127.0.0.1:1556/scripts/fixtures/canvas-reference/preview.html?explorer");
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.waitForFunction(() => window.calls.filter(call => call.command === "resize_source_browser").at(-1)?.args.visible === true);
  const browserNavigationCount = await page.evaluate(() => window.calls.filter(call => ["open_source_browser", "navigate_source_browser", "reload_source_browser"].includes(call.command)).length);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.locator('[data-canvas-node-id="old"]').click({ button: "right" });
    await page.getByRole("menu").waitFor();
    await page.waitForTimeout(120);
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === "resize_source_browser").at(-1)?.args.visible), true,
      "a context menu on the canvas must not hide the browser behind a loading placeholder");
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "hidden" });
  }
  assert.equal(await page.evaluate(() => window.calls.filter(call => ["open_source_browser", "navigate_source_browser", "reload_source_browser"].includes(call.command)).length), browserNavigationCount);
  const source = page.locator(".canvas-source-content");
  const resizer = page.getByRole("separator", { name: "调整素材面板宽度" });
  const toggle = page.locator(".canvas-source-toggle:visible");
  assert.equal(await page.locator(".canvas-board-toolbar .canvas-source-toggle").count(), 0);
  assert.equal(await page.locator(".canvas-source-panel .canvas-source-toggle:visible").count(), 1);
  assert.equal(await source.isVisible(), false, "opening a canvas with exploration already open collapses its library");
  await page.evaluate(() => {
    window.originalSource = document.querySelector(".canvas-source-panel");
    window.originalNode = document.querySelector('[data-canvas-node-id="old"]');
    window.originalTransform = document.querySelector(".canvas-plane").style.transform;
  });
  await toggle.click();
  assert.equal(await source.isVisible(), true, "manual expansion is allowed during exploration");
  await page.getByRole("tab", { name: "中央素材", exact: true }).click();
  await resizer.focus(); await page.keyboard.press("ArrowRight");
  const sourceWidth = await source.evaluate(element => element.getBoundingClientRect().width);
  const boardWidth = await page.locator(".canvas-board-shell").evaluate(element => element.getBoundingClientRect().width);
  await toggle.click();
  assert.equal(await resizer.count(), 0, "the hidden library does not leave a resize gutter");
  assert.ok(await page.locator(".canvas-board-shell").evaluate(element => element.getBoundingClientRect().width) > boardWidth + 200);
  await toggle.press("Enter");
  assert.equal(await page.getByRole("tab", { name: "中央素材", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await source.evaluate(element => element.getBoundingClientRect().width), sourceWidth);
  await page.getByRole("button", { name: "收起浏览器", exact: true }).click();
  await page.evaluate(() => window.setExploring(true));
  await source.waitFor({ state: "hidden" });
  await mkdir(".tmp", { recursive: true });
  await page.screenshot({ path: ".tmp/canvas-explorer-library-collapsed.png" });
  await page.getByRole("button", { name: "收起浏览器", exact: true }).click();
  assert.equal(await source.isVisible(), false, "closing exploration keeps the library collapsed until requested");
  await toggle.click();
  await page.getByRole("tab", { name: "项目素材", exact: true }).click();
  assert.ok(await page.evaluate(() => window.originalSource === document.querySelector(".canvas-source-panel")
    && window.originalNode === document.querySelector('[data-canvas-node-id="old"]')
    && window.originalTransform === document.querySelector(".canvas-plane").style.transform));
  await page.screenshot({ path: ".tmp/canvas-library-expanded.png" });
  await page.evaluate(() => window.setExploring(true));
  await page.setViewportSize({ width: 1000, height: 800 });
  await toggle.click(); await toggle.click();
  assert.equal(await toggle.isVisible(), true, "narrow canvases retain the expand control");
  await page.setViewportSize({ width: 1800, height: 1000 });
  await drop('[aria-label="探索采集素材"]'); await settled();
  assert.equal((await capturedNodes()).length, 0, "non-canvas drops only collect into the library");
  await page.evaluate(() => { window.holdCapture = true; });
  const first = await drop();
  await page.waitForFunction(() => window.releaseCapture);
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.evaluate(() => { window.holdCapture = false; window.releaseCapture(); window.releaseCapture = null; });
  await settled();
  const [node] = await capturedNodes(); atPoint(node, first);
  await page.locator(`[data-canvas-node-id="${node.id}"]`).waitFor();
  // Deduplicated library assets still get a fresh card at each drop.
  const second = await drop(); await settled();
  const nodes = await capturedNodes(); assert.equal(nodes.length, 2); assert.notEqual(nodes[0].id, nodes[1].id); atPoint(nodes[1], second);
  await page.evaluate(() => { window.failCapture = true; });
  await drop(); await settled(); assert.equal((await capturedNodes()).length, 2);
  await page.evaluate(() => { window.failCapture = false; window.holdCapture = true; });
  const third = await drop(); await page.waitForFunction(() => window.releaseCapture);
  await page.evaluate(() => window.store.setState({ activeProjectId: "q", projectRouteRevision: 1 }));
  await page.waitForFunction(() => !document.querySelector('[data-canvas-node-id="old"]'));
  await page.evaluate(() => { window.holdCapture = false; window.releaseCapture(); });
  await settled();
  const finalNodes = await capturedNodes(); assert.equal(finalNodes.length, 3); atPoint(finalNodes[2], third);
  assert.equal(await page.locator(`[data-canvas-node-id="${finalNodes[2].id}"]`).count(), 0, "must not add a card to the new project");
  await page.evaluate(() => window.save()); await page.reload();
  await page.locator(`[data-canvas-node-id="${finalNodes[2].id}"]`).waitFor();
  assert.deepEqual(await capturedNodes(), finalNodes, "positions survive reloading the original project");
  await page.evaluate(() => sessionStorage.clear());
  await page.goto("http://127.0.0.1:1556/scripts/fixtures/canvas-reference/preview.html?explorer&provisional");
  await page.waitForFunction(() => document.querySelector('.canvas-workspace[aria-busy="false"]'));
  const provisionalPoint = await drop(); await settled();
  const provisionalNodes = await capturedNodes(); assert.equal(provisionalNodes.length, 1); atPoint(provisionalNodes[0], provisionalPoint);
  const commands = await page.evaluate(() => window.calls.map(call => call.command));
  assert.ok(commands.indexOf("project_canvas_materialize") >= 0);
  assert.ok(commands.indexOf("project_canvas_materialize") < commands.indexOf("capture_source_browser_image"));
  assert.ok(commands.indexOf("capture_source_browser_image") < commands.indexOf("project_canvas_node_create"));
  assert.deepEqual(errors, []);
  console.log("PASS explorer canvas: right-click keeps browser visible without navigation, automatic library collapse, manual/keyboard toggle, retained filters/width/DOM/viewport, narrow controls, drop coordinates, zoom while downloading, duplicate instances, failure, frozen project, persisted reload, provisional project, library-only drop");
} finally { await browser.close(); await server.close(); }
