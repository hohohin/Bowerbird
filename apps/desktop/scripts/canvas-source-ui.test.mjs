import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1567, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const panel = page.getByRole("complementary", { name: "画板素材库" });
const card = id => panel.locator(`[data-asset-id="${id}"]`);
const selected = () => page.evaluate(() => [...window.store.getState().selectedIds].sort());
const settleSource = () => page.locator(".canvas-source-panel").evaluate(async element => {
  await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
});
async function checkChrome() {
  await page.mouse.move(800, 720);
  const chrome = await page.locator(".canvas-workspace").evaluate(workspace => {
    const box = selector => {
      const element = workspace.querySelector(selector);
      const { x, y, width, height } = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { x, y, width, height, radius: style.borderTopRightRadius, background: style.backgroundColor };
    };
    return { tab: box(".canvas-source-toggle"), title: box(".canvas-board-toolbar > div:first-child"),
      zoom: box(".canvas-zoom-controls"), tools: box(".canvas-drawing-tools"),
      icon: !!workspace.querySelector(".canvas-source-toggle svg") };
  });
  assert.equal(chrome.icon, true, "library tab retains its icon");
  assert.equal(chrome.tab.y, chrome.title.y);
  assert.equal(chrome.tab.y, chrome.zoom.y);
  assert.equal(chrome.tab.height, chrome.title.height);
  assert.equal(chrome.tab.height, chrome.zoom.height);
  assert.equal(chrome.tools.x - chrome.tab.x, 12);
  assert.equal(chrome.tools.y - chrome.tab.y - chrome.tab.height, 8);
  assert.equal(chrome.title.x - chrome.tab.x - chrome.tab.width, 8);
  assert.ok(chrome.title.x + chrome.title.width + 8 <= chrome.zoom.x, "title and zoom do not overlap");
  for (const element of [chrome.title, chrome.zoom, chrome.tools]) {
    assert.equal(element.radius, chrome.tab.radius);
    assert.equal(element.background, chrome.tab.background);
  }
}
try {
  await page.goto("http://127.0.0.1:1567/scripts/fixtures/canvas-reference/preview.html?source-library");
  await page.getByRole("button", { name: "展开画板素材库" }).click();
  await card("existing").waitFor();
  const topFilter = page.locator(".app-topbar").getByRole("group", { name: "生成图显示模式" });
  assert.equal(await panel.getByRole("group", { name: "生成图显示模式" }).count(), 0);
  for (const canvasMode of [false, true]) {
    await page.evaluate(value => window.setToolbarCanvasMode(value), canvasMode);
    await topFilter.waitFor();
    await topFilter.getByRole("button", { name: "只看生成图", exact: true }).click();
    assert.equal(await page.evaluate(() => window.store.getState().smartFilter), "source:generated");
    await topFilter.getByRole("button", { name: "不看生成图", exact: true }).click();
    assert.equal(await page.evaluate(() => window.store.getState().smartFilter), "source:!generated");
    await topFilter.getByRole("button", { name: "不看生成图", exact: true }).click();
    assert.equal(await page.evaluate(() => window.store.getState().smartFilter), null);
  }
  await page.evaluate(() => {
    window.picked = [];
    window.addEventListener("bowerbird://board-asset-picked", event => window.picked.push(event.detail));
  });

  // Browse -> Shift selection; plain clicks toggle, Shift extends the visible range.
  await card("a").click({ modifiers: ["Shift"] });
  assert.deepEqual(await selected(), ["a"]);
  assert.equal(await card("a").getAttribute("aria-pressed"), "true");
  await card("d").click({ modifiers: ["Shift"] });
  assert.deepEqual(await selected(), ["a", "b", "c", "d"]);
  await card("b").click();
  assert.deepEqual(await selected(), ["a", "c", "d"]);
  await card("existing").click();
  assert.deepEqual(await selected(), ["a", "c", "d", "existing"]);

  // An explicitly entered manage mode must also win over an active composer.
  for (const scope of ["项目素材", "全局素材"]) {
    await panel.getByRole("tab", { name: scope }).click();
    await card("a").waitFor();
    for (const editing of [{ boardOpen: false, genEditing: false }, { boardOpen: true, genEditing: false }, { boardOpen: false, genEditing: true }]) {
      await page.evaluate(editing => {
        const store = window.store;
        store.getState().exitManage();
        store.setState(editing);
        store.getState().enterManage();
      }, editing);
      await card("a").click();
      await card("c").click({ modifiers: ["Shift"] });
      assert.deepEqual(await selected(), ["a", "b", "c"]);
      await card("b").click();
      assert.deepEqual(await selected(), ["a", "c"]);
      assert.equal(await card("a").evaluate(el => getComputedStyle(el).cursor), "pointer");
    }
  }
  assert.deepEqual(await page.evaluate(() => window.picked), [], "multi-select must never insert a reference");
  assert.equal(await page.getByRole("dialog").count(), 0, "multi-select must never open a preview");

  // Enter and Space follow the same selection path.
  await card("b").focus();
  await page.keyboard.press("Space");
  assert.deepEqual(await selected(), ["a", "b", "c"]);
  await page.keyboard.press("Enter");
  assert.deepEqual(await selected(), ["a", "c"]);
  const dragIds = await card("a").evaluate(el => {
    const dataTransfer = new DataTransfer();
    el.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
    const ids = dataTransfer.getData("text/plain").split(",").sort();
    return ids;
  });
  assert.deepEqual(dragIds, ["a", "c"]);
  await page.waitForFunction(() => !window.store.getState().canvasLibraryOpen);
  assert.equal(await page.locator('.canvas-source-panel').evaluate(el => getComputedStyle(el).visibility), 'hidden', 'drag reveals canvas without a closing animation');
  assert.equal(await page.locator('.canvas-board-shell').evaluate(el => el.inert), false);
  await page.locator('.canvas-source-panel [data-asset-id="a"]').dispatchEvent('dragend');
  await page.getByRole("button", { name: "展开画板素材库" }).click();
  await settleSource();

  // Regular browsing and picking still work after leaving multi-select.
  await page.evaluate(() => { window.store.getState().exitManage(); window.store.setState({ boardOpen: false, genEditing: false }); });
  await card("a").click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.evaluate(() => window.store.setState({ boardOpen: true }));
  await card("a").click();
  assert.deepEqual(await page.evaluate(() => window.picked), ["a"]);
  await card("b").click({ modifiers: ["Shift"] });
  assert.deepEqual(await selected(), ["b"], "Shift must select even with an active composer");
  assert.deepEqual(await page.evaluate(() => window.picked), ["a"]);

  // Full-screen layout retains the size preference and canvas chrome at minimum window sizes.
  await mkdir('.tmp/canvas-source', { recursive: true });
  await panel.getByRole('slider', { name: '项目素材大小' }).fill('59');
  await panel.getByRole('button', { name: '返回画板', exact: true }).click();
  await settleSource();
  await checkChrome();
  await page.getByRole('button', { name: '展开画板素材库' }).click();
  await settleSource();
  assert.equal(await panel.getByRole('slider', { name: '项目素材大小' }).inputValue(), '59');
  // Rapidly reversing the reveal must leave the final view interactive.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.store.getState().setCanvasLibraryOpen(false));
    await page.waitForTimeout(50);
    await page.evaluate(() => window.store.getState().setCanvasLibraryOpen(true));
    await page.waitForTimeout(50);
  }
  await settleSource();
  assert.equal(await panel.evaluate(el => el.inert), false);
  for (const height of [760, 568]) {
    await page.setViewportSize({ width: 900, height });
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await panel.getByRole('button', { name: '返回画板', exact: true }).click();
    await settleSource();
    await checkChrome();
    assert.equal(await page.locator('.canvas-drawing-tools').evaluate(el => {
      return el.getBoundingClientRect().bottom <= el.closest('.canvas-board-shell').getBoundingClientRect().bottom - 12;
    }), true);
    await page.screenshot({ path: `.tmp/canvas-source/canvas-${height}.png` });
    await page.getByRole('button', { name: '展开画板素材库' }).click();
    await settleSource();
    assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.screenshot({ path: `.tmp/canvas-source/library-${height}.png` });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: full-screen source selection, range, keyboard, browse/pick priority, both scopes, batch drag and canvas chrome.');
} finally { await browser.close(); await server.close(); }
