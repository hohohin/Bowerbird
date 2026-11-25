import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const key = "bowerbird.draftBrushPreferences";
const defaults = { size: 16, hardness: 1, opacity: 1, smoothing: .15, pressure: true, inertia: 0 };
const server = await createServer({ server: { host: "127.0.0.1", port: 15996, strictPort: true, hmr: false, watch: null } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const url = "http://127.0.0.1:15996/scripts/fixtures/draft-brush-preferences/preview.html";
  const values = () => page.locator("[data-preferences]").evaluate(node => { const { tool, ...prefs } = JSON.parse(node.textContent); return prefs; });
  const read = () => page.evaluate(key => localStorage.getItem(key), key);
  const tool = name => page.getByRole("button", { name, exact: true }).click();
  const reload = async saved => {
    await page.evaluate(([key, saved]) => localStorage.setItem(key, saved), [key, saved]);
    await page.reload(); await page.locator("[data-preferences]").waitFor();
  };
  await page.goto(url); assert.deepEqual(await values(), defaults);
  assert.equal(await read(), null, "StrictMode mounting does not write default preferences");
  const diameter = page.getByLabel("大小", { exact: true });
  await diameter.fill(""); assert.equal(await diameter.inputValue(), ""); assert.deepEqual(await values(), defaults, "temporary empty input does not change the actual brush");
  await diameter.fill("30"); assert.equal((await values()).size, 30, "valid diameter updates before blur so the next pointerdown uses it");
  assert.equal(await diameter.evaluate(node => document.activeElement === node), true);
  await diameter.fill(""); assert.equal((await values()).size, 30, "clearing the input retains the latest valid diameter");
  await diameter.fill("0"); assert.equal(await diameter.inputValue(), "0"); assert.equal((await values()).size, .5);
  await diameter.fill("0."); assert.equal(await diameter.inputValue(), "0."); assert.equal((await values()).size, .5);
  await diameter.fill("."); assert.equal(await diameter.inputValue(), "."); assert.equal((await values()).size, .5, "a bare decimal point remains editable without changing the diameter");
  await diameter.fill(".5"); assert.equal(await diameter.inputValue(), ".5"); assert.equal((await values()).size, .5, "live updates never replace the editable decimal text");
  await diameter.press("Enter"); assert.equal((await values()).size, .5); assert.equal(await diameter.inputValue(), "0.5");
  await diameter.press("ArrowUp"); assert.equal((await values()).size, 1);
  await diameter.press("ArrowDown"); assert.equal((await values()).size, .5);
  for (const invalid of ["", ".", "not a number"]) {
    await diameter.fill(invalid); await diameter.press("Tab");
    assert.equal(await diameter.inputValue(), "0.5"); assert.equal((await values()).size, .5, "invalid blur restores the committed diameter");
  }
  await diameter.fill("1.24"); assert.equal((await values()).size, 1); assert.equal(await diameter.inputValue(), "1.24", "live normalization updates the model while preserving input text");
  await diameter.press("Enter"); assert.equal(await diameter.inputValue(), "1", "Enter normalizes the displayed diameter");
  for (const [name, value] of [["大小", "23"], ["硬度", ".4"], ["不透明度", ".65"], ["平滑", ".3"]]) await page.getByLabel(name, { exact: true }).fill(value);
  await page.getByLabel("压感", { exact: true }).uncheck(); await page.getByLabel("惯性", { exact: true }).fill(".35");
  const brush = { size: 23, hardness: .4, opacity: .65, smoothing: .3, pressure: false, inertia: .35 };
  assert.deepEqual(await values(), brush);
  await tool("橡皮"); assert.deepEqual(await values(), defaults, "editing brush values does not mutate the eraser bank");
  for (const [name, value] of [["大小", "81"], ["硬度", ".1"], ["不透明度", ".2"], ["平滑", ".7"]]) await page.getByLabel(name, { exact: true }).fill(value);
  await page.getByLabel("惯性", { exact: true }).fill(".8");
  const eraser = { size: 81, hardness: .1, opacity: .2, smoothing: .7, pressure: true, inertia: .8 };
  await tool("画笔"); assert.deepEqual(await values(), brush);
  await tool("连续增大两次"); brush.size = 25;
  assert.deepEqual(await values(), brush, "batched functional size setters use the latest value");
  await page.waitForFunction(key => JSON.parse(localStorage.getItem(key))?.brush.size === 25, key);
  assert.deepEqual(JSON.parse(await read()), { version: 1, brush, eraser });
  await tool("关闭编辑器"); await tool("重开编辑器");
  assert.deepEqual(await values(), brush, "editor remount restores brush preferences");
  await tool("橡皮"); assert.deepEqual(await values(), eraser);
  await page.reload(); assert.deepEqual(await values(), brush, "full page reload restores persisted preferences");
  await tool("橡皮"); assert.deepEqual(await values(), eraser);

  await reload(JSON.stringify({ version: 1, brush: { size: 99999, hardness: -1, opacity: 0, smoothing: 4, pressure: "false", inertia: 9 },
    eraser: { size: "50", hardness: null, opacity: .6, smoothing: .1 }, unrelated: "ignored" }));
  assert.deepEqual(await values(), { size: 500, hardness: 0, opacity: .01, smoothing: .8, pressure: true, inertia: 1 }, "finite persisted values are bounded to editor ranges");
  await tool("橡皮"); assert.deepEqual(await values(), { ...defaults, opacity: .6, smoothing: .1 }, "invalid field types fall back independently and old preferences gain new defaults");
  await page.evaluate(() => { window.setPreference("size", NaN); window.setPreference("hardness", Infinity); window.setPreference("opacity", "1"); });
  assert.deepEqual(await values(), { ...defaults, opacity: .6, smoothing: .1 }, "invalid runtime inputs preserve current field values");
  await page.evaluate(() => { window.setPreference("size", -99); window.setPreference("smoothing", 1); });
  await page.waitForFunction(() => JSON.parse(document.querySelector("[data-preferences]").textContent).size === .5);
  assert.deepEqual(await values(), { ...defaults, size: .5, opacity: .6, smoothing: .8 });
  for (const invalid of ["{broken", "null", "[]", JSON.stringify({ version: 2, brush: { size: 99 } })]) {
    await reload(invalid); assert.deepEqual(await values(), defaults);
    await tool("橡皮"); assert.deepEqual(await values(), defaults);
    assert.equal(await read(), invalid, "invalid or future storage is not overwritten just by opening the editor");
  }
  await reload(JSON.stringify({ version: 1, brush: [], eraser: { size: 73 } }));
  assert.deepEqual(await values(), defaults);
  await tool("橡皮"); assert.deepEqual(await values(), { ...defaults, size: 73 }, "one malformed tool never discards valid preferences from the other");

  for (const failure of ["getItem", "setItem"]) {
    const isolated = await browser.newPage(), failures = [];
    isolated.on("pageerror", error => failures.push(error.message));
    await isolated.addInitScript(({ key, failure }) => {
      const original = Storage.prototype[failure];
      Storage.prototype[failure] = function (storageKey, ...args) {
        if (storageKey === key) throw new DOMException("Synthetic storage unavailable", "SecurityError");
        return original.call(this, storageKey, ...args);
      };
    }, { key, failure });
    await isolated.goto(url);
    await isolated.getByLabel("大小", { exact: true }).fill("47");
    await isolated.getByRole("button", { name: "橡皮", exact: true }).click();
    await isolated.getByLabel("大小", { exact: true }).fill("92");
    await isolated.getByRole("button", { name: "画笔", exact: true }).click();
    assert.equal(await isolated.getByLabel("大小", { exact: true }).inputValue(), "47", `${failure} failure does not break independent in-memory editing`);
    assert.deepEqual(failures, []); await isolated.close();
  }
  assert.deepEqual(errors, []);
  console.log("PASS StrictMode tool preferences: independent six-value banks, editable half-pixel diameter, functional updates, close/reopen/reload, old schema, validation and storage failures");
} finally { await browser?.close(); await server.close(); }
