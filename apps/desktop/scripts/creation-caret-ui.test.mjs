import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

// 创作对话框点击正文的光标定位回归：宿主外层曾用 onClick=focus()，冒泡后 EditorView.focus()
// 会把 ProseMirror 旧选区写回 DOM、覆盖点击落点——点击正文任意位置光标都跳回文本末尾
// （视觉上「跳到下一行」，同官网 2026-08-02 踩坑）。现在正文点击完全交给 ProseMirror
// 原生定位，只有点到内容区外的宿主空白才手动聚焦。此测试逐点核对点击落点。
const server = await createServer({ server: { host: "127.0.0.1", port: 1595, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto("http://127.0.0.1:1595/scripts/fixtures/canvas-reference/preview.html");
  await page.waitForFunction(() => document.querySelector('.canvas-workspace[aria-busy="false"]'));
  const dock = page.locator('.creation-dock');
  await dock.waitFor();
  const editor = dock.locator(".ProseMirror");

  // 60 个全角字符在对话框宽度下折成两行；点击前先失焦再点正文，覆盖「点击重新定位」路径。
  await editor.click();
  await editor.fill("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十");
  await page.locator('[data-canvas-stage]').click({ position: { x: 60, y: 60 } });
  await editor.click();
  const box = await editor.boundingBox();

  const probes = [
    ["第一行左端", 0.05, 16],
    ["第一行中部", 0.5, 16],
    ["第二行中部", 0.5, 48],
  ];
  let sawMidText = false;
  for (const [label, widthRatio, dy] of probes) {
    const x = box.x + box.width * widthRatio;
    const y = box.y + dy;
    const expected = await page.evaluate(([x, y]) => document.caretRangeFromPoint(x, y).startOffset, [x, y]);
    await page.mouse.click(x, y);
    await page.waitForTimeout(120);
    const caret = await editor.evaluate(() => document.getSelection().anchorOffset);
    assert.equal(caret, expected, `${label}：光标应落在点击处 ${expected}，实际 ${caret}`);
    if (expected < 55) sawMidText = true;
  }
  assert.equal(sawMidText, true, "至少一个探测点必须落在正文中段（否则测试无效）");
  assert.deepEqual(errors, []);
  console.log("PASS: clicks inside composer text land the caret at the clicked offset");
} finally {
  await browser.close();
  await server.close();
}
