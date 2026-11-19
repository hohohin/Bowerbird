import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/text-context-menu/vite', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, reducedMotion: 'reduce' });
page.setDefaultTimeout(15000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const url = path => `${server.resolvedUrls.local[0]}scripts/fixtures/${path}/preview.html`;
async function observe() {
  await page.evaluate(() => {
    window.contextEvents = [];
    window.addEventListener('contextmenu', event => window.contextEvents.push(event), true);
    document.addEventListener('copy', event => {
      const el = document.activeElement;
      window.copiedText = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? el.value.slice(el.selectionStart, el.selectionEnd) : getSelection().toString();
      event.preventDefault(); // Verify the copy event without replacing the user's clipboard.
    });
  });
}
async function install() {
  await page.evaluate(async () => { window.removeTextMenu = (await import('/src/lib/textContextMenu.ts')).installTextContextMenu(); });
}
async function rightClickSelection(locator, expected, field = false) {
  await locator.evaluate((el, field) => {
    if (field) { el.focus(); el.select(); }
    else { el.closest('[contenteditable]')?.focus(); const range = document.createRange(); range.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(range); }
    window.contextEvents = [];
  }, field);
  // Synchronize the rich editor selection before sending native input.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await locator.click({ button: 'right', position: { x: 12, y: 10 } });
  await page.waitForFunction(() => window.contextEvents.length > 0);
  assert.equal(await page.evaluate(() => window.contextEvents.at(-1).defaultPrevented), false, 'native menu remains available');
  assert.equal(await page.getByRole('menu').count(), 0, 'no card or block menu');
  await page.keyboard.press('Control+c');
  assert.equal(await page.evaluate(() => window.copiedText), expected, 'copy keeps the original selection');
}
try {
  await page.goto(url('canvas-reference'));
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    snapshot.nodes = [{ ...snapshot.nodes[0], id: 'text', kind: 'note', role: null, assetId: null, x: 100, y: 80, width: 450, height: 220,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], cells: [[{ id: 'a', text: '画板文字可以复制', content_type: 'text', bold: false, italic: false, align: 'left' }]] }) }];
    snapshot.edges = []; snapshot.view = { ...snapshot.view, zoom: 1, panX: 0, panY: 0 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
  });
  await page.reload();
  const field = page.getByRole('textbox', { name: '第 1 行第 1 列', exact: true });
  await field.waitFor(); await observe();
  // Reproduce on the real canvas before installing the shared event boundary.
  await field.click({ button: 'right' });
  await page.getByRole('menu').waitFor();
  assert.equal(await page.evaluate(() => window.contextEvents.at(-1).defaultPrevented), true);
  await page.keyboard.press('Escape'); await install();
  await rightClickSelection(field, '画板文字可以复制', true);
  await page.locator('[data-canvas-node-id="text"]').click({ button: 'right', position: { x: 10, y: 8 } });
  await page.getByRole('menu').waitFor(); await page.keyboard.press('Escape');

  // The same rule covers settings/dialog fields outside the React root and nested rich text.
  await page.evaluate(() => {
    const host = document.createElement('section'); host.id = 'fields';
    host.style.cssText = 'position:fixed;z-index:10000;inset:60px 30px auto auto;background:white;color:black;padding:12px;width:400px';
    host.innerHTML = `<input id="plain" value="普通文本框" /><input id="readonly" readonly value="只读文本框" />
      <input id="search" type="search" value="搜索文字" /><textarea id="multiline">多行文字</textarea>
      <div contenteditable="true"><p id="rich">富文本<strong>选中内容</strong></p><span id="control" contenteditable="false">媒体控件</span></div>
      <div id="plaintext" contenteditable="plaintext-only">纯文本编辑</div>
      <div class="local-chat-text"><p id="reading">已选中的对话正文</p></div><button id="blank">卡片操作</button>`;
    host.querySelectorAll('input,textarea').forEach(el => el.style.cssText = 'display:block;width:300px;height:32px');
    host.oncontextmenu = event => { event.preventDefault(); window.containerMenuCount++; };
    window.containerMenuCount = 0; document.body.append(host);
  });
  for (const [id, text] of [['plain','普通文本框'],['readonly','只读文本框'],['search','搜索文字'],['multiline','多行文字']]) {
    await rightClickSelection(page.locator(`#${id}`), text, true);
  }
  for (const [id, text] of [['rich','富文本选中内容'],['plaintext','纯文本编辑'],['reading','已选中的对话正文']]) {
    await rightClickSelection(page.locator(`#${id}`), text);
  }
  assert.equal(await page.evaluate(() => window.containerMenuCount), 0);
  await page.locator('#blank').click({ button: 'right' });
  assert.equal(await page.evaluate(() => window.containerMenuCount), 1, 'selection elsewhere cannot steal the card menu');
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.locator('#control').click({ button: 'right' });
  assert.equal(await page.evaluate(() => window.containerMenuCount), 2, 'noneditable media controls keep their menu');
  await page.locator('#plain').focus(); await page.keyboard.press('Shift+F10');
  assert.equal(await page.evaluate(() => window.contextEvents.at(-1).defaultPrevented), false, 'keyboard context menu');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.removeTextMenu(); });
  await page.locator('#plain').click({ button: 'right' });
  assert.equal(await page.evaluate(() => window.containerMenuCount), 3, 'cleanup removes the listener');

  await page.goto(url('creation-editor')); await page.locator('.ProseMirror').waitFor();
  await observe(); await install();
  await rightClickSelection(page.locator('.ProseMirror p'), '你好');

  await page.goto(url('text-workspace-live')); await page.locator('.text-workspace [data-slate-editor]').waitFor();
  await observe(); await install();
  const slateText = page.locator('[data-slate-string]').first();
  const slateValue = await slateText.innerText();
  await rightClickSelection(slateText, slateValue);

  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(url('screenshot'));
  await page.waitForFunction(() => window.calls.some(call => call.command === 'screenshot_show'));
  await observe(); await install();
  await page.mouse.move(80, 80); await page.mouse.down(); await page.mouse.move(600, 440, { steps: 8 }); await page.mouse.up();
  await page.getByRole('button', { name: '文字', exact: true }).click();
  await page.mouse.click(160, 190);
  const annotation = page.getByRole('textbox', { name: '标注文字' });
  await annotation.fill('标注文字保持编辑');
  await rightClickSelection(annotation, '标注文字保持编辑', true);
  assert.equal(await annotation.count(), 1, 'right click must not finish screenshot text editing');
  assert.deepEqual(errors, []);
  console.log('PASS: reproduced canvas menu interception; native text menus preserve selection/copy in canvas, input/readonly/search/textarea, nested editable, reading text, ProseMirror, Plate and screenshot annotations; card/control menus, keyboard and cleanup retained');
} finally { await browser.close(); await server.close(); }
