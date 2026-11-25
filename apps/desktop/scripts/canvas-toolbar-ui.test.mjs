import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
import { placeWorkflowCard } from "./fixtures/canvas-reference/place-card.mjs";
const entry = "scripts/fixtures/canvas-reference/preview.html";
const native = process.argv.includes("--native");
const runtime = native ? await import("./fixtures/canvas-interaction-performance/webview2.mjs") : null;
const ipc = runtime?.isolatedCanvasIpc();
const evidence = native ? ".tmp/canvas-toolbar/native" : ".tmp/canvas-toolbar";
const server = await createServer({
  cacheDir: `${evidence}/vite`,
  optimizeDeps: { entries: [entry], esbuildOptions: ipc?.esbuildOptions },
  plugins: ipc ? [ipc.plugin] : [],
  server: { host: "127.0.0.1", port: native ? 17976 : 1554, strictPort: true, hmr: false, watch: null },
});
await server.listen();
const origin = server.resolvedUrls.local[0];
const fixtureUrl = new URL(entry, origin).href;
const host = await runtime?.openWebView(origin, entry).catch(async error => { await server.close(); throw error; });
const browser = host?.browser ?? await chromium.launch({ channel: "chrome", headless: true });
const page = host?.page ?? await browser.newPage();
await page.setViewportSize({ width: 1800, height: 1000 });
const errors = []; page.on("pageerror", error => errors.push(error.message));
const bounds = () => page.locator(".canvas-board-toolbar > div").evaluateAll(elements => elements.map(element => {
  const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
}));
const canvas = page.locator("[data-canvas-stage]");
const controls = page.locator(".canvas-zoom-controls");
const tools = page.getByRole("toolbar", { name: "画板工具" });
const group = name => tools.locator(`[data-canvas-tool-group="${name}"]`);
const dialog = page.getByRole("dialog", { name: "解锁 Pro" });
const menu = page.getByRole("menu");
const button = name => page.getByRole("button", { name, exact: true });
const snap = controls.getByRole("button", { name: "吸附对齐" });
const undo = controls.getByRole("button", { name: "撤销画布操作" });

async function setAccount(tier) {
  await page.evaluate(tier => window.store.setState({
    cloudAuth: { logged_in: true, cloud_available: true, user_id: "toolbar-fixture" },
    cloudEntitlement: { user_id: "toolbar-fixture", tier, offline_state: "fresh", is_test_account: false,
      policy: { can_use_cloud: true, can_use_byo: tier !== "free" }, balances: { daily: 100, sub: 0, topup: 0 }, generation_services: [] },
  }), tier);
}

async function checkToolbarActions() {
  assert.deepEqual(await controls.locator(":scope > button, :scope > .canvas-toolbar-divider").evaluateAll(elements => elements.map(el => el.getAttribute("aria-label") ?? "divider")),
    ["撤销画布操作", "吸附对齐", "divider", "画板视图", "时间线视图", "divider", "缩小", "放大", "适应内容"]);
  assert.deepEqual(await controls.locator(".canvas-toolbar-divider").evaluateAll(elements => elements.map(el => {
    const box = el.getBoundingClientRect(); return [box.width, box.height, el.getAttribute("aria-hidden")];
  })), [[1, 14, "true"], [1, 14, "true"]]);
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await button("画板视图").getAttribute("aria-pressed"), "true");
  const picked = await button("画板视图").evaluate(el => getComputedStyle(el, "::after").height);
  assert.equal(picked, "2px");
  await snap.hover();
  await page.waitForFunction(() => {
    const target = document.querySelector('[data-canvas-control="snap"]');
    return target?.matches(":hover") && getComputedStyle(target).backgroundColor !== "rgba(0, 0, 0, 0)";
  });
  await canvas.focus();
  const previous = await snap.getAttribute("aria-pressed");
  await canvas.evaluate(el => {
    for (const modifiers of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { repeat: true }, { isComposing: true }]) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true, ...modifiers }));
    }
  });
  assert.equal(await snap.getAttribute("aria-pressed"), previous, "input guards preserve snap during modifiers, repeat and IME");
  await page.keyboard.press("n");
  const next = await snap.getAttribute("aria-pressed");
  assert.notEqual(next, previous);
  assert.equal(await page.evaluate(() => localStorage.getItem("bowerbird.canvasSnapEnabled")), next);
  await canvas.focus();
  await page.keyboard.press("a");
  assert.equal(await button("抓手工具").getAttribute("aria-pressed"), "true");
  await page.keyboard.press("v");
  assert.equal(await button("选择工具").getAttribute("aria-pressed"), "true");
  await page.locator(".canvas-board-title").focus();
  await page.keyboard.press("n");
  assert.equal(await snap.getAttribute("aria-pressed"), next, "typing in the project title does not change snapping");
  await page.keyboard.press("Escape");
}

