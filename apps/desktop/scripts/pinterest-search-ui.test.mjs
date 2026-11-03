import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ cacheDir: ".tmp/pinterest-search-vite", server: { host: "127.0.0.1", port: 1818, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(7000);
const errors = []; page.on("pageerror", error => errors.push(error.message));
await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
const action = () => page.getByRole("menuitem", { name: "Pinterest 以图搜图", exact: true });
try {
  await mkdir(".tmp/pinterest-search", { recursive: true });
  await page.goto("http://127.0.0.1:1818/scripts/fixtures/asset-multi-menu/preview.html");
  await page.locator("#trigger").click();
  assert.equal(await action().count(), 1, "single image menu offers Pinterest image search");
  await action().click();
  const request = await page.evaluate(async () => (await import("/src/lib/pinterestSearch.ts")).usePinterestSearch.getState().request);
  assert.equal(request.assetId, "a1");
  assert.deepEqual(await page.evaluate(() => [...window.fixtureStore.getState().selectedIds]), ["unrelated"], "search does not change selection");
  for (const kind of ["multi", "canvas", "mixed"]) {
    await page.evaluate(kind => window.openMenu(kind), kind);
    await page.locator(".asset-context-menu").waitFor();
    await action().click();
    assert.equal(await page.evaluate(async () => (await import("/src/lib/pinterestSearch.ts")).usePinterestSearch.getState().request.assetId), "a1", "multiselect searches only the right-click target");
  }
  await page.evaluate(() => window.openMenu("video"));
  await page.locator(".asset-context-menu").waitFor();
  assert.equal(await action().count(), 0, "videos do not offer image search");
  await page.keyboard.press("Escape");

  // The real App must preserve the project, details, selection and canvas while opening exploration.
  await page.goto("http://127.0.0.1:1818/scripts/fixtures/canvas-reference/preview.html?source-library&detail-route&strict");
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(() => {
    const state = window.store.getState();
    state.assets.forEach(asset => { asset.ext = "png"; });
    window.beforeSearch = { projectId: state.activeProjectId, revision: state.projectRouteRevision };
    window.originalWorkspace = document.querySelector(".canvas-workspace");
    window.originalCamera = document.querySelector(".canvas-plane").getAttribute("style");
    window.store.setState({ selectedIds: new Set(["b", "c"]) });
    window.store.getState().openDetail("a");
  });
  const detailSearch = page.locator(".asset-detail").getByRole("button", { name: "Pinterest 以图搜图", exact: true });
  await detailSearch.click();
  const calls = command => page.evaluate(command => window.calls.filter(call => call.command === command), command);
  const waitStart = async count => page.waitForFunction(count => window.calls.filter(call => call.command === "start_pinterest_image_search").length === count, count);
  const emit = async (requestId, status, message) => page.evaluate(({ requestId, status, message }) => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "source-browser://pinterest-search", payload: { requestId, status, message } }), { requestId, status, message });
  await waitStart(1);
  let first = (await calls("start_pinterest_image_search"))[0].args;
  assert.equal(first.assetId, "a");
  assert.equal((await calls("open_source_browser"))[0].args.url, "https://www.pinterest.com/");
  assert.equal(await page.evaluate(() => window.calls.findIndex(call => call.command === "open_source_browser") < window.calls.findIndex(call => call.command === "start_pinterest_image_search")), true);
  assert.deepEqual(await page.evaluate(() => ({ projectId: window.store.getState().activeProjectId, revision: window.store.getState().projectRouteRevision })), await page.evaluate(() => window.beforeSearch));
  assert.deepEqual(await page.evaluate(() => [...window.store.getState().selectedIds]), ["b", "c"]);
  await emit(first.requestId, "waiting-login");
  await page.getByRole("status").filter({ hasText: "请在 Pinterest 登录" }).waitFor();
  assert.equal(await page.getByRole("status").filter({ hasText: "请在 Pinterest 登录" }).evaluate(element => {
    const reference = document.createElement("span"); reference.style.color = "var(--bb-muted)"; document.body.append(reference);
    const neutral = getComputedStyle(reference).color; reference.remove();
    return getComputedStyle(element).color === neutral;
  }), true, "waiting for login uses the neutral theme color");
  await emit(first.requestId, "searching");
  await page.getByRole("status").filter({ hasText: "正在搜索相似图片" }).waitFor();
  await emit(first.requestId, "submitted");
  await page.getByRole("status").filter({ hasText: "正在搜索相似图片" }).waitFor({ state: "hidden" });
  await emit(first.requestId, "preparing");
  assert.equal(await page.getByRole("status").filter({ hasText: "正在准备搜图" }).count(), 0, "terminal events cannot regress");
  await detailSearch.click(); await waitStart(2);
  const second = (await calls("start_pinterest_image_search"))[1].args;
  assert.notEqual(second.requestId, first.requestId, "repeated image searches get distinct identities");
  await emit(first.requestId, "error", "旧请求失败");
  assert.equal(await page.getByText("旧请求失败", { exact: true }).count(), 0);
  await emit(second.requestId, "waiting-login");
  await page.getByRole("button", { name: "收起浏览器", exact: true }).click();
  assert.equal((await calls("cancel_pinterest_image_search")).at(-1).args.requestId, second.requestId);
  await page.getByRole("button", { name: "探索", exact: true }).click();
  await page.waitForTimeout(150);
  assert.equal((await calls("start_pinterest_image_search")).length, 2, "reopening does not silently resubmit a cancelled image");
  for (const operation of ["花瓣", "返回上一页", "前往下一页", "刷新"]) {
    const before = (await calls("start_pinterest_image_search")).length;
    await detailSearch.click(); await waitStart(before + 1);
    const current = (await calls("start_pinterest_image_search")).at(-1).args;
    const button = operation === "刷新" ? page.locator('.source-browser-nav').getByRole("button", { name: operation, exact: true }) : page.getByRole("button", { name: operation, exact: true });
    await button.click();
    await page.waitForFunction(id => window.calls.some(call => call.command === "cancel_pinterest_image_search" && call.args.requestId === id), current.requestId);
  }
  const beforeRouteChange = (await calls("start_pinterest_image_search")).length;
  await detailSearch.click(); await waitStart(beforeRouteChange + 1);
  const changing = await page.evaluate(async () => (await import("/src/lib/pinterestSearch.ts")).usePinterestSearch.getState().request);
  await page.evaluate(() => window.store.setState(state => ({ projectRouteRevision: state.projectRouteRevision + 1 })));
  await page.waitForFunction(id => window.calls.some(call => call.command === "cancel_pinterest_image_search" && call.args.requestId === id), changing.requestId);
  await emit(changing.requestId, "searching");
  assert.equal(await page.getByRole("status").filter({ hasText: "正在搜索相似图片" }).count(), 0);
  // Cancelling must reach native code even while image preparation has not returned.
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const result = await invoke(command, args);
      if (command === "start_pinterest_image_search" && window.holdPinterest) await new Promise((resolve, reject) => { window.releasePinterest = resolve; window.rejectPinterest = reject; });
      return result;
    };
    window.holdPinterest = true;
  });
  await detailSearch.click();
  await page.waitForFunction(() => window.releasePinterest);
  const slow = (await calls("start_pinterest_image_search")).at(-1).args;
  const hidesBeforeClose = (await calls("hide_source_browser")).length;
  await page.getByRole("button", { name: "收起浏览器", exact: true }).click();
  await page.waitForFunction(id => window.calls.some(call => call.command === "cancel_pinterest_image_search" && call.args.requestId === id), slow.requestId);
  await page.waitForFunction(count => window.calls.filter(call => call.command === "hide_source_browser").length > count, hidesBeforeClose);
  await page.evaluate(() => { window.holdPinterest = false; window.rejectPinterest("迟到的图片读取失败"); });
  assert.equal(await page.getByText("迟到的图片读取失败", { exact: true }).count(), 0);
  await page.evaluate(() => { window.holdPinterest = true; window.releasePinterest = null; });
  await detailSearch.click();
  await page.waitForFunction(() => window.releasePinterest);
  const navigationsBeforeClick = (await calls("navigate_source_browser")).length;
  await page.getByRole("button", { name: "花瓣", exact: true }).click();
  await page.waitForFunction(count => window.calls.filter(call => call.command === "navigate_source_browser").length > count, navigationsBeforeClick);
  assert.equal((await calls("navigate_source_browser")).at(-1).args.url, "https://huaban.com/", "manual navigation is not blocked by image preparation");
  await page.evaluate(() => { window.holdPinterest = false; window.releasePinterest(); });
  const beforeError = (await calls("start_pinterest_image_search")).length;
  await detailSearch.click(); await waitStart(beforeError + 1);
  const failed = (await calls("start_pinterest_image_search")).at(-1).args;
  await emit(failed.requestId, "error", "TypeError: blocked at C:/private/image.png");
  await page.getByRole("alert").filter({ hasText: "以图搜图暂时无法完成，请重试。" }).waitFor();
  assert.equal(await page.getByText("C:/private/image.png", { exact: false }).count(), 0);
  await emit(failed.requestId, "waiting-login");
  assert.equal(await page.getByRole("status").filter({ hasText: "请在 Pinterest 登录" }).count(), 0, "a failed request cannot restart itself");
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: `.tmp/pinterest-search/${theme}.png` });
  }
  await page.setViewportSize({ width: 1000, height: 760 });
  const buttonBounds = await detailSearch.boundingBox();
  assert.ok(buttonBounds.x >= 0 && buttonBounds.x + buttonBounds.width <= 1000 && buttonBounds.height >= 30, "search remains reachable beside exploration in a narrow window");
  await page.screenshot({ path: ".tmp/pinterest-search/narrow.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "收起浏览器", exact: true }).click();
  await page.locator(".asset-detail").getByRole("button", { name: "返回", exact: true }).click();
  await page.locator(".asset-detail").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.originalWorkspace.isConnected), true, "the project canvas stays mounted during image search");
  assert.equal(await page.evaluate(() => document.querySelector(".canvas-plane").getAttribute("style")), await page.evaluate(() => window.originalCamera), "returning retains the canvas camera");

  // Connected reference entries search the underlying asset, without changing the selected files.
  await page.goto("http://127.0.0.1:1818/scripts/fixtures/connected-collections/preview.html");
  await page.locator('[data-collection-id="child"]').click();
  const reference = page.locator('[data-connection-entry="ref-two"] .folder-media-card');
  const other = page.locator('[data-connection-entry="child-0"] .folder-media-card');
  await other.click({ modifiers: ["Control"] });
  await reference.click({ modifiers: ["Control"] });
  await reference.click({ button: "right" });
  await action().click();
  assert.equal(await page.evaluate(async () => (await import("/src/lib/pinterestSearch.ts")).usePinterestSearch.getState().request.assetId), "root-0");
  assert.equal(await reference.getAttribute("aria-pressed"), "true");
  assert.equal(await other.getAttribute("aria-pressed"), "true");
  assert.deepEqual(errors, []);
  console.log("PASS Pinterest detail, ordinary/multi/connected menus, retained route/selection, login status, one-shot submission, cancellation, stale events and themes");
} catch (error) {
  await page.screenshot({ path: ".tmp/pinterest-search/failure.png" });
  throw error;
} finally { await browser.close(); await server.close(); }
