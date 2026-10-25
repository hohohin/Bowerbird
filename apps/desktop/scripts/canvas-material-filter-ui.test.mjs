import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || "../../html-renderer/node_modules/playwright/index.mjs");
const server = await createServer({ server: { host: "127.0.0.1", port: 1706, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
async function states(expected) {
  for (const [id, state] of Object.entries(expected)) {
    await page.waitForFunction(({ id, state }) => document.querySelector(`[data-canvas-node-id="${id}"]`)?.dataset.canvasFilter === state, { id, state });
    await page.waitForFunction(({ id, opacity }) => Math.abs(Number(getComputedStyle(document.querySelector(`[data-canvas-node-id="${id}"]`)).opacity) - opacity) < .01,
      { id, opacity: state === "dim" ? .2 : 1 });
  }
}
try {
  await page.goto("http://127.0.0.1:1706/scripts/fixtures/canvas-reference/preview.html?source-library");
  await node("old").waitFor();
  await page.evaluate(() => {
    const s = window.snapshot(), base = s.nodes[0];
    const image = window.store.getState().assets[0];
    sessionStorage.setItem("reference-drafts", JSON.stringify([
      { ...image, id: "gen", name: "生成图片", generation_session_id: "generated-session" },
      { ...image, id: "video", name: "导入视频", store_path: "imported.mp4" },
      { ...image, id: "gen-video", name: "生成视频", store_path: "generated.mp4", generation_session_id: "generated-video-session" },
    ]));
    s.nodes = ["existing", "gen", "video", "gen-video"].map((assetId, i) => ({ ...base, id: assetId, assetId,
      x: 80 + i * 260, y: 100, payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: assetId, width: 190, height: 150 } }) }));
    s.nodes.push({ ...base, id: "session", kind: "prompt", assetId: null, role: null, x: 80, y: 420, width: 260,
      payloadJson: JSON.stringify({ schema_version: 1, job_id: "job", turn_key: "one", text: "生成会话", provider: "codex", status: "done" }) },
      { ...base, id: "output", assetId: "a", role: "output", x: 400, y: 420,
        payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: "会话结果", width: 190, height: 150 }, execution: { job_id: "job", turn_key: "one" } }) },
      ...["existing", "gen"].map((assetId, i) => ({ ...base, id: `member-${i}`, assetId, x: 500, y: 420 })));
    s.groups = [{ id: "group", projectId: "p", name: "素材组", role: null, x: 500, y: 420, width: 240, height: 230, zIndex: 2, createdAt: 1, updatedAt: 1 }];
    s.groupItems = [0, 1].map(ordinal => ({ groupId: "group", nodeId: `member-${ordinal}`, ordinal }));
    s.edges = [{ id: "produced", projectId: "p", threadId: "t", fromNodeId: "session", toNodeId: "output", kind: "produced", ordinal: 0, createdAt: 1 }];
    s.view = { ...s.view, panX: 0, panY: 0, zoom: 1 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(s));
  });
  await page.reload();
  await node("session").waitFor();
  const before = await page.evaluate(() => window.snapshot());
  await page.getByRole("button", { name: "只看生成图", exact: true }).click();
  await states({ existing: "dim", gen: "match", video: "dim", "gen-video": "match", session: "match" });
  assert.equal(await node("gen").evaluate(el => getComputedStyle(el).animationName), "canvas-filter-lift");
  assert.deepEqual(await node("group").locator(".canvas-folder-grid [data-canvas-filter]").evaluateAll(els => els.map(el => el.dataset.canvasFilter)), ["dim", "match"]);
  await node("group").click();
  assert.equal(await page.locator('[data-canvas-folder-asset-id="member-0"]').getAttribute("data-canvas-filter"), "dim");
  assert.equal(await page.locator('[data-canvas-folder-asset-id="member-1"]').getAttribute("data-canvas-filter"), "match");
  await page.getByRole("button", { name: "只看视频", exact: true }).click();
  await states({ existing: "dim", gen: "dim", video: "dim", "gen-video": "match", session: "dim" });
  await page.getByRole("button", { name: "不看生成图", exact: true }).click();
  await states({ existing: "dim", gen: "dim", video: "match", "gen-video": "dim", session: "dim" });
  await page.getByRole("button", { name: "只看图片", exact: true }).click();
  await states({ existing: "match", gen: "dim", video: "dim", "gen-video": "dim", session: "dim" });
  await page.getByRole("button", { name: "不看生成图", exact: true }).click();
  await states({ existing: "match", gen: "match", video: "dim", "gen-video": "dim", session: "match" });
  await page.getByRole("button", { name: "只看图片", exact: true }).click();
  await states({ existing: "all", gen: "all", video: "all", "gen-video": "all", session: "all" });
  assert.deepEqual((await page.evaluate(() => window.snapshot())).nodes, before.nodes, "filtering never moves or removes persisted nodes");
  await mkdir(".tmp/canvas-material-filter", { recursive: true });
  await page.getByRole("button", { name: "只看生成图", exact: true }).click();
  await states({ existing: "dim", gen: "match" });
  await page.waitForTimeout(450);
  await page.screenshot({ path: ".tmp/canvas-material-filter/light.png" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path: ".tmp/canvas-material-filter/dark.png" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await node("gen").evaluate(el => getComputedStyle(el).animationName), "none");
  await page.getByRole("button", { name: "只看视频", exact: true }).click();
  await states({ "gen-video": "match", gen: "dim" });
  assert.equal(await node("gen-video").evaluate(el => getComputedStyle(el).animationName), "none");
  assert.deepEqual(errors, []);
  console.log("PASS actual toolbar filters: generated/imported/image/video combinations, opacity, lift, reset, session and group media, stable geometry, reduced motion");
} finally { await browser.close(); await server.close(); }