async function checkTimeline() {
  const pressed = await snap.getAttribute("aria-pressed");
  await button("时间线视图").click();
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await snap.isDisabled(), true);
  assert.equal(await button("时间线视图").getAttribute("aria-pressed"), "true");
  await page.keyboard.press("n");
  assert.equal(await snap.getAttribute("aria-pressed"), pressed, "timeline route ignores canvas shortcuts");
  await button("画板视图").click();
  assert.equal(await snap.getAttribute("aria-pressed"), pressed);
}

async function checkToolGroups() {
  assert.deepEqual(await tools.locator("[data-canvas-tool-group]").evaluateAll(elements => elements.map(el => el.dataset.canvasToolGroup)),
    ["container", "content", "workflow", "toolbox"]);
  assert.equal(await tools.getByRole("button", { name: "吸附对齐" }).count(), 0);
  await setAccount("free");
  const workflow = group("workflow");
  await workflow.focus();
  await page.keyboard.press("ArrowRight");
  await menu.getByRole("menuitem", { name: "Agent 卡片", exact: true }).waitFor();
  const agent = menu.getByRole("menuitem", { name: "Agent 卡片", exact: true });
  const agentBadge = await agent.evaluate(el => {
    const key = el.querySelector("kbd");
    const pro = [...el.querySelectorAll("span")].find(span => span.textContent.trim() === "PRO");
    return { key: key?.textContent, keyBeforePro: !!(key && pro && key.compareDocumentPosition(pro) & Node.DOCUMENT_POSITION_FOLLOWING),
      icon: el.querySelector(".agent-card-icon")?.innerHTML, descriptions: el.querySelectorAll("small").length };
  });
  assert.equal(agentBadge.key, "B");
  assert.equal(agentBadge.keyBeforePro, true);
  assert.ok(agentBadge.icon);
  assert.equal(agentBadge.descriptions, 0);
  assert.equal(await menu.getByText("PRO", { exact: true }).count(), 6);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await workflow.evaluate(el => el === document.activeElement), true);
  await canvas.focus();
  await page.keyboard.press("b");
  await dialog.getByText("已有结果仍可查看和导出", { exact: false }).waitFor();
  const pressed = await snap.getAttribute("aria-pressed");
  await page.keyboard.press("n");
  assert.equal(await snap.getAttribute("aria-pressed"), pressed, "visible paywall suppresses canvas shortcuts");
  await dialog.getByRole("button", { name: "查看 7 天 Pro 试用" }).click();
  await page.waitForFunction(() => window.store.getState().settingsRequest?.section === "account"
    || [...document.querySelectorAll('[role="dialog"]')].some(element => element.getAttribute("aria-label") === "Bowerbird 账号"));
  await dialog.waitFor({ state: "hidden" });
  await page.keyboard.press("Escape");

  const toolbox = group("toolbox");
  for (const name of ["本地 H3 视频", "角色声音"]) {
    await toolbox.focus();
    await page.keyboard.press("ArrowDown");
    const item = menu.getByRole("menuitem", { name, exact: true });
    await item.getByText("PRO", { exact: true }).waitFor();
    await item.click();
    await dialog.waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  }
  for (const tier of ["pro", "studio"]) {
    await setAccount(tier);
    await workflow.focus();
    await page.keyboard.press("ArrowRight");
    await menu.getByRole("menuitem", { name: "生成卡片", exact: true }).waitFor();
    assert.equal(await menu.getByText("PRO", { exact: true }).count(), 0);
    assert.equal(await menu.getByText("7 天试用", { exact: false }).count(), 0);
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
  }
  await canvas.focus();
  await page.keyboard.press("b");
  assert.equal(await workflow.getAttribute("aria-pressed"), "true");
  assert.equal(await workflow.getAttribute("aria-label"), "Agent 卡片");
  assert.equal(await workflow.locator(".agent-card-icon").innerHTML(), agentBadge.icon);
  assert.equal(await dialog.count(), 0);
  await page.keyboard.press("Escape");
}

