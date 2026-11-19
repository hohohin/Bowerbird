import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), cacheDir: '.tmp/text-editor-tail-vite', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
const blocks = editor.locator('.text-document-block');
async function blankClick(button = 'left') {
  const body = await editor.boundingBox(), last = await blocks.last().boundingBox();
  await page.mouse.click(body.x + body.width / 2, Math.min(last.y + last.height + 60, body.y + body.height - 12), { button });
}
try {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/text-workspace-live/preview.html?markdown`);
  await blocks.first().waitFor();
  await blankClick(); await blankClick();
  assert.equal(await blocks.count(), 1, 'blank initial document does not grow');
  await page.keyboard.type('first');
  await blankClick('right');
  assert.equal(await blocks.count(), 1, 'right click does not insert');
  await blankClick();
  assert.equal(await blocks.count(), 2, 'content gets one trailing paragraph');
  await blankClick(); await blankClick();
  assert.equal(await blocks.count(), 2, 'repeated clicks reuse trailing empty paragraph');
  await page.keyboard.type('second');
  assert.equal(await blocks.last().locator('[data-slate-string]').innerText(), 'second', 'caret is in the trailing paragraph');
  await blankClick();
  assert.equal(await blocks.count(), 3);
  await page.keyboard.press('Control+z');
  assert.equal(await blocks.count(), 2, 'appending a paragraph is one undo');
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await blocks.count(), 3);
  await page.keyboard.type('## Heading');
  await blankClick();
  assert.equal(await blocks.count(), 4);
  await page.keyboard.type('after heading');
  assert.equal(await blocks.last().locator('h1,h2,h3').count(), 0, 'clicking after a heading creates body text');
  await blocks.first().click();
  assert.equal(await blocks.count(), 4, 'content clicks do not append');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByRole('button', { name: '放大编辑', exact: true }).click();
  await editor.waitFor();
  assert.equal(await blocks.count(), 4);
  assert.deepEqual(errors, []);
  console.log('PASS tail click: empty, populated, repeated, caret, undo, heading, reopen');
} finally { await browser.close(); await server.close(); }
