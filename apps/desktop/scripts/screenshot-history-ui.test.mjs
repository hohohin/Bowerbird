import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ cacheDir: '.tmp/screenshot-history/vite', server: { host: '127.0.0.1', port: 17962, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
try {
  await page.goto('http://127.0.0.1:17962/scripts/fixtures/screenshot-history/preview.html');
  const autoSave = page.getByRole('checkbox', { name: '截图自动保存到素材库' });
  await autoSave.waitFor({ timeout: 5000 });
  assert.equal(await autoSave.isChecked(), true, 'missing legacy setting defaults on');
  await autoSave.uncheck();
  await page.waitForFunction(() => window.settings.screenshot_auto_save === false);
  await page.evaluate(() => window.fail = 'update_settings');
  await autoSave.click();
  await page.getByRole('alert').waitFor();
  assert.equal(await autoSave.isChecked(), false, 'failed persistence keeps previous setting');
  assert.doesNotMatch(await page.getByRole('alert').innerText(), /OS error|private/);
  await page.evaluate(() => window.fail = '');
  await page.getByRole('button', { name: '历史截图', exact: true }).click();
  const history = page.getByRole('dialog', { name: '历史截图' });
  await history.getByAltText('历史截图预览').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('img[alt="历史截图预览"]').length === 2);
  await mkdir('.tmp/screenshot-history', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.waitForTimeout(220); // Existing theme color transitions last 160 ms.
    await page.screenshot({ path: `.tmp/screenshot-history/history-${theme}.png` });
  }
  await history.getByRole('button', { name: '查看这张历史截图' }).first().click();
  await page.waitForFunction(() => window.calls.some(c => c.command === 'screenshot_history_image' && c.args.thumbnail === false));
  await page.keyboard.press('.');
  await history.getByText('2 / 2', { exact: true }).waitFor();
  await history.getByRole('button', { name: '返回列表' }).click();
  for (const [name, action] of [['复制', 'copy'], ['保存', 'save'], ['钉住', 'pin']]) {
    await history.getByRole('button', { name, exact: true }).first().click();
    await page.waitForFunction(action => window.calls.some(c => c.command === 'screenshot_history_output' && c.args.action === action), action);
  }
  await history.getByRole('button', { name: '删除这张历史截图' }).first().click();
  await page.waitForFunction(() => window.shots.length === 1);
  await history.getByRole('button', { name: '清空历史', exact: true }).click();
  assert.equal(await page.evaluate(() => window.shots.length), 1, 'clear requires explicit confirmation');
  await history.getByRole('button', { name: '确认清空' }).click();
  await history.getByText('暂无历史截图', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await history.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: '历史截图', exact: true }).evaluate(el => el === document.activeElement), true);
  assert.equal(await page.evaluate(() => window.calls.some(c => c.command === 'screenshot_cancel')), false);
  console.log('PASS: screenshot auto-save defaults/persistence/failure, history preview/actions/delete/clear, focus and Esc');
} finally { await browser.close(); await server.close(); }
