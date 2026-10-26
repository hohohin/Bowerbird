import assert from "node:assert/strict";
import { createServer } from "vite";
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ server: { host: "127.0.0.1", port: 1459, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
try {
  await page.goto("http://127.0.0.1:1459/scripts/fixtures/canvas-reference/preview.html");
  await node("old").waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot(), base = snapshot.nodes[0];
    const prompt = (id, turn, createdAt) => ({ ...base, id, kind: "prompt", assetId: null, role: null,
      x: 300, y: 100, width: 260, height: 148, createdAt,
      payloadJson: JSON.stringify({ schema_version: 1, job_id: "job", turn_key: turn, text: turn, provider: "codex", status: "done" }) });
    const outputs = ["a", "b", "c"].map((assetId, i) => ({ ...base, id: `output-${assetId}`, assetId, role: "output",
      createdAt: i + 1, payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: assetId, width: 190, height: 150 },
        execution: { job_id: "job", turn_key: assetId === "c" ? "two" : "one" } }) }));
    snapshot.nodes = [{ ...base, x: 50, y: 500 }, prompt("first", "one", 1), prompt("next", "two", 2), ...outputs];
    snapshot.edges = outputs.map((output, i) => ({ id: `edge-${i}`, projectId: "p", threadId: "t",
      fromNodeId: output.assetId === "c" ? "next" : "first", toNodeId: output.id, kind: "produced", ordinal: i, createdAt: 1 }));
    snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 1 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  });
  await page.reload();
  await node("first").waitFor();
  await page.locator('[data-conversation-image="c"]').waitFor();
  await page.locator(".ProseMirror").fill("保留未发送草稿");
  async function remove(id) {
    // Library deletion emits the same refresh event even when the result is folded into a card.
    await page.evaluate(async assetId => {
      const { api } = await import("/src/lib/api.ts");
      await api.deleteAssetWithMode(assetId, "delete", "p");
    }, id);
  }
  await remove("a");
  await page.waitForFunction(() => window.snapshot().nodes.find(n => n.id === "output-a").assetId === null);
  assert.equal(await node("first").count(), 1, "the turn still has another result");
  await remove("b");
  await node("first").waitFor({ state: "detached" });
  await node("next").waitFor();
  await page.locator('[data-conversation-image="c"]').waitFor();
  assert.equal(await page.locator(".canvas-prompt-node").count(), 1, "another turn stays available");
  await remove("c");
  await node("next").waitFor({ state: "detached" });
  assert.equal(await page.locator(".canvas-prompt-node").count(), 0, "no empty generation card remains");
  assert.equal(await node("old").count(), 1, "unrelated material survives");
  assert.match(await page.locator(".ProseMirror").innerText(), /保留未发送草稿/);
  await page.evaluate(() => { window.emitAssetsChanged(); window.save(); });
  await page.reload();
  await node("old").waitFor();
  assert.equal(await page.locator(".canvas-prompt-node").count(), 0, "reopening does not restore empty cards");
  assert.deepEqual(errors, []);
  console.log("PASS physical deletion: remaining outputs, multiple turns, last result removes card, draft and reload");
} finally {
  await browser.close();
  await server.close();
}
