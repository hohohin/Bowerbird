import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1571, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
page.setDefaultTimeout(8000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const output = ".tmp/explorer-classification-dock";
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="240"><rect width="200" height="240" fill="#648774"/><circle cx="100" cy="110" r="58" fill="#dce8c8"/></svg>';
await page.route("**/*", route => {
  const url = new URL(route.request().url());
  if (url.hostname === "127.0.0.1") return route.continue();
  if (url.hostname === "image.test") return route.fulfill({ contentType: "image/svg+xml", body: svg });
  return route.abort();
});
const dock = page.locator("[data-explorer-classification-dock]");
const cards = dock.locator("[data-classification-id]");
const bubble = page.locator(".explorer-capture-feedback");
const dragVisual = page.locator("[data-explorer-drag-visual]");
const dragId = number => number.toString(16).padStart(32, "0");
const card = number => dock.locator(`[data-classification-id^="${dragId(number)}:"]`);

async function drop(number) {
  await page.locator(".explore-main").evaluate((el, id) => {
    const bounds = el.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("application/x-bowerbird-explorer", JSON.stringify({
      version: 1, dragId: id, imageUrl: `https://image.test/${id}.png`, pageUrl: "https://www.pinterest.com/pin/1",
    }));
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer,
      clientX: bounds.left + bounds.width / 2, clientY: bounds.top + Math.min(240, bounds.height / 2) }));
  }, dragId(number));
}

async function pending(number) {
  await page.waitForFunction(id => Boolean(window.analysisResolvers[id]), dragId(number));
  await page.locator(".explore-capture-status").waitFor({ state: "detached" });
}

async function finish(number, labels) {
  await page.evaluate(({ id, labels }) => window.analysisResolvers[id].resolve(labels), { id: dragId(number), labels });
}

async function stage(number, value) {
  await page.waitForFunction(({ id, value }) => document.querySelector(`[data-classification-id^="${id}:"]`)?.getAttribute("data-stage") === value,
    { id: dragId(number), value });
}

async function reachedStage(number, value) {
  await page.waitForFunction(({ id, value }) => window.classificationStages.some(entry => entry.id.startsWith(`${id}:`) && entry.stage === value),
    { id: dragId(number), value });
}

async function visualState(number) {
  return card(number).evaluate(el => {
    const sheet = getComputedStyle(el.querySelector(".explorer-classification-sheet"));
    const matrix = new DOMMatrixReadOnly(sheet.transform);
    const labels = getComputedStyle(el.querySelector("[data-classification-labels]"));
    return { skewX: matrix.b, skewY: matrix.c, labelTransform: labels.transform, labelOpacity: Number(labels.opacity) };
  });
}

async function resetRoute(project = null) {
  await page.evaluate(activeProjectId => window.store.setState(state => ({ activeProjectId, projectRouteRevision: state.projectRouteRevision + 1 })), project);
  await cards.first().waitFor({ state: "detached" });
}

async function emit(event, payload) {
  await page.evaluate(({ event, payload }) => {
    for (const call of window.calls.filter(call => call.command === "plugin:event|listen" && call.args.event === event)) {
      window.callbacks[call.args.handler]?.({ event, payload, id: 1 });
    }
  }, { event, payload });
}

