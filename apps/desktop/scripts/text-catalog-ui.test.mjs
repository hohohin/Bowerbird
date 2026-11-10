import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, cacheDir: '.tmp/text-catalog-vite' });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(10000);
const errors = [], remote = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => {
  if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
  remote.push(route.request().url()); return route.abort();
});
async function selectMedia(pane, name) {
  const controls = pane.locator('.library-controls-host');
  await controls.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (await controls.evaluate(element => element.classList.contains('is-compact') && !element.classList.contains('is-open')))
    await pane.getByRole('button', { name: '更多素材库控件', exact: true }).click();
  await pane.getByRole('group', { name: '素材类型', exact: true }).hover();
  await pane.getByRole('button', { name, exact: true }).focus();
  await page.keyboard.press('Enter');
}
try {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/text-library/preview.html?catalog`);
  await page.waitForFunction(() => !!window.mode && !!window.store);
  await page.evaluate(() => {
    const text = ['---', 'internal: hidden', '---', '# 创作笔记', '', '保持**原来的布局**，*柔和配色*与~~旧内容~~。', '',
      '- 第一项', '- [x] 第二项', '', '> 一段引用', '', '[阅读资料](https://example.invalid/private-source)', '',
      '| 项目 | 内容 |', '| --- | --- |', '| 风格 | 自然 |', '',
      '<div><strong>富文本正文</strong><br>下一段 &amp; 更多<img src="https://example.invalid/image.png" alt="图片说明"></div>', '',
      '![封面说明](https://example.invalid/cover.png)', '', '<!-- 内部注释 -->', '', '<script>window.previewExecuted = true</script>', '',
      '```js', 'const value = 1;', '```'].join('\n');
    window.snapshots.set('md', { ...window.snapshots.get('md'), text });
    window.store.setState({ detailAssetId: null });
    window.mode.getState().setMedia('texts');
    window.calls = [];
  });
  const cards = page.locator('.text-file-card');
  await cards.first().waitFor();
  assert.equal(await cards.count(), 2);
  assert.equal(await page.getByRole('button', { name: '文本', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-text-document-editor]').count(), 0);
  assert.equal(await cards.locator('img, video, audio, textarea').count(), 0);
  assert.deepEqual((await cards.locator('.text-file-format').allTextContents()).sort(), ['Markdown', 'TXT']);
  const calls = await page.evaluate(() => window.calls);
  assert.ok(calls.some(call => call.command === 'catalog_page' && call.args.filter.media === 'texts'));
  assert.ok(!calls.some(call => ['external_files_media', 'external_files_preview'].includes(call.command)), 'text previews never use image decoding');
  await page.waitForFunction(() => document.querySelector('.text-file-excerpt')?.textContent.includes('保持原来的布局'));
  const bodyPreview = await cards.first().locator('.text-file-excerpt').innerText();
  for (const text of ['柔和配色', '第一项', '第二项', '一段引用', '阅读资料', '项目 · 内容', '风格 · 自然', '富文本正文', '下一段 & 更多', '图片说明', '封面说明', 'const value = 1;']) assert.ok(bodyPreview.includes(text), text);
  for (const syntax of ['# ', '**', '~~', '- [x]', '> ', '](', '| ---', '<div', '<strong', '<script', 'https://', 'internal:', '内部注释', '```']) assert.ok(!bodyPreview.includes(syntax), `preview must not expose ${syntax}`);
  assert.equal(await page.evaluate(() => window.previewExecuted), undefined);
  assert.deepEqual(remote, [], 'preview never loads linked resources');
  assert.ok((await cards.nth(1).locator('.text-file-excerpt').innerText()).includes('**不解释Markdown**'), 'TXT preserves literal content');
  assert.equal(await page.evaluate(() => window.textReads.length), 2);
  const size = await cards.first().boundingBox();
  assert.ok(Math.abs(size.width / size.height - .75) < .001, 'text tiles are portrait 3:4');
  await cards.first().click({ modifiers: ['Control'] });
  assert.equal(await cards.first().getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('button', { name: '添加到新项目', exact: true }).count(), 1);
  await page.getByRole('button', { name: '取消选择', exact: true }).click();
  await mkdir('.tmp/text-catalog', { recursive: true });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [1440, 600, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      const bounds = await cards.first().boundingBox();
      assert.ok(Math.abs(bounds.width / bounds.height - .75) < .001);
      assert.ok(await cards.first().locator('.text-file-excerpt').evaluate(el => el.clientHeight > 18 && el.scrollWidth <= el.clientWidth));
      await page.screenshot({ path: `.tmp/text-catalog/text-${theme}-${width}.png` });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: '标签分类', exact: true }).click();
  await page.waitForFunction(() => window.calls.some(call => call.command === 'catalog_page' && call.args.filter.kind === 'tags' && call.args.filter.media === 'texts'));
  await page.getByRole('button', { name: '向右分栏', exact: true }).click();
  const secondPane = page.locator('.library-split-pane').nth(1);
  await secondPane.locator('.text-file-card').first().waitFor();
  assert.equal(await secondPane.getByRole('tab', { name: '标签分类', exact: true }).getAttribute('aria-selected'), 'true');
  await selectMedia(secondPane, '图片');
  await selectMedia(secondPane, '文本');
  assert.equal(await secondPane.getByRole('tab', { name: '标签分类', exact: true }).getAttribute('aria-selected'), 'true', 'copied panes preserve the independent text browsing view');
  await secondPane.getByRole('button', { name: '关闭此栏', exact: true }).click();
  assert.equal(await page.evaluate(() => window.textReads.length), 2, 'views and split panes share cached excerpts');
  await page.evaluate(async () => {
    const { writeDocumentState } = await import('/src/lib/documentState.ts');
    const text = '保存后的正文片段\n\n短文不显示内部富文本尾注。';
    window.snapshots.set('md', { ...window.snapshots.get('md'), text: writeDocumentState(text, [{ id: 'p', type: 'p', align: 'right', children: [{ text }] }]), version: 'v2' });
    window.snapshots.set('txt', { ...window.snapshots.get('txt'), text: '长文内容。'.repeat(500), version: 'v2' });
    window.emit('library://assets-changed');
  });
  await page.waitForFunction(() => document.querySelector('.text-file-excerpt')?.textContent.startsWith('保存后的正文片段'));
  const excerpt = await cards.first().locator('.text-file-excerpt').innerText();
  assert.ok(excerpt.length <= 1200 && !excerpt.includes('bowerbird-document'), 'only bounded readable text is cached');
  await page.waitForFunction(() => document.querySelectorAll('.text-file-excerpt')[1]?.textContent.length === 1200);
  const loaded = await page.evaluate(() => window.textReads.length);
  await cards.first().click();
  await page.locator('[data-text-document-editor]').waitFor();
  assert.ok(await page.evaluate(count => window.textReads.length > count, loaded), 'details independently read the complete current document');
  assert.equal(await page.locator('.asset-detail-panel').count(), 1);
  assert.deepEqual(errors, []);
  console.log('PASS parsed body previews without Markdown/HTML source, no resource loads, 3:4 cards, themes, cache, saved refresh and detail');
} finally { await browser.close(); await server.close(); }
