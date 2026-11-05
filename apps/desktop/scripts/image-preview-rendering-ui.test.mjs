import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const baseline = process.argv.includes('--baseline');
const output = '.tmp/image-preview-rendering';
await mkdir(output, { recursive: true });
await writeFile(`${output}/standalone.tsx`, `import React from 'react';
import { createRoot } from 'react-dom/client';
import { AssetDetail } from '/src/components/AssetDetail';
export function mount() {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:100'; document.body.append(host);
  createRoot(host).render(<AssetDetail selection={{ assetId: 'review-two', onClose() {}, onOpen() {} }} />);
}`);
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 17950, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:17950/scripts/fixtures/creation-image-review/preview.html?deferred');
  await page.waitForFunction(() => window.__reviewPending?.length >= 4);
  const historyReads = await page.evaluate(() => {
    window.__reviewHold.clear(); window.__reviewPending.forEach(item => item.resolve());
    return window.__reviewPending.filter(item => item.command === 'generation_history').length;
  });
  const modal = page.locator('.creation-image-preview');
  const inspector = modal.getByRole('region', { name: '图片详情', exact: true });
  await inspector.waitFor();
  await page.waitForTimeout(700);
  const measure = () => modal.evaluate(root => {
    const filters = [...root.querySelectorAll('*')].filter(el => getComputedStyle(el).backdropFilter !== 'none' && el.checkVisibility());
    return { layers: filters.map(el => el.className), filteredBoundsArea: Math.round(filters.reduce((sum, el) => {
      const rect = el.getBoundingClientRect(); return sum + rect.width * rect.height;
    }, 0)) };
  });
  const dark = await measure();
  await page.screenshot({ path: `${output}/${baseline ? 'before' : 'after'}-dark.png` });
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  const light = await measure();
  await page.screenshot({ path: `${output}/${baseline ? 'before' : 'after'}-light.png` });
  if (!baseline) {
    assert.equal(await inspector.getByRole('tablist').count(), 0);
    assert.equal(await inspector.getByText('生成来源', { exact: true }).count(), 0);
    assert.equal(await inspector.getByRole('button', { name: '回看所属创作', exact: true }).count(), 0);
    assert.equal(historyReads, 1, 'only the right conversation reads generation history');
    assert.deepEqual(dark.layers, ['creation-image-preview-conversation-plane', 'creation-image-preview-conversation-plane']);
    assert.deepEqual(light.layers, dark.layers, 'both themes keep glass only on the two reading surfaces');
    assert.match(await inspector.innerText(), /尺寸/);
    assert.equal(await modal.getByRole('textbox', { name: '续轮对话', exact: true }).count(), 1);
    await page.mouse.move(80, 500); await page.waitForTimeout(400);
    const left = await inspector.evaluate(el => getComputedStyle(el).transform);
    await page.mouse.move(1360, 500); await page.waitForTimeout(400);
    assert.notEqual(await inspector.evaluate(el => getComputedStyle(el).transform), left, 'shared-plane motion remains enabled');
    const idleWrites = await modal.evaluate(root => new Promise(resolve => {
      let count = 0;
      const observer = new MutationObserver(records => { count += records.length; });
      observer.observe(root, { attributes: true, attributeFilter: ['style'], subtree: true });
      setTimeout(() => { observer.disconnect(); resolve(count); }, 400);
    }));
    assert.equal(idleWrites, 0, 'the idle preview does not keep writing animation styles');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await inspector.evaluate(el => getComputedStyle(el).transform), 'none');
    await modal.getByRole('button', { name: '关闭预览', exact: true }).click();
    await modal.waitFor({ state: 'detached' });
    await page.evaluate(async () => {
      (await import('/.tmp/image-preview-rendering/standalone.tsx')).mount();
    });
    const detail = page.locator('.asset-detail');
    await detail.getByRole('tab', { name: '再创作', exact: true }).click();
    assert.equal(await detail.getByRole('tab', { name: '再创作', exact: true }).getAttribute('aria-selected'), 'true');
    await detail.getByRole('tab', { name: '信息', exact: true }).click();
    assert.match(await detail.innerText(), /导入时间/);
  }
  assert.deepEqual(errors, []);
  const result = { historyReads, dark, light };
  await writeFile(`${output}/${baseline ? 'before' : 'after'}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  console.log(baseline ? 'BASELINE captured' : 'PASS direct inspector, single history read, two glass layers, preserved motion, idle and reduced motion');
} finally { await browser.close(); await server.close(); }
