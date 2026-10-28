import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";

const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || "../../html-renderer/node_modules/playwright/index.mjs");
const server = await createServer({ cacheDir: ".tmp/canvas-import-destinations/vite", server: { host: "127.0.0.1", port: 17936, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, reducedMotion: "reduce" });
page.setDefaultTimeout(12000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const stage = page.locator(".canvas-stage");
const library = page.locator(".categorized-library");
const imports = () => page.evaluate(() => window.mediaImports);
const nodes = () => page.evaluate(() => window.snapshot().nodes);
const importArgs = () => page.evaluate(() => window.imageImportArgs);
async function installImportFixture() {
  await page.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.imageImportArgs = [];
    window.collectionAssignments = [];
    const collections = ["a", "b"].map(id => ({ id: `collection-${id}`, name: `集合 ${id.toUpperCase()}`, parent_id: null, position: 0, created_at: 1 }));
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === "material_catalog") return { tags: [], collections, prompts: [], tag_asset_ids: {} };
      if (command === "set_collection_members") { window.collectionAssignments.push(args); window.emitAssetsChanged(); return; }
      if (command === "import_image_bytes") {
        window.imageImportArgs.push({ fileName: args.fileName, projectId: args.projectId, source: args.source });
        if (window.holdImage === args.fileName) await new Promise(resolve => { window.releaseImage = resolve; });
        // The existing closed fixture registers image bytes only for `imported`.
        // Preserve the actual source above, then reuse its in-memory ingestion.
        return original(command, { ...args, source: "imported" });
      }
      return original(command, args);
    };
    window.emitAssetsChanged();
  });
}
async function openLibrary(source, view = "all") {
  await page.evaluate(async ({ source, view }) => {
    const { useLocalFileMode } = await import("/src/lib/localFileMode.ts");
    useLocalFileMode.getState().openSource(source);
    useLocalFileMode.getState().setCatalogView(view);
  }, { source, view });
  await library.waitFor();
  await page.waitForFunction(source => document.querySelector(".categorized-library")?.dataset.fileImportProjectId === (source === "project" ? "p" : ""), source);
}
async function drop(selector, names, point) {
  await page.locator(selector).first().evaluate((element, { names, point }) => {
    const dataTransfer = new DataTransfer();
    for (const name of names) dataTransfer.items.add(new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" }));
    const rect = element.getBoundingClientRect();
    const coords = point ?? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    for (const type of ["dragenter", "dragover", "drop"]) element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, clientX: coords.x, clientY: coords.y }));
  }, { names, point });
}
async function waitImported(name) {
  await page.waitForFunction(name => window.mediaImports.some(item => item.asset.name === name), name);
  await page.getByText("正在导入素材…", { exact: true }).waitFor({ state: "hidden" });
  return (await imports()).find(item => item.asset.name === name);
}
async function canvasNode(name) {
  const imported = await waitImported(name);
  await page.waitForFunction(id => window.snapshot().nodes.some(node => node.assetId === id), imported.asset.id);
  return (await nodes()).find(node => node.assetId === imported.asset.id);
}
async function canvasPoint(x = .72, y = .42) {
  return stage.evaluate((element, { x, y }) => {
    const rect = element.getBoundingClientRect(), css = element.style;
    const zoom = parseFloat(css.backgroundSize) / 24;
    const [panX, panY] = css.backgroundPosition.split(" ").map(parseFloat);
    const clientX = Math.round(rect.left + rect.width * x), clientY = Math.round(rect.top + rect.height * y);
    return { x: clientX, y: clientY, boardX: (clientX - rect.left - panX) / zoom, boardY: (clientY - rect.top - panY) / zoom, zoom };
  }, { x, y });
}
function assertCentered(node, point, offset = 0) {
  assert.ok(Math.abs(node.x + node.width / 2 - point.boardX - offset) < .1, JSON.stringify({ node, point, offset }));
  assert.ok(Math.abs(node.y + node.height / 2 - point.boardY - offset) < .1, JSON.stringify({ node, point, offset }));
}
async function paste(selector, names, text = "") {
  return page.locator(selector).evaluate((element, { names, text }) => {
    const clipboardData = new DataTransfer();
    for (const name of names) clipboardData.items.add(new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" }));
    if (text) clipboardData.setData("text/plain", text);
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData });
    element.dispatchEvent(event); return event.defaultPrevented;
  }, { names, text });
}
try {
  await mkdir(".tmp/canvas-import-destinations", { recursive: true });
  await page.addInitScript(() => localStorage.setItem("bowerbird.canvasLibraryWidth", "620"));
  await page.goto("http://127.0.0.1:17936/scripts/fixtures/canvas-reference/preview.html?media-import&source-library&canvas-library&strict");
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.waitForFunction(() => Math.abs(parseFloat(document.querySelector(".canvas-stage").style.backgroundSize) / 24 - .9) < .001);
  await installImportFixture();

  // With the global drawer visible, dropping on canvas still freezes the project,
  // board coordinates and the complete batch before asynchronous image ingestion.
  await openLibrary("global");
  const point = await canvasPoint();
  await page.evaluate(() => { window.holdImage = "画布一.png"; });
  await drop(".canvas-stage", ["画布一.png", "画布二.png"], point);
  await page.waitForFunction(() => !!window.releaseImage);
  await stage.evaluate(element => element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -260, clientX: 700, clientY: 400 })));
  await page.waitForFunction(zoom => parseFloat(document.querySelector(".canvas-stage").style.backgroundSize) / 24 !== zoom, point.zoom);
  await page.evaluate(() => { window.holdImage = null; window.releaseImage(); window.releaseImage = null; });
  assertCentered(await canvasNode("画布一.png"), point);
  assertCentered(await canvasNode("画布二.png"), point, 24);
  assert.deepEqual((await importArgs()).slice(-2).map(item => item.projectId), ["p", "p"]);

  // The library and its own header use explicit source scope and never place a card.
  const beforeLibrary = (await nodes()).length;
  await drop(".categorized-library", ["全局库.png"]);
  assert.equal((await waitImported("全局库.png")).projectId, null);
  await drop(".canvas-source-panel", ["全局库边栏.png"]);
  assert.equal((await waitImported("全局库边栏.png")).projectId, null);
  await openLibrary("project");
  await drop(".categorized-library", ["项目库.png"]);
  assert.equal((await waitImported("项目库.png")).projectId, "p");
  assert.equal((await nodes()).length, beforeLibrary);

  // Switching the selected collection while a batch is pending must not move its
  // destination, close the collection view, or reset the user's newer selection.
  await openLibrary("project", "collections");
  await library.locator('[data-collection-id="collection-a"]').click();
  await page.waitForFunction(() => document.querySelector(".categorized-library").dataset.fileImportCollectionId === "collection-a");
  await page.evaluate(() => { window.holdImage = "集合一.png"; });
  await drop(".categorized-library", ["集合一.png", "集合二.png"]);
  await page.waitForFunction(() => !!window.releaseImage);
  await library.locator('[data-collection-id="collection-b"]').click();
  await page.evaluate(() => { window.holdImage = null; window.releaseImage(); window.releaseImage = null; });
  const collectionOne = await waitImported("集合一.png"), collectionTwo = await waitImported("集合二.png");
  assert.deepEqual(await page.evaluate(() => window.collectionAssignments), [
    { assetIds: [collectionOne.asset.id], id: "collection-a", added: true },
    { assetIds: [collectionTwo.asset.id], id: "collection-a", added: true },
  ]);
  assert.equal(collectionOne.projectId, "p");
  assert.equal(collectionTwo.projectId, "p");
  assert.equal(await library.getAttribute("data-file-import-collection-id"), "collection-b");
  await openLibrary("global", "collections");
  await library.locator('[data-collection-id="collection-b"]').click();
  await drop(".categorized-library", ["全局集合.png"]);
  const globalCollection = await waitImported("全局集合.png");
  assert.equal(globalCollection.projectId, null);
  assert.deepEqual(await page.evaluate(() => window.collectionAssignments.at(-1)), { assetIds: [globalCollection.asset.id], id: "collection-b", added: true });
  assert.equal(await library.getAttribute("data-file-import-collection-id"), "collection-b");
  assert.equal((await nodes()).length, beforeLibrary);

  // Real click focus determines the clipboard destination even with the drawer
  // open. Multiple images use the clicked canvas location, never the library.
  const pastePoint = await canvasPoint(.84, .68);
  await page.mouse.click(pastePoint.x, pastePoint.y);
  assert.equal(await stage.evaluate(element => element.contains(document.activeElement)), true);
  assert.equal(await paste(".canvas-stage", ["粘贴一.png", "粘贴二.png"]), true);
  assertCentered(await canvasNode("粘贴一.png"), pastePoint);
  assertCentered(await canvasNode("粘贴二.png"), pastePoint, 24);
  assert.deepEqual((await importArgs()).slice(-2).map(item => [item.source, item.projectId]), [["clipboard", "p"], ["clipboard", "p"]]);
  assert.equal(await page.evaluate(() => window.store.getState().canvasLibraryOpen), true);

  // Text and editable fields retain their own paste handling. In particular the
  // creation editor must not leak images into canvas via the global listener.
  const beforeEditor = (await nodes()).length;
  assert.equal(await paste(".canvas-stage", [], "普通文字"), false);
  const editor = page.locator(".creation-dock .ProseMirror");
  await editor.fill("保留编辑器草稿");
  await paste(".creation-dock .ProseMirror", ["编辑器图片.png"]);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal((await nodes()).length, beforeEditor);
  assert.equal(await editor.innerText(), "保留编辑器草稿");
  assert.deepEqual(errors, []);
  await page.screenshot({ path: ".tmp/canvas-import-destinations/complete.png" });
  console.log("PASS canvas drop coordinates/batches/frozen zoom, explicit global/project library/header scopes, frozen collection selection, focused canvas image paste and editor isolation.");
} catch (error) {
  await page.screenshot({ path: ".tmp/canvas-import-destinations/failure.png" });
  console.error(await page.evaluate(() => ({ imports: window.imageImportArgs, collections: window.collectionAssignments, nodes: window.snapshot?.().nodes, text: document.body.innerText.slice(-1000) })));
  throw error;
} finally {
  await browser.close();
  await server.close();
}
