import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ cacheDir: ".tmp/composer-video-pick/vite", server: { host: "127.0.0.1", port: 17964, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 960 } });
page.setDefaultTimeout(12000);
const errors = [];
page.on("pageerror", e => errors.push(e.message));
const dock = page.locator(".creation-dock");
const editor = dock.locator(".ProseMirror");
const path = "/src-tauri/tests/fixtures/media/fragmented.mp4";
async function selectMode(name) {
  await editor.click();
  await dock.getByRole("button", { name, exact: true }).click();
  await editor.click();
}
async function assertPicked(target, id) {
  await target.dblclick();
  await editor.locator(`[data-media-kind="video"][data-asset-id="${id}"]`).waitFor();
  await page.waitForTimeout(550);
  assert.equal(await editor.locator('[data-media-kind="video"]').count(), 1);
  assert.equal(await page.locator(".media-lightbox,.creation-image-preview").count(), 0);
}
try {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-reference/preview.html`);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(path => {
    const snapshot = window.snapshot();
    const asset = { id: "pick-video", name: "镜头.mp4", ext: "mp4", store_path: path, duration: 4, width: 240, height: 160 };
    const base = snapshot.nodes[0];
    snapshot.nodes = [{ ...base, id: "source-video", assetId: asset.id, x: 180, y: 140,
      payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: asset.name, width: 240, height: 160 } }) }];
    snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 1 };
    sessionStorage.setItem("reference-drafts", JSON.stringify([asset]));
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  }, path);
  await page.reload();
  const videoCard = page.locator('[data-canvas-node-id="source-video"]');
  await videoCard.waitFor();
  await selectMode("视频");
  await assertPicked(videoCard, "pick-video");
  await videoCard.click();
  await page.locator(".media-lightbox video").waitFor();
  await page.keyboard.press("Escape");
  await selectMode("对话");
  assert.equal(await editor.locator('[data-media-kind="video"]').count(), 0);
  await assertPicked(videoCard, "pick-video");
  await selectMode("图片");
  await videoCard.click();
  await page.locator(".media-lightbox video").waitFor();
  assert.equal(await editor.locator('[data-media-kind="video"]').count(), 0);
  await page.keyboard.press("Escape");

  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/library-generation-live/preview.html?source-library&detail-route&canvas-library`);
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  const homeId = await page.evaluate(path => {
    const first = window.store.getState().assets[0];
    Object.assign(first, { store_path: path, ext: "mp4", name: "素材库镜头.mp4", duration: 4 });
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "local_chat_models") return [];
      if (command === "local_chat_send") {
        window.chatInput = args.input;
        return { id: "chat", projectId: args.input.projectId, threadId: "thread", nodeId: "node", provider: "codex-local", status: "idle", title: "对话", revision: 1, messages: [], turns: [], actions: [] };
      }
      return original(command, args);
    };
    return first.id;
  }, path);
  await page.getByRole("button", { name: "返回主页", exact: true }).click();
  await page.waitForFunction(() => window.store.getState().activeProjectId === null);
  await page.evaluate(() => window.store.getState().setLibraryHomeView("library"));
  await page.getByRole("region", { name: "素材库创作", exact: true }).waitFor();
  await page.locator(".library-home").getByRole("tab", { name: "全部素材", exact: true }).first().click();
  await page.evaluate(() => window.mode.getState().setMedia("all"));
  const libraryVideo = page.locator(`.library-home [data-asset-id="${homeId}"]`).first();
  await selectMode("视频");
  await editor.fill("延续镜头运动");
  await assertPicked(libraryVideo, homeId);
  await dock.locator(".composer-send button").click();
  await page.waitForFunction(() => window.generationCalls.length === 1);
  const request = await page.evaluate(() => window.generationCalls[0]);
  assert.deepEqual(request.referenceImages, [path]);
  assert.equal(request.videoOptions.kind, "multimodal2video");
  await selectMode("对话");
  await editor.fill("把这个视频作为下一张卡片的参考");
  await assertPicked(libraryVideo, homeId);
  await dock.locator(".composer-send button").click();
  await page.waitForFunction(() => !!window.chatInput);
  assert.deepEqual(await page.evaluate(() => window.chatInput.referenceAssetIds), [homeId]);
  assert.deepEqual(errors, []);
  console.log("PASS: dashboard and canvas video/chat double click, exactly one video, ordinary playback, isolated drafts and submitted chat asset ID");
} catch (error) {
  console.error("UI state", await page.evaluate(() => ({ project: window.store?.getState().activeProjectId,
    home: window.store?.getState().libraryHomeView, view: document.body.innerText.slice(0, 320) })), errors);
  throw error;
} finally {
  await browser.close();
  await server.close();
}
