import assert from "node:assert/strict";
import { createServer } from "vite";
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ server: { host: "127.0.0.1", port: 1459, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 2000, height: 1400 } });
page.setDefaultTimeout(10000);
page.setDefaultNavigationTimeout(60000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const card = id => page.locator(`[data-workflow-card="${id}"]`);
const material = page.locator('[data-canvas-node-id="old"]');
const stage = page.locator(".canvas-stage");
const saved = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes);
async function selectPair() {
  await stage.click({ position: { x: 950, y: 600 } });
  await card("first").getByLabel("拖动卡片").click();
  await card("second").getByLabel("拖动卡片").click({ modifiers: ["Control"] });
  await page.waitForFunction(() => document.querySelectorAll(".workflow-card.is-selected").length === 2);
}
async function undo() {
  await stage.focus(); await page.keyboard.press("Control+z");
  await card("first").waitFor(); await card("second").waitFor();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes.length === 3);
}
try {
  await page.goto("http://127.0.0.1:1459/scripts/fixtures/canvas-reference/preview.html", { waitUntil: "domcontentloaded" });
  await material.waitFor();
  await page.evaluate(async () => {
    const snapshot = window.snapshot();
    snapshot.nodes = [{ ...snapshot.nodes[0], x: 70, y: 680 }];
    snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 1 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
    const { newWorkflowNode } = await import("/src/lib/canvasWorkflow.ts");
    const first = { ...newWorkflowNode("generation", 150, 90, "codex"), id: "first" };
    const second = { ...newWorkflowNode("generation", 550, 90, "codex"), id: "second" };
    const outside = { ...newWorkflowNode("generation", 1100, 90, "codex"), id: "outside",
      inputs: { image: [{ nodeId: "first", portId: "image" }] } };
    sessionStorage.setItem("workflow-p", JSON.stringify({ revision: 0, document: { schema_version: 1, nodes: [first, second, outside], run: null } }));
  });
  await page.reload(); await card("second").waitFor();
  // Marquee selection + Delete removes both generation cards and cleans downstream wires.
  const one = await card("first").boundingBox(), two = await card("second").boundingBox();
  await page.mouse.move(one.x - 15, one.y - 15); await page.mouse.down();
  await page.mouse.move(two.x + two.width + 15, Math.max(one.y + one.height, two.y + two.height) + 15, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll(".workflow-card.is-selected").length === 2);
  await stage.focus(); await page.keyboard.press("Delete");
  await card("first").waitFor({ state: "detached" }); await card("second").waitFor({ state: "detached" });
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes.length === 1);
  assert.deepEqual((await saved())[0].inputs.image, []);
  await undo();
  assert.equal((await saved()).find(node => node.id === "outside").inputs.image[0].nodeId, "first");
  // Delete inside a prompt edits text; Delete focused on a card control removes the selection.
  await selectPair();
  const editor = card("first").locator('[contenteditable="true"]').first();
  await editor.fill("保留卡片"); await page.keyboard.press("Delete");
  assert.equal(await card("first").count(), 1); assert.equal(await card("second").count(), 1);
  await selectPair(); await card("first").getByRole("button", { name: "删除卡片", exact: true }).focus();
  await page.keyboard.press("Delete"); await card("second").waitFor({ state: "detached" }); await undo();
  // The selected card's close button follows the same selection and undo path.
  await selectPair(); await card("first").getByRole("button", { name: "删除卡片", exact: true }).click();
  await card("second").waitFor({ state: "detached" }); await undo();
  // An unselected right-click target is removed alone.
  await selectPair(); await card("outside").getByLabel("拖动卡片").click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await page.getByRole("menuitem", { name: "从画布移出", exact: true }).click();
  await card("outside").waitFor({ state: "detached" }); assert.equal(await card("first").count(), 1);
  await stage.focus(); await page.keyboard.press("Control+z"); await card("outside").waitFor();
  // Native images and workflow cards are one deletion/undo action.
  await selectPair(); await material.click({ modifiers: ["Control"], position: { x: 20, y: 20 } });
  await card("first").getByLabel("拖动卡片").click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await page.getByRole("menuitem", { name: "从画布移出所选 3 项", exact: true }).click();
  await material.waitFor({ state: "detached" }); await card("second").waitFor({ state: "detached" });
  await undo(); await material.waitFor();
  // A locked member rejects the whole mixed selection before hiding native nodes.
  await selectPair(); await material.click({ modifiers: ["Control"], position: { x: 20, y: 20 } });
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import("/src/lib/canvasWorkflowRuntime.ts");
    const controller = canvasWorkflowController("p");
    const run = { id: "busy", status: "running", order: ["second"], lockedNodeIds: ["second"], writeNodeIds: ["second"], steps: { second: { status: "running" } } };
    controller.document = { ...controller.document, runs: [run], run };
  });
  await stage.focus(); await page.keyboard.press("Delete");
  await page.getByText("此卡片关联的工作流正在运行，请先停止对应流程", { exact: false }).waitFor();
  assert.equal(await card("first").count(), 1); assert.equal(await material.count(), 1);
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import("/src/lib/canvasWorkflowRuntime.ts");
    const controller = canvasWorkflowController("p"); controller.document = { ...controller.document, runs: [], run: null };
  });
  await stage.focus(); await page.keyboard.press("Delete"); await material.waitFor({ state: "detached" });
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes.length === 1);
  assert.equal(await page.evaluate(() => window.calls.some(call => /delete_asset|generation.*delete/.test(call.command))), false);
  assert.equal(await page.evaluate(() => window.calls.some(call => call.command === "project_canvas_node_remove" && ["first", "second", "outside"].includes(call.args?.nodeId))), false);
  await page.evaluate(() => window.save()); await page.reload(); await card("outside").waitFor();
  assert.equal(await card("first").count(), 0); assert.equal(await card("second").count(), 0);
  assert.equal(await page.evaluate(() => window.store.getState().assets.length), 5);
  assert.deepEqual(errors, []);
  console.log("PASS generation multi-delete: marquee, keyboard, header, context menu, mixed undo, locks, wires, reload and retained assets");
} catch (error) {
  await page.screenshot({ path: ".tmp/generation-multidelete-failure.png" });
  console.error(await page.locator("[data-workflow-card]").evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.workflowCard, class: node.className, rect: node.getBoundingClientRect().toJSON() }))));
  throw error;
} finally { await browser.close(); await server.close(); }
