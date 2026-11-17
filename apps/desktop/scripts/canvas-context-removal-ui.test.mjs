import assert from "node:assert/strict";
import { createServer } from "vite";
const { chromium } = await import("../../html-renderer/node_modules/playwright/index.mjs");
const server = await createServer({ server: { host: "127.0.0.1", port: 18573, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
try {
  for (const mode of ["canvas", "keep", "group-item", "group"]) {
    await page.goto("http://127.0.0.1:18573/scripts/fixtures/canvas-reference/preview.html", { waitUntil: "domcontentloaded", timeout: 60000 });
    await node("old").waitFor();
    await page.evaluate(() => {
      const snapshot = window.snapshot();
      const base = snapshot.nodes[0];
      snapshot.nodes = [
        { ...base, x: 60, y: 80 },
        { ...base, id: "copy", x: 280, y: 80 },
        { ...base, id: "member", x: 500, y: 80 },
        { ...base, id: "survivor", assetId: "a", x: 500, y: 80 },
      ];
      snapshot.groups = [{ id: "folder", projectId: "p", name: "素材组", role: null,
        x: 500, y: 80, width: 204, height: 178, zIndex: 1, createdAt: 1, updatedAt: 1 }];
      snapshot.groupItems = ["member", "survivor"].map((nodeId, ordinal) => ({ projectId: "p", groupId: "folder", nodeId, ordinal }));
      snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 1 };
      sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await node("copy").waitFor();
    await page.locator(".ProseMirror").fill("保留正在编辑的草稿");
    const beforeView = await page.evaluate(() => window.snapshot().view);
    // A rejected deletion must keep every instance and must not claim success.
    await page.evaluate(() => { window.failAssetDelete = true; });
    async function remove() {
      const grouped = mode.startsWith("group");
      const target = grouped ? node("folder").locator('[data-frequent-asset-id="existing"]') : node("old");
      await target.click({ button: "right", position: { x: 15, y: 15 } });
      const menu = page.getByRole("menu", { name: "素材操作" });
      const scope = mode === "group" ? "删除当前组" : "删除当前项";
      const trigger = menu.getByRole("menuitem", { name: scope, exact: true });
      assert.ok(await trigger.locator("svg").count() > 0);
      await trigger.click();
      const labels = ["移出画布", "移出项目", "删除原文件"];
      const tips = ["素材仍能在项目素材库找到", "移除后，进入全局素材", "将文件放入回收箱，应用内不可见"];
      const submenu = page.getByRole("menu").filter({ has: page.getByRole("menuitem", { name: "移出画布", exact: true }) }).last();
      assert.deepEqual(await submenu.getByRole("menuitem").allTextContents(), labels);
      for (const [index, label] of labels.entries()) {
        assert.equal(await submenu.getByRole("menuitem", { name: label, exact: true }).getAttribute("title"), tips[index]);
      }
      await submenu.getByRole("menuitem", { name: mode === "keep" ? "移出项目" : "移出画布", exact: true }).click();
    }
    if (mode.startsWith("group")) {
      await remove();
      await node("folder").locator('[data-frequent-asset-id="existing"]').waitFor({ state: "detached" });
      if (mode === "group") await node("folder").waitFor({ state: "detached" });
      else assert.equal(await node("folder").locator("img").count(), 1);
      assert.equal(await node("old").count(), 1);
      assert.equal(await node("copy").count(), 1);
      await page.evaluate(() => sessionStorage.clear());
      continue;
    }
    if (mode === "canvas") {
      await remove();
      await node("old").waitFor({ state: "detached", timeout: 10000 });
      assert.equal(await node("copy").count(), 1);
      await page.waitForFunction(() => window.snapshot().nodes.find(n => n.id === "old")?.hiddenAt != null);
      await page.evaluate(() => window.save());
      await page.reload();
      await node("copy").waitFor();
      assert.equal(await node("old").count(), 0);
      await page.evaluate(() => sessionStorage.clear());
      continue;
    }
    await remove();
    await page.getByText("模拟删除失败", { exact: false }).waitFor();
    assert.equal(await node("old").count(), 1);
    assert.equal(await node("copy").count(), 1);
    await page.keyboard.press("Escape");
    if (await page.locator('.context-menu-surface').count()) await page.keyboard.press("Escape");
    await page.evaluate(() => { window.failAssetDelete = false; });
    await remove();
    await node("old").waitFor({ state: "detached", timeout: 10000 });
    await node("copy").waitFor({ state: "detached" });
    assert.equal(await node("folder").locator("img").count(), 1, "other group members survive");
    assert.match(await page.locator(".ProseMirror").innerText(), /保留正在编辑的草稿/);
    const afterView = await page.evaluate(() => window.snapshot().view);
    assert.deepEqual([afterView.panX, afterView.panY, afterView.zoom], [beforeView.panX, beforeView.panY, beforeView.zoom]);
    // Repeated notifications and reopening the project cannot resurrect deleted instances.
    await page.evaluate(() => { window.emitAssetsChanged(); window.save(); });
    await page.reload({ waitUntil: "domcontentloaded" });
    await node("folder").waitFor();
    assert.equal(await node("old").count(), 0);
    assert.equal(await node("copy").count(), 0);
    await page.evaluate(() => sessionStorage.clear());
  }
  for (const session of [true, false]) {
    await page.evaluate(session => {
      const s = window.snapshot(), base = s.nodes[0];
      const outputs = ["a", "b"].map((assetId, i) => ({ ...base, id: "workflow-video:" + assetId, kind: "asset", assetId, role: "output", hiddenAt: null, x: 220, y: 200, createdAt: i + 2,
        payloadJson: JSON.stringify({ schema_version: 1, workflow_generation_group: "producer", snapshot: { name: assetId, width: 190, height: 150 }, execution: { job_id: "job", turn_key: "one" } }) }));
      const prompt = { ...base, id: "session", kind: "prompt", assetId: null, role: null, hiddenAt: null, x: 220, y: 200, createdAt: 1, payloadJson: JSON.stringify({ schema_version: 1, job_id: "job", turn_key: "one", text: "生成组图", provider: "codex", status: "done" }) };
      s.nodes = session ? [prompt, ...outputs] : outputs;
      s.edges = session ? outputs.map((o, ordinal) => ({ id: "e" + ordinal, projectId: "p", threadId: "t", kind: "produced", fromNodeId: "session", toNodeId: o.id, ordinal, createdAt: 1 })) : [];
      s.groups = []; s.groupItems = []; s.view = { ...s.view, panX: 0, panY: 0, zoom: 1 };
      sessionStorage.setItem("reference-fixture", JSON.stringify(s));
    }, session);
    await page.reload();
    const card = node(session ? "session" : "workflow-video:a");
    const target = session ? card.locator('[data-conversation-image="b"]') : card;
    await target.click({ button: "right", position: { x: 30, y: 30 } });
    await page.getByRole("menuitem", { name: "删除当前组" }).click();
    await page.getByRole("menuitem", { name: "删除原文件", exact: true }).click();
    await page.waitForFunction(() => window.calls.some(c => c.command === "preview_asset_originals"));
    assert.deepEqual(await page.evaluate(() => window.calls.findLast(c => c.command === "preview_asset_originals").args.assetIds.slice().sort()), ["a", "b"]);
    await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();
    assert.equal(await page.evaluate(() => window.calls.some(c => c.command === "trash_asset_original")), false);
    await target.click({ button: "right", position: { x: 30, y: 30 } });
    await page.getByRole("menuitem", { name: "删除当前项" }).click();
    await page.getByRole("menuitem", { name: "移出画布" }).click();
    await page.waitForFunction(() => window.snapshot().nodes.find(n => n.id === "workflow-video:b")?.hiddenAt != null);
    assert.equal(await card.isVisible(), true);
    assert.equal(await page.evaluate(() => window.snapshot().nodes.find(n => n.id === "workflow-video:a").hiddenAt), null);
    if (session) await card.locator('[data-conversation-image="a"]').waitFor();
  }
  assert.deepEqual(errors, []);
  console.log("PASS asset deletion: canvas/project, failed operation, all canvas instances, grouped survivor, live draft/view, repeat and reload");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
