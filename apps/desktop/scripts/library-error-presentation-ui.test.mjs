import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

// Existing fixtures provide isolated IPC; no user library, account or external service is accessed.
const server = await createServer({ cacheDir: '.tmp/library-error-vite', server: { host: '127.0.0.1', port: 1799, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const raw = '读取失败：TypeError debug_payload at native.rs:42 /Users/private/library.db';
const technical = /TypeError|debug_payload|native\.rs|\/Users\/private|SQLITE_BUSY|HotKey|Modifiers/;
const visit = fixture => page.goto(`http://127.0.0.1:1799/scripts/fixtures/${fixture}/preview.html`);
async function safeDisplay(scope) {
  assert.doesNotMatch(await scope.innerText(), technical);
  for (const title of await scope.locator('[title]').evaluateAll(elements => elements.map(el => el.title))) assert.doesNotMatch(title, technical);
}
try {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await visit('project-rename');
  await page.locator('.project-name').waitFor();
  await page.evaluate(raw => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args) => command === 'project_canvas_rename' ? Promise.reject(raw) : invoke(command, args);
  }, raw);
  await page.locator('.project-name').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  const rename = page.getByRole('dialog', { name: '重命名项目', exact: true });
  await rename.getByRole('textbox', { name: '项目名称' }).fill('保留这份草稿');
  await rename.getByRole('button', { name: '保存名称' }).click();
  await rename.getByRole('alert').waitFor();
  await safeDisplay(rename);
  assert.equal(await rename.getByRole('textbox', { name: '项目名称' }).inputValue(), '保留这份草稿');
  assert.equal(await page.evaluate(() => window.persistedProject().name), '测试项目');

  await visit('local-classification');
  const classification = page.getByRole('dialog', { name: '自动分类', exact: true });
  await classification.getByRole('button', { name: '进行分类', exact: true }).waitFor();
  await page.evaluate(raw => {
    Object.assign(window.classificationStatus, { phase: 'error', done: 1, total: 2, failed: 1, message: `${raw}；图片已保留`, last_error: raw });
    window.emitClassification();
  }, raw);
  await classification.getByText('最近未完成原因：部分素材分类未完成，请稍后重试。', { exact: true }).waitFor();
  await safeDisplay(classification);
  assert.equal(await page.evaluate(() => window.classificationStatus.last_error), raw, 'presentation must preserve raw recovery data');
  await page.evaluate(() => {
    Object.assign(window.classificationStatus, { phase: 'complete', done: 2, total: 2, failed: 0, message: '已完成 2 张素材的分类', last_error: '' });
    window.emitClassification();
  });
  await classification.getByText('已完成 2 张素材的分类', { exact: true }).first().waitFor();
  assert.equal(await classification.getByRole('alert').count(), 0);

  await visit('folder-mode');
  await page.getByRole('button', { name: '文件浏览器', exact: true }).click();
  await page.getByRole('button', { name: 'photo.png', exact: true }).waitFor();
  await page.evaluate(raw => { window.recordItems = [{ record_path: 'fixture.json', file: '需要恢复的图片.png', asset_id: null, action: 'blocked', message: raw }]; }, raw);
  await page.getByRole('button', { name: '更多文件操作', exact: true }).click();
  await page.getByRole('button', { name: '随图资料', exact: true }).click();
  const records = page.getByRole('dialog', { name: '随图资料', exact: true });
  await records.getByText('这份资料无法恢复，请检查文件是否完整。', { exact: true }).waitFor();
  await safeDisplay(records);
  assert.equal(await records.getByText('需要恢复的图片.png', { exact: true }).count(), 1);
  await page.evaluate(() => { window.recordPreviewError = 'SQLITE_BUSY: database is locked'; });
  await records.getByRole('button', { name: '重新预览', exact: true }).click();
  await records.getByRole('alert').filter({ hasText: '资料库正忙，请稍候再试。' }).waitFor();
  await safeDisplay(records);

  await visit('screenshot');
  await page.waitForFunction(() => document.querySelector('.snip-stage > canvas')?.width > 0);
  await page.evaluate(raw => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args) => command === 'screenshot_output' ? Promise.reject(raw) : invoke(command, args);
  }, raw);
  await page.mouse.move(180, 180); await page.mouse.down(); await page.mouse.move(650, 520); await page.mouse.up();
  await page.getByRole('button', { name: '复制截图', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '截图操作未完成，请关闭截图窗口后重试。' }).waitFor();
  await safeDisplay(page.locator('body'));
  assert.equal(await page.getByRole('button', { name: '复制截图', exact: true }).isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log('PASS: raw IPC rejection, persisted classification failure, blocked file restore, busy database and screenshot failure show Chinese; inputs, recovery data and success messages preserved');
} finally { await browser.close(); await server.close(); }
