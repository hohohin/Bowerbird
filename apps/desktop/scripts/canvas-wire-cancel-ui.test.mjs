import assert from "node:assert/strict";
import { createServer } from "vite";
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ server: { host: "127.0.0.1", port: 1707, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const draft = page.locator(".workflow-wires .is-draft");
const output = page.locator('[data-workflow-card="source"]').getByRole("button", { name: "输出：提示词", exact: true });
const input = page.locator('[data-workflow-card="target"]').getByRole("button", { name: "输入：文本", exact: true });
const snapshot = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes);
async function cancelled(before) {
  await draft.waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("menu").count(), 0, "cancellation must not open a context/disconnect menu");
  assert.deepEqual(await snapshot(), before, "cancellation must not alter existing connections");
}
try {
  await page.goto("http://127.0.0.1:1707/scripts/fixtures/canvas-reference/preview.html");
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const canvas = window.snapshot(); canvas.nodes = canvas.nodes.filter(node => node.id === "old");
    sessionStorage.setItem("reference-fixture", JSON.stringify(canvas));
    const { newWorkflowNode } = await import("/src/lib/canvasWorkflow.ts");
    const source = { ...newWorkflowNode("instruction", 120, 120, "codex"), id: "source" };
    const previous = { ...newWorkflowNode("instruction", 120, 500, "codex"), id: "previous" };
    const target = { ...newWorkflowNode("generation", 650, 120, "codex"), id: "target", inputs: { text: [{ nodeId: "previous", portId: "text" }] } };
    const trigger = { ...newWorkflowNode("trigger", 650, 500, ""), id: "trigger" };
    sessionStorage.setItem("workflow-p", JSON.stringify({ revision: 0, document: { schema_version: 1, nodes: [source, previous, target, trigger], run: null } }));
  });
  await page.reload();
  await page.locator('[data-workflow-card="source"]').waitFor({ state: "attached" });
  await page.getByRole("button", { name: "适应内容", exact: true }).click();
  await output.waitFor();
  const before = await snapshot();
  await output.click(); await draft.waitFor();
  await page.locator("[data-canvas-stage]").click({ button: "right", position: { x: 1300, y: 750 } });
  await cancelled(before);
  await output.click(); await draft.waitFor();
  await input.click({ button: "right" });
  await cancelled(before);
  await page.locator('[data-canvas-node-id="old"]').hover();
  await page.getByRole("button", { name: "连接图片到工作流", exact: true }).click();
  await draft.waitFor();
  await page.locator('[data-canvas-node-id="old"]').click({ button: "right" });
  await cancelled(before);

  // Left-button drag + right-button press must cancel before releasing over an input.
  const from = await output.boundingBox(), to = await input.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  await page.mouse.up();
  await cancelled(before);

  const signal = page.locator('[data-workflow-card="trigger"]').getByRole("button", { name: /^输出：/ });
  await signal.click(); await draft.waitFor();
  await page.locator('[data-workflow-card="target"] header').click({ button: "right" });
  await cancelled(before);

  // Esc still cancels, and a subsequent left click cannot complete the cancelled wire.
  await output.click(); await draft.waitFor();
  await page.keyboard.press("Escape");
  await input.click(); await cancelled(before);
  // Normal wiring remains usable after cancellation.
  await output.click(); await input.click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes.find(node => node.id === "target").inputs.text.length === 2);
  // Without an active draft, right click still opens the existing disconnect chooser.
  await input.click({ button: "right" });
  await page.getByRole("menu", { name: "选择要断开的连线" }).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS right-click cancels click/drag/signal wires without connecting, disconnecting or opening menus; normal wiring and disconnect remain available");
} finally { await browser.close(); await server.close(); }
