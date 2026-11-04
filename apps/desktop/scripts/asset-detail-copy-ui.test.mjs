import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/creation-image-review/preview.html`);
  const detail = page.getByRole('region', { name: '图片详情', exact: true });
  await detail.getByRole('button', { name: '反推', exact: true }).waitFor();
  await page.evaluate(async () => {
    const { useStore } = await import('/src/store.ts');
    window.describeCalls = [];
    useStore.setState({ cloudAuth: { cloud_available: true, logged_in: true },
      cloudEntitlement: { balances: { daily: 0, sub: 0, topup: 100 } },
      defaultUnderstandProvider: 'bowerbird-cloud',
      runDescribe: (...args) => window.describeCalls.push(args) });
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.hasCaption = true;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'list_analyses_by_asset') return window.hasCaption ? [{ id: 'copy-caption', asset_id: 'review-two', kind: 'caption',
        payload: JSON.stringify({ text: '测试反推内容' }), created_at: 1 }] : [];
      if (command === 'delete_analysis') throw 'TypeError debug_payload at native.rs:42 /Users/private/library.db';
      return invoke(command, args);
    };
  });
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  await page.getByTitle('重播展开动效', { exact: true }).click();
  await detail.getByRole('button', { name: '删除', exact: true }).click();
  await detail.locator('[class~="bg-red-500/15"]').waitFor();
  assert.doesNotMatch(await detail.innerText(), /TypeError|debug_payload|native\.rs|\/Users\/private/);
  assert.match(await detail.innerText(), /删除反推结果失败/);
  assert.equal(await detail.getByRole('button', { name: '删除', exact: true }).count(), 1, 'failed deletion keeps the result');

  await page.evaluate(() => { window.hasCaption = false; });
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  await page.getByTitle('重播展开动效', { exact: true }).click();
  const reverse = detail.getByRole('button', { name: '反推', exact: true });
  await reverse.waitFor();
  assert.equal(await reverse.getAttribute('title'), '用默认反推引擎进行反推');
  assert.doesNotMatch(await detail.innerText(), /点「反推」|选择引擎|本机 codex.*当前指令/);
  await mkdir('.tmp/ui-copy', { recursive: true });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: `.tmp/ui-copy/detail-${theme}.png`, animations: 'disabled' });
  }
  await reverse.click();
  assert.equal(await page.evaluate(() => window.describeCalls[0]?.[2]), 'bowerbird-cloud');
  console.log('PASS: detail removes redundant copy, uses the default engine, and sanitizes deletion failures without losing results.');
} finally {
  await browser?.close();
  await server.close();
}
