// Tests only the isolated proposal: real Plate, synthetic collections/projects/composer/wires.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const externalUrl = process.env.BOWERBIRD_TEXT_REVIEW_URL;
const server = externalUrl ? null : await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, cacheDir: '.tmp/text-workspace-review-vite' });
if (server) await server.listen();
const base = externalUrl || `${server.resolvedUrls.local[0]}scripts/fixtures/text-workspace-review/preview.html`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(10000);
const errors = [], remote = [], native = [], failures = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => {
  if (new URL(route.request().url()).hostname !== '127.0.0.1') { remote.push(route.request().url()); return route.abort(); }
  return route.continue();
});
await page.exposeFunction('unexpectedNative', command => native.push(command));
await page.addInitScript(() => {
  window.__TAURI_INTERNALS__ = { invoke: command => { window.unexpectedNative(command); throw Error(`Unexpected native IPC: ${command}`); } };
});
await mkdir('.tmp/text-workspace-review', { recursive: true });
const button = name => page.getByRole('button', { name, exact: true });
const editor = () => page.getByRole('textbox', { name: '文档正文', exact: true });
async function reset() { await page.goto(base); await editor().waitFor(); }
async function scenario(name, run) {
  try { await reset(); await run(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(`${name}: ${error.stack}`); await page.screenshot({ path: `.tmp/text-workspace-review/failure-${name}.png` }); console.error(`FAIL ${name}: ${error.message}`); }
}
try {
  await scenario('fresh-source-contract', async () => {
    assert.match(await editor().locator('figure img').getAttribute('src'), /preset-04\.webp/);
    assert.equal(await editor().locator('figure img').getAttribute('alt'), '人物与气氛参考');
    const format = await page.locator('.text-document-format').boundingBox();
    const mode = await button('正文').boundingBox();
    assert.ok(mode.y >= format.y && mode.y + mode.height <= format.y + format.height, 'body/source switch shares the format-toolbar row');
    await button('源码').click();
    assert.match(await page.getByRole('textbox', { name: 'Markdown 源码' }).inputValue(), /data-bowerbird-asset="review-image-3"/);
    await button('画板').click();
    const labels = await page.locator('.port span').evaluateAll(elements => elements.map(element => getComputedStyle(element).whiteSpace));
    assert.deepEqual(labels, ['nowrap', 'nowrap', 'nowrap', 'nowrap']);
  });
  await scenario('plate-caret', async () => {
    await page.getByRole('textbox', { name: '文档名称' }).fill('长文交互验收');
    const paragraph = editor().locator('.text-document-block').filter({ hasText: '窗外的光落在桌面上。' }).first();
    await paragraph.click();
    await paragraph.evaluate(element => {
      const text = element.querySelector('[data-slate-string]').firstChild;
      const range = document.createRange(); range.setStart(text, 6); range.collapse(true);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await page.waitForTimeout(80);
    await page.keyboard.insertText('【插图前】');
    const before = await editor().locator('figure').count();
    await button('插入画面参考 02').dblclick();
    await page.waitForFunction(count => document.querySelectorAll('.text-document-body figure').length === count, before + 1);
    assert.equal(await editor().locator('figure').count(), before + 1, 'double click inserts exactly one image');
    await button('源码').click();
    const source = await page.getByRole('textbox', { name: 'Markdown 源码' }).inputValue();
    assert.match(source, /# 一封写给秋天的信/); assert.match(source, /## 01/); assert.match(source, /\*\*镜头\*\*/);
    assert.match(source, /[-*] 远景/); assert.match(source, />.*有些地方/);
    assert.equal((source.match(/data-bowerbird-asset="review-image-1"/g) || []).length, 1);
    assert.ok(source.indexOf('【插图前】') < source.indexOf('data-bowerbird-asset="review-image-1"'), 'inserted image follows cursor prefix');
    assert.ok(source.indexOf('data-bowerbird-asset="review-image-1"') < source.indexOf('桌面上'), 'inserted image splits paragraph at the caret, before its suffix');
    await button('正文').click();
    await button('收起素材库').click(); assert.equal(await page.getByRole('complementary', { name: '素材库' }).count(), 0);
    await button('打开素材库').click();
    await button('返回').click(); await button('放大编辑').click();
    assert.match(await editor().innerText(), /【插图前】/);
    assert.equal(await editor().locator('figure').count(), before + 1);
  });
  await scenario('save-and-compose', async () => {
    await page.getByRole('textbox', { name: '文档名称' }).fill('保存分镜');
    await button('源码').click();
    const source = page.getByRole('textbox', { name: 'Markdown 源码' });
    await source.fill('# 保存分镜\n\n**保持强调**，以及长提示词。\n\n- 第一镜\n- 第二镜\n\n<img data-bowerbird-asset="review-image-2" data-caption="参考" />\n');
    await button('保存到文件夹').click(); await button('创作笔记').click();
    await page.getByRole('status').filter({ hasText: '已保存到示例集合' }).waitFor();
    await source.fill('临时替换'); await page.locator('.saved-document').click();
    assert.match(await editor().innerText(), /保持强调/);
    assert.equal(await editor().locator('figure').count(), 1);
    await button('保存到项目').click(); await button('产品摄影').click();
    await page.getByRole('status').filter({ hasText: '已保存到示例项目' }).waitFor();
    await button('添加到生成对话框').click();
    assert.match(await page.locator('.composer-body').innerText(), /保持强调/);
    assert.equal(await page.locator('.composer-body strong').innerText(), '保持强调');
    assert.equal(await page.locator('.composer-body img').count(), 1);
    await button('放大编辑').click(); assert.match(await editor().innerText(), /保持强调/);
    await button('画板').click(); assert.match(await page.locator('.workspace-heading').innerText(), /产品摄影/);
    assert.match(await page.locator('.text-node').innerText(), /保存分镜/);
    await button('编辑文本卡片').click(); assert.match(await editor().innerText(), /保持强调/);
    await button('返回').click(); await page.locator('.canvas-stage').waitFor();
  });
  await scenario('canvas-ports', async () => {
    await button('画板').click();
    await button('图片输出').click(); await button('文本输入').click();
    assert.equal(await page.locator('.wires path').count(), 0, 'incompatible types do not connect');
    await button('图片输入').click();
    await button('文本输出').click(); await button('文本输入').click();
    assert.equal(await page.locator('.wires path').count(), 2);
    assert.equal(await page.locator('.reference-chip').count(), 2);
    assert.equal(await page.locator('.linked-images img').count(), 1);
    await button('查看输入').click();
    const dialog = page.getByRole('dialog', { name: '生成卡片输入' });
    await dialog.waitFor(); assert.equal(await dialog.locator('h1').innerText(), '一封写给秋天的信');
    assert.equal(await dialog.locator('strong').innerText(), '镜头');
    assert.equal(await dialog.locator('img').count(), 1);
    await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 0);
    assert.equal(await button('查看输入').evaluate(element => element === document.activeElement), true);
    await button('图片输出').click({ button: 'right' });
    assert.equal(await page.locator('.wires path').count(), 1);
    assert.match(await page.locator('.text-node').innerText(), /窗外的光/);
    await button('图片输出').click(); await button('图片输入').click();
    await page.getByRole('status').waitFor({ state: 'hidden' });
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(100);
      const endpoints = await page.locator('.canvas-stage').evaluate(stage => {
        const stageBox = stage.getBoundingClientRect();
        return ['image', 'text'].map(type => {
          const path = stage.querySelector(`.${type}-wire`), end = path.getPointAtLength(path.getTotalLength()), start = path.getPointAtLength(0);
          const source = stage.querySelector(`.output.${type} i`).getBoundingClientRect(), target = stage.querySelector(`.input.${type} i`).getBoundingClientRect();
          return { start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y }, fromX: source.x + source.width / 2 - stageBox.x, fromY: source.y + source.height / 2 - stageBox.y, toX: target.x + target.width / 2 - stageBox.x, toY: target.y + target.height / 2 - stageBox.y };
        });
      });
      for (const entry of endpoints) {
        assert.ok(Math.abs(entry.start.x - entry.fromX) < 1 && Math.abs(entry.start.y - entry.fromY) < 1);
        assert.ok(Math.abs(entry.end.x - entry.toX) < 1 && Math.abs(entry.end.y - entry.toY) < 1);
      }
      await page.screenshot({ path: `.tmp/text-workspace-review/canvas-dark-${width}.png` });
    }
    await button('切换主题').click(); await page.screenshot({ path: '.tmp/text-workspace-review/canvas-light-900.png' });
  });
  await scenario('responsive-themes', async () => {
    for (const theme of ['dark', 'light']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await button('切换主题').click();
      for (const width of [1440, 900]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(100);
        const overflow = await page.evaluate(() => ({ root: document.documentElement.scrollWidth > innerWidth, header: document.querySelector('.editor-header').scrollWidth > document.querySelector('.editor-header').clientWidth }));
        assert.deepEqual(overflow, { root: false, header: false });
        for (const label of ['保存到文件夹', '保存到项目', '添加到生成对话框']) {
          const bounds = await button(label).boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
        }
        await page.screenshot({ path: `.tmp/text-workspace-review/editor-${theme}-${width}.png` });
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await button('添加到生成对话框').click(); await button('放大编辑').click(); await editor().waitFor();
    await button('对话框').click(); await page.screenshot({ path: '.tmp/text-workspace-review/composer-light-900.png' });
  });
  assert.deepEqual(remote, [], 'no remote requests'); assert.deepEqual(native, [], 'no native IPC'); assert.deepEqual(errors, [], 'no page errors');
  assert.deepEqual(failures, [], failures.join('\n\n'));
  console.log('PASS isolated text-workspace proposal: Plate editing, insertion, save examples, composer round trip, typed wires, themes, no real data or generation');
} finally { await browser.close(); if (server) await server.close(); }
