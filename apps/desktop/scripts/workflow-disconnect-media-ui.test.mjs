import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const entry = 'scripts/fixtures/canvas-reference/preview.html';
const server = await createServer({ cacheDir: '.tmp/disconnect-media/vite', optimizeDeps: { entries: [entry] },
  server: { host: '127.0.0.1', port: 17979, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.goto(server.resolvedUrls.local[0] + entry);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  const poster = await page.evaluate(async () => {
    const { newWorkflowNode, emptyWorkflow } = await import('/src/lib/canvasWorkflow.ts');
    const { api } = await import('/src/lib/api.ts');
    const [poster] = await api.getAssetsByIds(['b']);
    const assets = [
      { id: 'track', ext: 'mp3', store_path: '/fixture/sea.mp3', name: '潮声.mp3', source: 'external', duration: 3 },
      { id: 'clip', ext: 'mp4', store_path: '/fixture/waves.mp4', name: '浪花.mp4', source: 'external', thumb_path: poster.store_path,
        width: 190, height: 150, duration: 4 },
    ];
    const canvas = window.snapshot(), base = canvas.nodes[0];
    const cell = (id, assetIds) => ({ id, content_type: 'image', text: '', image_refs: assetIds.map((asset_id, i) => ({ asset_id, token: '@图片' + (i + 1) })) });
    canvas.nodes = [{ ...base, id: 'table', kind: 'note', role: null, assetId: null, x: 50, y: 60, width: 350, height: 220,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', cells: [
        [cell('image', ['a']), cell('mix', ['b', 'clip'])], [{ id: 'script', content_type: 'text', text: '海边' }, cell('same', ['c'])],
      ], member_ids: [] }) }];
    canvas.view = { ...canvas.view, zoom: .8, panX: 60, panY: 40 };
    const track = { assetId: 'track' }, clip = { assetId: 'clip' }, image = { canvasNodeId: 'table', cellId: 'image' };
    const mix = { canvasNodeId: 'table', cellId: 'mix', autoConnect: 'table-wire' };
    const draw = { ...newWorkflowNode('generation', 540, 110, 'codex'), id: 'draw',
      inputs: { image: [track, image, clip, mix], text: [{ canvasNodeId: 'table', cellId: 'script', autoConnect: 'table-wire' }] },
      prompt: '镜头风格 @[saved-track]', promptReferences: [{ id: 'saved-track', type: 'image', input: track, label: '图片来源 1' }] };
    sessionStorage.setItem('reference-drafts', JSON.stringify(assets));
    sessionStorage.setItem('reference-fixture', JSON.stringify(canvas));
    sessionStorage.setItem('workflow-p', JSON.stringify({ revision: 1, document: { ...emptyWorkflow(), nodes: [draw], cardNames: { table: '脚本与分镜', draw: '生成卡片' } } }));
    return poster.store_path;
  });
  await page.reload();
  const target = page.locator('[data-workflow-card="draw"]');
  await target.waitFor();
  await page.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args) => command === 'audio_waveform' && args.assetId === 'track'
      ? Promise.resolve({ sourceVersion: 'fixture', duration: 3, sampleRate: 48000, channels: 1,
        framesPerPeak: 2250, totalFrames: 144000, peaks: Array.from({ length: 64 }, (_, i) => [-.3, (1 + i % 5) / 5]) })
      : original(command, args);
  });
  const editor = target.getByRole('textbox', { name: '卡片指令' });
  const audioChip = editor.locator('[data-reference-id="saved-track"]');
  await page.waitForFunction(() => document.querySelector('[data-reference-id="saved-track"]')?.textContent.includes('音频来源 1'), null, { timeout: 5000 });
  assert.equal(await audioChip.locator('img[src$=".mp3"]').count(), 0);
  await editor.fill('请使用：');
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'draw').prompt === '请使用：');
  await editor.press('End');
  await editor.pressSequentially('@');
  const list = page.getByRole('listbox', { name: '收到的内容' });
  await list.waitFor();
  assert.deepEqual(await list.getByRole('option').locator('b').allTextContents(),
    ['文本 1', '音频来源 1', '图片来源 2', '视频来源 3', '素材来源 4']);
  assert.doesNotMatch(await list.getByRole('option').filter({ hasText: '音频来源 1' }).innerText(), /张图片/);
  await list.getByRole('option').filter({ hasText: '视频来源 3' }).click();
  assert.match(await editor.innerText(), /@视频来源 3/);

  const menu = page.getByRole('menu', { name: '选择要断开的连线' });
  const input = target.locator('[data-canvas-connect-side="input"]');
  const open = async () => { await target.hover(); await input.click({ button: 'right' }); await menu.waitFor(); };
  const rowWith = id => menu.getByRole('menuitem').filter({ has: page.locator('[data-workflow-disconnect-asset="' + id + '"]') });
  const saved = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'draw').inputs);
  const before = await saved();
  await open();
  assert.equal(await menu.getByRole('menuitem').count(), 4, 'image and text projections of a single wire share one item');
  const imageRow = rowWith('a'), trackRow = rowWith('track'), mixedRow = rowWith('b');
  await trackRow.locator('canvas').waitFor();
  assert.match(await trackRow.innerText(), /潮声/);
  assert.match(await imageRow.innerText(), /脚本与分镜/);
  const { imagePath } = await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    return { imagePath: (await api.getAssetsByIds(['a']))[0].store_path };
  });
  assert.equal(await imageRow.locator('img').getAttribute('src'), imagePath);
  const clipRow = rowWith('clip').filter({ hasNot: page.locator('[data-workflow-disconnect-asset="b"]') });
  await page.waitForFunction(poster => [...document.querySelectorAll('[role="menuitem"] [data-workflow-disconnect-asset="clip"] img')]
    .some(img => img.getAttribute('src') === poster), poster);
  assert.match(await clipRow.innerText(), /浪花/);
  await mkdir('.tmp/disconnect-media', { recursive: true });
  await menu.screenshot({ path: '.tmp/disconnect-media/mixed-menu.png' });
  await page.keyboard.press('Escape');
  assert.deepEqual(await saved(), before, 'opening and dismissing the chooser leaves every binding intact');

  await open(); await imageRow.click();
  await menu.waitFor({ state: 'hidden' });
  const remaining = async count => page.waitForFunction(count =>
    JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'draw').inputs.image.length === count, count);
  await remaining(3);
  assert.deepEqual((await saved()).image.map(input => input.assetId || input.cellId), ['track', 'clip', 'mix']);
  await open(); await mixedRow.click();
  await remaining(2);
  assert.equal((await saved()).text.length, 0, 'only the chosen relation loses both projections');
  await open(); await clipRow.click(); await remaining(1);
  assert.match(await target.getByTitle('断开此输入', { exact: true }).innerText(), /音频/);
  await open();
  assert.equal(await menu.getByRole('menuitem').count(), 1);
  await trackRow.locator('canvas').waitFor();
  await page.keyboard.press('Escape');
  assert.equal((await saved()).image[0].assetId, 'track', 'single-source right click previews before disconnecting');
  await open(); await trackRow.click(); await remaining(0);

  // A cell's own + previews only the input that feeds that destination.
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const c = canvasWorkflowController('p');
    const writer = (id, cellId, assetId) => ({ ...newWorkflowNode('text', 0, 0, ''), id,
      inputs: { image: [{ assetId }] }, textTarget: { nodeId: 'table', cellId, image: true } });
    await c.edit([...c.document.nodes, writer('write-image', 'image', 'b'), writer('write-other', 'same', 'c')]);
  });
  const imageCell = page.locator('[data-canvas-node-id="table"] [data-canvas-cell="image"]');
  await imageCell.hover();
  await imageCell.locator('[data-canvas-connect-side="input"]').click({ button: 'right' });
  await menu.waitFor();
  assert.equal(await menu.getByRole('menuitem').count(), 1);
  await rowWith('b').click();
  await page.waitForFunction(() => !JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.some(node => node.id === 'write-image'));
  assert.ok(await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.some(node => node.id === 'write-other')));
  assert.deepEqual(errors, []);
  console.log('PASS audio/video/mixed references and saved chips, waveform and exact source thumbnails, one-step selective disconnect, single-source preview and cancel');
} finally { await browser.close(); await server.close(); }
