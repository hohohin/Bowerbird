import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ server: { host: '127.0.0.1', port: 17944, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(8000);
try {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-reference/preview.html?detail-route`);
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(async () => {
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const snapshot = window.snapshot();
    snapshot.threads.push({ id: 'other', projectId: 'p', title: '其他线程', archivedAt: null }, { id: 'archived', projectId: 'p', title: '已归档', archivedAt: 1 });
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    const node = { ...newWorkflowNode('comfy-video', 12000, 9000, 'comfy-video'), id: 'h3-owned' };
    const run = { id: 'h3-run', startId: node.id, threadId: 't', status: 'failed', order: [node.id], steps: { [node.id]: { status: 'failed', error: '合成失败' } } };
    sessionStorage.setItem('workflow-p', JSON.stringify({ revision: 1, document: { schema_version: 1, nodes: [node], run, runs: [run] } }));
  });
  await page.reload();
  const card = page.locator('[data-workflow-card="h3-owned"]');
  await card.waitFor();
  await page.evaluate(() => window.store.setState({ creativeNavigation: { projectId: 'p', threadId: 't', nodeId: 'h3-owned' } }));
  await page.locator('[data-workflow-card="h3-owned"].is-selected').waitFor();
  const centered = await card.boundingBox();
  assert.ok(centered.x >= 0 && centered.x < 1440 && centered.y >= 0 && centered.y < 900, 'owned workflow card is brought into view');

  for (const threadId of ['other', 'archived']) {
    if (threadId === 'archived') await page.evaluate(() => {
      const saved = JSON.parse(sessionStorage.getItem('workflow-p'));
      saved.document.run.threadId = 'archived'; saved.document.runs[0].threadId = 'archived';
      sessionStorage.setItem('workflow-p', JSON.stringify(saved));
    });
    await page.reload(); await card.waitFor();
    const before = await card.boundingBox();
    await page.evaluate(threadId => window.store.setState({ creativeNavigation: { projectId: 'p', threadId, nodeId: 'h3-owned' } }), threadId);
    await page.waitForFunction(() => window.store.getState().creativeNavigation === null);
    await page.waitForTimeout(100);
    assert.equal(await page.locator('[data-workflow-card="h3-owned"].is-selected').count(), 0, 'wrong or archived thread cannot select workflow card');
    const after = await card.boundingBox();
    assert.deepEqual([after.x, after.y], [before.x, before.y], 'rejected target does not pan');
  }
  console.log('PASS: workflow task ownership, selection/pan, wrong and archived thread rejection');
} finally { await browser.close(); await server.close(); }
