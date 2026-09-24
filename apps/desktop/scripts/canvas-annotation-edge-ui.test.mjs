import assert from "node:assert/strict";
import { createServer } from "vite";
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || "../../html-renderer/node_modules/playwright/index.mjs");
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: "127.0.0.1", port: 1597, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto("http://127.0.0.1:1597/scripts/fixtures/canvas-reference/preview.html");
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const s = window.snapshot(), base = s.nodes[0];
    const session = { ...base, id: "session", kind: "prompt", assetId: null, role: null, x: 500, y: 100, width: 260, height: 180,
      payloadJson: JSON.stringify({ schema_version: 1, job_id: "job", turn_key: "turn", text: "使用标记图生成图片", provider: "codex", status: "done" }) };
    // Native generation projection keeps non-library references as assetId=null.
    const annotation = { ...base, id: "annotation", assetId: null, x: 100, y: 350,
      payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: "annotation.png" }, execution: { job_id: "job", turn_key: "turn" } }) };
    const output = { ...base, id: "output", assetId: "a", role: "output", x: 900, y: 100 };
    const deleted = { ...output, id: "deleted", assetId: null, y: 350 };
    s.nodes = [{ ...base, x: 100, y: 100 }, session, annotation, output, deleted];
    s.edges = [["old", "session", "input"], ["annotation", "session", "input"], ["session", "output", "produced"], ["session", "deleted", "produced"]]
      .map(([fromNodeId, toNodeId, kind], i) => ({ id: `edge-${i}`, projectId: "p", threadId: "t", fromNodeId, toNodeId, kind, ordinal: i, createdAt: 1 }));
    s.view = { ...s.view, panX: 40, panY: 60, zoom: 0.8 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(s));
  });
  await page.reload();
  await page.locator('[data-canvas-node-id="session"]').waitFor();
  const checkEdges = async () => {
    assert.equal(await page.locator('[data-canvas-node-id="annotation"]').count(), 0);
    assert.equal(await page.locator(".canvas-graph-edges .is-input").count(), 1, "non-library annotation must not leave a floating input wire");
    assert.equal(await page.locator(".canvas-graph-edges .is-produced").count(), 1, "deleted output must not leave a floating result wire");
    assert.equal((await page.evaluate(() => window.snapshot())).edges.length, 4, "execution history remains intact");
  };
  await checkEdges();
  const path = page.locator(".canvas-graph-edges .is-input");
  const initialPath = await path.getAttribute("d");
  const card = page.locator('[data-canvas-node-id="old"]');
  const box = await card.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 80, { steps: 10 });
  assert.notEqual(await path.getAttribute("d"), initialPath, "real reference wire follows drag before persistence");
  await page.mouse.up();
  await page.waitForFunction(() => window.calls.some(c => c.command === "project_canvas_node_update" && c.args.nodeId === "old"));
  await page.evaluate(() => window.save());
  await page.reload();
  await page.locator('[data-canvas-node-id="session"]').waitFor();
  await checkEdges();
  assert.deepEqual(errors, []);
  console.log("PASS annotation and deleted-result floating wires hidden; real input drag, history and reload preserved");
} finally {
  await browser.close();
  await server.close();
}
