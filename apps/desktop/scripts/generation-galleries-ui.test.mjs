import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/generation-galleries/vite', server: { host: '127.0.0.1', port: 17934, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await mkdir('.tmp/generation-galleries', { recursive: true });
  await page.addInitScript(() => {
    window.total = 2;
    const image = (id, color) => ({ id, name: `${id}.png`, ext: 'png', width: 240, height: 160, store_path: `/${id}.png`,
      thumb_path: 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="${color}"/><text x="20" y="90" fill="white">${id}</text></svg>`), generation_session_id: 'shared' });
    window.testImage = image;
    window.generationGroups = { 'asset-1': [image('previous-1', '#64554e'), image('previous-2', '#556854'), image('asset-1', '#506574')] };
    window.assetDimensions = i => i === 1 ? window.generationGroups['asset-1'].at(-1) : {};
  });
  await page.goto('http://127.0.0.1:17934/scripts/fixtures/catalog-paging/preview.html');
  const group = page.locator('.catalog-generation-group');
  await group.locator('[data-asset-id="asset-1"]').waitFor();
  assert.equal(await page.locator('.folder-media-card').count(), 2, 'only one tile per conversation');
  assert.equal(await group.locator('.generation-group-count').innerText(), '3/3');
  await group.hover();
  await group.getByRole('button', { name: '上一张生成素材' }).click();
  await group.locator('[data-asset-id="previous-2"]').waitFor();
  await group.locator('[data-asset-id="previous-2"]').click();
  await page.waitForFunction(() => window.requests.some(r => r.command === 'external_files_media' && r.args.path === '/previous-2.png'));
  await page.keyboard.press('Escape');
  await group.locator('[data-asset-id="previous-2"]').click({ modifiers: ['Control'] });
  assert.equal(await group.locator('[data-asset-id="previous-2"]').getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: '全选', exact: true }).click();
  assert.equal(await group.locator('[data-asset-id="previous-2"]').getAttribute('aria-pressed'), 'true', 'select all uses the currently displayed result');
  await page.locator('[data-asset-id="asset-0"]').click({ modifiers: ['Shift'] });
  assert.equal(await group.locator('[data-asset-id="previous-2"]').getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: '取消选择', exact: true }).click();
  await group.locator('[data-asset-id="previous-2"]').click({ button: 'right' });
  assert.equal(await page.evaluate(() => window.store.getState().contextMenu.assetId), 'previous-2');
  await page.keyboard.press('Escape');
  await group.getByRole('button', { name: '上一张生成素材' }).focus();
  await page.keyboard.press('Enter');
  await group.locator('[data-asset-id="previous-1"]').waitFor();
  assert.equal(await group.locator('.generation-group-count').innerText(), '1/3');
  await page.evaluate(() => {
    const latest = window.testImage('new-result', '#76654d');
    window.generationGroups = { 'new-result': [window.testImage('previous-1', '#64554e'), latest] };
    window.assetDimensions = i => i === 1 ? latest : {};
    window.refresh();
  });
  await group.locator('[data-asset-id="new-result"]').waitFor();
  assert.equal(await group.locator('.generation-group-count').innerText(), '2/2', 'changed newest identity resets browsing even when results are removed');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await group.hover();
    await page.screenshot({ path: `.tmp/generation-galleries/library-${theme}.png` });
  }

  await page.goto('http://127.0.0.1:17934/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot(), base = snapshot.nodes[0];
    const prompt = (id, job, time) => ({ ...base, id, kind: 'prompt', assetId: null, role: null, x: 200, y: 100, width: 260, height: 148, createdAt: time,
      payloadJson: JSON.stringify({ schema_version: 1, job_id: job, conversation_id: 'saved-conversation', turn_key: 'turn', text: id, status: 'done' }) });
    const output = (id, job, time) => ({ ...base, id: `output-${id}`, assetId: id, role: 'output', createdAt: time,
      payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: id, width: 190, height: 150 }, execution: { job_id: job, turn_key: 'turn' } }) });
    snapshot.nodes = [prompt('session-first', 'job-first', 1), output('a', 'job-first', 1), prompt('session-next', 'job-next', 2), output('b', 'job-next', 2)];
    snapshot.edges = []; snapshot.view = { ...snapshot.view, panX: 100, panY: 60, zoom: 1 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
  });
  await page.reload();
  await page.locator('[data-conversation-image="b"]').waitFor();
  assert.equal(await page.locator('.canvas-prompt-node').count(), 1, 'unloaded jobs still share their persisted conversation');
  await page.locator('.canvas-conversation-images').hover();
  await page.getByRole('button', { name: '上一张生成图片' }).click();
  await page.locator('[data-conversation-image="a"]').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot(), base = snapshot.nodes[0];
    snapshot.nodes.push({ ...base, id: 'container', kind: 'note', threadId: null, assetId: null, role: null, x: 200, y: 100, width: 320, height: 260,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'images', text: '', cells: [[{ id: 'cell', text: '@图片1', content_type: 'image', image_refs: [{ token: '@图片1', asset_id: 'a' }], generation_ref: { session_node_id: 'session-first', output_node_id: 'output-a' } }]] }) });
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
  });
  await page.reload();
  const cell = page.locator('[data-canvas-cell="cell"]');
  await cell.locator('[data-conversation-image="b"]').waitFor();
  assert.equal(await page.locator('.canvas-prompt-node').count(), 0);
  await cell.hover();
  await cell.getByRole('button', { name: '上一张生成图片' }).click();
  await cell.locator('[data-conversation-image="a"]').waitFor();
  const before = await page.evaluate(() => window.snapshot().nodes.find(node => node.id === 'container').payloadJson);
  await cell.getByRole('button', { name: '下一张生成图片' }).click();
  assert.equal(await page.evaluate(() => window.snapshot().nodes.find(node => node.id === 'container').payloadJson), before, 'browsing never rewrites exact generation bindings');
  await page.screenshot({ path: '.tmp/generation-galleries/canvas-embedded.png' });
  await page.reload();
  await cell.locator('[data-conversation-image="b"]').waitFor();
  assert.deepEqual(errors, []);
  console.log('generation galleries: latest, navigation, exact preview/context/selection, new results, persisted canvas grouping and embedded continuation passed');
} finally { await browser.close(); await server.close(); }
