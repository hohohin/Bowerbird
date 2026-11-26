import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ cacheDir: ".tmp/canvas-image-paste/vite", server: { host: "127.0.0.1", port: 17930, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
page.setDefaultTimeout(8000);
page.setDefaultNavigationTimeout(30000);
const errors = []; page.on("pageerror", error => errors.push(error.message));
const selected = page.locator('[aria-label*="已选中"]');
const imports = () => page.evaluate(() => window.mediaImports);
const imageCalls = () => page.evaluate(() => window.mediaCalls.filter(call => call.command === "import_image_bytes"));
async function paste(selector, names = ["外部图片.png"], text = "", itemsOnly = false) {
  return page.locator(selector).first().evaluate((element, { names, text, itemsOnly }) => {
    const clipboardData = new DataTransfer();
    for (const item of names) {
      const [name, type] = typeof item === "string" ? [item, "image/png"] : item;
      clipboardData.items.add(new File([new Uint8Array([1, 2, 3])], name, { type }));
    }
    if (itemsOnly) Object.defineProperty(clipboardData, "files", { value: [] });
    if (text) clipboardData.setData("text/plain", text);
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, { names, text, itemsOnly });
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
  const canvasPoint = async (fractionX, fractionY) => {
    const bounds = await page.locator(".canvas-stage").boundingBox();
    const x = Math.round(bounds.width * fractionX), y = Math.round(bounds.height * fractionY);
    const view = await page.locator(".canvas-plane").evaluate(plane => {
      const camera = new DOMMatrixReadOnly(getComputedStyle(plane).transform);
      return { panX: camera.m41, panY: camera.m42, zoom: camera.m11 };
    });
    assert.equal(await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      return !!target?.closest(".canvas-stage") && !target.closest("[data-canvas-node]");
    }, { x: bounds.x + x, y: bounds.y + y }), true, `expected empty canvas at ${x}, ${y}`);
    await page.mouse.click(bounds.x + x, bounds.y + y);
    return { x: (x - view.panX) / view.zoom, y: (y - view.panY) / view.zoom };
  };
  async function assertCentered(id, expected) {
    const node = await page.evaluate(id => window.snapshot().nodes.find(node => node.id === id), id);
    assert.ok(Math.abs(node.x + node.width / 2 - expected.x) < 1 && Math.abs(node.y + node.height / 2 - expected.y) < 1,
      JSON.stringify({ node, expected }));
  }
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
  const second = await waitForAsset(1);
  await second.and(selected).waitFor();
  assert.equal(await page.evaluate(() => {
    const [a, b] = [0, 1].map(index => window.snapshot().nodes.find(node => node.assetId === `media-${index}`));
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  }), false, "pasting twice at the same point keeps both cards accessible");
  // An open source library must not disable image paste aimed at the canvas.
  await page.getByRole("button", { name: "展开画板素材库", exact: true }).click();
  await page.getByRole("region", { name: "平铺浏览全部图片", exact: true }).waitFor();
  await page.getByRole("separator", { name: "调整素材库宽度", exact: true }).press("Home");
  const clickedImage = await canvasPoint(0.65, 0.58);
  assert.equal(await paste("body", ["with-library.png"], "", true), true);
  const openedLibraryImage = await waitForAsset(2);
  const openedLibraryId = await openedLibraryImage.getAttribute("data-canvas-node-id");
  await assertCentered(openedLibraryId, clickedImage);
  await openedLibraryImage.and(selected).waitFor();
  assert.equal((await imports()).length, 3);
  assert.equal(await page.evaluate(() => window.unhandledPastes), 0);

  // Internal card data wins even if a source also advertises image bytes.
  await page.locator(".canvas-library-resize").getByRole("button", { name: "关闭素材库", exact: true }).click();
  const multiselect = [process.platform === "darwin" ? "Meta" : "Control"];
  await canvasPoint(0.70, 0.79);
  await page.locator('[data-canvas-node-id="old"]').click({ position: { x: 30, y: 30 }, modifiers: multiselect });
  await first.click({ position: { x: 85, y: 56 }, modifiers: multiselect });
  const cardText = await page.locator(".canvas-stage").evaluate(element => {
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }));
    return clipboardData.getData("text/plain");
  });
  assert.ok(cardText.length > 0, "the selected original card has an internal clipboard payload");
  const copied = JSON.parse(cardText.slice(cardText.indexOf("\n") + 1)).nodes;
  assert.equal(copied.length, 2, "two selected cards are copied");
  const clickAnchor = await canvasPoint(0.78, 0.80);
  const cardsBefore = await page.evaluate(() => window.snapshot().nodes.map(node => node.id));
  await paste(".canvas-stage", ["not-an-external-import.png"], cardText);
  await page.waitForFunction(count => window.snapshot().nodes.length === count + 2, cardsBefore.length);
  const clones = await page.evaluate(previous => window.snapshot().nodes.filter(node => !previous.includes(node.id)), cardsBefore);
  await page.waitForFunction(ids => ids.every(id => document.querySelector(`[data-canvas-node-id="${id}"]`)?.getAttribute("aria-label")?.includes("已选中")), clones.map(node => node.id));
  assert.ok(Math.abs(Math.min(...clones.map(node => node.x)) - clickAnchor.x) < 1, JSON.stringify({ clones, clickAnchor }));
  assert.ok(Math.abs(Math.min(...clones.map(node => node.y)) - clickAnchor.y) < 1, JSON.stringify({ clones, clickAnchor }));
  assert.ok(Math.abs((clones[1].x - clones[0].x) - (copied[1].x - copied[0].x)) < 0.001);
  assert.ok(Math.abs((clones[1].y - clones[0].y) - (copied[1].y - copied[0].y)) < 0.001);
  assert.equal((await imports()).length, 3);

  // Plain text forms one editable content card at its own click; native Undo removes it.
  const message = "  原文首行\n第二行  ";
  const clickedText = await canvasPoint(0.46, 0.12);
  assert.equal(await paste("body", [], message), true);
  const textId = await page.waitForFunction(message => window.snapshot().nodes.find(node => node.kind === "note"
    && JSON.parse(node.payloadJson).cells?.[0]?.[0]?.text === message)?.id, message).then(handle => handle.jsonValue());
  assert.equal(await page.evaluate(id => JSON.parse(window.snapshot().nodes.find(node => node.id === id).payloadJson).text, textId), message);
  await assertCentered(textId, clickedText);
  const note = page.locator(`[data-canvas-node-id="${textId}"]`);
  await note.waitFor();
  assert.match(await note.getAttribute("class"), /is-content-card.*is-selected/);
  const shortcut = process.platform === "darwin" ? "Meta+z" : "Control+z";
  await page.keyboard.press(shortcut);
  await page.waitForFunction(id => window.snapshot().nodes.find(node => node.id === id)?.hiddenAt != null, textId);

  // Editing controls, dialogs and an already handled paste keep their owner.
  const count = (await imageCalls()).length;
  await page.evaluate(() => {
    const input = document.createElement("textarea"); input.id = "paste-editor"; document.querySelector(".canvas-stage").append(input);
    const editable = document.createElement("div"); editable.id = "paste-editable"; editable.contentEditable = "plaintext-only";
    document.querySelector(".canvas-stage").append(editable);
  });
  assert.equal(await paste("#paste-editor"), false);
  await page.locator("#paste-editor").focus();
  assert.equal(await paste("body", [], "保持编辑焦点"), false);
  await page.locator("#paste-editable").focus();
  assert.equal(await paste("body", [], "保留纯文本编辑器粘贴"), false);
  await page.evaluate(() => {
    document.querySelector("#paste-editor").remove();
    document.querySelector("#paste-editable").remove();
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
  await paste(".canvas-stage", ["recovery.png"]);
  await paste(".canvas-stage", ["second.png"]);
  await waitForAsset(3);
  const lastPastedImage = await waitForAsset(4);
  await lastPastedImage.and(selected).waitFor();
  assert.equal((await imports()).length, 5, "consecutive paste events each import once");

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

  await canvasPoint(0.17, 0.70);
  assert.equal(await paste("body", [["导入视频.mp4", "video/mp4"], ["导入音轨.wav", "audio/wav"]]), true);
  const video = await waitForAsset(6), audio = await waitForAsset(7);
  await video.getByRole("img", { name: "视频", exact: true }).waitFor();
  await audio.locator(".canvas-audio-waveform").waitFor();
  const placedMedia = await imports();
  assert.equal(placedMedia.length, 8, "files mirrored by items are imported only once");
  assert.deepEqual(placedMedia.slice(-2).map(({ asset, projectId }) => [asset.name, asset.ext, projectId]),
    [["导入视频.mp4", "mp4", "p"], ["导入音轨.wav", "wav", "p"]]);
  assert.deepEqual(await page.evaluate(() => window.mediaCalls.filter(call => call.command === "video_import_begin").map(({ args }) => [args.fileName, args.size, args.projectId])),
    [["导入视频.mp4", 3, "p"], ["导入音轨.wav", 3, "p"]]);
  await audio.and(selected).waitFor();
  await video.and(selected).waitFor();
  await page.keyboard.press(shortcut);
  await page.waitForFunction(() => ["media-6", "media-7"].every(id => window.snapshot().nodes.find(node => node.assetId === id)?.hiddenAt != null));
  assert.equal((await imports()).length, 8, "undo preserves library media");

  // A project switch during the image read/import cannot retarget the pending card.
  await page.evaluate(() => { window.holdMedia = true; });
  await paste(".canvas-stage", ["delayed.png"]);
  await page.waitForFunction(() => typeof window.releaseMedia === "function");
  await page.evaluate(() => {
    const state = window.store.getState();
    window.store.setState({ projects: [...state.projects, { ...state.projects[0], id: "q", name: "新项目" }], activeProjectId: "q", projectRouteRevision: state.projectRouteRevision + 1 });
    window.holdMedia = false; window.releaseMedia();
  });
  await page.waitForFunction(() => window.snapshot().nodes.some(node => node.assetId === "media-8"));
  assert.equal((await imports()).at(-1).projectId, "p");
  assert.equal(await page.evaluate(() => window.snapshot().nodes.find(node => node.assetId === "media-8").projectId), "p");
  assert.equal((await imports()).length, 9);

  // The main App still imports a screenshot on a non-canvas route.
  await page.goto("http://127.0.0.1:17930/scripts/fixtures/canvas-reference/preview.html?media-import&media-home&detail-route");
  await page.locator(".app-workspace").waitFor();
  assert.equal(await page.locator("[data-canvas-stage]").count(), 0);
  const homeNodes = await page.evaluate(() => window.snapshot().nodes.length);
  assert.equal(await paste("body", ["全局截图.png"], "", true), true);
  await page.getByText("剪贴板图片已加入素材库", { exact: true }).waitFor();
  assert.equal((await imports()).length, 1);
  assert.equal((await imports())[0].projectId, null);
  assert.equal(await page.evaluate(() => window.snapshot().nodes.length), homeNodes);
  assert.deepEqual(errors, []);
  console.log("PASS: canvas media and text paste, exact click and center placement, no duplicate import, internal card relocation, owner isolation, Undo, write retry, frozen project and App library fallback.");
} finally { await browser.close(); await server.close(); }
