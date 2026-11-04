import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer as createSocket } from 'node:net';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const socket = createSocket();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const server = await createServer({ server: { host: '127.0.0.1', port, hmr: false, watch: null } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', error => console.error('Browser:', error.message));
  page.on('console', message => { if (message.type() === 'error') console.error('Browser console:', message.text()); });
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const embedded = process.env.TAG_PICKER_EMBEDDED === '1';
  const fixture = embedded ? 'creation-image-review' : 'asset-tag-picker';
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/${fixture}/preview.html`);
  const detail = page.getByRole('region', { name: '图片详情', exact: true });
  await detail.waitFor();
  await page.evaluate(() => {
    const names = ['自然风景', '时装', '花卉', '黑白', '建筑空间', 'AI 绘画', '包装设计', '壁纸', '材质纹理', '产品设计', '动物', '复古', '海报设计', '品牌视觉', '人像', '摄影', '手绘插画', '123'];
    window.tagLabels = names.map((name, i) => ({ id: `tag-${i}`, name, description: '', enabled: name !== '壁纸', count: 0, has_examples: false }));
    window.assetTags = [{ name: '时装', source: 'manual', origin: 'manual' }, { name: '花卉', source: 'auto', origin: 'local' }];
    window.tagWrites = [];window.failTags = false;window.holdWrite = false;window.failRead = false;
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'local_classification_labels') {
        if (window.failRead) throw 'Error database internal failed';
        return structuredClone(window.tagLabels);
      }
      if (command === 'list_asset_tags') return args.assetId === 'review-one' ? [] : structuredClone(window.assetTags);
      if (command === 'local_classification_save_label') {
        if (window.tagLabels.some(t => t.name.toLowerCase() === args.name.toLowerCase())) throw '同名标签已存在';
        const tag = { id: 'new-' + window.tagLabels.length, name: args.name, description: '', enabled: true, count: 0, has_examples: false };
        window.tagLabels.push(tag);return tag.id;
      }
      if (command === 'local_classification_example') {
        if (window.failTags) throw 'TypeError debug_payload /private/library.db';
        if (window.holdWrite) await new Promise(resolve => window.releaseTagWrite = resolve);
        window.tagWrites.push(args);
        const label = window.tagLabels.find(t => t.id === args.tagId);
        window.assetTags = window.assetTags.filter(t => t.name !== label.name);
        if (args.positive) window.assetTags.push({ name: label.name, source: 'manual', origin: 'manual' });
        return;
      }
      return invoke(command, args);
    };
  });
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  await page.getByTitle('重播展开动效', { exact: true }).click();
  const add = detail.getByRole('button', { name: '添加标签', exact: true });
  await page.evaluate(() => import('/src/components/TacticalMenus.css'));
  await add.click({ timeout: 5000 });
  const popup = page.getByRole('dialog', { name: '添加标签', exact: true });
  await popup.getByRole('checkbox', { name: '壁纸', exact: true }).waitFor({ timeout: 5000 }).catch(async error => {
    await page.screenshot({ path: '.tmp/asset-tag-picker-failure.png' });throw error;
  });
  assert.equal(await popup.locator('.asset-tag-picker-column').count(), 3);
  const letters = await popup.locator('.asset-tag-picker-letter').allTextContents();
  assert.deepEqual(letters, ['A', 'B', 'C', 'D', 'F', 'H', 'J', 'P', 'R', 'S', 'Z', '#']);
  assert.equal(await popup.getByRole('checkbox', { name: '花卉', exact: true }).isChecked(), true);
  await popup.getByRole('checkbox', { name: '花卉', exact: true }).uncheck();
  await page.waitForFunction(() => !window.assetTags.some(t => t.name === '花卉'));
  await popup.getByRole('checkbox', { name: '壁纸', exact: true }).check();
  await detail.getByRole('button', { name: '移除标签 壁纸', exact: true }).waitFor();
  assert.equal(await popup.isVisible(), true);
  await popup.getByRole('textbox').fill('极简构图');
  await popup.getByRole('button', { name: '新建并添加“极简构图”', exact: true }).click();
  await detail.getByRole('button', { name: '移除标签 极简构图', exact: true }).waitFor();
  await popup.getByRole('textbox').fill('时装');
  assert.equal(await popup.getByRole('button', { name: /新建并添加/ }).count(), 0);
  await popup.getByRole('textbox').fill('');
  const firstLast = popup.locator('.asset-tag-picker-column').first().getByRole('checkbox').last();
  await firstLast.focus();await firstLast.press('ArrowDown');
  assert.equal(await popup.locator('.asset-tag-picker-column').nth(1).getByRole('checkbox').first().evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('ArrowRight');
  assert.equal(await popup.locator('.asset-tag-picker-column').nth(1).getByRole('checkbox').first().evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal(await popup.count(), 0);assert.equal(await detail.isVisible(), true);
  assert.equal(await add.evaluate(el => el === document.activeElement), true);
  await page.evaluate(() => { window.failRead = true; });
  await add.click();
  await popup.getByRole('alert').waitFor();
  assert.equal(await popup.getByRole('checkbox').count(), 0);
  assert.doesNotMatch(await popup.innerText(), /database|internal/);
  await page.evaluate(() => { window.failRead = false; });
  await popup.getByRole('button', { name: '重试', exact: true }).click();
  await popup.getByRole('checkbox', { name: '人像', exact: true }).waitFor();
  await popup.getByRole('textbox').fill('输入法确认');
  await popup.getByRole('textbox').dispatchEvent('compositionstart');
  await popup.getByRole('textbox').press('Enter');
  assert.equal(await page.evaluate(() => window.tagLabels.some(t => t.name === '输入法确认')), false);
  await popup.getByRole('textbox').dispatchEvent('compositionend');
  await popup.getByRole('textbox').fill('');
  await page.evaluate(() => { window.failTags = true; });
  await popup.getByRole('checkbox', { name: '人像', exact: true }).click();
  await popup.getByRole('alert').waitFor();
  assert.doesNotMatch(await popup.innerText(), /TypeError|debug_payload|library\.db/);
  assert.equal(await popup.getByRole('checkbox', { name: '人像', exact: true }).isChecked(), false);
  await page.evaluate(() => { window.failTags = false; window.holdWrite = true; });
  await popup.getByRole('checkbox', { name: '人像', exact: true }).click();
  await page.waitForFunction(() => !!window.releaseTagWrite);
  assert.equal(await popup.getByRole('checkbox', { name: '摄影', exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.holdWrite = false; window.releaseTagWrite(); });
  await detail.getByRole('button', { name: '移除标签 人像', exact: true }).waitFor();
  await mkdir('.tmp/asset-tag-picker', { recursive: true });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: `.tmp/asset-tag-picker/${theme}.png`, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 520, height: 800 });
  await page.waitForFunction(() => document.querySelectorAll('.asset-tag-picker-column').length === 2);
  await popup.getByRole('checkbox', { name: '摄影', exact: true }).waitFor();
  assert.equal(await popup.locator('.asset-tag-picker-column').count(), 2);
  await page.screenshot({ path: '.tmp/asset-tag-picker/narrow.png', animations: 'disabled' });
  const bounds = await popup.boundingBox();assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 520 && bounds.y + bounds.height <= 800, JSON.stringify(bounds));
  assert.equal(await page.evaluate(() => window.tagWrites.every(w => w.assetIds.length === 1 && w.assetIds[0] === 'review-two')), true);
  if (embedded) {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.evaluate(() => { window.holdWrite = true; window.releaseTagWrite = null; });
    await popup.getByRole('checkbox', { name: '摄影', exact: true }).click();
    await page.waitForFunction(() => !!window.releaseTagWrite);
    await popup.getByRole('textbox').press('Escape');
    await page.getByRole('button', { name: '关闭预览', exact: true }).click();
    await page.getByRole('button', { name: '会话卡片 城市肖像 · 画面一，单击查看详情', exact: true }).click();
    await detail.waitFor();
    await page.evaluate(() => { window.holdWrite = false; window.releaseTagWrite(); });
    await page.waitForFunction(() => window.assetTags.some(t => t.name === '摄影'));
    assert.equal(await detail.getByRole('button', { name: '移除标签 摄影', exact: true }).count(), 0);
  }
  console.log(`PASS ${fixture}: all tags, alphabet, 3/2 columns, manual/auto toggles, create, errors, serialized writes, keyboard and viewport.`);
} finally { await browser?.close(); await server.close(); }
