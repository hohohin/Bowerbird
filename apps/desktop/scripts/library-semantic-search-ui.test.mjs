import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const output = ".tmp/library-semantic-search-ui";
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1120, height: 760 }, reducedMotion: "reduce" });
page.setDefaultTimeout(9000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
await page.addInitScript(() => {
  window.total = 170;
  window.semanticModelState = "missing";
  window.semanticIndexState = "off";
  window.questions = new Map();
  window.answers = new Map();
  window.semanticInvoke = async (command, args) => {
    if (command === "semantic_status") return {
      supported: true, libraryId: "test-library", activeModelKey: "fixture", modelState: window.semanticModelState,
      indexState: window.semanticIndexState, operationId: null, indexRevision: 1, backfillComplete: false,
      eligible: 170, indexed: 130, pending: 40, auditing: 0, unavailable: 0, unsupported: 0, failed: 0, lastError: null,
      downloadBytes: 1_503_000_000, installedBytes: 0, downloadedBytes: 100, totalBytes: 200,
      ...window.semanticStatusOverride,
    };
    if (command === "semantic_model_control") { window.semanticModelState = args.action === "cancel" ? "missing" : "downloading"; return { operationId: "install" }; }
    if (command === "semantic_index_control") { window.semanticIndexState = args.action === "pause" ? "paused" : "running"; return { operationId: "index" }; }
    if (command === "semantic_search_start") {
      const scopeSize = args.filter.projectId ? Math.min(window.total, 120) : window.total;
      return new Promise(resolve => window.questions.set(args.text, (ids, { eligible = scopeSize, indexed = eligible, truncated = false } = {}) => {
        window.answers.set(args.text, ids);
        resolve({ requestId: args.requestId, sessionId: args.text, libraryId: "test-library", modelKey: "fixture", indexRevision: 1,
          eligible, indexed, resultCount: ids.length, truncated });
      }));
    }
    if (command === "semantic_search_cancel") return;
    if (window.invalidateSemanticPage) throw "stale_session";
    const ids = window.answers.get(args.sessionId).slice(args.offset, args.offset + args.limit);
    if (command === "semantic_search_ids") return ids;
    if (command === "semantic_search_page") return ids.map(id => ({ asset: { id, name: `${id}.jpg`, ext: "jpg", source: "imported", width: 320, height: 240, store_path: `/${id}.jpg` }, score: 0.6 }));
    throw new Error(command);
  };
});

const fixture = `${server.resolvedUrls.local[0]}scripts/fixtures/catalog-paging/preview.html`;
const pane = () => page.locator(".categorized-library");
const scroller = () => pane().locator(".catalog-scroller");
const dialog = () => page.getByRole("dialog", { name: "以文搜图", exact: true });
const entry = () => pane().getByRole("button", { name: "以文搜图", exact: true });
const field = () => dialog().getByRole("textbox", { name: "描述想找的图片" });
const view = name => page.getByRole("tablist", { name: "素材视图切换条", exact: true }).getByRole("tab", { name, exact: true });
const click = name => dialog().getByRole("button", { name, exact: true }).click();
const card = id => pane().locator(`[data-asset-id="${id}"]`);
async function open(host = pane()) {
  const overflow = host.getByRole("button", { name: "更多素材库控件" });
  const search = host.getByRole("button", { name: "以文搜图", exact: true });
  await search.or(overflow).first().waitFor();
  if (await overflow.isVisible() && await overflow.getAttribute("aria-expanded") !== "true") await overflow.click();
  try { await search.click({ timeout: 2000 }); }
  catch (error) {
    if (!await overflow.isVisible() || await overflow.getAttribute("aria-expanded") === "true") throw error;
    await overflow.click();
    await search.click();
  }
  await dialog().waitFor();
}
async function submit(value) {
  await field().fill(value);
  await field().press("Enter");
  await page.waitForFunction(value => window.questions.has(value), value);
}
const answer = (text, ids, counts) => page.evaluate(({ text, ids, counts }) => window.questions.get(text)(ids, counts), { text, ids, counts });

try {
  await mkdir(output, { recursive: true });
  await page.goto(`${fixture}?navigation&home`);
  await pane().locator("[data-asset-id]").first().waitFor();
  assert.equal(await entry().count(), 0, "shared editor-equivalent caller remains opt-out");
  await page.goto(`${fixture}?navigation&home&semantic`);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await pane().locator("[data-asset-id]").first().waitFor();
  const layout = await pane().locator(".catalog-body").boundingBox();
  await open();
  await dialog().getByText("全部素材", { exact: true }).waitFor();
  await dialog().getByText(/1.5 GB/).waitFor();
  assert.deepEqual(await pane().locator(".catalog-body").boundingBox(), layout, "search overlay does not reserve gallery space");
  await page.screenshot({ path: `${output}/setup-dark.png` });
  await click("下载模型");
  await dialog().getByRole("progressbar", { name: "下载进度" }).waitFor();
  await click("取消下载");
  await dialog().getByRole("button", { name: "下载模型", exact: true }).waitFor();
  async function repairFailure(modelError) {
    await page.evaluate(async modelError => {
      window.semanticModelState = "corrupt";
      window.semanticStatusOverride = { modelError };
      window.emitFixtureEvent("semantic://progress", await window.semanticInvoke("semantic_status", {}));
    }, modelError);
    await dialog().getByRole("button", { name: "重新下载", exact: true }).waitFor();
  }
  await repairFailure("download_failed");
  await dialog().getByRole("alert").getByText("搜图模型下载失败，请检查网络后重试。", { exact: true }).waitFor();
  await click("重新下载");
  await dialog().getByRole("progressbar", { name: "下载进度" }).waitFor();
  await repairFailure("disk_full");
  await dialog().getByRole("alert").getByText("磁盘空间不足，请释放空间后重试。", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "hidden" });
  assert.ok(await entry().evaluate(element => document.activeElement === element));

  await page.evaluate(() => { window.semanticModelState = "ready"; window.semanticStatusOverride = undefined; });
  await scroller().evaluate(el => { el.scrollTop = 1100; });
  const top = await scroller().evaluate(el => el.scrollTop);
  assert.ok(top > 500);
  await open();
  await click("建立索引");
  await dialog().getByText("正在建立索引", { exact: true }).waitFor();
  await click("暂停索引");
  await dialog().getByText("索引已暂停", { exact: true }).waitFor();
  await click("继续索引");
  await dialog().getByText("正在建立索引", { exact: true }).waitFor();
  const showProgress = status => page.evaluate(async status => {
    window.semanticStatusOverride = status;
    window.emitFixtureEvent("semantic://progress", await window.semanticInvoke("semantic_status", {}));
  }, status);
  await showProgress({ backfillComplete: true, eligible: 1, indexed: 0, pending: 0, unavailable: 1 });
  await dialog().getByText("已索引 0 / 可索引 1 张", { exact: true }).waitFor();
  await dialog().getByText("1 张图片暂时不可用，可用后会重新检查。", { exact: true }).waitFor();
  await showProgress({ backfillComplete: true, eligible: 1, indexed: 1, pending: 0, auditing: 1 });
  await dialog().getByText("已索引 1 / 可索引 1 张", { exact: true }).waitFor();
  await dialog().getByText("正在核对 1 张已索引图片。", { exact: true }).waitFor();
  await showProgress({ backfillComplete: true, eligible: 170, indexed: 170, pending: 0 });

  await field().fill("中文输入");
  await field().dispatchEvent("compositionstart");
  await field().press("Enter");
  assert.equal(await page.evaluate(() => window.questions.size), 0, "IME confirmation must not send a search");
  await field().dispatchEvent("compositionend");
  await submit("没有可索引图片");
  await answer("没有可索引图片", [], { eligible: 0 });
  const noEligible = "当前范围内没有可索引的图片。";
  await dialog().getByText(noEligible, { exact: true }).waitFor();
  await pane().getByText(noEligible, { exact: true }).waitFor();
  await submit("尚未索引");
  await answer("尚未索引", [], { indexed: 0 });
  const notIndexed = "当前范围内还没有已索引的图片。";
  await dialog().getByText(notIndexed, { exact: true }).waitFor();
  await pane().getByText(notIndexed, { exact: true }).waitFor();
  await showProgress({ backfillComplete: true, eligible: 170, indexed: 120, pending: 50 });
  await submit("部分索引时未找到匹配");
  await answer("部分索引时未找到匹配", [], { indexed: 120, truncated: true });
  const partialNoMatch = "在已索引的 120 张图片中未找到匹配。当前范围有 170 张可索引图片。描述较长，已按部分描述搜索。";
  await dialog().getByText(partialNoMatch, { exact: true }).waitFor();
  await pane().getByText(partialNoMatch, { exact: true }).waitFor();
  await showProgress({ backfillComplete: true, eligible: 170, indexed: 170, pending: 0 });
  await submit("小鸟");
  await answer("小鸟", []);
  const noMatch = "在已索引的 170 张图片中未找到匹配。";
  await dialog().getByText(noMatch, { exact: true }).waitFor();
  await pane().getByText(noMatch, { exact: true }).waitFor();
  assert.equal(await pane().locator("[data-asset-id]").count(), 0, "a zero-match search must not fall back to browsing indexed images");
  await page.evaluate(() => window.emitFixtureEvent("library://assets-changed", null));
  await page.waitForFunction(() => window.requests.some(request => request.command === "semantic_search_ids" && request.args.sessionId === "小鸟" && request.args.limit === 1));
  assert.equal(await pane().locator("[data-asset-id]").count(), 0, "refresh preserves the frozen empty session");

  await submit("先发");
  await submit("后发");
  const latest = Array.from({ length: 65 }, (_, index) => `hit-${index}`);
  await answer("后发", latest);
  await dialog().getByText("显示 65 张匹配图片", { exact: true }).waitFor();
  await card("hit-0").waitFor();
  assert.equal(await pane().locator('[data-asset-id^="asset-"]').count(), 0, "results contain only matching IDs");
  await answer("先发", ["slow-only"]);
  await page.waitForFunction(() => window.requests.some(request => request.command === "semantic_search_cancel" && request.args.sessionId === "先发"));
  assert.equal(await card("slow-only").count(), 0);
  await card("hit-0").focus();
  await page.keyboard.press("Control+a"); // Popup still owns keyboard shortcuts.
  assert.equal(await page.evaluate(() => window.requests.some(request => request.command === "semantic_search_ids" && request.args.sessionId === "后发")), false);
  await card("hit-0").click({ modifiers: ["Control"] });
  await dialog().waitFor({ state: "hidden" });
  await pane().getByRole("button", { name: "全选", exact: true }).click();
  await pane().getByText("65 项", { exact: true }).waitFor();
  const idPages = await page.evaluate(() => window.requests.filter(request => request.command === "semantic_search_ids" && request.args.sessionId === "后发").map(request => request.args));
  assert.deepEqual(idPages, [{ sessionId: "后发", offset: 0, limit: 60 }, { sessionId: "后发", offset: 60, limit: 5 }]);
  const resultPages = await page.evaluate(() => window.requests.filter(request => request.command === "semantic_search_page").map(request => request.args.sessionId));
  assert.ok(resultPages.length > 0 && resultPages.every(id => id === "后发"), "matching cards and selection are read from the same session");
  const rankedTop = await scroller().evaluate(el => el.scrollTop);
  await page.evaluate(() => window.emitFixtureEvent("library://assets-changed", null));
  await page.waitForFunction(() => window.requests.some(request => request.command === "semantic_search_ids" && request.args.sessionId === "后发" && request.args.limit === 1));
  await pane().getByText("65 项", { exact: true }).waitFor();
  assert.equal(await scroller().evaluate(el => el.scrollTop), rankedTop);
  assert.ok(await card("hit-0").isVisible(), "unrelated catalog change retains a valid ranking and selection");
  await page.keyboard.press("Escape");
  await page.waitForFunction(top => Math.abs(document.querySelector(".catalog-scroller").scrollTop - top) < 4, top);
  assert.ok(await entry().evaluate(element => document.activeElement === element));

  await page.evaluate(() => window.mode.getState().setQuery("small"));
  await open();
  await field().fill("图".repeat(513));
  await dialog().getByRole("alert").getByText("描述最多可输入 512 个字符。").waitFor();
  assert.equal(await dialog().getByRole("button", { name: "搜索", exact: true }).isEnabled(), false);
  await submit("保留名称筛选");
  assert.equal(await page.evaluate(() => window.requests.find(request => request.command === "semantic_search_start" && request.args.text === "保留名称筛选").args.filter.query), "small");
  await answer("保留名称筛选", ["deleted-later"]);
  await card("deleted-later").waitFor();
  await page.evaluate(() => { window.invalidateSemanticPage = true; window.emitFixtureEvent("library://assets-changed", null); });
  await card("deleted-later").waitFor({ state: "detached" });
  await dialog().getByRole("alert").getByText("索引或素材范围已有变化，请重新搜索。", { exact: true }).waitFor();
  await page.waitForFunction(() => window.requests.some(request => request.command === "semantic_search_cancel" && request.args.sessionId === "保留名称筛选"));
  await page.evaluate(() => { window.invalidateSemanticPage = false; window.mode.getState().setQuery(""); });

  await open();
  await submit("离开范围");
  await view("标签分类").click();
  await entry().waitFor({ state: "hidden" });
  await answer("离开范围", ["old-scope"]);
  await page.waitForFunction(() => window.requests.some(request => request.command === "semantic_search_cancel" && request.args.sessionId === "离开范围"));
  assert.equal(await card("old-scope").count(), 0);

  await page.setViewportSize({ width: 460, height: 720 });
  await page.goto(`${fixture}?navigation&semantic`);
  await view("项目素材").click();
  await pane().locator("[data-asset-id]").first().waitFor();
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; window.semanticModelState = "ready"; window.semanticIndexState = "running"; });
  await open();
  await dialog().getByText("项目素材 / 项目A", { exact: true }).waitFor();
  await submit("项目图片");
  await answer("项目图片", ["project-only"]);
  await card("project-only").waitFor();
  const projectRequest = await page.evaluate(() => window.requests.find(request => request.command === "semantic_search_start").args);
  assert.equal(projectRequest.filter.projectId, "p");
  assert.equal(projectRequest.filter.media, "images");
  assert.equal(projectRequest.filter.query, "");
  assert.equal(projectRequest.topK, 240);
  const box = await dialog().boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 460);
  await page.screenshot({ path: `${output}/result-light-narrow.png` });
  await submit("过期");
  await page.evaluate(() => { window.invalidateSemanticPage = true; });
  await answer("过期", ["expired-result"]);
  await dialog().getByRole("alert").getByText("索引或素材范围已有变化，请重新搜索。", { exact: true }).waitFor();
  assert.equal(await card("expired-result").count(), 0);

  await page.setViewportSize({ width: 1360, height: 760 });
  await page.goto(`${fixture}?split`);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await view("全部素材").click();
  await page.getByRole("button", { name: "向右分栏" }).click();
  await page.evaluate(() => { window.semanticModelState = "ready"; window.semanticIndexState = "running"; });
  for (const [index, text] of ["左栏", "右栏"].entries()) {
    const host = page.locator(".library-split-pane").nth(index);
    await open(host);
    const overlay = await dialog().boundingBox();
    const partition = await host.boundingBox();
    assert.ok(overlay.x >= partition.x && overlay.x + overlay.width <= partition.x + partition.width);
    await submit(text);
    await answer(text, [`result-${index}`]);
    await host.locator(`[data-asset-id="result-${index}"]`).waitFor();
  }
  const paneIds = await page.evaluate(() => window.requests.filter(request => request.command === "semantic_search_start").map(request => request.args.paneId));
  assert.equal(new Set(paneIds).size, 2);
  assert.equal(await page.locator(".library-split-pane").first().locator('[data-asset-id="result-0"]').count(), 1);
  assert.equal(await page.locator(".library-split-pane").first().locator('[data-asset-id="result-1"]').count(), 0);
  await page.locator(".library-split-pane").last().locator('[data-asset-id="result-1"]').click({ modifiers: ["Control"] });
  await dialog().waitFor({ state: "hidden" });
  await page.evaluate(() => window.emitFixtureEvent("semantic://sessions-reset", { libraryId: "different-library" }));
  assert.ok(await page.locator('[data-asset-id="result-1"]').isVisible(), "another library reset retains local ranking");
  await page.evaluate(() => window.emitFixtureEvent("semantic://sessions-reset", { libraryId: "test-library" }));
  await page.locator('[data-asset-id="result-0"]').waitFor({ state: "detached" });
  await page.locator('[data-asset-id="result-1"]').waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log("PASS semantic setup, overlay geometry, IME/length, retained and stale sessions, background resets, ranked selection, filename scope, scroll/focus restoration, narrow light theme, split panes");
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` });
  throw error;
} finally {
  await browser.close();
  await server.close();
}