try {
  await mkdir(output, { recursive: true });
  await page.goto("http://127.0.0.1:1571/scripts/fixtures/explorer/preview.html");
  await page.getByRole("button", { name: "探索", exact: true }).click();
  await page.evaluate(() => {
    window.analyse = true; window.holdAnalysis = true; window.uniqueCaptures = true;
    window.holdClaim = true; window.hold = true; window.classificationStages = [];
    const previousStages = new Map();
    const record = element => {
      if (element instanceof Element && element.hasAttribute("data-classification-id")) {
        const id = element.getAttribute("data-classification-id"), stage = element.getAttribute("data-stage");
        if (previousStages.get(id) === stage) return;
        previousStages.set(id, stage);
        window.classificationStages.push({ id, stage, at: performance.now() });
      }
    };
    new MutationObserver(records => records.forEach(change => {
      if (change.type === "attributes") record(change.target);
      else change.addedNodes.forEach(node => { record(node); if (node instanceof Element) node.querySelectorAll("[data-classification-id]").forEach(record); });
    })).observe(document.querySelector(".explore-main"), { childList: true, subtree: true, attributes: true, attributeFilter: ["data-stage"] });
  });

  // A real accepted claim starts the dock; capture and classification settle independently.
  await drop(1);
  await page.waitForFunction(id => window.claimResolvers[id], dragId(1));
  assert.equal(await cards.count(), 0, "an unconfirmed claim must not invent a running classification");
  await page.evaluate(id => { window.holdClaim = false; window.claimResolvers[id](); }, dragId(1));
  await card(1).waitFor();
  await page.waitForFunction(id => window.captureResolvers[id], dragId(1));
  assert.equal(await page.locator('[data-asset-id^="captured-"]').count(), 0, "capture is still held");
  const lateThumbnail = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  await emit("source-browser://drag-preview", { id: dragId(1), thumbnail: lateThumbnail, labels: [] });
  await page.waitForFunction(({ id, thumbnail }) => document.querySelector(`[data-classification-id^="${id}:"] img`)?.getAttribute("src") === thumbnail,
    { id: dragId(1), thumbnail: lateThumbnail });
  await page.evaluate(id => { window.hold = false; window.captureResolvers[id](); }, dragId(1));
  await pending(1);
  assert.equal(await page.locator('[data-asset-id="captured-1"]').count(), 1, "image is in the library before classification finishes");
  await page.getByRole("textbox", { name: "主页面草稿" }).fill("分类过程中继续工作");
  await drop(2); await pending(2);
  await drop(3); await pending(3);
  assert.equal(await cards.count(), 3, "later drops retain earlier pending cards");
  assert.equal(await bubble.count(), 0, "accepted classifications use the dock");
  assert.equal(await dock.evaluate(el => getComputedStyle(el).pointerEvents), "none", "dock does not intercept normal work");
  await emit("source-browser://drag-preview", { id: dragId(1), labels: [{ key: "label_0", name: "预览候选", probability: .9, selected: true }] });
  assert.equal(await dock.getByText("预览候选", { exact: false }).count(), 0, "preview probabilities are never presented as committed results");
  const dockBounds = await dock.boundingBox();
  const panelBounds = await page.locator(".explore-main").boundingBox();
  assert.ok(dockBounds.x >= panelBounds.x && dockBounds.x < panelBounds.x + 100, "dock sits in the main panel's lower-left area");
  assert.ok(dockBounds.y + dockBounds.height <= panelBounds.y + panelBounds.height + 1);
  await stage(3, "pending");
  await page.screenshot({ path: `${output}/01-light-pending.png` });

  // Completion order, rather than drop order, controls the single foreground presentation.
  await finish(2, ["海报", "字体排版"]);
  await stage(2, "extract");
  const extracting = await visualState(2);
  assert.ok(Math.abs(extracting.skewX) > .05 || Math.abs(extracting.skewY) > .05, "extraction begins with the tilted sheet");
  assert.equal(extracting.labelOpacity, 0, "labels wait until the card is laid flat");
  await finish(3, ["产品展示"]);
  await finish(1, ["插画"]);
  await stage(2, "hold");
  assert.deepEqual(await visualState(2), { skewX: 0, skewY: 0, labelTransform: "none", labelOpacity: 1 }, "the held card is flat with horizontal readable labels");
  assert.ok((await card(2).textContent()).includes("海报"));
  assert.notEqual(await card(3).getAttribute("data-stage"), "extract", "a later completion cannot replace the current presentation");
  await page.screenshot({ path: `${output}/02-light-result.png` });
  await stage(2, "exit");
  assert.deepEqual(await visualState(2), { skewX: 0, skewY: 0, labelTransform: "none", labelOpacity: 1 }, "exit preserves the flat card and horizontal labels");
  await card(2).waitFor({ state: "detached" });
  await reachedStage(3, "extract");
  await card(3).waitFor({ state: "detached" });
  await reachedStage(1, "extract");
  await card(1).waitFor({ state: "detached" });
  const traces = await page.evaluate(() => window.classificationStages);
  const extraction = traces.filter(entry => entry.stage === "extract").map(entry => entry.id.split(":")[0]);
  assert.deepEqual(extraction, [dragId(2), dragId(3), dragId(1)]);
  const stages = traces.filter(entry => entry.id.startsWith(`${dragId(2)}:`));
  const time = name => stages.find(entry => entry.stage === name)?.at;
  for (const [from, to, minimum] of [["extract", "settle", 350], ["settle", "reveal", 270], ["reveal", "hold", 200], ["hold", "exit", 950]]) {
    assert.ok(time(to) - time(from) >= minimum, `${from} → ${to} keeps its promised viewing duration`);
  }

  // The wheel has six visible slots; overflow items remain real queued work.
  for (let number = 10; number < 18; number++) { await drop(number); await pending(number); }
  const visibleSlots = await cards.evaluateAll(elements => elements.filter(el => /^[0-5]$/.test(el.getAttribute("data-slot") || "")).length);
  assert.equal(visibleSlots, 6);
  assert.equal(await dock.locator('[data-classification-id][data-slot="queue"]').count(), 2);
  assert.equal(await dock.locator("[data-classification-overflow]").textContent(), "另有 2 张排队");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await stage(15, "pending");
  await page.screenshot({ path: `${output}/03-dark-overflow.png` });
  await finish(17, ["队列中的完成结果"]);
  await stage(17, "extract");
  const overflowStart = await card(17).boundingBox();
  assert.ok(overflowStart.y > panelBounds.y + panelBounds.height / 2, "queued completions emerge from the lower wheel instead of their old drop position");
  await stage(17, "hold");
  assert.ok((await card(17).textContent()).includes("队列中的完成结果"), "an overflow completion is promoted to the foreground");
  await resetRoute();
  for (let number = 10; number < 17; number++) await finish(number, ["旧范围结果"]);
  await page.waitForTimeout(80);
  assert.equal(await cards.count(), 0, "same-project route revision invalidates all late results");

  // Reduced motion retains a readable hold; hidden documents pause dismissal.
  await drop(20); await pending(20); await finish(20, ["减弱动画结果"]);
  await stage(20, "extract");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stage(20, "hold");
  const changedMotion = await page.evaluate(id => window.classificationStages.filter(entry => entry.id.startsWith(`${id}:`)).map(entry => entry.stage), dragId(20));
  assert.ok(!changedMotion.includes("settle"), "enabling reduced motion during extraction skips the remaining spatial movement");
  const presentation = await card(20).evaluate(el => ({ animations: el.getAnimations({ subtree: true }).map(animation => animation.effect?.getTiming().duration) }));
  assert.ok(presentation.animations.every(duration => duration === 0 || duration <= 160), "reduced motion avoids long spatial animation");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(1400);
  assert.equal(await card(20).getAttribute("data-stage"), "hold", "background time does not consume the result viewing interval");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await card(20).waitFor({ state: "detached" });

  // Closing the browser is not a route change; accepted classifications remain visible.
  await drop(21); await pending(21);
  await page.getByRole("button", { name: "探索", exact: true }).click();
  assert.equal(await card(21).count(), 1);
  await finish(21, ["关闭探索后仍可见"]);
  await stage(21, "hold");
  await page.screenshot({ path: `${output}/04-closed-explorer-reduced.png` });
  await card(21).waitFor({ state: "detached" });
  await page.getByRole("button", { name: "探索", exact: true }).click();

  await drop(22); await pending(22);
  await resetRoute("another-project");
  await finish(22, ["不应出现在新项目"]);
  await page.waitForTimeout(80);
  assert.equal(await cards.count(), 0);
  await resetRoute();

  // Failure and no-match remain truthful terminal results, while capture failure releases the claim.
  await drop(23); await pending(23);
  await page.evaluate(id => window.analysisResolvers[id].reject("模拟分类失败"), dragId(23));
  await stage(23, "hold");
  assert.equal(await card(23).getAttribute("data-outcome"), "failed");
  assert.ok((await card(23).textContent()).includes("未完成"));
  assert.ok(await page.locator('[data-asset-id^="captured-"]').count() > 0);
  await card(23).waitFor({ state: "detached" });
  await drop(24); await pending(24); await finish(24, []);
  await stage(24, "hold");
  assert.equal(await card(24).getAttribute("data-outcome"), "unmatched");
  assert.ok((await card(24).textContent()).includes("暂无匹配"));
  await card(24).waitFor({ state: "detached" });
  await page.evaluate(() => { window.fail = true; });
  await drop(25);
  await page.waitForFunction(id => window.calls.some(call => call.command === "release_source_browser_analysis" && call.args.dragId === id), dragId(25));
  assert.equal(await card(25).count(), 0);
  assert.equal(await page.evaluate(id => window.calls.filter(call => call.command === "finish_source_browser_analysis" && call.args.dragId === id).length, dragId(25)), 0);
  await page.evaluate(() => { window.fail = false; window.analyse = false; });
  await drop(26);
  await bubble.getByText("已采集", { exact: true }).waitFor();
  assert.equal(await cards.count(), 0);
  await page.waitForTimeout(1100);
  assert.equal(await bubble.count(), 1, "disabled classification preserves the old two-second acknowledgement");
  await bubble.waitFor({ state: "detached" });
  await page.evaluate(() => { window.claimError = "分类任务忙，请稍后重试"; });
  await drop(27);
  await bubble.getByText("已采集；分类任务忙，请稍后重试", { exact: true }).waitFor();
  assert.equal(await cards.count(), 0);
  await page.evaluate(() => { window.claimError = null; window.analyse = true; });

  // Cancelled carries never become dock jobs.
  const claimsBeforeCancel = await page.evaluate(() => window.calls.filter(call => call.command === "claim_source_browser_analysis").length);
  await emit("source-browser://drag", { phase: "start", id: dragId(28), imageUrl: "https://image.test/cancel.png" });
  await page.locator(".explore-main").evaluate(el => {
    const dataTransfer = new DataTransfer(); dataTransfer.setData("text/plain", "");
    el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer, clientX: 750, clientY: 350 }));
  });
  await dragVisual.locator(".card").waitFor();
  await page.keyboard.press("Escape");
  await dragVisual.waitFor({ state: "detached" });
  assert.equal(await cards.count(), 0);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === "claim_source_browser_analysis").length), claimsBeforeCancel);

  await emit("source-browser://drag", { phase: "start", id: dragId(31), imageUrl: "https://image.test/cancel-close.png" });
  await page.locator(".explore-main").evaluate(el => {
    const dataTransfer = new DataTransfer(); dataTransfer.setData("text/plain", "");
    el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer, clientX: 750, clientY: 350 }));
  });
  await dragVisual.locator(".card").waitFor();
  await page.getByRole("button", { name: "探索", exact: true }).click();
  await dragVisual.waitFor({ state: "detached" });
  assert.equal(await cards.count(), 0, "closing exploration cancels an uncommitted carry");
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === "claim_source_browser_analysis").length), claimsBeforeCancel);
  await page.getByRole("button", { name: "探索", exact: true }).click();

  // Long labels stay text, fit a narrow main panel, and remain readable in both themes.
  await page.setViewportSize({ width: 900, height: 650 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await drop(29); await pending(29);
  await finish(29, ['<img onerror="throw 1">长标签', "这是完整保留的一条较长分类标签名称", "第三个类别"]);
  await stage(29, "hold");
  assert.equal(await card(29).locator("[data-classification-labels] img").count(), 0);
  const labelsBounds = await card(29).locator("[data-classification-labels]").boundingBox();
  const narrowBounds = await page.locator(".explore-main").boundingBox();
  assert.ok(labelsBounds.x >= narrowBounds.x - 1 && labelsBounds.x + labelsBounds.width <= narrowBounds.x + narrowBounds.width + 1, "long label block stays within the narrow main panel");
  assert.ok(labelsBounds.y >= narrowBounds.y - 1 && labelsBounds.y + labelsBounds.height <= narrowBounds.y + narrowBounds.height + 1);
  await page.screenshot({ path: `${output}/05-narrow-light-labels.png` });
  assert.deepEqual(errors, []);
  console.log("PASS explorer classification dock: confirmed claims, independent capture, continuous drops, FIFO outcomes/timing, six slots/overflow, reduced motion/hidden pause, close/route isolation, failure/release/disabled/cancel and narrow safe labels");
} catch (error) {
  console.error("Dock diagnostics", await page.evaluate(() => ({
    stages: window.classificationStages,
    cards: Array.from(document.querySelectorAll("[data-classification-id]")).map(el => ({ id: el.getAttribute("data-classification-id"), stage: el.getAttribute("data-stage"), slot: el.getAttribute("data-slot"), text: el.textContent })),
    hidden: document.hidden,
  })).catch(() => null));
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await server.close();
}
