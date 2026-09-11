import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1573, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.route("**/reliability-test", route => route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }));
  await page.addInitScript(() => { window.__TAURI_INTERNALS__ = { invoke: async () => null, transformCallback: () => 1 }; });
  const mount = async () => page.evaluate(async () => {
    const [{ useStore }, { api }, { default: React }, { default: { createRoot } }, { Toolbar }, { ToastViewport }] = await Promise.all([
      import("/src/store.ts"), import("/src/lib/api.ts"), import("/node_modules/.vite/deps/react.js"),
      import("/node_modules/.vite/deps/react-dom_client.js"), import("/src/components/Toolbar.tsx"), import("/src/components/ToastViewport.tsx"),
    ]);
    await import("/src/styles.css");
    window.store = useStore;
    window.notices = []; window.refreshes = 0; window.mode = "empty";
    window.addEventListener("bowerbird://notify", event => window.notices.push(event.detail));
    api.pickImageFiles = async () => window.mode === "cancel" ? [] : ["first.png", "second.png"];
    api.importFiles = async () => window.mode === "empty" ? [] : [{ id: "first" }];
    api.pickFolder = async () => "empty-folder";
    api.importFolder = async () => 0;
    useStore.setState({ settings: { library_root: "synthetic-reliability" }, cloudAuth: null,
      activeProjectId: null, projectRoutePending: false, projects: [], genJobs: {}, genJobOrder: [],
      cloudAgentRuns: { accepted: { runId: "accepted", status: "succeeded", feedbackAction: "accept",
        intentPrompt: "测试持久化提醒", projectId: "p", threadId: "t", finalAssetId: "a", updatedAt: 1,
        snapshot: { run: {}, artifacts: [{ id: "final", role: "final_result", mime: "image/png", sha256: "sha", user_visible: true, downloaded_at: null }] } } },
      cloudAgentRunOrder: ["accepted"],
    });
    document.body.innerHTML = '<div id="test"></div>';
    createRoot(document.getElementById("test")).render(React.createElement(React.Fragment, null,
      React.createElement(Toolbar, { onRefresh: async () => { window.refreshes++; }, canvasMode: false,
        onCanvasModeChange: () => {}, onCreateCreative: () => {} }), React.createElement(ToastViewport)));
  });
  await page.goto("http://127.0.0.1:1573/reliability-test");
  await mount();
  const importFiles = async () => {
    await page.locator("[data-import-trigger]").click();
    await page.getByRole("menuitem", { name: "导入图片", exact: true }).click();
    await page.waitForFunction(() => !window.store.getState().loading);
  };
  await importFiles();
  assert.deepEqual(await page.evaluate(() => window.notices.map(n => n.tone)), ["error"]);
  assert.equal(await page.evaluate(() => window.refreshes), 0);
  await page.evaluate(() => { window.notices = []; window.mode = "partial"; window.store.setState({ searchQuery: "hidden filter" }); });
  await importFiles();
  assert.deepEqual(await page.evaluate(() => window.notices.map(n => n.tone)), ["error", "success"]);
  assert.equal(await page.evaluate(() => window.store.getState().searchQuery), "");
  await page.evaluate(() => { window.notices = []; window.mode = "cancel"; });
  await importFiles();
  assert.equal(await page.evaluate(() => window.notices.length), 0);
  await page.locator("[data-import-trigger]").click();
  await page.getByRole("menuitem", { name: "导入文件夹", exact: true }).click();
  await page.waitForFunction(() => !window.store.getState().loading);
  assert.deepEqual(await page.evaluate(() => window.notices.map(n => n.tone)), ["error"]);
  await page.locator(".task-center-trigger").click();
  await page.getByRole("dialog", { name: "任务中心" }).waitFor();
  await page.getByRole("button", { name: "清除 Agent 任务提醒 测试持久化提醒", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "清除 Agent 任务提醒 测试持久化提醒", exact: true }).count(), 0);
  assert.ok(await page.evaluate(() => window.store.getState().cloudAgentRuns.accepted));
  await page.reload(); await mount();
  await page.locator(".task-center-trigger").click();
  assert.equal(await page.getByRole("button", { name: "清除 Agent 任务提醒 测试持久化提醒", exact: true }).count(), 0);

  await page.goto("http://127.0.0.1:1573/scripts/fixtures/canvas-reference/preview.html");
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.waitForTimeout(400);
  const handle = page.getByRole("separator", { name: "调整素材面板宽度" });
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 200); await page.mouse.down();
  await page.waitForTimeout(150);
  const before = await page.evaluate(() => window.canvasCommits);
  await page.mouse.move(box.x + 100, box.y + 200, { steps: 35 });
  const during = await page.evaluate(() => window.canvasCommits);
  assert.ok(during - before < 12, `drag must not rerender the canvas for every pointer move: ${during - before}`);
  const width = await page.locator(".canvas-source-panel").evaluate(el => el.getBoundingClientRect().width);
  assert.ok(width > 380);
  await page.mouse.up();
  await page.waitForFunction(expected => Math.abs(window.snapshot().view.sourcePanelWidth - expected) < 1, width);
  await page.evaluate(() => window.save());
  await page.reload(); await page.locator('[data-canvas-node-id="old"]').waitFor();
  assert.ok(Math.abs(await page.locator(".canvas-source-panel").evaluate(el => el.getBoundingClientRect().width) - width) < 1);
  assert.deepEqual(errors, []);
  console.log(`PASS: empty/partial/cancelled imports, filters, persistent Agent reminder dismissal, resize (${during - before} commits / 35 moves) and saved width.`);
} finally { await browser.close(); await server.close(); }
