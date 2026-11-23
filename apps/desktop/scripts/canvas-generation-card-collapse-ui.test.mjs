import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const entry = "scripts/fixtures/canvas-reference/preview.html";
const native = process.argv.includes("--native");
const runtime = native ? await import("./fixtures/canvas-interaction-performance/webview2.mjs") : null;
const ipc = runtime?.isolatedCanvasIpc();
const evidence = native ? ".tmp/canvas-generation-card-collapse/native" : ".tmp/canvas-generation-card-collapse";
const server = await createServer({
  cacheDir: `${evidence}/vite`,
  optimizeDeps: { entries: [entry], esbuildOptions: ipc?.esbuildOptions },
  plugins: ipc ? [ipc.plugin] : [],
  server: { host: "127.0.0.1", port: native ? 17974 : 17973, strictPort: false, hmr: false, watch: null },
});
await server.listen();
const host = runtime ? await runtime.openWebView(server.resolvedUrls.local[0], entry) : null;
const browser = host?.browser ?? await chromium.launch({ channel: "chrome", headless: true });
const page = host?.page ?? await browser.newPage();
await page.setViewportSize({ width: 1680, height: 1050 });
await page.emulateMedia({ reducedMotion: "reduce" });
const fixtureUrl = `${server.resolvedUrls.local[0]}${entry}`;
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const modifier = process.platform === "darwin" ? "Meta" : "Control";
const origin = page.locator('[data-workflow-card="generator"]');
const media = page.locator('[data-canvas-node-id="generation-session"]');
const image = media.locator('[data-conversation-image="a"]');
const preview = page.locator(".creation-image-preview");
const reply = page.getByRole("dialog", { name: "继续修改此图", exact: true });
const peek = page.locator('[data-workflow-peek]');
const pin = origin.getByRole("button", { name: "固定在画板上", exact: true });
const unpin = origin.getByRole("button", { name: "取消固定并收起", exact: true });
const readWorkflow = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("workflow-p")).document);
const waitForSourceX = (x, equals = true) => page.waitForFunction(
  ({ x, equals }) => (JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes.find(node => node.id === "generator").x === x) === equals,
  { x, equals },
);
async function captureThemes(name) {
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.screenshot({ path: `${evidence}/${name}-${theme}.png` });
  }
}

