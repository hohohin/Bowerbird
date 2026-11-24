import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), cacheDir: '.tmp/text-editor-features-vite', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(12000);
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
const selection = page.getByRole('toolbar', { name: '选中文字格式', exact: true });
const selectionTools = page.getByRole('dialog', { name: '更多选区工具', exact: true });
async function fresh() { await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/text-workspace-live/preview.html?markdown`, { timeout: 60000 }); await editor.locator('[data-slate-node="element"]').first().click(); }
async function reopen() { await page.getByRole('button', { name: '返回', exact: true }).click(); await page.getByRole('button', { name: '放大编辑', exact: true }).click(); await editor.waitFor(); }
try {
  await fresh();
  await page.keyboard.type('Local review');
  await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
  await selection.getByRole('button', { name: '更多选区工具', exact: true }).click();
  await selectionTools.getByRole('button', { name: '评论', exact: true }).click();
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
  await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
  await selection.getByRole('button', { name: '更多选区工具', exact: true }).click();
  await selectionTools.getByRole('button', { name: '修订', exact: true }).click();
  await editor.locator('[data-slate-string]').click(); await page.keyboard.press('End'); await page.keyboard.type(' revised');
  await reopen(); assert.match(await editor.innerText(), /revised/);
  await editor.getByText(' revised', { exact: true }).click();
  await page.getByRole('button', { name: '接受', exact: true }).click();
  assert.match(await editor.innerText(), /Original revised/);
  console.log('PASS suggestion persistence and acceptance');

  await fresh();
  await page.keyboard.type('Keep this selection');
  await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
  const more = selection.getByRole('button', { name: '更多选区工具', exact: true });
  const action = (name) => selectionTools.getByRole('button', { name, exact: true });
  const outerOrder = () => selection.getByRole('button').evaluateAll(buttons =>
    buttons.map(button => button.getAttribute('aria-label')).slice(1, -1));
  await selection.waitFor();
  const documentLeaves = () => editor.locator('[data-slate-node="text"]').evaluateAll(nodes => nodes.map(node => node.innerHTML));
  const before = await documentLeaves();
  assert.deepEqual(await outerOrder(), ['加粗', '斜体', '链接']);
  await more.click();
  for (const name of ['下划线', '字号', '底色', '字色', '删除线']) await action('添加' + name).click();
  assert.ok(await action('添加高亮').isDisabled());
  const grip = name => action('调整' + name + '的顺序');
  await grip('字号').scrollIntoViewIfNeeded();
  const start = await grip('字号').boundingBox();
  const end = await grip('加粗').boundingBox();
  await page.mouse.move(start.x + 8, start.y + 12);
  await page.mouse.down();
  await page.mouse.move(end.x + 8, end.y + 4, { steps: 14 });
  await page.mouse.up();
  assert.equal((await outerOrder())[0], '字号');
  await grip('字号').press('ArrowDown');
  assert.equal((await outerOrder())[1], '字号');
  await grip('字号').click();
  await action('上移').click();
  const expected = ['字号', '加粗', '斜体', '链接', '下划线', '底色', '字色', '删除线'];
  assert.deepEqual(await outerOrder(), expected);
  assert.deepEqual(await documentLeaves(), before);
  await page.keyboard.press('Escape');
  await selection.getByRole('button', { name:'下划线', exact:true }).click();
  assert.equal(await editor.locator('u').innerText(), 'Keep this selection');
  await selection.getByRole('button', { name:'字号', exact:true }).click();
  const sizeField = page.getByRole('textbox', { name:'字号', exact:true });
  await sizeField.fill('21'); await sizeField.press('Enter');
  assert.equal(await editor.locator('[data-slate-string]').first().evaluate(el => getComputedStyle(el).fontSize), '21px');
  await selection.getByRole('button', { name:'字号', exact:true }).click();
  await sizeField.fill('48'); await sizeField.press('Escape');
  assert.equal(await editor.locator('[data-slate-string]').first().evaluate(el => getComputedStyle(el).fontSize), '21px');
  await selection.getByRole('button', { name:'底色', exact:true }).click();
  await page.getByRole('menuitem', {name:'yellow', exact:true}).click();
  await page.waitForFunction(() => document.querySelector('[contenteditable=true] [style*="background-color"]'));
  console.log('PASS eight-format limit, drag, keyboard and click ordering, retained selection and pinned formatting');

  await page.goto(new URL('scripts/fixtures/text-library/preview.html', server.resolvedUrls.local[0]).href);
  await editor.locator('[data-slate-string]').first().click();
  await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
  await selection.waitFor();
  assert.deepEqual(await outerOrder(), expected);
  await page.setViewportSize({ width:375, height:800 });
  await more.click();
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height:800 });
    await page.waitForFunction(width => ['[aria-label="选中文字格式"]', '[role=dialog][aria-label="更多选区工具"]'].every(selector => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box?.width && box.x >= -1 && box.right <= width + 1;
    }), width);
  }
  for (const name of expected) await action('移除' + name).click();
  assert.deepEqual(await outerOrder(), []);
  assert.ok(await action('添加下划线').isEnabled());
  await action('下划线').click();
  assert.ok(await editor.locator('u').count() > 0);
  await fresh();
  await page.keyboard.type('Empty preference');
  await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
  await selection.waitFor();
  assert.deepEqual(await outerOrder(), []);
  console.log('PASS shared preferences in asset detail and workspace, narrow layout, direct menu format and saved empty toolbar');
  assert.deepEqual(errors, []);
} finally {
  await mkdir('.tmp/text-editor-features', { recursive: true });
  await page.screenshot({ path: '.tmp/text-editor-features/current.png' });
  console.log('PAGE_ERRORS', errors);
  await browser.close(); await server.close();
}
