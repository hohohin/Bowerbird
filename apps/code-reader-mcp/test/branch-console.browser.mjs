import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { fixture } from './branch-fixture.mjs';
import { createSnapshotReader } from '../snapshot-store.mjs';
import { callTool } from '../core.mjs';

test('developer can publish a branch and see a failed coverage check from the local console', async t => {
  const f = await fixture(t);
  const before = f.git('status', '--porcelain');
  const trees = f.git('worktree', 'list', '--porcelain');
  const reader = createSnapshotReader(f.output);
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  try {
    const page = await browser.newPage();
    await page.route('**/api/services', route => route.fulfill({ json: {
      gpt: { state: 'degraded', process: 'running', controlPlane: { state: 'backoff', reason: 'network_error', consecutiveFailures: 5 }, proxy: 'unhealthy' },
      gemini: { state: 'healthy', process: 'running', http: 'healthy', ssh: 'connected', interface: 'Fixture WLAN' },
    } }));
    await page.goto(f.app.origin);
    await page.locator('#gpt-service').getByText(/network_error/).waitFor();
    await page.locator('#gemini-service').getByText(/SSH 连接已建立/).waitFor();
    await page.getByRole('button', { name: '刷新状态' }).click();
    await page.getByRole('button', { name: '一键更新当前快照' }).click();
    await page.getByRole('status').filter({ hasText: '覆盖检查已通过' }).waitFor();
    assert.equal(callTool(reader(), 'project_overview').branch, 'main');
    assert.equal(callTool(reader(), 'project_overview').isDirty, true);
    await page.getByRole('button', { name: '更新快照 topic/green' }).click();
    await page.getByRole('status').filter({ hasText: '覆盖检查已通过' }).waitFor();
    const expected = f.branches.find(row => row.branch === 'topic/green');
    const overview = callTool(reader(), 'project_overview');
    assert.equal(overview.branch, expected.branch);
    assert.equal(overview.revision, expected.revision);
    assert.match(await page.locator('#snapshot').innerText(), /干净/);
    await page.getByRole('button', { name: '更新快照 broken' }).click();
    await page.getByRole('status').filter({ hasText: 'apps/a/large.ts' }).waitFor();
    assert.match(await page.locator('#snapshot').innerText(), /topic\/green/);
    assert.deepEqual(callTool(reader(), 'project_overview'), overview);
    assert.equal(f.git('status', '--porcelain'), before);
    assert.equal(f.git('worktree', 'list', '--porcelain'), trees);
  } finally { await browser.close(); }
});
