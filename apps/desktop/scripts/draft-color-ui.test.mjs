import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 16003, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const hex = () => page.getByLabel("HEX 颜色", { exact: true });
const plane = () => page.getByRole("slider", { name: "饱和度与明度", exact: true });
const hue = () => page.getByRole("slider", { name: "色相", exact: true });
const color = () => page.getByLabel("当前前景色", { exact: true }).textContent();
async function setHue(value) {
  await hue().evaluate((input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, String(value)); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}
async function enterHex(value) { await hex().fill(value); await hex().press("Enter"); }
async function waitHex(value) { await page.waitForFunction(value => document.querySelector('input[aria-label="HEX 颜色"]')?.value === value, value); }
try {
  await page.goto("http://127.0.0.1:16003/scripts/fixtures/draft-color/preview.html");
  await plane().waitFor();
  assert.equal(await hex().inputValue(), "#ff0000");
  await enterHex("#336699"); assert.equal(await color(), "#336699");
  await enterHex("invalid"); assert.equal(await color(), "#336699");
  assert.equal(await hex().getAttribute("aria-invalid"), "true");
  await hex().press("Escape"); assert.equal(await hex().inputValue(), "#336699");
  await enterHex("#abc"); assert.equal(await color(), "#aabbcc");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("bowerbird.draft.recentColors") || "[]")[0] === "#aabbcc");
  assert.equal(await page.getByRole("button", { name: "最近颜色 #AABBCC", exact: true }).count(), 1);

  await page.getByLabel("模拟顶部颜色").fill("#ff0000");
  await waitHex("#ff0000");
  await setHue(120); assert.equal(await color(), "#00ff00");
  await setHue(240); assert.equal(await color(), "#0000ff");
  await plane().focus(); await page.keyboard.press("Home"); assert.equal(await color(), "#ffffff");
  await page.keyboard.press("End"); assert.equal(await color(), "#0000ff", "gray retains the selected hue");
  await page.keyboard.press("Shift+ArrowDown"); assert.equal(await color(), "#0000e6");
  await page.keyboard.press("ArrowLeft"); assert.equal(await plane().getAttribute("aria-valuenow"), "99");
  await page.keyboard.press("Shift+ArrowUp"); assert.equal(await plane().getAttribute("aria-valuetext"), "饱和度 99%，明度 100%");

  // Pointer capture keeps adjusting outside the plane and clamps both axes.
  const box = await plane().boundingBox();
  await page.mouse.move(box.x + box.width * .4, box.y + box.height * .4); await page.mouse.down();
  await page.mouse.move(box.x + box.width + 30, box.y - 20, { steps: 6 }); await page.mouse.up();
  assert.equal(await color(), "#0000ff");
  await page.getByRole("button", { name: "常用色 #22C55E", exact: true }).click(); assert.equal(await color(), "#22c55e");
  await page.getByRole("button", { name: "最近颜色 #AABBCC", exact: true }).click(); assert.equal(await color(), "#aabbcc");
  await page.evaluate(() => window.setDisabled(true));
  await page.waitForFunction(() => document.querySelector('.draft-color-plane')?.getAttribute('aria-disabled') === 'true');
  const before = await page.evaluate(() => window.changes.length);
  await plane().dispatchEvent("keydown", { key: "ArrowDown" });
  await plane().dispatchEvent("pointerdown", { pointerId: 11, button: 0, clientX: 1, clientY: 1 });
  assert.equal(await page.evaluate(() => window.changes.length), before);
  assert.equal(await hex().isDisabled(), true); assert.equal(await hue().isDisabled(), true);
  await page.evaluate(() => window.setDisabled(false));
  await page.getByLabel("模拟顶部颜色").fill("#8844cc");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("bowerbird.draft.recentColors") || "[]")[0] === "#8844cc");
  await page.reload(); await plane().waitFor();
  assert.equal(await page.getByRole("button", { name: "最近颜色 #8844CC", exact: true }).count(), 1);
  await page.evaluate(() => localStorage.setItem("bowerbird.draft.recentColors", '{"broken":true}'));
  await page.reload(); await plane().waitFor();
  assert.equal(await hex().inputValue(), "#ff0000");
  await mkdir("/private/tmp/bowerbird-draft-color-ui", { recursive: true });
  await page.screenshot({ path: "/private/tmp/bowerbird-draft-color-ui/color-panel-light.png" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path: "/private/tmp/bowerbird-draft-color-ui/color-panel-dark.png" });

  // Full editor integration uses the same isolated IPC fixture as other draft tests.
  await page.goto("http://127.0.0.1:16003/scripts/fixtures/draft-editor/preview.html");
  await page.evaluate(() => window.openDraft());
  const dialog = page.getByRole("dialog", { name: "草稿编辑器", exact: true });
  await dialog.locator("[data-draft-color-panel]").waitFor();
  await enterHex("#336699"); assert.equal(await dialog.getByLabel("前景颜色", { exact: true }).inputValue(), "#336699");
  await dialog.getByLabel("前景颜色", { exact: true }).fill("#00ff00"); await waitHex("#00ff00");
  await enterHex("oops"); await hex().press("Escape");
  assert.equal(await dialog.isVisible(), true); assert.equal(await hex().inputValue(), "#00ff00");
  await plane().focus();
  for (const key of ["e", "b", "Delete", "Space"]) await page.keyboard.press(key);
  assert.equal(await dialog.locator('.draft-preview.is-pan-ready, .draft-preview.is-panning').count(), 0);
  assert.equal(await dialog.getByRole("button", { name: "画笔", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await dialog.locator(".draft-layer-row").count(), 2);
  await page.keyboard.press("Tab");
  assert.equal(await hue().evaluate(element => element === document.activeElement), true);
  assert.equal(await dialog.locator('[data-draft-library][aria-hidden="false"]').count(), 0);
  await dialog.getByRole("button", { name: "吸管", exact: true }).click();
  await dialog.locator("[data-draft-canvas]").click({ position: { x: 300, y: 300 } });
  await waitHex("#ffffff");
  assert.equal(await hex().inputValue(), "#ffffff", "eyedropper and panel share the foreground color");
  await page.screenshot({ path: "/private/tmp/bowerbird-draft-color-ui/editor-color-panel.png" });
  assert.deepEqual(errors, []);
  console.log("PASS draft color: HSV/gray hue retention, pointer capture, keyboard adjustment, valid/invalid HEX, common/recent colors and persistence, disabled state, light/dark, full-editor shared foreground/eyedropper and shortcut isolation.");
} catch (error) {
  console.error(await page.evaluate(() => ({ color: document.querySelector('input[aria-label="前景颜色"]')?.value,
    hex: document.querySelector('input[aria-label="HEX 颜色"]')?.value,
    tool: document.querySelector('.draft-tools button[aria-pressed="true"]')?.getAttribute('aria-label') })), errors);
  await page.screenshot({ path: "/private/tmp/bowerbird-draft-color-ui/failure.png" });
  throw error;
} finally { await browser.close(); await server.close(); }
