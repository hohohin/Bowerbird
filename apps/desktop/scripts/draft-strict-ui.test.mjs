import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 15995, strictPort: true, hmr: false, watch: null } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const observations = [];
  for (const strict of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:15995/scripts/fixtures/draft-strict/preview.html?strict=${strict ? 1 : 0}`);
    await page.evaluate(() => window.openDraft());
    const dialog = page.getByRole("dialog", { name: "草稿编辑器", exact: true });
    const canvas = dialog.locator("[data-draft-canvas]"); await canvas.waitFor();
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const pixel = (x, y) => canvas.evaluate((node, [x, y]) => [...node.getContext("2d").getImageData(x, y, 1, 1).data], [x, y]);
    await settle(); const background = await pixel(0, 0);
    assert.deepEqual(await canvas.evaluate(c => [c.width, c.height]), [1600, 1200], "default canvas is ready without a setup form");
    assert.equal(await dialog.locator(".draft-canvas-settings").count(), 0);
    await dialog.getByLabel("前景颜色", { exact: true }).fill("#e63322");
    await dialog.getByLabel("画笔大小", { exact: true }).fill("20");
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width * .25, box.y + box.height * .5); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .75, box.y + box.height * .5, { steps: 8 });
    await settle(); const activeStroke = await pixel(800, 600);
    await page.mouse.up(); await settle(); const finishedStroke = await pixel(800, 600);
    await dialog.getByRole("button", { name: "保存工程", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    const saved = await page.evaluate(async () => {
      const image = new Image(); image.src = window.saves.at(-1).dataUrl; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
      return [...context.getImageData(800, 600, 1, 1).data];
    });
    await page.evaluate(() => window.openDraft("synthetic-draft")); await canvas.waitFor(); await settle();
    const reopened = await pixel(800, 600);
    observations.push({ strict, background, activeStroke, finishedStroke, saved, reopened, errors });
    await page.close();
  }
  console.log(JSON.stringify({ source: "current component", observations }, null, 2));
  for (const sample of observations) {
    assert.deepEqual(sample.errors, []);
    assert.deepEqual(sample.background, [255, 255, 255, 255], `StrictMode=${sample.strict}: default white background paints immediately`);
    for (const key of ["activeStroke", "finishedStroke", "saved", "reopened"])
      assert.deepEqual(sample[key], [230, 51, 34, 255], `StrictMode=${sample.strict}: ${key} has visible brush pixels`);
  }
  console.log("PASS normal and StrictMode lifecycle: initial background, active/final stroke, saved PNG and reopened composite");
} finally { await browser?.close(); await server.close(); }
