import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const fixture = 'scripts/fixtures/canvas-reference/preview.html';
const marker = '  const [active, setActive] =';
const server = await createServer({
  cacheDir: '.tmp/canvas-content-isolation-vite',
  optimizeDeps: { entries: [fixture] },
  server: { host: '127.0.0.1', port: 18046, strictPort: true, hmr: false, watch: null },
  plugins: [{
    name: 'content-render-count', enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/CanvasTextCard.tsx')) return;
      assert.ok(code.includes(marker));
      return code.replace(marker, `  const renderCounts = ((window as any).contentRenders ??= {});
  const key = value.cells[0]?.[0]?.id ?? '';
  renderCounts[key] = (renderCounts[key] ?? 0) + 1;
${marker}`);
    },
  }],
});
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const card = id => page.locator(`[data-canvas-node-id="table-${id}"]`);
try {
  await page.goto(`${server.resolvedUrls.local[0]}${fixture}?canvas-library`);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot(), base = snapshot.nodes[0];
    snapshot.nodes = Array.from({ length: 3 }, (_, table) => {
      const cells = Array.from({ length: 12 }, (_, row) => Array.from({ length: 6 }, (_, column) => ({
        id: `table-${table}-${row}-${column}`, text: `表格 ${table} · ${row}:${column}`,
        ...(row === 0 && column > 0 && column < 3 ? {
          content_type: 'image', image_refs: [{ token: '@图片1', asset_id: column === 1 ? 'a' : 'd' }],
        } : {}),
      })));
      return { ...base, id: `table-${table}`, kind: 'note', assetId: null, role: null, x: 50 + table * 1000, y: 160,
        width: 950, height: 1500, payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', cells, text: '' }) };
    });
    snapshot.view = { ...snapshot.view, panX: 100, panY: 30, zoom: 0.35 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    sessionStorage.setItem('canvas-only-assets', JSON.stringify(['d']));
  });
  await page.reload();
  await card(2).getByRole('button', { name: '放大图片：合成参考 d', exact: true }).waitFor();
  const refetches = () => page.evaluate(() => window.calls.filter(call => call.command === 'get_assets_by_ids')
    .flatMap(call => call.args.assetIds).filter(id => id === 'a' || id === 'd'));
  const initialRequests = await refetches();
  await page.evaluate(() => { window.contentRenders = {}; });
  await card(0).getByRole('textbox', { name: '第 1 行第 1 列', exact: true }).focus();
  await page.evaluate(() => {
    const stage = document.querySelector('.canvas-stage');
    stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 19, deltaY: 12 }));
    stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -30, ctrlKey: true, clientX: 700, clientY: 400 }));
    window.store.setState({ genJobs: { unrelated: { id: 'unrelated', running: true, turns: [], progress: { stage: 'generating' } } } });
    window.store.setState(state => ({ assets: state.assets.map(asset => asset.id === 'b' ? { ...asset, name: '无关素材已更新' } : asset) }));
  });
  await page.waitForFunction(() => window.snapshot().view.zoom > 0.35);
  const renders = await page.evaluate(() => window.contentRenders);
  assert.deepEqual({ initialRequests, renders: [renders['table-1-0-0'] ?? 0, renders['table-2-0-0'] ?? 0] },
    { initialRequests: ['d'], renders: [0, 0] }, 'board assets are reused and unchanged tables skip unrelated renders');
  assert.deepEqual(await refetches(), initialRequests, 'unchanged tables never repeat an IPC lookup');
  await page.evaluate(() => {
    window.contentRenders = {};
    window.canvasReads = window.calls.filter(call => call.command === 'project_canvas_get').length;
    window.emitFixtureEvent('project-canvas://nodes-changed', 'p');
  });
  await page.waitForFunction(() => window.calls.filter(call => call.command === 'project_canvas_get').length > window.canvasReads);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await page.evaluate(() => window.contentRenders), {}, 'an unchanged table survives an unrelated workflow snapshot refresh');
  assert.deepEqual(await refetches(), initialRequests, 'a same-revision graph refresh keeps shared references');
  await page.evaluate(() => window.store.setState(state => ({
    assets: state.assets.map(asset => asset.id === 'a' ? { ...asset, name: '现有素材已重命名' } : asset),
  })));
  for (const index of [0, 1, 2]) await card(index).getByRole('button', { name: '放大图片：现有素材已重命名', exact: true }).waitFor();
  assert.deepEqual(await refetches(), initialRequests, 'updated indexed assets require no fallback lookup');
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__, invoke = bridge.invoke;
    bridge.invoke = async (command, args) => {
      const result = await invoke(command, args);
      return command === 'get_assets_by_ids' ? result.map(asset => asset.id === 'd' ? { ...asset, name: '隐藏素材已重命名' } : asset) : result;
    };
    window.emitAssetsChanged();
  });
  for (const index of [0, 1, 2]) await card(index).getByRole('button', { name: '放大图片：隐藏素材已重命名', exact: true }).waitFor();
  assert.deepEqual(await refetches(), ['d', 'd'], 'a catalog refresh invalidates the shared fallback once');
  assert.deepEqual(errors, []);
  console.log('Canvas content isolation: cached/shared references, pan, zoom, selection and independent job updates.');
} finally { await browser.close(); await server.close(); }
