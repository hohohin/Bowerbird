import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
await mkdir('.tmp/video-diagnostics', { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: '.tmp/video-diagnostics/vite',
  server: { host: '127.0.0.1', port: 1657, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 800 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:1657/scripts/fixtures/video-diagnostics/preview.html');
  const query = () => page.getByRole('button', { name: '查询诊断信息', exact: true });
  await query().click();
  assert.equal(await page.getByRole('button', { name: '正在查询诊断信息…' }).isDisabled(), true);
  await page.getByRole('button', { name: '切换任务', exact: true }).click();
  await query().click();
  await page.evaluate(() => window.pending[0].resolve({ submit_id: 'task-a', logid: 'stale-a' }));
  assert.equal(await page.getByLabel('完整错误诊断').count(), 0, 'old task response must not appear on another task');
  await page.evaluate(() => window.pending[1].resolve({ submit_id: 'task-b', query_result: { response: { gen_status: 'fail', logid: 'log-b', error_code: 42 } }, saved_path: 'diagnostics/task-b.json' }));
  await page.getByLabel('完整错误诊断').waitFor();
  assert.match(await page.getByLabel('完整错误诊断').innerText(), /log-b/);
  await page.evaluate(() => { window.copied = ''; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copied = text; } } }); });
  await page.getByRole('button', { name: '复制完整诊断' }).click();
  assert.match(await page.evaluate(() => window.copied), /"error_code": 42/);
  await query().click();
  await page.evaluate(() => window.pending[2].reject('network timeout'));
  await page.getByText('诊断查询失败：等待响应超时', { exact: false }).waitFor();
  assert.doesNotMatch(await page.getByLabel('完整错误诊断').innerText(), /network timeout/);
  await page.getByRole('button', { name: '没有编号' }).click();
  assert.equal(await query().isDisabled(), true);
  const calls = await page.evaluate(() => window.calls);
  assert.deepEqual(calls.map(call => call.command), Array(3).fill('dreamina_task_diagnostics'));
  assert.deepEqual(calls.map(call => call.args.submitId), ['task-a', 'task-b', 'task-b']);
  assert.deepEqual(errors, []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  console.log('Video diagnostics UI passed: exact task, no resubmission, stale response, clipboard, query failure, missing ID.');
} finally { await browser.close(); await server.close(); }
