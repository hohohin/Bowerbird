import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
import { startBrowserDrag } from "./fixtures/explorer/native-drag.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1567, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
const errors = []; page.on("pageerror", error => errors.push(error.message));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="240"><rect width="200" height="240" fill="#cddfd3"/><circle cx="100" cy="110" r="65" fill="#436655"/><path d="M50 210L100 50L160 210" fill="#e9eee6"/></svg>';
const id = "a".repeat(32);
const imageUrl = "https://image.test/a.png";
const labels = [
  { key: "label_0", name: "海报", probability: .45, selected: true },
  { key: "label_1", name: "字体排版", probability: .3, selected: true },
  { key: "no_match", name: "无明显匹配项", probability: .15, selected: false },
  { key: "label_2", name: "图文卡片", probability: .1, selected: false },
];
const host = page.locator("[data-explorer-drag-visual]");
async function emit(event, payload) {
  await page.evaluate(({ event, payload }) => {
    for (const call of window.calls.filter(c => c.command === "plugin:event|listen" && c.args.event === event)) {
      window.callbacks[call.args.handler]({ event, payload, id: 1 });
    }
  }, { event, payload });
}
async function over(x = 750, y = 360) {
  await page.locator(".explore-main").evaluate((el, { x, y }) => {
    const dataTransfer = new DataTransfer(); dataTransfer.setData("text/plain", "");
    el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer, clientX: x, clientY: y }));
  }, { x, y });
}
async function drop() {
  await page.locator(".explore-main").evaluate((el, { id, imageUrl }) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("application/x-bowerbird-explorer", JSON.stringify({ version: 1, dragId: id, imageUrl, pageUrl: "https://www.pinterest.com/pin/1" }));
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer, clientX: 750, clientY: 360 }));
  }, { id, imageUrl });
}
try {
  await mkdir(".tmp/explorer-motion", { recursive: true });
  // Real Chromium dragstart: source pickup, transparent replacement and cancel.
  const source = await browser.newPage({ viewport: { width: 560, height: 650 } });
  for (const file of ["../extension/candidate-utils.js", "src/lib/explorerDragVisual.js", "src-tauri/src/commands/source_browser_drag.js"]) await source.addInitScript(await readFile(file, "utf8"));
  await source.route("https://source.test/**", route => route.fulfill(route.request().resourceType() === "image"
    ? { contentType: "image/svg+xml", body: svg }
    : { contentType: "text/html; charset=utf-8", body: '<meta charset="utf-8"><body style="background:#f2f4f0;padding:50px;font:16px system-ui"><h2>探索灵感</h2><img src="/image.png" width="200" height="240"></body>' }));
  await source.goto("https://source.test/");
  const rect = await source.locator("img").boundingBox();
  const { session, data } = await startBrowserDrag(source, rect.x + 70, rect.y + 70);
  await source.locator("[data-explorer-drag-visual] .card").waitFor();
  await source.waitForTimeout(150);
  await source.screenshot({ path: ".tmp/explorer-motion/01-pickup.png" });
  await session.send("Input.dispatchDragEvent", { type: "dragCancel", x: 0, y: 0, data });
  await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 0, y: 0, button: "left", buttons: 0 });
  await source.locator("[data-explorer-drag-visual]").waitFor({ state: "detached" });
  await session.detach(); await source.close();

  await page.route("https://image.test/**", route => route.fulfill({ contentType: "image/svg+xml", body: svg }));
  await page.goto("http://127.0.0.1:1567/scripts/fixtures/explorer/preview.html");
  await page.getByRole("button", { name: "探索", exact: true }).click();
  await page.waitForFunction(() => window.calls.some(c => c.args?.event === "source-browser://drag-preview"));
  await emit("source-browser://drag", { phase: "start", id, imageUrl });
  await over();
  await host.locator(".card").waitFor();
  assert.equal(await host.evaluate(el => getComputedStyle(el).pointerEvents), "none");
  await emit("source-browser://drag-preview", { id: "old", labels });
  assert.equal(await host.locator(".chip").count(), 0);
  await emit("source-browser://drag-preview", { id, labels });
  await page.waitForTimeout(650);
  assert.equal(await host.locator(".heading").count(), 0, "one unified ranking has no dimension headings");
  const cardBox = await host.locator(".card").boundingBox();
  for (const [index, group] of (await host.locator(".chip").all()).entries()) {
    const rows = group.locator(".candidate");
    const box = await rows.first().boundingBox();
    assert.equal(box.x + box.width / 2 < cardBox.x + cardBox.width / 2, index % 2 === 0, "left/right corner placement");
    assert.equal(box.y + box.height / 2 < cardBox.y + cardBox.height / 2, index < 2, "top/bottom corner placement");
    const styles = await rows.evaluateAll(elements => elements.map(el => {
      const style = getComputedStyle(el);
      return { weight: Number(style.fontWeight), opacity: Number(style.opacity), transform: style.transform };
    }));
    assert.equal(styles.length, 1, "each corner shows one candidate from the unified ranking");
    assert.equal(styles[0].weight, index < 2 ? 700 : 400);
  }
  assert.deepEqual(await host.locator('.candidate').allTextContents(), ["#海报45%", "#字体排版30%", "无明显匹配项15%", "#图文卡片10%"]);
  assert.deepEqual(await host.locator('[data-selected="true"]').allTextContents(), ["#海报45%", "#字体排版30%"]);
  await page.screenshot({ path: ".tmp/explorer-motion/02-carry-tags.png" });
  for (const [x, y] of [[480, 40], [480, 840], [1270, 40], [1270, 840]]) {
    await over(x, y);
    const panel = await page.locator(".explore-main").boundingBox();
    for (const chip of await host.locator(".candidate").all()) {
      const box = await chip.boundingBox();
      assert.ok(box.x >= panel.x && box.x + box.width <= panel.x + panel.width && box.y >= panel.y && box.y + box.height <= panel.y + panel.height);
    }
  }
  await page.evaluate(() => { window.analyse = true; window.hold = true; });
  await over(); await drop();
  const dock = page.locator("[data-explorer-classification-dock]");
  await host.waitFor({ state: "detached" });
  await dock.locator("[data-classification-id]").waitFor();
  await page.waitForTimeout(270);
  await page.screenshot({ path: ".tmp/explorer-motion/03-impact.png" });
  await emit("source-browser://drag", { phase: "end", id });
  await page.waitForTimeout(150);
  assert.equal(await dock.locator("[data-classification-id]").count(), 1, "dragend must not erase pending classification");
  await emit("source-browser://drag-preview", { id, labels: [] });
  assert.equal(await host.getByText("暂无已有标签").count(), 0);
  await page.waitForFunction(() => window.release);
  await page.evaluate(() => { window.hold = false; window.release(); });
  await host.waitFor({ state: "detached" });
  await dock.locator('[data-classification-labels]').getByText("插画", { exact: true }).waitFor();

  await emit("source-browser://drag", { phase: "start", id, imageUrl }); await over();
  await page.keyboard.press("Escape"); assert.equal(await host.count(), 0);
  await emit("source-browser://drag", { phase: "start", id, imageUrl }); await over();
  await page.evaluate(() => window.store.setState({ activeProjectId: "another", projectRouteRevision: 1 }));
  await page.waitForFunction(() => window.calls.filter(c => c.args?.event === "source-browser://drag-preview").length >= 2);
  assert.equal(await host.count(), 0, "project change clears carried image");
  await page.evaluate(() => window.store.setState({ activeProjectId: null, projectRouteRevision: 2 }));
  await page.waitForFunction(() => window.calls.filter(c => c.args?.event === "source-browser://drag-preview").length >= 3);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await emit("source-browser://drag", { phase: "start", id: "b".repeat(32), imageUrl });
  const thumbnail = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  await emit("source-browser://drag-preview", { id: "b".repeat(32), thumbnail, labels });
  await over();
  assert.equal(await host.locator("img").getAttribute("src"), thumbnail, "preview ready before crossing is reused immediately");
  await emit("source-browser://drag", { phase: "end", id });
  await page.waitForTimeout(650);
  assert.equal(await host.count(), 1, "old dragend cannot clear a newer drag");
  await page.screenshot({ path: ".tmp/explorer-motion/04-dark-carry.png" });
  await page.setViewportSize({ width: 900, height: 650 });
  const longLabels = structuredClone(labels).slice(0, 3);
  longLabels[1].name = '<img onerror="throw 1">这是一个非常长的候选标签名称';
  longLabels[2].probability = .0004;
  await emit("source-browser://drag-preview", { id: "b".repeat(32), labels: longLabels });
  await over(890, 640); await page.waitForTimeout(650);
  assert.equal(await host.locator(".chip img").count(), 0, "labels must remain text");
  assert.equal(await host.locator(".candidate").count(), 3);
  assert.equal(await host.locator(".probability").last().textContent(), "<0.1%");
  const narrowPanel = await page.locator(".explore-main").boundingBox();
  for (const candidate of await host.locator(".candidate").all()) {
    const box = await candidate.boundingBox();
    assert.ok(box.x >= narrowPanel.x && box.x + box.width <= narrowPanel.x + narrowPanel.width && box.y >= narrowPanel.y && box.y + box.height <= narrowPanel.y + narrowPanel.height, "whole fan stays inside narrow panel");
  }
  await page.screenshot({ path: ".tmp/explorer-motion/05-narrow-ranks.png" });
  await emit("source-browser://drag-preview", { id: "b".repeat(32), labels: [] });
  assert.equal(await host.getByText("暂无已有标签").count(), 1);
  assert.equal(await host.locator(".probability").count(), 0, "no invented scores for an empty library");
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await emit("source-browser://drag", { phase: "start", id, imageUrl }); await over();
  await emit("source-browser://drag-preview", { id, labels });
  assert.equal(await host.locator(".chip").first().evaluate(el => getComputedStyle(el).animationName), "none");
  assert.equal(await host.locator(".card").evaluate(el => el.getAnimations().length), 0);
  await page.evaluate(() => { window.fail = true; });
  await drop(); await host.waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log("PASS explorer motion: real source pickup/cancel, cross-view carry, scoped live tags, bounds, landing during slow capture, route/escape cleanup, failure and reduced motion");
} finally { await browser.close(); await server.close(); }
