import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || "../../html-renderer/node_modules/playwright/index.mjs");

const server = await createServer({ cacheDir: ".tmp/canvas-frequent-assets/vite", server: { host: "127.0.0.1", port: 1789, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
const panel = page.locator(".canvas-source-panel");
const footer = panel.locator(".canvas-frequent-assets");
const row = name => footer.locator(`.canvas-frequent-row[data-row="${name}"]`);
const card = (name, id) => row(name).locator(`[data-asset-id="${id}"]`);
const libraryCard = id => panel.locator(`.categorized-library [data-asset-id="${id}"]`);
const ids = name => row(name).locator("[data-asset-id]").evaluateAll(elements => elements.map(element => element.dataset.assetId));
const add = () => footer.getByRole("button", { name: "添加素材", exact: true });
const done = () => footer.getByRole("button", { name: "完成添加", exact: true });
const threshold = () => footer.getByRole("spinbutton", { name: "高频引用次数阈值", exact: true });
async function settle() {
  await footer.locator('xpath=self::*[@aria-busy="false"]').waitFor();
  await panel.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
  });
}
async function openLibrary() {
  if (await panel.getAttribute("aria-hidden") !== "false") await page.getByRole("button", { name: "展开画板素材库", exact: true }).click();
  await footer.waitFor();
  await settle();
}
async function reopen() {
  await page.reload();
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await openLibrary();
}
async function scope(name) {
  await footer.getByRole("button", { name, exact: true }).click();
  await settle();
}
async function saveThreshold(value, commit = "Enter") {
  await threshold().fill(String(value));
  await threshold().press(commit);
  await page.waitForFunction(value => window.frequentPreferences().threshold === value, value);
  await settle();
  assert.equal(await threshold().inputValue(), String(value));
}
async function beginPicking() {
  await add().click();
  await done().waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0, "adding uses the existing workspace without a modal");
}
async function pickLibrary(id) {
  await libraryCard(id).click();
  await page.waitForFunction(id => window.frequentPreferences().pinned.includes(id), id);
  await settle();
  assert.equal(await done().isVisible(), true, "point selection remains active for another material");
}
async function addLibraryAssets(assetIds) {
  await beginPicking();
  for (const id of assetIds) await pickLibrary(id);
  await done().click();
  await add().waitFor();
}
async function narrowLibrary() {
  await page.getByRole("separator", { name: "调整素材库宽度", exact: true }).focus();
  await page.keyboard.press("Home");
  await settle();
}
async function assertNoPickMode() {
  await add().waitFor();
  assert.equal(await done().count(), 0);
}
try {
  await mkdir(".tmp/canvas-frequent-assets", { recursive: true });
  await page.goto("http://127.0.0.1:1789/scripts/fixtures/canvas-frequent-assets/preview.html?source-library&canvas-library");
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await openLibrary();
  assert.equal(await threshold().inputValue(), "10", "default threshold is ten references");
  assert.equal(await threshold().getAttribute("min"), "0");
  assert.equal(await threshold().getAttribute("step"), "1");
  assert.deepEqual(await ids("frequent"), ["existing", ...Array.from({ length: 7 }, (_, index) => `frequent-${index}`)], "default retrieval includes strictly more than ten references in descending order");
  assert.equal(await card("frequent", "frequent-6").count(), 1, "eleven references is included");
  assert.equal(await card("frequent", "frequent-7").count(), 0, "ten references is excluded");
  await page.screenshot({ path: ".tmp/canvas-frequent-assets/default-threshold.png" });
  await threshold().focus();
  await threshold().press("ArrowUp");
  assert.equal(await threshold().inputValue(), "11", "number-input arrows adjust by one");
  await threshold().press("ArrowDown");
  assert.equal(await threshold().inputValue(), "10");
  await threshold().press("Tab");
  await saveThreshold(3);
  const expected = ["existing", ...Array.from({ length: 12 }, (_, index) => `frequent-${index}`), "a"];
  assert.deepEqual(await ids("frequent"), expected, "lowering the threshold to three includes four references in descending order");
  assert.equal(await card("frequent", "b").count(), 0, "a count equal to the saved threshold is excluded");
  assert.equal(await card("frequent", "hidden").count(), 0, "library-hidden assets stay out of automatic retrieval");
  assert.deepEqual(await ids("pinned"), []);
  assert.equal(await footer.locator(".canvas-frequent-name:visible").count(), 0, "the compact strips have no visible material captions");
  assert.ok(!(await footer.innerText()).includes("最高频素材"), "material names are absent from visible footer text");
  assert.equal(await card("frequent", "existing").getAttribute("aria-label"), "最高频素材", "thumbnail accessible names remain available");
  assert.ok(await card("frequent", "existing").evaluate(element => [element, element.parentElement].some(item => item.title.includes("最高频素材"))), "hover retains the material name");
  const empty = await row("pinned").boundingBox();
  const populated = await row("frequent").boundingBox();
  assert.ok(empty.height <= 48 && empty.height < populated.height, `empty manual row is one compact text line (${empty.height}px)`);
  const geometry = await footer.evaluate(element => {
    const box = element.getBoundingClientRect(), panel = element.closest(".canvas-source-panel").getBoundingClientRect();
    const frequent = element.querySelector('[data-row="frequent"]').getBoundingClientRect();
    const pinned = element.querySelector('[data-row="pinned"]').getBoundingClientRect();
    return { bottomGap: panel.bottom - box.bottom, separateRows: frequent.bottom <= pinned.top + 1 };
  });
  assert.ok(geometry.bottomGap >= -1 && geometry.bottomGap < 10 && geometry.separateRows, "the independent rows remain at the library bottom");
  await page.screenshot({ path: ".tmp/canvas-frequent-assets/empty-manual.png" });
  await footer.getByRole("button", { name: "收起常用素材", exact: true }).click();
  assert.equal(await footer.locator(".canvas-frequent-row:visible").count(), 0);
  assert.ok((await footer.boundingBox()).height <= 48, "collapse leaves only a compact header");
  await page.screenshot({ path: ".tmp/canvas-frequent-assets/collapsed.png" });
  await reopen();
  assert.equal(await footer.locator(".canvas-frequent-row:visible").count(), 0, "collapsed state survives workspace reload");
  await footer.getByRole("button", { name: "展开常用素材", exact: true }).click();
  await settle();
  assert.equal(await threshold().inputValue(), "3", "custom threshold survives workspace reload");

  await footer.getByRole("button", { name: "移除常用素材 最高频素材", exact: true }).click();
  await card("frequent", "existing").waitFor({ state: "detached" });
  const preferences = await page.evaluate(() => window.frequentPreferences());
  await saveThreshold(10);
  assert.equal(await card("frequent", "existing").count(), 0, "changing the threshold does not restore a suppressed eligible material");
  await saveThreshold(3, "Tab");
  assert.deepEqual(await page.evaluate(() => window.frequentPreferences()), preferences, "blur saves the threshold without clearing exclusions or manual pins");
  const invalidRetrieveStart = await page.evaluate(() => window.calls.length);
  await threshold().fill("");
  await footer.getByRole("button", { name: "检索常用素材", exact: true }).click();
  await settle();
  assert.equal(await threshold().inputValue(), "3", "an empty direct retrieval restores the saved threshold");
  assert.ok(await threshold().evaluate(element => document.activeElement === element), "rejected direct retrieval retains input focus");
  assert.deepEqual(await page.evaluate(start => window.calls.slice(start).filter(call => ["canvas_frequent_assets_set_threshold", "canvas_frequent_assets_refresh"].includes(call.command)), invalidRetrieveStart), [],
    "an empty direct retrieval sends neither a threshold save nor a refresh");
  await saveThreshold(6);
  assert.deepEqual(await page.evaluate(start => window.calls.slice(start).filter(call => ["canvas_frequent_assets_set_threshold", "canvas_frequent_assets_refresh"].includes(call.command)).map(call => call.command), invalidRetrieveStart), ["canvas_frequent_assets_set_threshold"],
    "editing a valid value without refocusing after rejection still saves once on Enter");
  await saveThreshold(3);
  assert.deepEqual(await page.evaluate(() => window.frequentPreferences()), preferences);
  const directRetrieveStart = await page.evaluate(() => window.calls.length);
  await page.evaluate(() => { window.failFrequentCommand = "canvas_frequent_assets_set_threshold"; });
  await threshold().fill("6");
  await footer.getByRole("button", { name: "检索常用素材", exact: true }).click();
  await page.waitForFunction(start => window.calls.slice(start).some(call => call.command === "canvas_frequent_assets_set_threshold"), directRetrieveStart);
  await settle();
  assert.equal(await threshold().inputValue(), "3", "direct retrieval restores the saved threshold when the draft fails to save");
  assert.deepEqual(await page.evaluate(() => window.frequentPreferences()), preferences, "failed draft saving leaves exclusions intact");
  assert.equal(await card("frequent", "existing").count(), 0);
  assert.equal(await page.evaluate(start => window.calls.slice(start).filter(call => call.command === "canvas_frequent_assets_refresh").length, directRetrieveStart), 0,
    "direct retrieval never refreshes after a failed threshold save");
  await page.evaluate(() => { window.failFrequentCommand = undefined; });
  const successfulRetrieveStart = await page.evaluate(() => window.calls.length);
  await threshold().fill("6");
  await footer.getByRole("button", { name: "检索常用素材", exact: true }).click();
  await page.waitForFunction(start => window.calls.slice(start).some(call => call.command === "canvas_frequent_assets_refresh"), successfulRetrieveStart);
  await settle();
  const directRetrieveCalls = await page.evaluate(start => window.calls.slice(start).filter(call => ["canvas_frequent_assets_set_threshold", "canvas_frequent_assets_refresh"].includes(call.command)), successfulRetrieveStart);
  assert.deepEqual(directRetrieveCalls.map(call => call.command), ["canvas_frequent_assets_set_threshold", "canvas_frequent_assets_refresh"],
    "direct retrieval saves the focused draft once, then retrieves once");
  assert.equal(directRetrieveCalls[0].args.threshold, 6);
  assert.equal(await threshold().inputValue(), "6");
  assert.equal(await page.evaluate(() => window.frequentPreferences().threshold), 6);
  assert.deepEqual(await ids("frequent"), ["existing", ...Array.from({ length: 11 }, (_, index) => `frequent-${index}`)],
    "direct retrieval uses the new strict threshold and restores the explicitly suppressed material");
  await footer.getByRole("button", { name: "移除常用素材 最高频素材", exact: true }).click();
  await card("frequent", "existing").waitFor({ state: "detached" });
  await saveThreshold(3);
  assert.deepEqual(await page.evaluate(() => window.frequentPreferences()), preferences);
  const reads = await page.evaluate(() => window.calls.filter(call => call.command === "canvas_frequent_assets").length);
  await page.evaluate(() => window.emitAssetsChanged());
  await page.waitForFunction(previous => window.calls.filter(call => call.command === "canvas_frequent_assets").length > previous, reads);
  await settle();
  assert.equal(await card("frequent", "existing").count(), 0, "ordinary refresh preserves suppression");
  await scope("本项目");
  assert.equal(await threshold().inputValue(), "3", "project scope shares the saved threshold");
  assert.deepEqual(await ids("frequent"), ["frequent-0", "frequent-1", "a"], "project scope uses project membership");
  assert.deepEqual(await page.evaluate(() => window.frequentPreferences()), preferences, "changing scope never rewrites saved pin or suppression lists");
  await scope("全局");
  assert.equal(await threshold().inputValue(), "3", "returning to global scope retains the custom threshold");
  await page.getByRole("button", { name: "关闭素材库", exact: true }).click();
  await openLibrary();
  assert.equal(await card("frequent", "existing").count(), 0);
  await reopen();
  assert.equal(await card("frequent", "existing").count(), 0, "workspace reload preserves suppression");
  await footer.getByRole("button", { name: "检索常用素材", exact: true }).click();
  await card("frequent", "existing").waitFor();
  assert.deepEqual(await ids("frequent"), expected, "explicit retrieval restores removed eligible materials");

  await page.evaluate(() => window.store.setState({ boardOpen: true }));
  await page.locator(".creation-dock .ProseMirror").waitFor();
  const editorBefore = await page.locator(".creation-dock .ProseMirror").innerHTML();
  await beginPicking();
  await pickLibrary("c");
  await pickLibrary("d");
  await pickLibrary("a");
  await pickLibrary("c");
  assert.deepEqual(await ids("pinned"), ["c", "d", "a"], "continuous point selection permits zero-reference assets and deduplicates repeats");
  await narrowLibrary();
  const canvasBefore = await page.evaluate(() => window.snapshot().nodes);
  const hiddenNode = page.locator('[data-canvas-node-id="hidden-node"]');
  await hiddenNode.click({ position: { x: 60, y: 50 } });
  await card("pinned", "hidden").waitFor();
  await settle();
  // FileMediaCard normally delays preview insertion by 300ms; let that window pass.
  await page.waitForTimeout(350);
  assert.deepEqual(await page.evaluate(() => window.picked), [], "point selection never inserts composer references");
  assert.equal(await page.locator(".creation-dock .ProseMirror").innerHTML(), editorBefore);
  assert.deepEqual(await page.evaluate(() => window.snapshot().nodes), canvasBefore, "picking a canvas image does not move or recreate canvas nodes");
  assert.equal(await page.getByRole("dialog").count(), 0, "point selection never opens media preview or details");
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === "external_files_media").length), 0);
  assert.equal(await page.evaluate(() => window.frequentAssets.find(asset => asset.id === "hidden").library_hidden), true, "explicitly pinning a canvas-only image does not change its library visibility");
  await page.screenshot({ path: ".tmp/canvas-frequent-assets/picking-light.png" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path: ".tmp/canvas-frequent-assets/picking-dark.png" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.keyboard.press("Escape");
  await assertNoPickMode();
  assert.equal(await panel.getAttribute("aria-hidden"), "false", "Escape exits point selection without closing the library");
  await libraryCard("b").click();
  await page.waitForFunction(() => window.picked.includes("b"));
  assert.equal(await card("pinned", "b").count(), 0, "normal composer insertion resumes after point-selection cleanup");
  await page.evaluate(() => window.store.setState({ boardOpen: false }));

  await beginPicking();
  await done().click();
  await assertNoPickMode();
  await beginPicking();
  await footer.getByRole("button", { name: "收起常用素材", exact: true }).click();
  await footer.getByRole("button", { name: "展开常用素材", exact: true }).click();
  await assertNoPickMode();
  await beginPicking();
  await page.getByRole("button", { name: "关闭素材库", exact: true }).click();
  await page.getByRole("button", { name: "完成添加", exact: true }).waitFor();
  const beforeClosedPick = await page.evaluate(() => window.snapshot().nodes);
  await page.locator('[data-canvas-node-id="old"]').click({ position: { x: 60, y: 50 } });
  await page.waitForFunction(() => window.frequentPreferences().pinned.includes("existing"));
  assert.deepEqual(await page.evaluate(() => window.snapshot().nodes), beforeClosedPick, "closing the drawer keeps canvas point selection active without moving nodes");
  await openLibrary();
  await done().waitFor();
  await done().click();
  await assertNoPickMode();
  await beginPicking();
  await page.evaluate(() => window.store.setState({ activeProjectId: "q" }));
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await openLibrary();
  await assertNoPickMode();
  await page.evaluate(() => window.store.setState({ activeProjectId: "p" }));
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await openLibrary();

  const manualBeforeThreshold = await ids("pinned");
  await saveThreshold(10);
  assert.deepEqual(await ids("pinned"), manualBeforeThreshold, "changing the threshold never filters manually pinned materials");
  await saveThreshold(0);
  assert.equal(await card("frequent", "b").count(), 1, "zero is a valid threshold for referenced materials");
  assert.equal(await card("frequent", "c").count(), 0, "zero references is excluded even at threshold zero");
  assert.deepEqual(await ids("pinned"), manualBeforeThreshold);
  await saveThreshold(3, "Tab");
  const thresholdWrites = await page.evaluate(() => window.calls.filter(call => call.command === "canvas_frequent_assets_set_threshold").length);
  for (const invalid of ["-1", "3.5"]) {
    await threshold().fill(invalid);
    await threshold().press("Enter");
    await settle();
    assert.equal(await threshold().inputValue(), "3", `invalid threshold ${invalid} restores the saved value`);
  }
  await threshold().fill("8");
  await threshold().press("Escape");
  assert.equal(await threshold().inputValue(), "3", "Escape restores the saved threshold");
  await threshold().press("Tab");
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === "canvas_frequent_assets_set_threshold").length), thresholdWrites,
    "invalid and escaped edits never invoke a threshold write");
  await page.evaluate(() => { window.failFrequentCommand = "canvas_frequent_assets_set_threshold"; });
  await threshold().fill("9");
  await threshold().press("Enter");
  await page.waitForFunction(previous => window.calls.filter(call => call.command === "canvas_frequent_assets_set_threshold").length > previous, thresholdWrites);
  await settle();
  assert.equal(await threshold().inputValue(), "3", "a failed threshold save restores the last saved value");
  assert.equal(await page.evaluate(() => window.frequentPreferences().threshold), 3);
  assert.deepEqual(await ids("pinned"), manualBeforeThreshold);
  assert.deepEqual(await ids("frequent"), expected);
  await page.evaluate(() => { window.failFrequentCommand = null; });

  await scope("本项目");
  assert.deepEqual(await ids("frequent"), ["existing", "frequent-0", "frequent-1", "a"]);
  assert.deepEqual(await ids("pinned"), ["c", "a", "hidden", "existing"], "both rows use the same project-membership filter, including an explicitly pinned canvas-only image");
  await footer.getByRole("button", { name: "移除固定素材 四次边界素材", exact: true }).click();
  await card("pinned", "a").waitFor({ state: "detached" });
  assert.equal(await card("frequent", "a").count(), 1, "manual removal leaves the frequent counterpart intact");
  await scope("全局");
  assert.deepEqual(await ids("pinned"), ["c", "d", "hidden", "existing"], "project-scope removal edits the same global pin list");
  await reopen();
  assert.deepEqual(await ids("pinned"), ["c", "d", "hidden", "existing"], "manual pins, removals and canvas-only pins survive workspace reload");
  await footer.getByRole("button", { name: "检索常用素材", exact: true }).click();
  await settle();
  assert.deepEqual(await ids("pinned"), ["c", "d", "hidden", "existing"], "retrieval leaves manual pins unchanged");
  await page.getByRole("separator", { name: "调整素材库宽度", exact: true }).dblclick();
  await settle();
  await page.evaluate(() => { window.holdPinAssetId = "frequent-0"; window.failPinAssetId = "frequent-1"; });
  await beginPicking();
  await libraryCard("frequent-0").click();
  await page.waitForFunction(() => typeof window.releaseHeldPin === "function");
  await footer.getByRole("button", { name: "本项目", exact: true }).click();
  await libraryCard("frequent-1").click();
  await page.evaluate(() => window.releaseHeldPin());
  await page.waitForFunction(() => window.calls.some(call => call.command === "canvas_frequent_assets_pin" && call.args.projectId === "p" && call.args.assetIds.includes("frequent-1")));
  await settle();
  assert.equal(await footer.getAttribute("aria-busy"), "false", "a queued failure after a scope change cannot leave the list loading forever");
  assert.equal(await footer.getByRole("button", { name: "检索常用素材", exact: true }).isEnabled(), true);
  assert.deepEqual(await ids("pinned"), ["c", "hidden", "existing", "frequent-0"], "the refreshed project scope retains the successful queued pin and omits the failed pin");
  await page.evaluate(() => { window.failPinAssetId = null; });
  await done().click();
  await scope("全局");
  await addLibraryAssets(Array.from({ length: 5 }, (_, index) => `frequent-${index}`));
  await page.screenshot({ path: ".tmp/canvas-frequent-assets/light-wide.png" });
  await narrowLibrary();
  for (const name of ["frequent", "pinned"]) {
    const scroll = await row(name).locator(".canvas-frequent-scroll").evaluate(element => {
      element.scrollLeft = element.scrollWidth;
      return { left: element.scrollLeft, width: element.clientWidth, scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight, height: element.clientHeight };
    });
    assert.ok(scroll.left > 0 && scroll.scrollWidth > scroll.width, `${name} materials scroll horizontally in a narrow library`);
    assert.ok(scroll.scrollHeight <= scroll.height + 1, "materials remain in a single horizontal track");
    await row(name).locator(".canvas-frequent-scroll").evaluate(element => { element.scrollLeft = 0; });
    await row(name).locator(".canvas-frequent-scroll").hover();
    await page.mouse.wheel(0, 200);
    await page.waitForFunction(name => document.querySelector(`.canvas-frequent-row[data-row="${name}"] .canvas-frequent-scroll`).scrollLeft > 0, name);
  }
  await page.screenshot({ path: ".tmp/canvas-frequent-assets/light-narrow.png" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path: ".tmp/canvas-frequent-assets/dark-narrow.png" });
  const before = await page.evaluate(() => window.snapshot().nodes.length);
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await card("pinned", "c").dispatchEvent("dragstart", { dataTransfer: transfer });
  assert.deepEqual(await transfer.evaluate(data => data.getData("text/plain").split(",")), ["c"]);
  const stage = page.locator(".canvas-stage");
  await stage.dispatchEvent("dragover", { dataTransfer: transfer, clientX: 1000, clientY: 650 });
  await stage.dispatchEvent("drop", { dataTransfer: transfer, clientX: 1000, clientY: 650 });
  await page.waitForFunction(count => window.snapshot().nodes.length > count, before);
  assert.ok(await page.evaluate(() => window.snapshot().nodes.some(node => node.assetId === "c")), "normal drag creates a canvas reference after point selection exits");
  await page.evaluate(() => window.dispatchEvent(new DragEvent("dragend")));
  await transfer.dispose();
  assert.deepEqual(errors, []);
  console.log("PASS frequent materials: strict adjustable threshold/default 10, arrow/Enter/blur/Escape editing, persisted threshold/suppression/manual pins, invalid/save-failure rollback, compact/collapsible strips, in-place library/canvas pinning, exit cleanup, project/global scope, queued failure recovery, horizontal wheel scroll and normal drag");
} catch (error) {
  await page.screenshot({ path: ".tmp/canvas-frequent-assets/failure.png" });
  console.error(await footer.innerText().catch(() => "footer unavailable"));
  throw error;
} finally {
  await browser.close();
  await server.close();
}
