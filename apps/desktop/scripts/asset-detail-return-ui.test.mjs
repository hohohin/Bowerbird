import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1597, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on("pageerror", error => { errors.push(error.message); console.error(error.stack); });
const detail = page.locator(".asset-detail");
async function settleLayout() {
  await page.waitForFunction(() => ![...document.querySelectorAll(".canvas-source-panel, .masonry-layout, .masonry-cell")]
    .some(element => element.getAnimations().some(animation => animation.playState === "running")));
}
async function openDetails(card) {
  await card.click({ button: "right" });
  await page.getByRole("menuitem", { name: "打开图片详情", exact: true }).click();
  await detail.waitFor();
}
async function returnFromDetails() {
  await detail.getByRole("button", { name: "返回", exact: true }).click();
  await detail.waitFor({ state: "detached" });
}
async function captureWorkspace() {
  return page.evaluate(() => {
    const state = window.store.getState();
    const workspace = document.querySelector(".canvas-workspace") ?? document.querySelector(".library-home");
    window.returnWorkspace = workspace;
    return { projectId: state.activeProjectId, revision: state.projectRouteRevision,
      filter: state.mediaFilter, selected: [...state.selectedIds], boardOpen: state.boardOpen,
      scroll: [...workspace.querySelectorAll(".collection-scroll-viewport")].map(el => el.scrollTop),
      transform: workspace.querySelector(".canvas-plane")?.getAttribute("style"),
      source: workspace.querySelector('[role="tab"][aria-selected="true"]')?.textContent };
  });
}
async function assertWorkspace(before) {
  assert.equal(await page.evaluate(() => window.returnWorkspace.isConnected), true, "workspace must stay mounted");
  assert.deepEqual(await captureWorkspace(), before, "route, camera, source, selection and scroll must survive details");
}
try {
  await page.goto("http://127.0.0.1:1597/scripts/fixtures/canvas-reference/preview.html?source-library&detail-route");
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await settleLayout();
  const panel = page.getByRole("complementary", { name: "画板素材库" });
  await page.getByRole("button", { name: "展开画板素材库" }).click();
  await settleLayout();
  // Project source: returning must preserve the mounted workspace and scrolled list.
  // Use a left-side tile so the right tag index does not force Playwright to scroll before clicking.
  await panel.locator('[data-asset-id="detail-44"]').scrollIntoViewIfNeeded();
  const before = await captureWorkspace();
  assert.ok(before.scroll.some(top => top > 0));
  await openDetails(panel.locator('[data-asset-id="detail-44"]'));
  assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), "p", "opening details must keep the project route");
  await page.keyboard.press("Space");
  assert.equal(await page.locator(".canvas-stage.is-pan-ready").count(), 0, "hidden canvas must not consume detail keyboard input");
  await returnFromDetails();
  await assertWorkspace(before);

  // Central source can contain an image absent from the current project's assets.
  await page.evaluate(() => window.store.setState(state => ({ assets: state.assets.filter(asset => asset.id !== "d") })));
  await panel.getByRole("tab", { name: "全局素材" }).click();
  await settleLayout();
  await panel.locator('[data-asset-id="d"]').scrollIntoViewIfNeeded();
  const central = await captureWorkspace();
  await openDetails(panel.locator('[data-asset-id="d"]'));
  assert.equal(await page.evaluate(() => window.store.getState().detailAssetId), "d");
  await returnFromDetails();
  await assertWorkspace(central);

  // Canvas-only assets are fetched by ID, without making them library members.
  await panel.getByRole("button", { name: "返回画板", exact: true }).click();
  await page.evaluate(async () => {
    await window.__TAURI_INTERNALS__.invoke("set_canvas_asset_library_visibility", { projectId: "p", assetId: "existing", visible: false });
    window.store.setState({ boardOpen: true });
  });
  await settleLayout();
  const canvasBefore = await captureWorkspace();
  await openDetails(page.locator('[data-canvas-node-id="old"]'));
  assert.equal(await page.evaluate(() => window.store.getState().detailAssetId), "existing");
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => window.store.getState().boardOpen), true, "details must not exit the hidden composer");
  await returnFromDetails();
  await assertWorkspace(canvasBefore);
  assert.equal(await page.evaluate(() => window.store.getState().assets.some(asset => asset.id === "existing")), false);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === "set_active_project").length), 0, "details never navigate out of the project");

  // Home library also keeps its scroll/filter context.
  await page.evaluate(async () => { await window.store.getState().exitProject(); window.store.getState().setMediaFilter("image"); });
  const home = page.locator(".library-home");
  await home.locator('[data-asset-id="detail-40"]').scrollIntoViewIfNeeded();
  const homeBefore = await captureWorkspace();
  await openDetails(home.locator('[data-asset-id="detail-40"]'));
  await returnFromDetails();
  await assertWorkspace(homeBefore);

  // A missing asset must still offer a way back to the untouched workspace.
  await page.evaluate(() => window.store.getState().openDetail("missing-asset"));
  await page.getByText("暂未读取到素材").waitFor();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await assertWorkspace(homeBefore);
  assert.deepEqual(errors, []);
  console.log("PASS project/central source, canvas-only asset, preserved route/scroll/workspace, keyboard isolation, home library return");
} catch (error) {
  console.error({ errors, state: await page.evaluate(() => ({ project: window.store?.getState().activeProjectId, detail: window.store?.getState().detailAssetId })) });
  throw error;
} finally {
  await browser.close();
  await server.close();
}
