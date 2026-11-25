import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 15997, strictPort: true, hmr: false, watch: null } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:15997/scripts/fixtures/draft-editor/preview.html");
  await page.evaluate(() => window.openDraft());
  const dialog = page.getByRole("dialog", { name: "草稿编辑器", exact: true });
  const canvas = dialog.locator("[data-draft-canvas]"), preview = dialog.locator(".draft-preview");
  const ring = dialog.locator(".draft-brush-cursor");
  const tool = name => dialog.getByRole("button", { name, exact: true }).click();
  const field = name => dialog.getByLabel(name, { exact: true });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const systemCursor = () => canvas.evaluate(node => getComputedStyle(node).cursor);
  const point = async (x, y) => { const b = await canvas.boundingBox(); return { x: b.x + x / 1600 * b.width, y: b.y + y / 1200 * b.height }; };
  const ringAt = async target => {
    const center = await ring.evaluate(node => {
      const point = new DOMPoint(node.cx.baseVal.value, node.cy.baseVal.value).matrixTransform(node.getScreenCTM());
      return { x: point.x, y: point.y };
    });
    assert.ok(Math.hypot(center.x - target.x, center.y - target.y) < 1, `brush circle follows pointer: ${JSON.stringify({ center, target })}`);
  };
  await canvas.waitFor(); await settle();
  await field("前景颜色").fill("#e63322"); await field("画笔大小").fill("30");
  let a = await point(400, 300), b = await point(700, 300);
  await page.mouse.move(a.x, a.y); await settle();
  assert.equal(await ring.count(), 1); assert.equal(await systemCursor(), "none");
  assert.equal(await ring.getAttribute("r"), "15");
  await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 }); await settle(); await ringAt(b);
  await page.mouse.up(); await settle();
  assert.equal(await systemCursor(), "none", "system cursor stays hidden while the brush circle remains after pointerup");
  await ringAt(b);
  const painted = await canvas.evaluate(node => node.toDataURL());

  await page.keyboard.down("Alt"); await settle();
  assert.equal(await ring.count(), 0); assert.notEqual(await systemCursor(), "none", "Alt restores a system cursor");
  a = await point(900, 700); await page.mouse.click(a.x, a.y);
  assert.equal(await field("前景颜色").inputValue(), "#ffffff", "Alt clicks sample pixels instead of painting");
  await page.keyboard.up("Alt"); await settle();
  assert.equal(await ring.count(), 1); assert.equal(await systemCursor(), "none"); await ringAt(a);
  assert.equal(await canvas.evaluate(node => node.toDataURL()), painted);

  await preview.focus(); await page.keyboard.down("Space"); await settle();
  assert.equal(await ring.count(), 0); assert.equal(await systemCursor(), "grab");
  await page.mouse.down(); b = { x: a.x + 60, y: a.y + 30 }; await page.mouse.move(b.x, b.y); await settle();
  assert.equal(await systemCursor(), "grabbing");
  await page.keyboard.up("Space"); await settle();
  assert.equal(await ring.count(), 0); assert.equal(await systemCursor(), "grabbing", "releasing Space during a pan retains its captured gesture");
  await page.mouse.up(); await settle();
  assert.equal(await ring.count(), 1); assert.equal(await systemCursor(), "none"); await ringAt(b);
  assert.equal(await canvas.evaluate(node => node.toDataURL()), painted, "temporary Hand never edits pixels");

  a = await point(800, 600); await page.mouse.move(a.x, a.y); await page.mouse.down({ button: "middle" });
  b = { x: a.x + 35, y: a.y - 20 }; await page.mouse.move(b.x, b.y); await settle();
  assert.equal(await ring.count(), 0); assert.equal(await systemCursor(), "grabbing");
  await page.mouse.up({ button: "middle" }); await settle();
  assert.equal(await systemCursor(), "none"); await ringAt(b);

  await dialog.getByRole("button", { name: "适应窗口", exact: true }).hover(); await settle();
  assert.equal(await ring.count(), 0);
  assert.notEqual(await dialog.getByRole("button", { name: "适应窗口", exact: true }).evaluate(node => getComputedStyle(node).cursor), "none", "view buttons retain their own cursor");
  await tool("适应窗口"); await tool("橡皮"); await field("橡皮大小").fill("74");
  a = await point(800, 600); await page.mouse.move(a.x, a.y); await settle();
  assert.equal(await ring.getAttribute("r"), "37"); assert.equal(await systemCursor(), "none");
  await tool("画笔"); assert.equal(await field("画笔大小").inputValue(), "30", "brush and eraser sizes remain independent in the real editor");
  await tool("移动"); await page.mouse.move(a.x, a.y); await settle();
  assert.equal(await ring.count(), 0); assert.notEqual(await systemCursor(), "none");

  await tool("画笔"); a = await point(500, 500); b = await point(850, 500);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 }); await settle();
  await ringAt(b);
  for (const key of ["Alt", "Space"]) {
    await page.keyboard.down(key); await settle(); assert.equal(await ring.count(), 0);
    await page.keyboard.up(key); await settle();
    await ringAt(b); // Remount must use the latest sample, not the pointerdown coordinates.
    assert.equal(await systemCursor(), "none");
  }
  await page.keyboard.press("Escape"); await page.mouse.up(); await settle();
  assert.equal(await canvas.evaluate(node => node.toDataURL()), painted, "cancel after modifier changes still restores the active stroke");
  await page.evaluate(() => window.dispatchEvent(new Event("blur"))); await settle();
  assert.equal(await ring.count(), 0); assert.notEqual(await systemCursor(), "none", "window blur releases the custom cursor");
  await page.mouse.move(a.x + 5, a.y + 5); await settle(); assert.equal(await ring.count(), 1);
  await field("画笔大小").hover(); await settle();
  assert.equal(await ring.count(), 0); assert.notEqual(await field("画笔大小").evaluate(node => getComputedStyle(node).cursor), "none", "leaving preview restores input cursor");
  assert.deepEqual(errors, []);
  console.log("PASS real editor cursor: brush/eraser replacement, pointerup, Alt sampling, Space/middle pan ownership, controls, active-stroke modifier remount, cancel and blur");
} finally { await browser?.close(); await server.close(); }
