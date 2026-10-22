import assert from "node:assert/strict";
import { createServer } from "vite";
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ server: { host: "127.0.0.1", port: 1704, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const editor = page.locator(".creation-dock .ProseMirror");
async function reset() {
  await page.reload();
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(() => {
    const assets = window.store.getState().assets;
    const previous = window.__TAURI_INTERNALS__.invoke;
    window.submissions = [];
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "material_catalog") return { tags: [], collections: [], prompts: [], tag_asset_ids: {} };
      if (command === "material_catalog_assets") return assets;
      if (command === "external_file_media") return args.path;
      if (command === "codex_create_image") { window.submissions.push(args); return null; }
      return previous(command, args);
    };
    window.store.setState({
      boardOpen: true, activeGenProvider: "jimeng", dreaminaHealth: { ok: true },
      cloudEntitlement: { plan: "pro", policy: { can_use_byo: true }, balances: { daily: 100, sub: 0, topup: 0 } },
    });
    window.emitAssetsChanged();
  });
  await editor.fill("使用参考图绘制海报");
}
async function pickLibrary(id) {
  await page.evaluate(() => window.store.getState().setCanvasLibraryOpen(true));
  await page.locator(`.categorized-library [data-asset-id="${id}"]`).click();
  await editor.locator(`[data-asset-id="${id}"]`).waitFor();
  await page.getByRole("button", { name: "关闭素材库", exact: true }).click();
}
async function send() {
  await page.locator(".creation-dock").getByRole("button", { name: "生成图像", exact: true }).click();
  await page.waitForFunction(() => window.submissions.length === 1);
  return page.evaluate(() => window.submissions[0]);
}
try {
  await page.goto("http://127.0.0.1:1704/scripts/fixtures/canvas-reference/preview.html?source-library");
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    snapshot.nodes[0].role = "output"; // Same central asset already has a generated canvas result.
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  });
  await reset();
  await pickLibrary("existing");
  const library = await send();
  assert.equal(library.referenceImages.length, 1, "library image still reaches the provider");
  assert.deepEqual(library.referenceNodeIds, [null]);
  assert.equal(library.parentNodeId, null, "matching output must not turn a library pick into a continuation");
  assert.equal(library.parentAssetPath, null);

  await reset();
  await page.locator('[data-canvas-node-id="old"]').click({ position: { x: 60, y: 50 } });
  await editor.locator('[data-asset-id="existing"]').waitFor();
  const canvas = await send();
  assert.equal(canvas.referenceImages.length, 1);
  assert.deepEqual(canvas.referenceNodeIds, ["old"]);
  assert.equal(canvas.parentNodeId, "old");

  await reset();
  await page.locator('[data-canvas-node-id="old"]').click({ position: { x: 60, y: 50 } });
  await editor.locator('[data-asset-id="existing"]').waitFor();
  await pickLibrary("a");
  const mixed = await send();
  assert.equal(mixed.referenceImages.length, 2);
  assert.deepEqual(mixed.referenceNodeIds, ["old", null]);
  assert.equal(mixed.parentNodeId, "old");
  assert.deepEqual(errors, []);
  console.log("PASS actual library/canvas clicks preserve reference origin through editor, parent resolution and provider submission");
} finally {
  await browser.close();
  await server.close();
}
