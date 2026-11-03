import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1569, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const dialog = page.getByRole("dialog", { name: "草稿编辑器", exact: true });
const library = page.locator("[data-draft-library]");
const layers = () => dialog.locator(".draft-layer-row").count();
const saveCalls = () => page.evaluate(() => window.calls.filter(call => call.command === "draft_workspace_save"));
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function canvasPoint(x, y) {
  return dialog.locator("[data-draft-canvas]").evaluate((canvas, p) => {
    const box = canvas.getBoundingClientRect();
    return { x: box.x + p.x * box.width / canvas.width, y: box.y + p.y * box.height / canvas.height };
  }, { x, y });
}
async function dragCanvas(from, to) {
  const start = await canvasPoint(...from), end = await canvasPoint(...to);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up(); await settle();
}
async function pixel(x, y) {
  return dialog.locator("[data-draft-canvas]").evaluate((canvas, p) => [...canvas.getContext("2d").getImageData(p.x, p.y, 1, 1).data], { x, y });
}
async function makeSelection() {
  await dialog.getByRole("button", { name: "选区", exact: true }).click();
  await dragCanvas([40, 40], [240, 180]);
  await dialog.locator("[data-draft-selection]").waitFor();
  await dialog.getByRole("button", { name: "画笔", exact: true }).click();
}
async function selectedImportedLayer(name) {
  assert.equal(await dialog.getByRole("button", { name: "移动", exact: true }).getAttribute("aria-pressed"), "true", "successful import switches to the move/select tool");
  const active = dialog.locator(".draft-layer-row.is-selected");
  assert.equal(await active.count(), 1, "only the newly imported layer is highlighted");
  assert.ok((await active.innerText()).includes(name));
  assert.equal(await active.locator(".draft-layer-select").getAttribute("aria-pressed"), "true");
  assert.equal(await active.getAttribute("data-draft-layer"), await dialog.locator(".draft-layer-row").first().getAttribute("data-draft-layer"), "the final imported layer is the active top layer");
  assert.equal(await dialog.locator("[data-draft-selection]").count(), 0, "old pixel selection does not restrict the imported image");
  assert.equal(await dialog.locator("[data-draft-selected-layer]").count(), 1, "the imported image has a visible selection outline");
  assert.equal(await dialog.getByRole("button", { name: "等比缩放图层", exact: true }).isVisible(), true);
}
async function openLibrary() {
  await dialog.locator(".draft-preview").focus();
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => document.querySelector("[data-draft-library]")?.getAttribute("aria-hidden") === "false");
}
async function hiddenLibrary() { await page.waitForFunction(() => document.querySelector("[data-draft-library]")?.getAttribute("aria-hidden") === "true"); }
async function dragCard(id) {
  const card = library.locator(`[data-asset-id="${id}"]`);
  await card.waitFor();
  await card.evaluate(element => { window.dragSource = element; });
  const box = await card.boundingBox(), target = await dialog.locator(".draft-preview").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 14, box.y + box.height / 2 + 14, { steps: 4 });
  await hiddenLibrary();
  assert.equal(await page.evaluate(() => window.dragSource.isConnected), true, "drag source must stay mounted after the drawer folds");
  await page.mouse.move(target.x + target.width * .7, target.y + target.height * .7, { steps: 10 });
  await page.mouse.up();
}
try {
  await page.goto("http://127.0.0.1:1569/scripts/fixtures/draft-library/preview.html");
  await page.evaluate(() => {
    window.libraryState.setState({ query: "原库搜索", generatedFilter: "source:generated", media: "videos", source: "project", open: false });
    window.store.getState().openDraftEditor({ assetId: null, projectId: "isolated-project" });
  });
  await dialog.locator("[data-draft-canvas]").waitFor();
  assert.equal(await layers(), 2);
  await openLibrary();
  await library.locator('[data-asset-id="library-red"]').waitFor();
  const thumb = await library.locator('[data-asset-id="library-red"] img').boundingBox();
  assert.ok(thumb && thumb.width > 20 && thumb.height > 20, "catalog thumbnails must retain visible dimensions within editor button styles");
  assert.equal(await library.getByRole("button", { name: "视频", exact: true }).count(), 0);
  assert.equal(await library.getByRole("button", { name: "添加到画板", exact: true }).count(), 0);
  await library.getByRole("tab", { name: "项目", exact: true }).click();
  await library.locator('[data-asset-id="library-red"]').waitFor();
  assert.equal(await library.locator('[data-asset-id="library-blue"]').count(), 0);
  await library.getByRole("tab", { name: "全局", exact: true }).click();
  await library.locator('[data-asset-id="library-blue"]').waitFor();
  await library.getByRole("textbox", { name: "搜索草稿素材" }).fill("红色");
  await library.locator('[data-asset-id="library-blue"]').waitFor({ state: "detached" });
  await page.keyboard.press("Tab");
  assert.equal(await library.getAttribute("aria-hidden"), "false", "Tab from a text input must remain focus traversal");
  await library.focus();
  for (const key of ["b", "e", "Delete", "Control+s"]) await page.keyboard.press(key);
  assert.equal(await layers(), 2);
  assert.equal(await dialog.getByRole("button", { name: "画笔", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal((await saveCalls()).length, 0);
  await page.keyboard.press("Escape"); await hiddenLibrary();
  assert.equal(await dialog.isVisible(), true, "Escape closes the library before the editor");
  assert.deepEqual(await page.evaluate(() => { const { query, generatedFilter, media, source, open } = window.libraryState.getState(); return { query, generatedFilter, media, source, open }; }),
    { query: "原库搜索", generatedFilter: "source:generated", media: "videos", source: "project", open: false });

  await page.keyboard.press("Tab");
  await page.waitForFunction(() => document.querySelector("[data-draft-library]")?.getAttribute("aria-hidden") === "false");
  await library.focus(); await page.keyboard.press("Space");
  await library.getByRole("textbox", { name: "搜索草稿素材" }).focus();
  await page.keyboard.press("Escape"); await hiddenLibrary();
  assert.equal(await dialog.locator(".draft-preview").evaluate(element => element === document.activeElement), true);
  assert.equal(await dialog.locator(".draft-preview").evaluate(element => element.classList.contains("is-pan-ready") || element.classList.contains("is-panning")), false);
  await makeSelection();
  await openLibrary();
  await dragCard("library-red");
  await page.waitForFunction(() => document.querySelectorAll(".draft-layer-row").length === 3);
  await selectedImportedLayer("红色样片");
  const importedX = Number(await dialog.getByLabel("位置 X", { exact: true }).inputValue());
  const importedY = Number(await dialog.getByLabel("位置 Y", { exact: true }).inputValue());
  await dragCanvas([importedX + 60, importedY + 40], [importedX + 260, importedY + 160]);
  assert.ok(Math.abs(Number(await dialog.getByLabel("位置 X", { exact: true }).inputValue()) - importedX - 200) < 1);
  assert.ok(Math.abs(Number(await dialog.getByLabel("位置 Y", { exact: true }).inputValue()) - importedY - 120) < 1);
  assert.deepEqual(await pixel(importedX + 60, importedY + 40), [255, 255, 255, 255], "immediate drag moves the imported image away without painting");
  assert.deepEqual(await pixel(importedX + 260, importedY + 160), [234, 68, 34, 255]);
  await dialog.getByRole("button", { name: "撤销", exact: true }).click();
  await settle();
  assert.equal(Number(await dialog.getByLabel("位置 X", { exact: true }).inputValue()), importedX, "the first drag is one undoable move");
  assert.deepEqual(await pixel(importedX + 60, importedY + 40), [234, 68, 34, 255]);
  await dialog.getByRole("button", { name: "撤销", exact: true }).click();
  assert.equal(await layers(), 2, "library import is one undoable layer operation");
  await dialog.getByRole("button", { name: "重做", exact: true }).click();
  assert.equal(await layers(), 3);

  // Existing multi-selection toolbar must target this draft, never the canvas.
  await openLibrary();
  await library.locator('[data-asset-id="library-red"]').click();
  await library.locator('[data-asset-id="library-blue"]').click({ modifiers: ["Meta"] });
  assert.equal(await library.locator('.folder-media-card[aria-pressed="true"]').count(), 2);
  await library.getByRole("button", { name: "添加到草稿", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".draft-layer-row").length === 5);
  await selectedImportedLayer("蓝色样片");
  await dialog.getByRole("button", { name: "撤销", exact: true }).click();
  assert.equal(await layers(), 3, "a multi-image import is undone as a single operation");

  // Connected collections must retain the Mac draft's explicit image picker contract.
  await openLibrary();
  await library.getByRole("tab", { name: "集合", exact: true }).click();
  await library.locator('[data-connection-entry="entry-library-red"]').waitFor();
  assert.equal(await library.getByRole("button", { name: "视频", exact: true }).count(), 0);
  await library.locator('[data-asset-id="library-red"]').dblclick();
  await page.waitForFunction(() => document.querySelectorAll(".draft-layer-row").length === 4);
  await selectedImportedLayer("红色样片");
  await dialog.getByRole("button", { name: "撤销", exact: true }).click();
  await openLibrary();
  await library.locator('[data-asset-id="library-red"]').click();
  await library.locator('[data-asset-id="library-blue"]').click({ modifiers: ["Meta"] });
  assert.equal(await library.getByRole("button", { name: "删除", exact: true }).count(), 0);
  await library.getByRole("button", { name: "添加到草稿", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".draft-layer-row").length === 5);
  await selectedImportedLayer("蓝色样片");
  await dialog.getByRole("button", { name: "撤销", exact: true }).click();
  assert.equal(await layers(), 3);
  await openLibrary();
  await library.getByRole("tab", { name: "全部", exact: true }).click();
  await page.keyboard.press("Escape"); await hiddenLibrary();

  // A failed read is atomic: preserve the current tool, pixel selection and active layer.
  await dialog.locator(".draft-layer-select").first().click();
  await makeSelection();
  const failedSelection = await dialog.locator("[data-draft-selection]").getAttribute("d");
  const failedActiveLayer = await dialog.locator(".draft-layer-row.is-selected").getAttribute("data-draft-layer");
  await page.evaluate(() => { window.failRead = true; });
  await openLibrary();
  await library.locator('[data-asset-id="library-blue"]').dblclick();
  await dialog.getByRole("alert").waitFor();
  assert.equal(await layers(), 3);
  assert.equal(await dialog.getByRole("button", { name: "画笔", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await dialog.locator("[data-draft-selection]").getAttribute("d"), failedSelection);
  assert.equal(await dialog.locator(".draft-layer-row.is-selected").getAttribute("data-draft-layer"), failedActiveLayer);
  await page.evaluate(() => { window.failRead = false; window.delayRead = true; });
  await openLibrary();
  await library.locator('[data-asset-id="library-blue"]').dblclick();
  await page.waitForFunction(() => !!window.releaseRead);
  assert.equal(await dialog.getByRole("button", { name: "关闭草稿", exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByRole("button", { name: "素材库", exact: true }).isDisabled(), true);
  for (const key of ["Escape", "Control+s", "e", "Delete", "Tab"]) await page.keyboard.press(key);
  assert.equal(await dialog.isVisible(), true);
  assert.equal((await saveCalls()).length, 0);
  assert.equal(await layers(), 3);
  await page.evaluate(() => { window.delayRead = false; window.releaseRead(); });
  await page.waitForFunction(() => document.querySelectorAll(".draft-layer-row").length === 4);
  await selectedImportedLayer("蓝色样片");

  // Arbitrary drag text/path is not an asset identity and must never trigger reads.
  const readsBefore = await page.evaluate(() => window.calls.filter(call => call.command === "read_image_data_url").length);
  await dialog.locator(".draft-preview").evaluate(element => {
    const dataTransfer = new DataTransfer(); dataTransfer.setData("text/plain", "/private/secret.png");
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  });
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === "read_image_data_url").length), readsBefore);
  assert.equal(await page.evaluate(() => window.backgroundDrops), 0);
  assert.equal(await page.evaluate(() => window.calls.some(call => call.command === "start_external_drag")), false, "draft library drag stays within its editor even in Tauri");
  assert.equal(await page.evaluate(() => window.calls.some(call => /project_canvas_node_create|draft_workspace_canvas_upsert/.test(call.command))), false);
  await mkdir("/private/tmp/bowerbird-draft-library-ui", { recursive: true });
  await openLibrary();
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('[data-draft-library] [data-asset-id] img')];
    return images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0);
  });
  await page.screenshot({ path: "/private/tmp/bowerbird-draft-library-ui/library-open.png" });
  const libraryBox = await library.boundingBox();
  assert.ok(libraryBox.height <= 641, "the library overlay must not expand past its height cap");
  await page.keyboard.press("Escape"); await hiddenLibrary();
  await dialog.getByRole("button", { name: "素材库", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await dialog.evaluate(element => element.contains(document.activeElement) && !document.activeElement.closest('[inert], [aria-hidden="true"]')), true, "Shift+Tab must wrap within the editor and exclude the hidden library");
  await dialog.getByRole("button", { name: "保存工程", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal((await saveCalls()).at(-1).args.document.layers.length, 4);
  assert.deepEqual(errors, []);
  console.log("PASS draft library: Tab/input/focus isolation, image catalog/project/search, native drag with mounted source, automatic move tool/highlight/immediate move, layer undo/multi-import, read failure preserves selection/tool and retry/busy lock, trusted asset IDs, no canvas drops, save.");
} catch (error) {
  console.error(await page.evaluate(() => ({ layers: document.querySelectorAll(".draft-layer-row").length, alerts: [...document.querySelectorAll('[role="alert"]')].map(e => e.textContent), calls: window.calls.slice(-8) })), errors);
  throw error;
} finally { await browser.close(); await server.close(); }
