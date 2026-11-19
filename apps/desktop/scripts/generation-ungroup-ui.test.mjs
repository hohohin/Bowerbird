import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/generation-ungroup/vite', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const url = path => `${server.resolvedUrls.local[0]}scripts/fixtures/${path}/preview.html`;
const dissolve = () => page.getByRole('menuitem', { name: '解散组合', exact: true });
try {
  await mkdir('.tmp/generation-ungroup', { recursive: true });
  await page.addInitScript(() => { window.total = 2; });
  await page.goto(url('catalog-paging'));
  await page.locator('[data-asset-id="asset-1"]').waitFor();
  await page.evaluate(() => {
    const image = id => ({ id, name: id, ext: 'png', width: 240, height: 160, generation_session_id: 'conversation', store_path: `/${id}.png`, thumb_path: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="%237b9eaa"/></svg>' });
    window.generationGroups = { 'asset-1': [image('asset-2'), image('asset-1')] };
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'dissolve_generation_group') {
        window.dissolveRequest = args;
        if (window.rejectDissolve) throw new Error('模拟保存失败');
        window.generationGroups = {}; window.total = 3; window.refresh(); return;
      }
      return invoke(command, args);
    };
    window.refresh();
  });
  const group = page.locator('.catalog-generation-group');
  await group.waitFor();
  await group.getByRole('button', { name: '上一张生成素材' }).click();
  await group.locator('[data-asset-id="asset-2"]').click({ button: 'right' });
  await dissolve().waitFor();
  await page.evaluate(() => { window.rejectDissolve = true; });
  await dissolve().click();
  await page.waitForFunction(() => window.dissolveRequest?.assetId === 'asset-2');
  assert.equal(await group.count(), 1, 'failed persistence does not optimistically split the gallery');
  await page.evaluate(() => { window.rejectDissolve = false; });
  await dissolve().click();
  await group.waitFor({ state: 'detached' });
  await page.locator('[data-asset-id="asset-2"]').waitFor();
  await page.locator('[data-asset-id="asset-0"]').click({ button: 'right' });
  assert.equal(await dissolve().count(), 0, 'ordinary cards do not offer dissolution');
  await page.keyboard.press('Escape');

  await page.goto(url('connected-collections'));
  await page.getByRole('tab', { name: '文件夹', exact: true }).click();
  await page.locator('[data-connection-entry="root-0"]').waitFor();
  await page.evaluate(() => {
    const base = window.entries[0];
    window.entries = ['older','newer'].map((id,i) => ({ ...base, id, asset_id: id, name: `${id}.png`, asset: { ...base.asset, id, generation_session_id: 'folder-session', created_at: i } }));
    const invoke = window.__TAURI_INTERNALS__.invoke;
    let split = false;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'dissolve_generation_group') { window.dissolveRequest = args; split = true; window.changed(); return; }
      if (split && ['folder_connections','connection_entries','connection_entry_ids'].includes(command)) args = { ...args, filter: { ...args.filter, grouped: false } };
      return invoke(command, args);
    };
    window.changed();
  });
  await page.locator('.catalog-generation-group').waitFor();
  await page.locator('[data-connection-entry="newer"] .folder-media-card').click({ button: 'right' });
  await dissolve().click();
  await page.locator('[data-connection-entry="older"]').waitFor();
  assert.equal(await page.locator('.catalog-generation-group').count(), 0);
  assert.deepEqual(await page.evaluate(() => window.dissolveRequest), { assetId: 'newer' });

  await page.goto(url('canvas-reference'));
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot(), base = snapshot.nodes[0];
    snapshot.nodes = ['one','two'].flatMap((turn, i) => [
      { ...base, id: `session-${turn}`, kind: 'prompt', assetId: null, role: null, x: 200, y: 100, width: 260, height: 148, createdAt: i+1,
        payloadJson: JSON.stringify({ schema_version: 1, job_id: 'job', conversation_id: 'conversation', turn_key: turn, text: `会话 ${turn}`, status: 'done' }) },
      { ...base, id: `output-${turn}`, assetId: i ? 'b' : 'a', role: 'output', x: 200, y: 100, createdAt: i+1,
        payloadJson: JSON.stringify({ schema_version: 1, snapshot: {name:turn,width:190,height:150}, execution: {job_id:'job',turn_key:turn} }) },
    ]);
    snapshot.edges = [{id:'exact-wire',projectId:'p',threadId:'t',fromNodeId:'session-one',toNodeId:'output-one',kind:'produced',ordinal:0,createdAt:1}];
    snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 0.8 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
  });
  await page.reload();
  await page.locator('[data-conversation-image="b"]').waitFor();
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    let separated;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'dissolve_generation_group') {
        window.dissolveRequest = args; separated = window.snapshot();
        separated.nodes.forEach((node,i) => { node.x = 100+i*280; node.payloadJson = JSON.stringify({...JSON.parse(node.payloadJson),generation_group_dissolved:true}); });
        sessionStorage.setItem('reference-fixture', JSON.stringify(separated)); window.emitAssetsChanged(); return;
      }
      if (command === 'project_canvas_get' && separated) return structuredClone(separated);
      return invoke(command,args);
    };
  });
  await page.locator('[data-conversation-image="b"]').click({ button: 'right' });
  await dissolve().click();
  await page.locator('[data-canvas-node-id="output-one"]').waitFor();
  await page.locator('[data-canvas-node-id="output-two"]').waitFor();
  assert.deepEqual(await page.evaluate(() => window.dissolveRequest), { groupKey: 'generation:conversation' });
  assert.equal(await page.locator('.canvas-prompt-node').count(), 2);
  assert.equal(await page.locator('.generation-group-count').count(), 0);
  await page.reload();
  await page.locator('[data-canvas-node-id="output-one"]').waitFor();
  assert.equal(await page.locator('.canvas-prompt-node').count(), 2);
  assert.equal(await page.locator('.canvas-node.is-asset').count(), 2);
  assert.equal(await page.evaluate(() => window.snapshot().edges[0].toNodeId), 'output-one');
  await page.locator('[data-canvas-node-id="output-two"]').click({ button: 'right' });
  assert.equal(await dissolve().count(), 0);
  await page.keyboard.press('Escape');
  for (const theme of ['dark','light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: `.tmp/generation-ungroup/canvas-${theme}.png` });
  }
  // A grouped session without image results uses the canvas node menu too.
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    snapshot.nodes = snapshot.nodes.filter(node => node.kind === 'prompt').map(node => {
      const payload = JSON.parse(node.payloadJson); delete payload.generation_group_dissolved;
      return { ...node, payloadJson: JSON.stringify({ ...payload, status: 'failed' }) };
    });
    snapshot.edges = []; sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
  });
  await page.reload();
  await page.locator('.canvas-prompt-node').waitFor();
  assert.equal(await page.locator('.canvas-prompt-node').count(), 1);
  await page.locator('.canvas-prompt-node').click({ button: 'right' });
  await dissolve().waitFor();
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log('generation ungroup: library, folder, canvas, persistence, precise bindings, failure and ordinary-card menus passed');
} finally { await browser.close(); await server.close(); }
