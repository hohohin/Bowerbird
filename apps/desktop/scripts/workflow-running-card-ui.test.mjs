import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const entry = "scripts/fixtures/canvas-reference/preview.html";
const server = await createServer({ cacheDir: ".tmp/workflow-running-card/vite", optimizeDeps: { entries: [entry] },
  server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.goto(`${server.resolvedUrls.local[0]}${entry}`);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { newWorkflowNode } = await import("/src/lib/canvasWorkflow.ts");
    const { canvasWorkflowController } = await import("/src/lib/canvasWorkflowRuntime.ts");
    const controller = canvasWorkflowController("p");
    window.requestCount = 0;
    window.store.setState({ codexHealth: { ok: true }, cloudAuth: { logged_in: true, cloud_available: true },
      cloudEntitlement: { policy: { can_use_byo: true }, balances: { daily: 10, sub: 0, topup: 0 } },
      startGeneration: async () => {
        window.requestCount++;
        await new Promise(resolve => { window.finish = resolve; });
        return { accepted: true };
      } });
    await controller.load();
    await controller.edit([{ ...newWorkflowNode("generation", 100, 100, "codex"), id: "source", prompt: "一只鸟" }]);
  });
  const original = page.locator('[data-workflow-card="source"]');
  const run = original.getByRole("button", { name: "运行此卡片", exact: true });
  await run.click();
  await page.waitForFunction(() => !!window.finish);
  assert.equal(await original.getByLabel("卡片指令", { exact: true }).getAttribute("contenteditable"), "false");
  assert.equal(await original.getByLabel("删除卡片", { exact: true }).isDisabled(), true);
  assert.equal(await original.getByLabel("生成类型", { exact: true }).isDisabled(), true);
  const read = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("workflow-p")).document);
  const before = await read();
  const header = await original.locator("header strong").boundingBox();
  await page.mouse.move(header.x + 10, header.y + 8);
  await page.mouse.down();
  await page.mouse.move(header.x + 95, header.y + 64, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes[0].x !== 100);
  const moved = await read();
  assert.deepEqual(moved.run, before.run);
  await page.keyboard.press(`${modifier}+z`);
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes[0].x === 100);
  await original.getByLabel("复制卡片", { exact: true }).click();
  const copy = page.locator(".workflow-card:not([data-workflow-card=source])").first();
  await copy.getByLabel("卡片指令", { exact: true }).fill("副本指令");
  assert.equal(await original.getByLabel("卡片指令", { exact: true }).innerText(), "一只鸟");
  await original.locator("header strong").click();
  await page.keyboard.press("Delete");
  assert.equal(await original.count(), 1);
  await page.keyboard.press(`${modifier}+c`);
  await page.keyboard.press(`${modifier}+v`);
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes.length === 3);
  const copied = await read();
  assert.deepEqual(copied.run, before.run);
  for (const n of copied.nodes.slice(1)) {
    assert.deepEqual(n.outputs, {});
    assert.deepEqual(n.sessionNodeIds, []);
    assert.equal(n.activeSessionNodeId, null);
  }
  await page.evaluate(() => window.finish());
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.run.status === "done");
  await page.waitForFunction(() => !document.querySelector('[data-workflow-card="source"] [aria-label="删除卡片"]').disabled);
  assert.equal(await page.evaluate(() => window.requestCount), 1);
  assert.deepEqual(errors, []);
  console.log("PASS active generation move/undo, independent click and keyboard copies, original prompt/options/deletion locks and single submission");
} finally { await browser.close(); await server.close(); }
