import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, cacheDir: '.tmp/app-error-boundary-vite' });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.setDefaultTimeout(10000);
try {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/app-error-boundary/preview.html`);
  const panel = page.getByRole('alert');
  await panel.waitFor();
  assert.match(await panel.innerText(), /界面暂时无法显示/, 'renders a readable fallback instead of a blank window');
  assert.equal(await page.getByRole('button', { name: '重新加载', exact: true }).count(), 1);
  assert.match(await page.locator('.app-error-boundary code').textContent(), /测试渲染失败/, 'keeps the original error for diagnostics');
  assert.equal(await page.evaluate(() => document.getElementById('root')?.innerHTML.length ?? 0) > 100, true, 'the window is not blank');
  console.log('PASS app error boundary: render failures stay visible, recoverable and keep diagnostics');
} finally { await browser.close(); await server.close(); }
