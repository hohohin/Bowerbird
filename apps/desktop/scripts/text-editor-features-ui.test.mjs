import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), cacheDir: '.tmp/text-editor-features-vite', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(12000);
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
const toolbar = page.getByRole('toolbar', { name: '文字格式', exact: true });
async function fresh() { await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/text-workspace-live/preview.html?markdown`, { timeout: 60000 }); await editor.locator('[data-slate-node="element"]').first().click(); }
async function reopen() { await page.getByRole('button', { name: '返回', exact: true }).click(); await page.getByRole('button', { name: '放大编辑', exact: true }).click(); await editor.waitFor(); }
try {
  await fresh();
  await page.keyboard.type('Local review');
  await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
  await toolbar.getByRole('button', { name: '评论', exact: true }).click();
  const comment = page.getByRole('textbox', { name: '评论内容', exact: true });
  await comment.click(); await page.keyboard.type('Keep this detail'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.draft?.markdown.includes('bowerbird-document'));
  await page.keyboard.press('Escape'); await reopen();
  await editor.getByText('Local review', { exact: true }).click();
  await page.getByText('Keep this detail', { exact: true }).waitFor();
  console.log('PASS local comment persistence and reopening');

  await fresh(); await page.keyboard.type('@Mina');
  await page.getByRole('option', { name: 'Mina', exact: true }).click();
  await reopen(); assert.equal(await editor.locator('[data-slate-value="Mina"]').count(), 1);
  console.log('PASS local mention creation and persistence');

  await fresh(); await page.keyboard.type('Original');
  await toolbar.locator('[aria-label="编辑模式"]').click();
  await page.getByRole('menuitemradio', { name: '修订', exact: true }).click();
  await editor.locator('[data-slate-string]').click(); await page.keyboard.press('End'); await page.keyboard.type(' revised');
  await reopen(); assert.match(await editor.innerText(), /revised/);
  await editor.getByText(' revised', { exact: true }).click();
  await page.getByRole('button', { name: '接受', exact: true }).click();
  assert.match(await editor.innerText(), /Original revised/);
  console.log('PASS suggestion persistence and acceptance');
  assert.deepEqual(errors, []);
} finally {
  await mkdir('.tmp/text-editor-features', { recursive: true });
  await page.screenshot({ path: '.tmp/text-editor-features/current.png' });
  console.log('PAGE_ERRORS', errors);
  await browser.close(); await server.close();
}
