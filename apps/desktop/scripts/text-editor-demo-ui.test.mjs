import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), cacheDir: '.tmp/text-editor-demo-vite', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('pageerror', e => errors.push(e.stack));
page.on('console', message => { if (message.type() === 'error') console.log(message.text().slice(0, 600)); });
try {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/text-editor-demo/preview.html`);
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.waitFor({ timeout: 45000 });
  await editor.click();
  await page.keyboard.type('/table');
  await page.getByRole('option', { name: '表格', exact: true }).click();
  await page.keyboard.type('A cell');
  assert.equal(await editor.locator('table').count(), 1);
  assert.match(await editor.locator('table').innerText(), /A cell/);
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/text-editor-demo/preview.html`);
  await editor.click();
  await page.keyboard.type('[] Task');
  assert.equal(await editor.getByRole('checkbox').count(), 1, 'task lists render an interactive checkbox');
  await editor.getByRole('checkbox').click();
  assert.equal(await editor.getByRole('checkbox').getAttribute('data-state'), 'checked');
  assert.deepEqual(errors, []);
  console.log('PASS full kit: slash table insertion and editing');
} finally {
  await mkdir('.tmp/text-editor-demo', { recursive: true });
  await page.screenshot({ path: '.tmp/text-editor-demo/current.png' });
  console.log('PAGE_ERRORS', errors);
  await browser.close(); await server.close();
}
