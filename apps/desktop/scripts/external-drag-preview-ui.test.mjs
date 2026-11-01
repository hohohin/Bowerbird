import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = resolve('.tmp/external-drag-preview');
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: `${output}/vite`,
  css: { postcss: { plugins: [] } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { entries: ['scripts/fixtures/external-drag/preview.html'], include: ['react', 'react-dom/client', 'react/jsx-runtime'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1380, height: 860 } });
page.setDefaultTimeout(5000);
const errors = [], remote = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.hostname !== '127.0.0.1') { remote.push(url.origin); return route.abort(); }
  return route.continue();
});
const url = `${server.resolvedUrls.local[0]}scripts/fixtures/external-drag/preview.html`;
try {
  await page.goto(url);
  await page.getByRole('heading', { name: '素材库', exact: true }).waitFor();
  const receiver = page.getByRole('region', { name: '外部应用演示' });
  const file = id => page.locator(`.drag-library [data-id="${id}"]`);
  await file('image').dragTo(receiver);
  await receiver.getByText('青色立面.jpg', { exact: true }).waitFor();
  await file('video').click({ modifiers: ['Control'] });
  await file('audio').click({ modifiers: ['Control'] });
  await file('video').dragTo(receiver);
  assert.equal(await receiver.locator('.received-item').count(), 3);
  await page.getByRole('button', { name: '清空接收区' }).click();
  const canvasCard = page.locator('.drag-canvas [data-id="image"]');
  await canvasCard.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '拖入到其他应用', exact: true }).click();
  await page.locator('.carried-preview').waitFor();
  await receiver.hover();
  await page.screenshot({ path: `${output}/carrying-dark.png` });
  await receiver.click();
  await receiver.getByText('青色立面.jpg', { exact: true }).waitFor();
  assert.equal(await page.locator('.carried-preview').count(), 0);
  await canvasCard.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '拖入到其他应用', exact: true }).click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.carried-preview').count(), 0);
  assert.equal(await receiver.locator('.received-item').count(), 1);
  await page.getByRole('button', { name: '剪辑时间线', exact: true }).click();
  await canvasCard.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '拖入到其他应用', exact: true }).click();
  await receiver.click();
  await receiver.locator('.timeline-clip').waitFor();
  await page.screenshot({ path: `${output}/timeline-dark.png` });
  await page.getByRole('button', { name: '切换主题' }).click();
  await canvasCard.click({ button: 'right' });
  await page.screenshot({ path: `${output}/menu-light.png` });
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${output}/overview-light.png` });
  assert.deepEqual(errors, []); assert.deepEqual(remote, []);
  await writeFile(`${output}/result.json`, JSON.stringify({ passed: true, scope: 'Independent UI demonstration only; no native file drop, no file access', errors, remote }, null, 2));
  console.log(JSON.stringify({ passed: true, output }));
} finally { await browser.close(); await server.close(); }
