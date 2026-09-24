import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

// 「生成选项」弹层（ImageGenOptions：张数分段格 + 透明图层复选框）回归：张数不再
// 常驻工具条（默认态触发钮只显示「选项」），弹层内四格等宽、点选生效并关闭、复选框
// 勾选随请求下发；仅即梦 / Cloud 生图引擎显示（codex 隐藏）。
const server = await createServer({ server: { host: "127.0.0.1", port: 1590, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto("http://127.0.0.1:1590/scripts/fixtures/canvas-reference/preview.html");
  await page.waitForFunction(() => document.querySelector('.canvas-workspace[aria-busy="false"]'));
  await page.evaluate(() => {
    window.store.setState({
      activeGenProvider: "jimeng",
      dreaminaHealth: { ok: true },
      cloudEntitlement: { plan: "pro", policy: { can_use_byo: true }, balances: { daily: 100, sub: 0, topup: 0 } },
    });
  });
  const dock = page.locator('.creation-dock');
  await dock.waitFor();
  await dock.locator('.ProseMirror').click();
  await page.waitForTimeout(200);

  const trigger = dock.locator('[title^="生成选项"]');
  await trigger.waitFor();
  assert.equal((await trigger.innerText()).trim(), "选项"); // 默认态：张数不显示，只有「选项」占位。

  // 比例与生成选项两个选择器必须水平并排（外层容器缺 flex 时会竖着叠成同一列）。
  const rowLayout = await page.evaluate(() => {
    const ratio = document.querySelector('[title="选择画面比例"]').getBoundingClientRect();
    const options = document.querySelector('[title^="生成选项"]').getBoundingClientRect();
    return { sameRow: Math.abs(ratio.y - options.y) < 2, optionsRightOfRatio: options.x > ratio.x };
  });
  assert.equal(rowLayout.sameRow, true, "比例与生成选项按钮应并排在同一行");
  assert.equal(rowLayout.optionsRightOfRatio, true, "生成选项按钮应在比例按钮右侧");

  await trigger.click();
  const popover = page.locator(".app-popover");
  await popover.waitFor();

  // 透明图层复选框：默认未勾选；勾选后保持弹层打开，触发钮回显「透明」。
  const checkbox = popover.locator('[aria-label="透明图层"]');
  await checkbox.waitFor();
  assert.equal(await checkbox.isChecked(), false);
  await checkbox.click();
  await page.waitForTimeout(150);
  assert.equal(await popover.count(), 1, "勾选透明图层不应关闭弹层");
  assert.equal(await checkbox.isChecked(), true);
  assert.equal((await trigger.innerText()).trim(), "透明");

  const options = popover.locator('[role="option"]');
  assert.equal(await options.count(), 4);

  // 四格等宽（分段格核心预期），字号与工具栏其余控件一致（12px）。
  const geometry = await options.evaluateAll((cells) => cells.map((el) => ({
    width: el.getBoundingClientRect().width,
    fontSize: getComputedStyle(el).fontSize,
  })));
  for (const cell of geometry) {
    assert.equal(cell.width, geometry[0].width, "分段格必须等宽");
    assert.equal(cell.fontSize, "12px", "分段格字号应与工具栏控件一致");
  }
  assert.equal(await options.first().getAttribute("aria-selected"), "true");

  // 点选 3 张：生效、弹层关闭、触发钮同步为「透明 · 3 张」。
  await options.nth(2).click();
  await page.waitForTimeout(150);
  assert.equal(await popover.count(), 0, "点选后弹层应关闭");
  assert.equal((await trigger.innerText()).trim(), "透明 · 3 张");
  await trigger.click();
  await popover.waitFor();
  assert.equal(await popover.locator('[aria-selected="true"]').innerText(), "3 张");
  await page.keyboard.press("Escape");
  assert.equal(await popover.count(), 0, "Esc 应关闭弹层");

  // codex 引擎不显示生成选项（提示词驱动张数，也不支持透明参数）。
  await page.evaluate(() => window.store.setState({ activeGenProvider: "codex" }));
  await page.waitForTimeout(150);
  assert.equal(await trigger.count(), 0, "codex 引擎下应隐藏生成选项");

  assert.deepEqual(errors, []);
  console.log("PASS: image options popover keeps count hidden by default, toggles transparent, and hides on codex");
} finally {
  await browser.close();
  await server.close();
}