async function checkToolGestures() {
  const content = group("content");
  const pausedAt = new Date("2026-11-25T08:00:00.000Z");
  await page.clock.install({ time: pausedAt });
  await page.clock.pauseAt(new Date(pausedAt.getTime() + 1000));
  try {
    const outer = await content.boundingBox();
    const point = [outer.x + outer.width / 2, outer.y + outer.height / 2];
    await page.mouse.move(...point);
    await page.clock.runFor(239);
    assert.equal(await content.getAttribute("aria-expanded"), "false");
    await page.clock.runFor(1);
    assert.equal(await content.getAttribute("aria-expanded"), "true");
    await page.mouse.move(700, 100);
    await page.clock.runFor(139);
    assert.equal(await content.getAttribute("aria-expanded"), "true");
    await page.clock.runFor(1);
    assert.equal(await content.getAttribute("aria-expanded"), "false");

    await page.mouse.move(...point);
    await page.mouse.down();
    await page.clock.runFor(109);
    assert.equal(await content.getAttribute("aria-expanded"), "false");
    await page.clock.runFor(1);
    assert.equal(await content.getAttribute("aria-expanded"), "true");
    const bubble = menu.getByRole("menuitem", { name: "气泡便签", exact: true });
    const box = await bubble.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.up();
    assert.equal(await content.getAttribute("aria-label"), "气泡便签");
    assert.equal(await content.getAttribute("aria-pressed"), "true");
    await page.keyboard.press("Escape");
    await page.mouse.click(...point);
    assert.equal(await content.getAttribute("aria-pressed"), "true", "short click directly activates the remembered tool");
  } finally { await page.clock.resume(); }
}

async function checkFreeGeneration() {
  await setAccount("free");
  await page.evaluate(async () => {
    const { api } = await import("/src/lib/api.ts");
    api.canvasWorkflowAuthorize = async () => { throw new Error("夹具账号无工作流 Pro 权限"); };
    window.toolbarSubmissions = [];
    window.store.setState({ activeGenProvider: "bowerbird-cloud-image_lite", defaultProvider: "bowerbird-cloud-image_lite",
      startGeneration: async (prompt, _assets, _ratio, provider, ...rest) => {
        const identity = rest.at(-1);
        window.toolbarSubmissions.push({ prompt, provider, jobId: identity.jobId, turnKey: identity.turnKey });
        return { accepted: true, jobId: identity.jobId };
      } });
  });
  await placeWorkflowCard(page, "生成卡片");
  const first = page.locator(".workflow-card.is-generation").last();
  const firstId = await first.getAttribute("data-workflow-card");
  await page.waitForFunction(id => JSON.parse(sessionStorage.getItem("workflow-p"))?.document.nodes.some(node => node.id === id), firstId);
  assert.equal(await undo.isEnabled(), true);
  await canvas.focus();
  await page.keyboard.press("Control+z");
  await page.locator(`[data-workflow-card="${firstId}"]`).waitFor({ state: "detached" });
  await placeWorkflowCard(page, "生成卡片");
  const generation = page.locator(".workflow-card.is-generation").last();
  await generation.locator('[contenteditable="true"]').first().fill("画一只蓝色小鸟");
  await generation.getByRole("button", { name: "运行此卡片", exact: true }).click();
  await page.waitForFunction(() => window.toolbarSubmissions.length === 1);
  const [submission] = await page.evaluate(() => window.toolbarSubmissions);
  assert.equal(submission.prompt, "画一只蓝色小鸟");
  assert.equal(submission.provider, "bowerbird-cloud-image_lite");
  assert.ok(submission.jobId && submission.turnKey);
  await page.waitForFunction(({ jobId, turnKey }) => Object.values(JSON.parse(sessionStorage.getItem("workflow-p"))?.document.run?.steps ?? {})
    .some(step => step.jobId === jobId && step.turnKey === turnKey && step.generationSubmission === "submitted"), submission);
}

