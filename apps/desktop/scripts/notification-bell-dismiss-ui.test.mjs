import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/notification-dismiss-vite', server: { host: '127.0.0.1', port: 18951, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage();
  const bell = page.getByRole('button', { name: /^通知/ });
  const panel = page.getByRole('dialog', { name: '通知历史' });
  const seed = turn => page.evaluate(turn => {
    const makeJob = (id, running) => ({ id, projectId: 'p', threadId: id, createdAt: 10, running,
      lastPrompt: id, turns: [{ id: 1, turnKey: turn, prompt: id, images: [], error: running ? null : '模拟失败' }] });
    const jobs = [makeJob('失败作业', false), makeJob('仍在生成', true)];
    window.store.setState({ genJobs: Object.fromEntries(jobs.map(job => [job.id, job])), projectUnreadThreads: { p: ['失败作业'] } });
  }, turn);
  await page.goto(server.resolvedUrls.local[0] + 'scripts/fixtures/library-generation-live/preview.html?source-library&detail-route&canvas-library');
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await seed('first');
  await bell.click();
  await panel.getByRole('button', { name: '移除通知：失败作业' }).click();
  assert.equal(await panel.getByRole('button', { name: /失败作业/ }).count(), 0);
  assert.equal(await panel.getByRole('button', { name: /移除通知：仍在生成/ }).count(), 0);
  assert.equal(await bell.getAttribute('aria-label'), '通知');
  assert.equal(await page.evaluate(() => window.store.getState().genJobs['失败作业'].turns[0].error), '模拟失败');
  await page.reload();
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await seed('first');
  await bell.click();
  assert.equal(await panel.getByRole('button', { name: /失败作业/ }).count(), 0);
  await seed('retry');
  await panel.getByRole('button', { name: '移除通知：失败作业' }).waitFor();
  await panel.getByRole('button', { name: '清除已结束' }).click();
  await panel.getByRole('button', { name: /仍在生成/ }).waitFor();
  assert.equal(await panel.getByRole('button', { name: /失败作业/ }).count(), 0);
  console.log('PASS notification history: remove a failed turn, unread dot, persisted dismissal, new failure, bulk clear and active job protection');
} finally { await browser.close(); await server.close(); }
