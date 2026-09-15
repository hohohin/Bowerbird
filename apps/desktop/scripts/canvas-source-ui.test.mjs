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

  // Real resize control: all controls stay on one row without overlap at narrow/wide sizes.
  const resizer = page.getByRole("separator", { name: "调整素材面板宽度" });
  await mkdir(".tmp/canvas-source", { recursive: true });
  for (const [name, key, steps] of [["narrow", "ArrowLeft", 12], ["wide", "ArrowRight", 20]]) {
    await resizer.focus();
    for (let i = 0; i < steps; i++) await page.keyboard.press(key);
    const geometry = await panel.locator(".canvas-source-header").evaluate(header => {
      const rect = selector => {
        const { x, y, width, height } = header.querySelector(selector).getBoundingClientRect();
        return { x, y, width, height };
      };
      return { tabs: rect(".canvas-source-tabs"), collapse: rect(".canvas-source-collapse"), scale: rect(".canvas-source-scale-dots"), overflow: header.scrollWidth > header.clientWidth };
    });
    assert.equal(geometry.overflow, false);
    for (const control of Object.values(geometry).filter(value => typeof value === "object")) assert.equal(control.height, 28);
    assert.equal(geometry.tabs.y, geometry.collapse.y);
    assert.equal(geometry.scale.y, geometry.tabs.y);
    assert.ok(geometry.tabs.x + geometry.tabs.width <= geometry.scale.x);
    assert.ok(geometry.scale.x + geometry.scale.width <= geometry.collapse.x);
    await panel.locator(".canvas-source-header").screenshot({ path: `.tmp/canvas-source/${name}.png`, scale: "css" });
  }
  await panel.getByRole("button", { name: "大缩略图", exact: true }).click();
  assert.equal(await panel.getByRole("button", { name: "大缩略图", exact: true }).getAttribute("aria-pressed"), "true");
  await panel.getByRole("button", { name: "收起画板素材库" }).click();
  await panel.getByRole("button", { name: "展开画板素材库" }).click();
  await panel.getByRole("tab", { name: "项目素材" }).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS: canvas source Shift/range/toggle/keyboard selection, browse/pick priority, both scopes, batch drag, aligned resizable toolbar.");
} finally { await browser.close(); await server.close(); }
