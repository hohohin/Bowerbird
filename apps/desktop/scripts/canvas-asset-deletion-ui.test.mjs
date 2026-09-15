import assert from "node:assert/strict";
import { createServer } from "vite";
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ server: { host: "127.0.0.1", port: 1457, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
try {
  for (const mode of ["keep", "delete"]) {
    await page.goto("http://127.0.0.1:1457/scripts/fixtures/canvas-reference/preview.html", { waitUntil: "domcontentloaded", timeout: 60000 });
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
      await node("old").click({ button: "right", position: { x: 30, y: 30 } });
      if (mode === "keep") {
        await page.getByRole("menuitem", { name: "仅移出当前项目 · 素材留在全局", exact: true }).click();
      } else {
        await page.getByRole("menuitem", { name: "物理删除", exact: true }).click();
        await page.getByRole("dialog").getByRole("button", { name: "物理删除", exact: true }).click();
      }
    }
    await remove();
    await page.getByText("模拟删除失败", { exact: false }).waitFor();
    assert.equal(await node("old").count(), 1);
    assert.equal(await node("copy").count(), 1);
    await page.keyboard.press("Escape");
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
  assert.deepEqual(errors, []);
  console.log("PASS asset deletion: keep/physical, failed operation, all canvas instances, grouped survivor, live draft/view, repeat and reload");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