try {
  await page.goto(fixtureUrl, { timeout: 90_000 });
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.waitForTimeout(400);
  await checkToolbarActions();
  const idle = await bounds();
  await page.evaluate(() => window.holdViewSave = true);
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.waitForFunction(() => window.releaseViewSave);
  await page.locator(".canvas-save-state").waitFor({ state: "visible" });
  const saving = await bounds();
  assert.deepEqual(saving, idle, "automatic saving must not resize or move either capsule");
  await page.evaluate(() => { window.holdViewSave = false; window.releaseViewSave(); window.releaseViewSave = null; });
  await page.locator(".canvas-save-state").waitFor({ state: "hidden" });
  assert.deepEqual(await bounds(), idle);
  // Fast local saves must never flash the status, even for a single frame.
  await page.evaluate(() => {
    window.saveFrames = [];
    window.sampleUntil = performance.now() + 1200;
    const sample = () => {
      window.saveFrames.push(getComputedStyle(document.querySelector(".canvas-save-state")).visibility);
      if (performance.now() < window.sampleUntil) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const savesBefore = await page.evaluate(() => window.calls.filter(c => c.command === "project_canvas_view_upsert").length);
  await page.getByRole("button", { name: "缩小", exact: true }).click();
  await page.waitForFunction(() => performance.now() > window.sampleUntil);
  assert.ok(await page.evaluate(before => window.calls.filter(c => c.command === "project_canvas_view_upsert").length > before, savesBefore));
  assert.equal(await page.evaluate(() => window.saveFrames.includes("visible")), false);
  // A narrow canvas also keeps its capsules stable; saving failures remain visible.
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.waitForTimeout(400);
  const narrow = await bounds();
  await page.evaluate(() => window.holdViewSave = true);
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.waitForFunction(() => window.releaseViewSave);
  await page.locator(".canvas-save-state").waitFor({ state: "visible" });
  assert.deepEqual(await bounds(), narrow);
  await page.evaluate(() => { window.failViewSave = true; window.holdViewSave = false; window.releaseViewSave(); });
  await page.locator(".canvas-save-error").waitFor({ state: "visible" });

  const hand = tools.getByRole("button", { name: "抓手工具" });
  const toolsBeforeFocus = await tools.boundingBox();
  const handBox = await hand.boundingBox();
  const handX = handBox.x + handBox.width / 2, handY = handBox.y + handBox.height / 2;
  const distantCell = page.locator('[data-canvas-node-id="far"] textarea').first();
  assert.ok((await distantCell.boundingBox()).x > page.viewportSize().width);
  await distantCell.focus();
  assert.equal(await distantCell.evaluate(el => document.activeElement === el), true);
  assert.deepEqual(await tools.boundingBox(), toolsBeforeFocus, "focusing an offscreen cell must keep the left toolbar anchored");
  // Use the original screen point: a locator click could scroll a displaced button back into view.
  await page.mouse.click(handX, handY);
  assert.equal(await hand.getAttribute("aria-pressed"), "true");
  const planeTransform = () => page.locator(".canvas-plane").evaluate(el => el.style.transform);
  const beforePan = await planeTransform();
  await page.mouse.move(650, 380);
  await page.mouse.down();
  await page.mouse.move(770, 430, { steps: 5 });
  await page.mouse.up();
  assert.notEqual(await planeTransform(), beforePan);
  assert.deepEqual(await tools.boundingBox(), toolsBeforeFocus);
  const beforeZoom = await planeTransform();
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.waitForFunction(previous => document.querySelector(".canvas-plane").style.transform !== previous, beforeZoom);
  assert.deepEqual(await tools.boundingBox(), toolsBeforeFocus);
  await page.addInitScript(() => { window.isTauri = true; });
  await page.goto(fixtureUrl + "?source-library&detail-route&canvas-library");
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  const lastTool = group("toolbox");
  for (const height of [800, 720, 601, 600]) {
    await page.setViewportSize({ width: 900, height });
    const stageBox = await page.locator(".canvas-stage").boundingBox();
    const lastBox = await lastTool.boundingBox();
    assert.ok(lastBox.y + lastBox.height <= stageBox.y + stageBox.height, "the last left tool must fit inside the canvas height");
    assert.ok(await tools.locator("button").evaluateAll(buttons => buttons.every(el => el.getBoundingClientRect().height >= 24)), "compact drawing buttons keep a 24px hit target");
    const pressed = await snap.getAttribute("aria-pressed");
    await snap.click();
    assert.notEqual(await snap.getAttribute("aria-pressed"), pressed, "the top control remains reachable without scrolling the canvas");
  }
  await page.setViewportSize({ width: 1280, height: 840 });
  await checkToolGroups();
  await checkToolGestures();
  await checkFreeGeneration();
  await checkTimeline();
  if (native) {
    await mkdir(evidence, { recursive: true });
    await setAccount("free");
    const workflow = group("workflow");
    await workflow.press("ArrowRight");
    await menu.getByRole("menuitem", { name: "Agent 卡片", exact: true }).waitFor();
    for (const theme of ["dark", "light"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.screenshot({ path: `${evidence}/${theme}.png` });
    }
  }
  assert.deepEqual(errors, []);
  console.log(`PASS [${native ? "WebView2" : "Chrome"}] stable save controls, canvas and timeline routing, undo/snap, tool groups, pointer and keyboard gestures, and account tiers.`);
} catch (error) {
  console.error(error);
  throw error;
} finally {
  try { await (host ? host.close() : browser.close()); }
  finally { await server.close(); }
}
