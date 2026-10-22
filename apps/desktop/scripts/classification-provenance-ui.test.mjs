import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const requireRenderer = createRequire(new URL("../../html-renderer/package.json", import.meta.url));
const { chromium } = requireRenderer("playwright");
const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), cacheDir: ".tmp/provenance-vite", server: { host: "127.0.0.1", port: 1467, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1050, height: 950 } });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await mkdir(".tmp/classification-provenance", { recursive: true });
  for (const scope of ["manage", "folder", "project"]) {
    await page.goto(`http://127.0.0.1:1467/scripts/fixtures/local-classification/preview.html?${scope}`);
    await page.evaluate(() => {
      window.sourcePreview = window.previewAsset.thumb_path;
      window.labels = [
        { id: "cloud", name: "水彩植物", description: "有透明水彩笔触的植物插画", enabled: true, count: 1, provenance: { kind: "cloud", asset_id: "original", asset_name: "植物原图.png", reason: "透明色层形成独立类别", created_at: 1792600000 } },
        { id: "library", name: "继承规则", description: "主库定义", enabled: true, count: 0, provenance: { kind: "library", asset_id: null, created_at: 1792600000 } },
        { id: "legacy", name: "历史空标签", description: "旧规则", enabled: true, count: 0 },
      ];
    });
    const cloudButton = page.getByRole("button", { name: "查看标签 水彩植物 的详情", exact: true });
    await cloudButton.waitFor();
    assert.equal(await page.getByText("Cloud 补充", { exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "查看标签 历史空标签 的详情", exact: true }).count(), 1, "empty rules remain editable in management");
    await cloudButton.focus(); await page.keyboard.press("Enter");
    const detail = page.getByRole("region", { name: "水彩植物标签详情", exact: true });
    await detail.getByText("新增理由：透明色层形成独立类别", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('img[alt*="植物原图.png"]')?.naturalWidth > 0);
    assert.equal(await detail.getByRole("img").evaluate(el => getComputedStyle(el).objectFit), "contain");
    const call = await page.evaluate(() => window.calls.filter(c => c.command === "local_classification_source").at(-1));
    assert.deepEqual(call.args, { tagId: "cloud", root: scope === "folder" ? "D:/fixture" : null });
    await page.screenshot({ path: `.tmp/classification-provenance/${scope}-dark.png` });
    await page.evaluate(() => document.documentElement.dataset.theme = "light");
    await page.setViewportSize({ width: 650, height: 780 });
    await page.screenshot({ path: `.tmp/classification-provenance/${scope}-light.png` });
    const bounds = await detail.getByRole("img").boundingBox();
    const container = await detail.boundingBox();
    assert.ok(bounds.x >= container.x && bounds.x + bounds.width <= container.x + container.width);
    await page.getByRole("button", { name: "查看标签 历史空标签 的详情", exact: true }).click();
    await page.getByText("此标签没有保存创建来源，无法确定最初来自哪张图片。", { exact: true }).waitFor();
    assert.equal(await detail.count(), 0);
    await page.getByRole("button", { name: "查看标签 继承规则 的详情", exact: true }).click();
    await page.getByText("从主库复制的分类规则，文件夹内新增标签保留在当前文件夹。", { exact: true }).waitFor();
    await page.evaluate(() => window.sourcePreview = null);
    await cloudButton.click();
    await detail.getByText("来源图片预览不可用，图片可能已移除、变更或暂时离线。", { exact: true }).waitFor();
    await detail.getByText("创建来源图片：植物原图.png", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.calls.some(c => /(_start|_save_label|_edit|_delete_labels)$/.test(c.command))), false, "reading creation evidence does not mutate or classify");
    await page.setViewportSize({ width: 1050, height: 950 });
  }
  // The real sidebar receives scoped counts; empty rules must not become navigation rows.
  await page.goto("http://127.0.0.1:1467/scripts/fixtures/catalog-paging/preview.html");
  await page.waitForFunction(() => window.changeKind);
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const result = await invoke(command, args);
      if (command === "catalog_overview") result.catalog.tags.push({ id: "empty", name: "空标签", count: 0, projectCount: 0, description: "" });
      return result;
    };
    window.changeKind("tags");
  });
  await page.locator('.catalog-tag-list [data-tag-id="first"]').waitFor();
  assert.equal(await page.locator('.catalog-tag-list [data-tag-id="empty"]').count(), 0);
  await page.evaluate(() => { window.total = 0; window.refresh(); });
  await page.waitForFunction(() => document.querySelectorAll('.catalog-tag-list [data-tag-id]').length === 0);
  assert.deepEqual(errors, []);
  console.log("PASS classification provenance: main/folder/project, image evidence, historical labels, missing source, keyboard, themes, empty sidebar");
} finally {
  await browser.close();
  await server.close();
}
