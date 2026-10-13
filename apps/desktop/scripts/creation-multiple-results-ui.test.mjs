import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

// Real canvas/composer/store with synthetic IPC: no library or provider access.
const server = await createServer({ server: { host: "127.0.0.1", port: 1597, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const url = "http://127.0.0.1:1597/scripts/fixtures/canvas-reference/preview.html";
try {
  for (const mode of ["cross-thread", "same-thread", "explicit-parent"]) {
    await page.goto(url);
    await page.waitForFunction(() => window.snapshot && document.querySelector('.canvas-workspace[aria-busy="false"]'));
    await page.evaluate(mode => {
      const snapshot = window.snapshot();
      const base = snapshot.nodes[0];
      snapshot.nodes = ["a", "b"].map((id, index) => ({
        ...base, id: `result-${id}`, assetId: id, role: "output",
        threadId: mode === "same-thread" ? "t" : `thread-${id}`,
        x: 400 + index * 250, y: 200,
      }));
      snapshot.threads = ["t", "thread-a", "thread-b"].map(id => ({ id, projectId: "p", title: id, archivedAt: null }));
      snapshot.edges = [];
      snapshot.view.activeNodeId = null;
      snapshot.view.focusedThreadId = mode === "same-thread" ? "t" : null;
      snapshot.canvas.draftJson = "{}";
      sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
    }, mode);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.canvas-workspace[aria-busy="false"]'));
    const dock = page.locator(".creation-dock");
    await dock.locator(".ProseMirror").click();
    const expectedPaths = await page.evaluate(mode => {
      const references = ["a", "b"].map(id => window.store.getState().assets.find(asset => asset.id === id));
      window.store.setState({
        activeGenProvider: "jimeng", dreaminaHealth: { ok: true },
        cloudEntitlement: { plan: "pro", policy: { can_use_byo: true }, balances: { daily: 100, sub: 0, topup: 0 } },
        pendingCreativeContinuation: mode === "explicit-parent"
          ? { requestId: "continue-a", projectId: "p", threadId: "thread-a", parentAssetId: "a", parentNodeId: "result-a" }
          : null,
      });
      window.dispatchEvent(new CustomEvent("bowerbird://board-load-prompt", { detail: {
        prompt: "结合 @合成参考 a 和 @合成参考 b 生成海报", refs: references, dimRefs: [],
        referenceNodeIds: ["result-a", "result-b"],
      } }));
      return references.map(asset => asset.store_path);
    }, mode);
    await page.waitForFunction(() => document.querySelectorAll('.creation-dock .ProseMirror [data-asset-id]').length === 2);
    await dock.getByRole("button", { name: "生成图像", exact: true }).click();
    await page.waitForFunction(() => window.calls.some(call => call.command === "codex_create_image"), null, { timeout: 5000 });
    const calls = await page.evaluate(() => window.calls);
    const submissions = calls.filter(call => call.command === "codex_create_image");
    assert.equal(submissions.length, 1);
    const request = submissions[0].args;
    assert.equal(request.projectId, "p");
    assert.deepEqual(request.referenceImages, expectedPaths);
    assert.deepEqual(request.referenceNodeIds, ["result-a", "result-b"]);
    const threads = calls.filter(call => call.command === "project_thread_create");
    if (mode === "explicit-parent") {
      assert.equal(threads.length, 0);
      assert.equal(request.threadId, "thread-a");
      assert.equal(request.parentNodeId, "result-a");
      assert.equal(request.creativeRelation, "continued");
    } else {
      assert.equal(threads.length, 1);
      assert.equal(request.threadId, threads[0].args.value.id);
      assert.ok(!["t", "thread-a", "thread-b"].includes(request.threadId));
      assert.equal(request.parentNodeId, null);
      assert.equal(request.parentAssetPath, null);
      assert.equal(request.creativeRelation, null);
    }
    await page.evaluate(() => sessionStorage.clear());
  }
  assert.deepEqual(errors, []);
  console.log("PASS: multiple result references submit once in a new thread; explicit continuation keeps its exact parent; all references and node IDs survive");
} finally {
  await browser.close();
  await server.close();
}
