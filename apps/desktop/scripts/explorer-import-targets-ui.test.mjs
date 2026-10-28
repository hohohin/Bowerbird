import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 17932, strictPort: true, hmr: false, watch: null } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(10000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("https://image.test/**", route => route.fulfill({ contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="240"><rect width="200" height="240" fill="#4868ff"/></svg>' }));
  await page.goto("http://127.0.0.1:17932/scripts/fixtures/explorer/preview.html");
  await page.getByRole("button", { name: "探索", exact: true }).click();
  await page.evaluate(() => {
    window.store.setState({ activeProjectId: "p", projects: ["p", "q"].map(id => ({ id, name: id, kind: "blank" })) });
    const root = document.createElement("div"); root.dataset.projectDropId = "p";
    root.innerHTML = '<div id="drop-global" data-file-import-project-id=""><span>全局素材库</span></div>'
      + '<div id="drop-unready" data-canvas-stage><span>尚未就绪的画布</span></div>'
      + '<div id="drop-project" data-file-import-project-id="p"><span>项目素材库</span></div>'
      + '<div id="drop-other" data-project-drop-id="q"><span>另一项目</span></div>'
      + '<div id="drop-collection" data-file-import-project-id="" data-file-import-collection-id="collection-first"><span>集合</span></div>';
    document.querySelector(".explore-main").append(root);
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "set_collection_members") {
        window.calls.push({ command, args });
        if (window.failMembers) throw new Error("collection membership failed");
        return null;
      }
      return invoke(command, args);
    };
  });
  const dragId = value => value.toString(16).padStart(32, "0");
  const calls = command => page.evaluate(command => window.calls.filter(call => call.command === command), command);
  const settled = () => page.locator(".explore-capture-status").waitFor({ state: "detached" });
  const card = value => page.locator(`[data-classification-id^="${dragId(value)}:"]`);
  async function drop(selector, value) {
    await page.locator(`${selector} span`).evaluate((element, id) => {
      const bounds = element.getBoundingClientRect(), dataTransfer = new DataTransfer();
      dataTransfer.setData("application/x-bowerbird-explorer", JSON.stringify({ version: 1, dragId: id,
        imageUrl: `https://image.test/${id}.png`, pageUrl: "https://www.pinterest.com/pin/1" }));
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer,
        clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 }));
    }, dragId(value));
  }
  async function release() {
    await page.evaluate(() => { window.hold = false; window.release(); window.release = null; });
    await settled();
  }
  // A global drawer inside a project imports globally and still shows local feedback.
  await drop("#drop-global", 1); await settled();
  assert.equal((await calls("capture_source_browser_image")).at(-1).args.projectId, null);
  await page.locator(".explorer-capture-feedback").getByText("已采集", { exact: true }).waitFor();
  await drop("#drop-project", 2); await settled();
  assert.equal((await calls("capture_source_browser_image")).at(-1).args.projectId, "p");
  await drop("#drop-other", 3); await settled();
  assert.equal((await calls("capture_source_browser_image")).at(-1).args.projectId, "q");
  await page.locator(".explorer-capture-feedback").getByText("已采集", { exact: true }).waitFor();
  assert.equal((await calls("project_canvas_node_create")).length, 0);

  // Freeze collection membership before asynchronous capture; keep classification in the visible route.
  await page.evaluate(() => { window.hold = true; window.analyse = true; window.holdAnalysis = true; });
  await drop("#drop-collection", 4);
  await page.waitForFunction(() => window.release); await card(4).waitFor();
  await page.evaluate(() => { document.querySelector("#drop-collection").dataset.fileImportCollectionId = "collection-second"; });
  await release();
  assert.equal((await calls("capture_source_browser_image")).at(-1).args.projectId, null);
  assert.deepEqual((await calls("set_collection_members")).at(-1).args, { id: "collection-first", assetIds: ["captured"], added: true });
  await page.waitForFunction(id => window.analysisResolvers[id], dragId(4));
  await page.evaluate(id => window.analysisResolvers[id].resolve(["插画"]), dragId(4));
  await page.waitForFunction(id => document.querySelector(`[data-classification-id^="${id}:"]`)?.dataset.outcome === "matched", dragId(4));

  // Navigating away does not retarget the in-flight collection or resurrect classification there.
  await page.evaluate(() => { window.hold = true; });
  await drop("#drop-collection", 5);
  await page.waitForFunction(() => window.release); await card(5).waitFor();
  await page.evaluate(() => {
    window.store.setState({ activeProjectId: "q", projectRouteRevision: 1 });
    document.querySelector("#drop-collection").dataset.fileImportCollectionId = "collection-third";
  });
  await card(5).waitFor({ state: "detached" }); await release();
  assert.equal((await calls("set_collection_members")).at(-1).args.id, "collection-second");
  await page.waitForFunction(id => window.analysisResolvers[id], dragId(5));
  await page.evaluate(id => window.analysisResolvers[id].resolve(["插画"]), dragId(5));
  assert.equal(await card(5).count(), 0);

  // A missing collection reports the partial import and releases the pending analysis.
  await page.evaluate(() => { window.failMembers = true; });
  await drop("#drop-collection", 6); await settled();
  await page.getByText("图片已入库，但加入集合失败，请重新添加", { exact: true }).waitFor();
  assert.equal((await calls("finish_source_browser_analysis")).filter(call => call.args.dragId === dragId(6)).length, 0);
  assert.equal((await calls("release_source_browser_analysis")).filter(call => call.args.dragId === dragId(6)).length, 1);
  assert.equal(await card(6).count(), 0);
  const captures = (await calls("capture_source_browser_image")).length;
  await drop("#drop-unready", 7); await settled();
  await page.getByText("画布尚未准备好，请稍后重新拖入", { exact: true }).waitFor();
  assert.equal((await calls("capture_source_browser_image")).length, captures);
  assert.deepEqual(errors, []);
  console.log("PASS explorer import destinations: global/project/other project, collection freeze, visible feedback and classification, navigation isolation and membership failure cleanup.");
} finally { await browser?.close(); await server.close(); }
