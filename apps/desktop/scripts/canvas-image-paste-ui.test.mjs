import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ cacheDir: ".tmp/canvas-image-paste/vite", server: { host: "127.0.0.1", port: 17930, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
page.setDefaultTimeout(8000);
const errors = []; page.on("pageerror", error => errors.push(error.message));
const imports = () => page.evaluate(() => window.mediaImports);
const imageCalls = () => page.evaluate(() => window.mediaCalls.filter(call => call.command === "import_image_bytes"));
async function paste(selector, names = ["外部图片.png"], text = "") {
  return page.locator(selector).first().evaluate((element, { names, text }) => {
    const clipboardData = new DataTransfer();
    for (const name of names) clipboardData.items.add(new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" }));
    if (text) clipboardData.setData("text/plain", text);
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, { names, text });
}
async function waitForAsset(index) {
  await page.waitForFunction(index => window.snapshot().nodes.some(node => node.assetId === `media-${index}`), index);
  const id = await page.evaluate(index => window.snapshot().nodes.find(node => node.assetId === `media-${index}`).id, index);
  return page.locator(`[data-canvas-node-id="${id}"]`);
}
try {
  await page.goto("http://127.0.0.1:17930/scripts/fixtures/canvas-reference/preview.html?media-import&source-library&canvas-library&strict");
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    window.unhandledPastes = 0;
    window.addEventListener("paste", () => { window.unhandledPastes += 1; });
  });
  const stage = await page.locator(".canvas-stage").boundingBox();
  const before = await page.evaluate(() => window.snapshot().nodes.length);
  assert.equal(await paste(".canvas-stage"), true, "external image paste must be handled by the canvas");
  const first = await waitForAsset(0); await first.waitFor();
  assert.equal((await imports()).length, 1);
  assert.equal((await imageCalls())[0].args.source, "clipboard");
  assert.equal((await imports())[0].projectId, "p");
  assert.equal(await page.evaluate(() => window.snapshot().nodes.length), before + 1);
  assert.equal(await page.evaluate(() => window.unhandledPastes), 0, "global library paste must not ingest the same event again");
  const placed = await page.evaluate(() => {
    const { nodes, view } = window.snapshot();
    const node = nodes.find(node => node.assetId === "media-0");
    return { x: (node.x + node.width / 2) * view.zoom + view.panX, y: (node.y + node.height / 2) * view.zoom + view.panY };
  });
  // Stored geometry includes the optional caption even when the caption is hidden.
  assert.ok(Math.abs(placed.x - stage.width / 2) < 1, JSON.stringify({ placed, stage }));
  assert.ok(Math.abs(placed.y - stage.height / 2) < 1, JSON.stringify({ placed, stage }));

  // Body focus is the usual keyboard target after clicking empty canvas space.
  assert.equal(await paste("body", ["body.png"]), true);
  await waitForAsset(1);
  // An open source library must not disable image paste aimed at the canvas.
  await page.getByRole("button", { name: "展开画板素材库", exact: true }).click();
  await page.locator(".categorized-library").waitFor();
  assert.equal(await paste(".canvas-stage", ["with-library.png"]), true);
  await waitForAsset(2);
  assert.equal((await imports()).length, 3);
  assert.equal(await page.evaluate(() => window.unhandledPastes), 0);

  // Internal card data wins even if a source also advertises image bytes.
  await page.evaluate(() => window.store.getState().setCanvasLibraryOpen(false));
  await page.locator('[data-canvas-node-id="old"]').click({ position: { x: 30, y: 30 }, modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
  const cardText = await page.locator(".canvas-stage").evaluate(element => {
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }));
    return clipboardData.getData("text/plain");
  });
  assert.ok(cardText.length > 0, "the selected original card has an internal clipboard payload");
  const cardsBefore = await page.evaluate(() => window.snapshot().nodes.length);
  await paste(".canvas-stage", ["not-an-external-import.png"], cardText);
  await page.waitForFunction(count => window.snapshot().nodes.length === count + 1, cardsBefore);
  assert.equal((await imports()).length, 3);

  // Plain text, editing controls, dialogs and an already handled paste keep their owner.
  const count = (await imageCalls()).length;
  assert.equal(await paste(".canvas-stage", [], "ordinary text"), false);
  await page.evaluate(() => {
    const input = document.createElement("textarea"); input.id = "paste-editor"; document.querySelector(".canvas-stage").append(input);
  });
  assert.equal(await paste("#paste-editor"), false);
  await page.evaluate(() => {
    document.querySelector("#paste-editor").remove();
    const dialog = document.createElement("div"); dialog.id = "paste-dialog"; dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); document.body.append(dialog);
  });
  assert.equal(await paste(".canvas-stage"), false);
  await page.evaluate(() => document.querySelector("#paste-dialog").remove());
  await page.locator(".canvas-stage").evaluate(element => {
    const clipboardData = new DataTransfer(); clipboardData.items.add(new File(["image"], "claimed.png", { type: "image/png" }));
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }); event.preventDefault(); element.dispatchEvent(event);
  });
  assert.equal((await imageCalls()).length, count);

  // A browser FileReader failure is visible and never reaches native import.
  await page.evaluate(() => {
    window.originalFileReader = window.FileReader;
    window.FileReader = class {
      error = null;
      readAsDataURL() { queueMicrotask(() => this.onerror?.()); }
    };
  });
  await paste(".canvas-stage", ["unreadable.png"]);
  await page.getByText("无法读取文件，请重新导入", { exact: true }).waitFor();
  assert.equal((await imageCalls()).length, count);
  await page.evaluate(() => { window.FileReader = window.originalFileReader; });

  // Import failures report the error and leave the canvas unchanged; the next paste works.
  await page.evaluate(() => { window.failImageImport = true; });
  await paste(".canvas-stage", ["failure.png"]);
  await page.getByText("模拟图片导入失败", { exact: true }).waitFor();
  assert.equal((await imports()).length, 3);
  await page.evaluate(() => { window.failImageImport = false; });
  await paste(".canvas-stage", ["recovery.png", "second.png"]);
  await waitForAsset(3); await waitForAsset(4);
  assert.equal((await imports()).length, 5, "one paste imports every image once");

  // Retrying a canvas write reuses its saved image and node identity.
  await page.evaluate(() => { window.failNodeSave = true; });
  await paste(".canvas-stage", ["node-retry.png"]);
  await page.getByRole("button", { name: "重试保存画板", exact: true }).waitFor();
  assert.equal((await imports()).length, 6);
  assert.equal(await page.evaluate(() => window.snapshot().nodes.filter(node => node.assetId === "media-5").length), 0);
  const writesBeforeRetry = (await imageCalls()).length;
  await page.evaluate(() => { window.failNodeSave = false; });
  await page.getByRole("button", { name: "重试保存画板", exact: true }).click();
  await waitForAsset(5);
  assert.equal((await imageCalls()).length, writesBeforeRetry);
  assert.equal(await page.evaluate(() => window.snapshot().nodes.filter(node => node.assetId === "media-5").length), 1);

  // A project switch during the image read/import cannot retarget the pending card.
  await page.evaluate(() => { window.holdMedia = true; });
  await paste(".canvas-stage", ["delayed.png"]);
  await page.waitForFunction(() => typeof window.releaseMedia === "function");
  await page.evaluate(() => {
    const state = window.store.getState();
    window.store.setState({ projects: [...state.projects, { ...state.projects[0], id: "q", name: "新项目" }], activeProjectId: "q", projectRouteRevision: state.projectRouteRevision + 1 });
    window.holdMedia = false; window.releaseMedia();
  });
  await page.waitForFunction(() => window.snapshot().nodes.some(node => node.assetId === "media-6"));
  assert.equal((await imports()).at(-1).projectId, "p");
  assert.equal(await page.evaluate(() => window.snapshot().nodes.find(node => node.assetId === "media-6").projectId), "p");
  assert.equal((await imports()).length, 7);
  assert.deepEqual(errors, []);
  console.log("PASS: external canvas image paste, center placement, body focus, open library, no duplicate import, internal card priority, owner isolation, read/import failure recovery, node retry and frozen project.");
} finally { await browser.close(); await server.close(); }
