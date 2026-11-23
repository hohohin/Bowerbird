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
    const { api } = await import("/src/lib/api.ts");
    const { newWorkflowNode } = await import("/src/lib/canvasWorkflow.ts");
    const { canvasWorkflowController } = await import("/src/lib/canvasWorkflowRuntime.ts");
    const { publishGeneration } = await import("/scripts/fixtures/canvas-reference/generation.ts");
    const controller = canvasWorkflowController("p");
    api.localAgentFindAssetId = async () => "a";
    window.requestCount = 0;
    window.store.setState({ codexHealth: { ok: true }, cloudAuth: { logged_in: true, cloud_available: true },
      cloudEntitlement: { policy: { can_use_byo: true }, balances: { daily: 10, sub: 0, topup: 0 } },
      startGeneration: async (...args) => {
        window.requestCount++;
        const { jobId, turnKey } = args[12];
        window.deliverResult = async () => {
          const [asset] = await api.getAssetsByIds(["a"]);
          const { x, y } = controller.document.nodes.find(node => node.id === "source");
          await publishGeneration(args, [asset.store_path]);
          await api.projectCanvasNodeUpdate(`gen-prompt:${jobId}:${turnKey}:0`, { x, y });
          await api.projectCanvasNodeUpdate(`gen-output:${jobId}:${turnKey}:0`, { payloadJson: JSON.stringify({
            schema_version: 1, snapshot: { name: asset.name, width: asset.width, height: asset.height },
            execution: { job_id: jobId, turn_key: turnKey },
          }) });
          window.emitChange();
        };
        await new Promise(resolve => { window.finish = resolve; });
        return { accepted: true, jobId };
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
  assert.equal(await original.getByRole("group", { name: "生成类型" }).getByRole("button", { name: "视频", exact: true }).isDisabled(), true);
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
  assert.equal(await original.getAttribute("aria-busy"), "true", "acceptance without a visible result keeps the original card running");
  assert.equal(await original.getByLabel("删除卡片", { exact: true }).isDisabled(), true);
  assert.equal(await original.getByLabel("卡片指令", { exact: true }).getAttribute("contenteditable"), "false");

  await page.evaluate(() => window.deliverResult());
  const result = page.locator('[data-conversation-image="a"]');
  await result.waitFor();
  await original.waitFor({ state: "detached" });
  await result.click({ button: "right" });
  await page.getByRole("menuitem", { name: "固定生成卡", exact: true }).click();
  assert.equal(await original.getByLabel("删除卡片", { exact: true }).isDisabled(), false);
  assert.equal(await original.getByLabel("卡片指令", { exact: true }).getAttribute("contenteditable"), "true");
  assert.equal(await page.evaluate(() => window.requestCount), 1);
  assert.deepEqual(errors, []);
  console.log("PASS active generation move/undo, independent click and keyboard copies, locks through acceptance, delivery collapse/unlock and single submission");
} finally { await browser.close(); await server.close(); }
