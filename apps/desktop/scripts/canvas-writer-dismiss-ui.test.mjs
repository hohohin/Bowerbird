import assert from "node:assert/strict";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
import { createServer } from "vite";

const entry = "scripts/fixtures/canvas-reference/preview.html";
const server = await createServer({ cacheDir: ".tmp/writer-dismiss-vite", optimizeDeps: { entries: [entry] },
  server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  await page.goto(server.resolvedUrls.local[0] + entry);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { newWorkflowNode } = await import("/src/lib/canvasWorkflow.ts");
    const snapshot = window.snapshot(), base = snapshot.nodes.find(node => node.id === "old");
    snapshot.nodes = [{ ...base, id: "table", kind: "note", assetId: null, x: 130, y: 180, width: 320,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: "text", text: "", cells: [[{ id: "c", text: "保留正文" }]], member_ids: [] }) }];
    snapshot.edges = []; snapshot.view = { ...snapshot.view, zoom: 1, panX: 40, panY: 20 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
    const writer = { ...newWorkflowNode("text", 130, 180, ""), id: "writer", textTarget: { nodeId: "table", cellId: "c" } };
    const run = { id: "run-1", status: "failed", startId: writer.id, order: [writer.id], steps: { writer: { status: "failed", error: "写入失败" } } };
    sessionStorage.setItem("workflow-p", JSON.stringify({ revision: 1, document: { schema_version: 1, nodes: [writer], run, runs: [run] } }));
  });
  await page.reload();
  const card = page.locator('[data-canvas-node-id="table"]');
  const dismiss = card.getByRole("button", { name: "关闭错误提示" });
  await dismiss.click(); await dismiss.waitFor({ state: "detached" });
  assert.ok(!(await card.getAttribute("class")).includes("canvas-card-error"));
  await page.reload();
  await page.waitForFunction(async () => (await import("/src/lib/canvasWorkflowRuntime.ts")).canvasWorkflowController("p").ready);
  assert.equal(await dismiss.count(), 0);
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import("/src/lib/canvasWorkflowRuntime.ts");
    const controller = canvasWorkflowController("p"), doc = controller.document;
    const run = { ...doc.run, id: "run-2" };
    await controller.save({ ...doc, run, runs: [...doc.runs, run] });
  });
  await dismiss.waitFor();
  assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.runs.map(run => run.status)), ["failed", "failed"]);
  console.log("PASS content card dismissal, reload, retained history and a new writer failure");
} finally {
  await browser.close(); await server.close();
}
