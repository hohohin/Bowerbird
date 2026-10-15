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
const settleSource = () => page.locator(".canvas-workspace").evaluate(async element => {
  await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
});
async function checkChrome() {
  const chrome = await page.locator(".canvas-workspace").evaluate(workspace => {
    const box = selector => {
      const element = workspace.querySelector(selector);
      const { x, y, width, height } = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { x, y, width, height, radius: style.borderRadius, background: style.backgroundColor };
    };
    return { tab: box(".canvas-source-expand"), title: box(".canvas-board-toolbar > div:first-child"),
      zoom: box(".canvas-zoom-controls"), tools: box(".canvas-drawing-tools"),
      icon: !!workspace.querySelector(".canvas-source-expand svg") };
  });
  assert.equal(chrome.icon, true, "library tab retains its icon");
  assert.equal(chrome.tab.y, chrome.title.y);
  assert.equal(chrome.tab.y, chrome.zoom.y);
  assert.equal(chrome.tab.height, chrome.title.height);
  assert.equal(chrome.tab.height, chrome.zoom.height);
  assert.equal(chrome.tab.x, chrome.tools.x);
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
  await card("existing").waitFor();
  const topFilter = page.locator(".app-topbar").getByRole("group", { name: "生成图显示模式" });
  assert.equal(await panel.getByRole("group", { name: "生成图显示模式" }).count(), 0);
  for (const canvasMode of [false, true]) {
    await page.evaluate(value => window.setToolbarCanvasMode(value), canvasMode);
    await topFilter.waitFor();
    await topFilter.getByRole("button", { name: "只看", exact: true }).click();
    assert.equal(await page.evaluate(() => window.store.getState().smartFilter), "source:generated");
    await topFilter.getByRole("button", { name: "不看", exact: true }).click();
    assert.equal(await page.evaluate(() => window.store.getState().smartFilter), "source:!generated");
    await topFilter.getByRole("button", { name: "不看", exact: true }).click();
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
  for (const scope of ["项目素材", "中央素材"]) {
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
    el.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
    return ids;
  });
  assert.deepEqual(dragIds, ["a", "c"]);

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

  // Real resize control: controls wrap at narrow widths without overlap.
  const resizer = page.getByRole("separator", { name: "调整素材面板宽度" });
  await mkdir(".tmp/canvas-source", { recursive: true });
  for (const [name, key, steps] of [["narrow", "ArrowLeft", 12], ["wide", "ArrowRight", 20]]) {
    await resizer.focus();
    for (let i = 0; i < steps; i++) await page.keyboard.press(key);
    await settleSource();
    const geometry = await panel.locator(".canvas-source-header").evaluate(header => {
      const rect = selector => {
        const { x, y, width, height } = header.querySelector(selector).getBoundingClientRect();
        return { x, y, width, height };
      };
      return { tabs: rect(".canvas-source-tabs"), collapse: rect(".canvas-source-collapse"), scale: rect(".thumbnail-size-slider"), overflow: header.scrollWidth > header.clientWidth };
    });
    assert.equal(geometry.overflow, false);
    for (const control of Object.values(geometry).filter(value => typeof value === "object")) assert.equal(control.height, 28);
    assert.equal(geometry.tabs.y, geometry.collapse.y);
    if (name === "narrow") assert.ok(geometry.scale.y >= geometry.tabs.y + geometry.tabs.height);
    else {
      assert.equal(geometry.scale.y, geometry.tabs.y);
      assert.ok(geometry.tabs.x + geometry.tabs.width <= geometry.scale.x);
    }
    assert.ok(geometry.scale.x + geometry.scale.width <= geometry.collapse.x);
    await panel.locator(".canvas-source-header").screenshot({ path: `.tmp/canvas-source/${name}.png`, scale: "css" });
  }
  await panel.getByRole("slider", { name: "项目素材大小" }).fill("208");
  assert.equal(await panel.getByRole("slider", { name: "项目素材大小" }).inputValue(), "208");
  await panel.getByRole("button", { name: "收起画板素材库" }).click();
  await settleSource();
  const collapsed = await page.locator(".canvas-workspace").evaluate(workspace => {
    const panel = workspace.querySelector(".canvas-source-panel").getBoundingClientRect();
    const board = workspace.querySelector(".canvas-board-shell").getBoundingClientRect();
    const tab = workspace.querySelector(".canvas-source-expand").getBoundingClientRect();
    const hit = document.elementFromPoint(tab.x + tab.width / 2, tab.y + tab.height / 2);
    return { panelWidth: panel.width, boardLeft: board.left, workspaceLeft: workspace.getBoundingClientRect().left,
      tabHeight: tab.height, tabClickable: !!hit?.closest(".canvas-source-expand") };
  });
  assert.equal(collapsed.panelWidth, 0, "collapsed library must release its entire rail");
  assert.equal(collapsed.boardLeft, collapsed.workspaceLeft);
  assert.ok(collapsed.tabHeight <= 100, "only a compact edge tab remains");
  assert.equal(collapsed.tabClickable, true, "canvas must not cover the expand tab");
  await checkChrome();
  await page.screenshot({ path: ".tmp/canvas-source/collapsed.png", scale: "css" });
  await panel.getByRole("button", { name: "展开画板素材库" }).click();
  await settleSource();
  await panel.getByRole("tab", { name: "项目素材" }).waitFor();
  assert.equal(await panel.getByRole("slider", { name: "项目素材大小" }).inputValue(), "208");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await panel.getByRole("button", { name: "收起画板素材库" }).click();
  assert.ok(await page.locator(".canvas-workspace").evaluate(el => parseFloat(getComputedStyle(el).transitionDuration) < 0.001));
  assert.equal(await panel.locator(".canvas-source-expand").evaluate(el => getComputedStyle(el).animationName), "none");
  await page.keyboard.press("Enter");
  assert.equal(await panel.getByRole("button", { name: "收起画板素材库" }).evaluate(el => el === document.activeElement), true);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // Interrupt an in-flight transition in both directions; the final state stays usable.
  for (let attempt = 0; attempt < 3; attempt++) {
    await panel.locator(".canvas-source-collapse").evaluate(el => el.click());
    await page.waitForTimeout(60);
    await panel.locator(".canvas-source-expand").evaluate(el => el.click());
    await page.waitForTimeout(60);
  }
  await settleSource();
  assert.ok((await panel.boundingBox()).width > 200);
  await page.setViewportSize({ width: 900, height: 760 });
  await page.evaluate(() => document.documentElement.dataset.theme = "dark");
  await panel.getByRole("button", { name: "收起画板素材库" }).click();
  await settleSource();
  await checkChrome();
  await page.screenshot({ path: ".tmp/canvas-source/collapsed-dark-narrow.png", scale: "css" });
  await panel.getByRole("button", { name: "展开画板素材库" }).click();
  await settleSource();
  await page.screenshot({ path: ".tmp/canvas-source/expanded-dark-narrow.png", scale: "css" });
  await page.setViewportSize({ width: 900, height: 568 });
  await panel.getByRole("button", { name: "收起画板素材库" }).click();
  await settleSource();
  await checkChrome();
  const toolsFit = await page.locator(".canvas-drawing-tools").evaluate(el => {
    const tools = el.getBoundingClientRect(), board = el.closest(".canvas-board-shell").getBoundingClientRect();
    return tools.bottom <= board.bottom - 12;
  });
  assert.equal(toolsFit, true, "all tools fit a minimum-height window including native titlebar space");
  await page.getByRole("button", { name: "吸附对齐", exact: true }).click();
  assert.deepEqual(errors, []);
  console.log("PASS: canvas source Shift/range/toggle/keyboard selection, browse/pick priority, both scopes, batch drag, aligned resizable toolbar.");
} finally { await browser.close(); await server.close(); }
