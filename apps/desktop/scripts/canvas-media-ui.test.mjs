import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
const server = await createServer({ server: { host: "127.0.0.1", port: 1569, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
try {
  await page.goto("http://127.0.0.1:1569/scripts/fixtures/canvas-reference/preview.html");
  await node("old").waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    const base = snapshot.nodes[0];
    snapshot.nodes = [
      { ...base, id: "wide", assetId: "a", x: 100, y: 100, height: 272 },
      { ...base, id: "tall", assetId: "b", x: 330, y: 100, height: 272 },
      { ...base, id: "duplicate", assetId: "a", x: 1150, y: 500, height: 272 },
      { ...base, id: "prompt", kind: "prompt", assetId: null, role: null, x: 570, y: 100, width: 280,
        payloadJson: JSON.stringify({ schema_version: 1, text: "参考 @合成参考 a.png的构图，结合 @合成参考 b.svg的色彩。保留我的描述。", status: "succeeded" }) },
      { ...base, id: "agent-prompt", kind: "prompt", assetId: null, role: null, x: 900, y: 100, width: 280,
        payloadJson: JSON.stringify({ schema_version: 1, text: "使用 @合成参考 b 设计一张海报", status: "succeeded" }) },
      { ...base, id: "agent", kind: "agent_group", assetId: null, role: null, x: 900, y: 100, width: 280,
        payloadJson: JSON.stringify({ schema_version: 1, run_id: "test", status: "succeeded" }) },
    ];
    snapshot.nodes[0].payloadJson = JSON.stringify({ schema_version: 1, snapshot: { name: "合成参考 a", width: 1600, height: 400 } });
    snapshot.nodes[1].payloadJson = JSON.stringify({ schema_version: 1, snapshot: { name: "改名前的参考 b", width: 400, height: 1600 } });
    snapshot.nodes.push({ ...base, id: "clip", assetId: "v", x: 1150, y: 100, height: 272,
      payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: "演示视频", width: 1280, height: 720 } }) });
    sessionStorage.setItem("reference-drafts", JSON.stringify([
      { id: "v", name: "演示视频.mp4", width: 1280, height: 720, store_path: "demo-clip.mp4", source: "imported" }]));
    snapshot.edges = [["wide", "prompt"], ["tall", "prompt"], ["tall", "agent-prompt"], ["agent-prompt", "agent"]].map(([fromNodeId, toNodeId], ordinal) => ({ id: `e${ordinal}`, projectId: "p", threadId: "t", fromNodeId, toNodeId, kind: "input", ordinal }));
    snapshot.edges[0].kind = "continued";
    snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 1 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
    sessionStorage.setItem("canvas-media-dimensions", "true");
  });
  await page.reload();
  await node("wide").waitFor();
  const duplicateBefore = await node("duplicate").boundingBox();
  for (const [id, dx, dy] of [["wide", 60, 5], ["tall", -5, -80]]) {
    const before = (await page.evaluate(() => window.snapshot())).nodes.find(n => n.id === id);
    await node(id).hover();
    const handle = await node(id).getByRole("button", { name: "调整素材大小" }).boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + dx, handle.y + handle.height / 2 + dy, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(id => !document.querySelector('.canvas-save-state.is-visible') && window.snapshot().nodes.find(n => n.id === id).width !== 190, id);
    const after = (await page.evaluate(() => window.snapshot())).nodes.find(n => n.id === id);
    assert.deepEqual([after.x, after.y], [before.x, before.y]);
    assert.ok(id === "wide" ? after.width > before.width : after.width < before.width);
  }
  assert.deepEqual(await node("duplicate").boundingBox(), duplicateBefore, "resizing affects only this instance");
  // Video cards carry their own identity: dedicated class, badge and video element.
  assert.equal(await node("clip").evaluate(e => e.classList.contains("is-video")), true, "video asset node gets the is-video class");
  assert.equal(await node("clip").locator(":scope > video").count(), 1);
  assert.equal(await node("clip").locator(".canvas-video-badge").count(), 1);
  assert.equal(await node("wide").evaluate(e => e.classList.contains("is-video")), false, "image nodes keep the plain asset style");
  assert.equal(await node("wide").locator(".canvas-video-badge").count(), 0);
  const resized = await node("wide").boundingBox();
  for (const [id, ratio] of [["wide", 4], ["tall", 0.25]]) {
    const geometry = await node(id).locator(":scope > img").evaluate(image => {
      const rect = image.getBoundingClientRect(); return { ratio: rect.width / rect.height, fit: getComputedStyle(image).objectFit };
    });
    assert.ok(Math.abs(geometry.ratio - ratio) < 0.01, `${id}: ${geometry.ratio}`);
    assert.equal(geometry.fit, "contain");
  }
  await node("prompt").locator('[data-asset-id="a"] img').waitFor();
  assert.deepEqual(await node("prompt").locator("[data-asset-id]").evaluateAll(elements => elements.map(e => e.dataset.assetId)), ["a", "b"]);
  assert.match(await node("prompt").innerText(), /保留我的描述/);
  assert.doesNotMatch(await node("prompt").innerText(), /合成参考/);
  assert.match(await node("prompt").innerText(), /的构图，结合.*的色彩/s);
  await node("agent").locator('[data-asset-id="b"] img').waitFor();
  assert.equal(await node("agent").locator("[data-asset-id]").count(), 1);
  assert.match(await node("agent").innerText(), /设计一张海报/);
  await page.evaluate(() => window.save());
  await page.reload();
  await node("prompt").locator('[data-asset-id="a"] img').waitFor();
  assert.ok(Math.abs(await node("tall").locator(":scope > img").evaluate(e => e.clientWidth / e.clientHeight) - 0.25) < 0.01);
  assert.deepEqual(await node("wide").boundingBox(), resized, "custom asset size survives hydration/reload");
  for (const relation of ["retry", "branch"]) {
    await page.evaluate(kind => {
      const snapshot = window.snapshot();
      snapshot.edges[0].kind = kind;
      sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
    }, relation);
    await page.reload();
    await node("prompt").locator('[data-asset-id="a"] img').waitFor();
    assert.deepEqual(await node("prompt").locator("[data-asset-id]").evaluateAll(elements => elements.map(e => e.dataset.assetId)), ["a", "b"]);
    assert.doesNotMatch(await node("prompt").innerText(), /合成参考/);
  }
  assert.deepEqual(errors, []);
  console.log("PASS original canvas aspect ratios, per-turn/Agent reference thumbnails, prose, video card identity and reload.");
} finally { await browser.close(); await server.close(); }