try {
  await mkdir(evidence, { recursive: true });
  if (!host) await page.goto(fixtureUrl);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { newWorkflowNode } = await import("/src/lib/canvasWorkflow.ts");
    const snapshot = window.snapshot();
    const base = snapshot.nodes[0];
    const generator = { ...newWorkflowNode("generation", 450, 180, "codex"), id: "generator", prompt: "生成一只鸟",
      activeSessionNodeId: "generation-session", sessionNodeIds: ["generation-session"],
      inputs: { image: [{ assetId: "existing", assetNodeId: "old", autoConnect: "upstream" }], text: [] } };
    const downstream = { ...newWorkflowNode("generation", 1000, 180, "codex"), id: "downstream", prompt: "生成鸟巢",
      inputs: { image: [{ nodeId: generator.id, portId: "image", autoConnect: "downstream" }], text: [] } };
    sessionStorage.setItem("workflow-p", JSON.stringify({ revision: 1, document: { version: 1, nodes: [generator, downstream] } }));
    const group = "workflow:" + JSON.stringify(["p", generator.id]);
    const session = { ...base, id: "generation-session", kind: "prompt", assetId: null, role: null, x: 450, y: 180, width: 260, height: 150,
      payloadJson: JSON.stringify({ schema_version: 1, job_id: "job", turn_key: "first-turn", text: "生成一只鸟",
        workflow_generation_group: group, status: "running", provider: "codex" }) };
    snapshot.nodes = [{ ...base, x: 20, y: 195 }, session];
    snapshot.view = { ...snapshot.view, panX: 100, panY: 100, zoom: 1 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  });
  await page.reload();
  await origin.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-workflow-card="generator"]')?.classList.contains("canvas-card-running"));
  assert.equal(await media.count(), 0, "the submitted session does not occupy a second card");
  assert.equal(await origin.evaluate(card => getComputedStyle(card, "::after").animationName), "none");
  await captureThemes("running");
  await page.evaluate(async () => {
    const { api } = await import("/src/lib/api.ts");
    const session = window.snapshot().nodes.find(node => node.id === "generation-session");
    await api.projectCanvasNoteUpdate(session.id, JSON.stringify({ ...JSON.parse(session.payloadJson), status: "failed" }));
    window.emitChange();
  });
  await origin.getByRole("alert").getByRole("button", { name: "查看生成详情" }).waitFor();
  assert.equal(await media.count(), 0, "a first failure stays on its original generator");
  await page.evaluate(async () => {
    const { api } = await import("/src/lib/api.ts");
    const session = window.snapshot().nodes.find(node => node.id === "generation-session");
    await api.projectCanvasNodeCreate({ ...session, id: "malformed-output", kind: "asset", role: "output", assetId: "b",
      payloadJson: JSON.stringify({ execution: { job_id: "job", turn_key: "first-turn" } }) });
    await api.projectCanvasNoteUpdate(session.id, JSON.stringify({ ...JSON.parse(session.payloadJson), status: "done" }));
    window.emitChange();
  });
  await media.waitFor();
  assert.equal(await image.count(), 0);
  assert.equal(await origin.isVisible(), true, "missing media snapshot cannot replace the generator");
  await page.evaluate(async () => {
    const { api } = await import("/src/lib/api.ts");
    const session = window.snapshot().nodes.find(node => node.id === "generation-session");
    await api.projectCanvasNodeRemove("malformed-output");
    await api.projectCanvasNoteUpdate(session.id, JSON.stringify({ ...JSON.parse(session.payloadJson), status: "running" }));
    window.emitChange();
  });
  await origin.locator("header strong").click();
  const stop = origin.getByRole("button", { name: "停止生成", exact: true });
  await stop.focus();
  const originalPosition = await origin.boundingBox();
  await page.evaluate(async () => {
    const { api } = await import("/src/lib/api.ts");
    const session = window.snapshot().nodes.find(node => node.id === "generation-session");
    const payload = JSON.parse(session.payloadJson);
    const [asset] = await api.getAssetsByIds(["a"]);
    await api.projectCanvasNoteUpdate(session.id, JSON.stringify({ ...payload, status: "done" }));
    await api.projectCanvasNodeCreate({ ...session, id: "output-a", kind: "asset", role: "output", assetId: "a",
      width: 260, height: 205, payloadJson: JSON.stringify({ schema_version: 1,
        snapshot: { name: "合成参考 a", width: 190, height: 150 },
        workflow_generation_group: payload.workflow_generation_group, execution: { job_id: "job", turn_key: "first-turn" } }) });
    const turn = { id: 1, turnKey: "first-turn", prompt: "生成一只鸟", images: [asset.store_path], provider: "codex" };
    const job = { id: "job", projectId: "p", threadId: "t", conversationId: "conversation", sessionId: "provider-session",
      provider: "codex", running: false, turns: [turn] };
    const { FREE_POLICY } = await import("/src/lib/entitlement.ts");
    window.store.setState({ genJobs: { job }, codexHealth: { ok: true },
      cloudAuth: { logged_in: true, cloud_available: true },
      cloudEntitlement: { policy: { ...FREE_POLICY, can_use_byo: true, max_parallel_jobs: 3 }, balances: { daily: 100, sub: 0, topup: 0 } } });
    window.emitChange();
  });
  await image.waitFor();
  assert.equal(await origin.count(), 0);
  assert.match(await media.getAttribute("class"), /is-selected/);
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-canvas-node-id") === "generation-session");
  const mediaPosition = await media.boundingBox();
  assert.ok(Math.abs(mediaPosition.x - originalPosition.x) < 1);
  assert.ok(Math.abs(mediaPosition.y - originalPosition.y) < 1);
  assert.equal(await page.locator('[data-workflow-generator="generator"]').count(), 0);
  const incoming = page.locator('path[data-auto-connection="upstream"]');
  const outgoing = page.locator('path[data-auto-connection="downstream"]');
  await incoming.waitFor({ state: "attached" });
  await outgoing.waitFor({ state: "attached" });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const endpoints = await media.evaluate(card => {
    const plane = card.closest(".canvas-plane");
    const incoming = plane.querySelector('path[data-auto-connection="upstream"]');
    const outgoing = plane.querySelector('path[data-auto-connection="downstream"]');
    const measure = (line, start) => {
      const point = line.getPointAtLength(start ? 0 : line.getTotalLength());
      const matrix = line.getScreenCTM();
      return { anchor: point.x, screen: point.matrixTransform(matrix).x, matrix: [matrix.a, matrix.e],
        d: line.getAttribute("d"), path: getComputedStyle(line).d };
    };
    const rect = card.getBoundingClientRect();
    return { input: measure(incoming, false), output: measure(outgoing, true), left: rect.left, right: rect.right,
      plane: getComputedStyle(plane).transform };
  });
  assert.ok(Math.abs(endpoints.input.screen - endpoints.left) < 2, JSON.stringify(endpoints));
  assert.ok(Math.abs(endpoints.output.screen - endpoints.right) < 2, JSON.stringify(endpoints));

  await image.click({ modifiers: [modifier] });
  assert.doesNotMatch(await media.getAttribute("class"), /is-selected/);
  assert.equal(await preview.count(), 0);
  await image.click();
  await preview.waitFor();
  assert.equal(await page.locator("[data-project-inspector]").count(), 0);
  assert.equal(await preview.getByRole("button", { name: /在画布.*生成卡/ }).count(), 0);
  await page.keyboard.press("Escape");
  await preview.waitFor({ state: "detached" });
  const blank = { x: 80, y: 150 };
  await page.mouse.move(blank.x, blank.y);
  await origin.waitFor({ state: "detached" });
  await media.hover();
  await page.mouse.move(blank.x, blank.y);
  await page.waitForTimeout(200);
  assert.equal(await origin.count(), 0, "brief pass does not mount the editor");

  await page.keyboard.down("Space");
  await media.hover();
  await page.waitForTimeout(200);
  assert.equal(await origin.count(), 0, "space-to-pan keeps the editor hidden");
  await page.keyboard.up("Space");
  await page.mouse.move(blank.x, blank.y);
  await media.hover();
  await origin.waitFor();
  assert.equal(await peek.count(), 1);
  const peekPosition = await origin.boundingBox();
  const anchorPosition = await media.boundingBox();
  assert.ok(Math.abs(anchorPosition.x - (peekPosition.x + peekPosition.width) - 12) < 1);
  assert.ok(Math.abs(anchorPosition.y - peekPosition.y) < 1);
  assert.equal(await origin.evaluate(card => getComputedStyle(card).zIndex), "11500");
  assert.equal(await page.locator('[data-workflow-generator="generator"]').count(), 0, "peek leaves wires at the result anchor");
  await page.mouse.move(anchorPosition.x + 5, anchorPosition.y + 80);
  await page.mouse.move(anchorPosition.x - 5, anchorPosition.y + 80);
  await page.waitForTimeout(260);
  await peek.waitFor();
  const editor = origin.locator('[contenteditable="true"]');
  await editor.fill("生成一只蓝色的鸟");
  await page.mouse.move(blank.x, blank.y);
  await page.waitForTimeout(260);
  await peek.waitFor();
  await editor.evaluate(element => element.blur());
  await origin.waitFor({ state: "detached" });
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes.find(node => node.id === "generator").prompt === "生成一只蓝色的鸟");
  await media.hover();
  await peek.waitFor();
  assert.equal(await editor.textContent(), "生成一只蓝色的鸟");
  await pin.click();
  assert.equal(await peek.count(), 0);
  assert.deepEqual(await origin.boundingBox(), peekPosition);
  await captureThemes("expanded");
  const sourceBeforePinDrag = (await readWorkflow()).nodes.find(node => node.id === "generator");
  const header = await origin.locator("header strong").boundingBox();
  await page.mouse.move(header.x + 10, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(header.x + 75, header.y + header.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  await waitForSourceX(sourceBeforePinDrag.x, false);
  assert.notEqual((await origin.boundingBox()).x, peekPosition.x, "the pinned card can be dragged");
  await page.keyboard.press(`${modifier}+z`);
  await waitForSourceX(sourceBeforePinDrag.x);
  assert.deepEqual(await origin.boundingBox(), peekPosition);
  await unpin.click();
  await origin.waitFor({ state: "detached" });
  await media.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "固定生成卡", exact: true }).press("Enter");
  await origin.waitFor();
  await unpin.click();
  await origin.waitFor({ state: "detached" });

  await image.click({ button: "right" });
  await page.getByRole("menuitem", { name: "固定生成卡", exact: true }).click();
  await origin.waitFor();
  assert.equal(await unpin.getAttribute("aria-pressed"), "true");
  await unpin.click();
  await origin.waitFor({ state: "detached" });

  const change = media.getByRole("button", { name: "继续修改", exact: true });
  await media.hover();
  await change.focus();
  await page.keyboard.press("Enter");
  await reply.waitFor();
  await reply.getByRole("textbox", { name: "续轮对话", exact: true }).waitFor();
  await captureThemes("continuation");
  await page.keyboard.press("Escape");
  await reply.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "继续修改");
  await image.click({ button: "right" });
  await page.getByRole("menuitem", { name: "继续修改", exact: true }).click();
  await reply.waitFor();
  await page.evaluate(() => window.store.setState({ sendGenRevise: async (id, prompt, provider, options) => {
    const job = window.store.getState().genJobs[id];
    window.continuation = { id, prompt, options };
    window.store.setState({ genJobs: { [id]: { ...job, running: true, turns: [...job.turns,
      { id: 2, turnKey: "second-turn", prompt, images: [], provider }] } } });
  } }));
  const beforeRevision = await media.boundingBox();
  await reply.getByRole("textbox", { name: "续轮对话", exact: true }).fill("给鸟加上蓝色羽毛");
  await reply.getByRole("button", { name: "发送续轮对话", exact: true }).click();
  await reply.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.continuation.options.parentNodeId), "output-a");
  assert.equal(await page.evaluate(() => window.continuation.id), "job");
  assert.deepEqual(await media.boundingBox(), beforeRevision);
  assert.equal(await image.count(), 1, "a running revision retains the previous image");

  const beforeDrag = await readWorkflow();
  const box = await image.boundingBox();
  await page.mouse.move(box.x + 65, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 145, box.y + 160, { steps: 5 });
  await page.mouse.up();
  await waitForSourceX(beforeDrag.nodes[0].x, false);
  await page.keyboard.press(`${modifier}+z`);
  await waitForSourceX(beforeDrag.nodes[0].x);
  await page.evaluate(() => window.save());
  await page.reload();
  await image.waitFor();
  assert.equal(await origin.count(), 0, "the media remains the only presentation after reopening");
  await page.mouse.move(blank.x, blank.y);
  await media.hover();
  await origin.waitFor();
  assert.ok((await origin.boundingBox()).x + (await origin.boundingBox()).width <= (await media.boundingBox()).x);
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    snapshot.view = { ...snapshot.view, zoom: 0.3 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  });
  await page.reload();
  await image.waitFor();
  await page.mouse.move(blank.x, blank.y);
  await media.hover();
  await page.waitForTimeout(200);
  assert.equal(await origin.count(), 0, "zoom below 35% keeps the editor hidden");
  assert.deepEqual(errors, []);
  console.log("PASS running placeholder, reduced motion, original placement, live wires, hover intent and bridge, editing focus, pinning and exact continuation with move undo");
} catch (error) {
  console.error("Canvas fixture", await page.evaluate(() => ({
    path: location.pathname,
    canvasNodes: Array.from(document.querySelectorAll("[data-canvas-node-id]"), node => node.getAttribute("data-canvas-node-id")).slice(0, 12),
    ipcMock: typeof window.store !== "undefined",
    firstSnapshotNodes: window.snapshot?.().nodes.slice(0, 4).map(node => node.id),
  })).catch(() => null), errors);
  throw error;
} finally {
  if (host) await host.close();
  else await browser.close();
  await server.close();
}
