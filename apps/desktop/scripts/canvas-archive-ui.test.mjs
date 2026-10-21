import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ server: { host: "127.0.0.1", port: 1497, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
const item = () => page.getByRole("menuitem", { name: "将所选内容打包", exact: true });
async function openMenu(id = "a") {
  await node(id).click({ button: "right", position: { x: 30, y: 30 } });
  await item().waitFor();
}
try {
  await page.goto("http://127.0.0.1:1497/scripts/fixtures/canvas-reference/preview.html");
  await node("old").waitFor();
  await page.evaluate(() => {
    const s = window.snapshot(), base = s.nodes[0];
    s.nodes = [{ ...base, x: 60, y: 80 }, { ...base, id: "a", assetId: "a", x: 280, y: 80 },
      { ...base, id: "duplicate-a", assetId: "a", x: 500, y: 80 },
      { ...base, id: "outside", assetId: "b", x: 60, y: 400 }];
    s.view = { ...s.view, panX: 0, panY: 0, zoom: 1 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(s));
  });
  await page.reload();
  await node("outside").waitFor();
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.store.setState({ boardOpen: false, mode: "manage", selectedIds: new Set(["b", "c"]), assets: [] });
    window.archiveCalls = []; window.dialogCalls = []; window.archiveNotices = [];
    window.addEventListener("bowerbird://notify", event => window.archiveNotices.push(event.detail));
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "plugin:dialog|save") { window.dialogCalls.push(args); return window.archivePath ?? null; }
      if (command === "export_assets_zip") {
        window.archiveCalls.push(args);
        if (window.holdArchive) await new Promise(resolve => { window.releaseArchive = resolve; });
        if (window.failArchive) throw "原图片不可用";
        return args.assetIds.length;
      }
      return original(command, args);
    };
  });
  await page.waitForFunction(() => !document.querySelector(".canvas-stage.is-creation-mode"));
  const rect = await page.locator(".canvas-stage").boundingBox();
  await page.mouse.move(rect.x + 710, rect.y + 290);
  await page.mouse.down();
  await page.mouse.move(rect.x + 55, rect.y + 60, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll("[data-canvas-node-id].is-selected").length === 3);
  await openMenu();
  assert.equal(await item().isEnabled(), true);
  await mkdir(".tmp/canvas-archive", { recursive: true });
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: `.tmp/canvas-archive/${theme}.png`, animations: "disabled" });
  }
  // Cancelling the native save dialog never exports.
  await item().click();
  assert.equal(await page.evaluate(() => window.dialogCalls.length), 1);
  assert.deepEqual(await page.evaluate(() => window.archiveCalls), []);
  await page.evaluate(() => { window.archivePath = "D:/export/所选内容.zip"; });
  await openMenu();
  await item().click();
  await page.waitForFunction(() => window.archiveNotices.some(n => n.tone === "success"));
  assert.deepEqual(await page.evaluate(() => window.archiveCalls[0]), { assetIds: ["existing", "a"], path: "D:/export/所选内容.zip" });
  // Blank-canvas menu shares the same selection and does not package outside images.
  await page.mouse.click(rect.x + 800, rect.y + 350, { button: "right" });
  await item().click();
  await page.waitForFunction(() => window.archiveCalls.length === 2);
  assert.deepEqual(await page.evaluate(() => window.archiveCalls[1].assetIds), ["existing", "a"]);
  // Ctrl multi-select, independent of the library's selection.
  await node("outside").click({ modifiers: ["Control"], position: { x: 30, y: 30 } });
  await page.waitForFunction(() => document.querySelectorAll("[data-canvas-node-id].is-selected").length === 4);
  await openMenu("outside");
  await page.evaluate(() => { window.holdArchive = true; });
  await item().click();
  await page.waitForFunction(() => window.releaseArchive);
  assert.deepEqual(await page.evaluate(() => window.archiveCalls[2].assetIds), ["existing", "a", "b"]);
  await openMenu();
  await item().click();
  assert.equal(await page.evaluate(() => window.archiveCalls.length), 3, "a second menu cannot start a concurrent export");
  await page.evaluate(() => { window.holdArchive = false; window.releaseArchive(); });
  await page.waitForFunction(() => window.archiveNotices.filter(n => n.tone === "success").length === 3);
  await page.evaluate(() => { window.failArchive = true; });
  await openMenu();
  await item().click();
  await page.waitForFunction(() => window.archiveNotices.some(n => n.tone === "error" && n.message === "原图片不可用"));
  assert.equal(await node("old").count(), 1, "export never removes canvas nodes");
  assert.deepEqual(errors, []);
  console.log("Canvas ZIP export: marquee, Ctrl selection, both menus, tooltip, cancellation, duplicate guard and failure passed.");
} finally {
  await browser.close();
  await server.close();
}
