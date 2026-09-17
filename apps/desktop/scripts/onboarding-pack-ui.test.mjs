import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const pack = JSON.parse(await readFile('src-tauri/resources/onboarding-v0917/bowerbird-onboarding.json', 'utf8'));
const server = await createServer({ server: { host: '127.0.0.1', port: 1579, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:1579/scripts/fixtures/onboarding/preview.html');
  await page.getByRole('button', { name: '跳过入门引导', exact: true }).click();
  await page.evaluate(pack => { window.pack = pack; }, pack);
  async function importFolder() {
    await page.locator('[data-import-trigger]').click();
    await page.getByRole('menuitem', { name: '导入文件夹', exact: true }).click();
  }
  await importFolder();
  const visible = pack.tables.canvas_nodes.filter(node => node.hidden_at == null && (node.kind !== 'asset' || node.asset_id != null));
  // The source already contains one deleted image; it stays absent from the UI.
  await page.waitForFunction(count => document.querySelectorAll('[data-canvas-node-id]').length === count, visible.length);
  // Compare against the source graph rendered by the current UI. Image cards
  // already derive their height from the original aspect ratio on every load.
  // Rust separately checks that the saved width/height are copied verbatim.
  const sourceLayout = await page.evaluate(async () => {
    const { hydrateProjectCanvas } = await import('/src/lib/creativeCanvas.ts');
    return hydrateProjectCanvas(window.snapshot(), new Map(window.pack.tables.assets.map(asset => [asset.id, asset]))).nodes;
  });
  for (const showNames of [false, true, false]) {
    await page.evaluate(showNames => window.store.setState({
      settings: { ...window.store.getState().settings, canvas_show_asset_names: showNames },
    }), showNames);
    await page.waitForFunction(showNames => [...document.querySelectorAll('.canvas-node.is-asset')]
      .every(el => el.classList.contains('is-name-hidden') === !showNames), showNames);
    for (const node of visible) {
      const layout = await page.locator(`[data-canvas-node-id="${node.id}"]`).evaluate(el => {
        const matrix = new DOMMatrix(el.style.transform);
        return { x: matrix.m41, y: matrix.m42, width: parseFloat(el.style.width), height: parseFloat(el.style.height || el.style.minHeight) };
      });
      const source = sourceLayout.find(item => item.id === node.id) ?? node;
      // Hiding names removes the 30px caption from display, not saved geometry.
      const expected = { ...source, height: source.height - (node.kind === 'asset' && !showNames ? 30 : 0) };
      for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(layout[key] - expected[key]) < 0.01, `${node.id}: ${key}, names=${showNames}`);
    }
  }
  const expectedView = pack.tables.canvas_views[0];
  const readView = () => page.locator('[data-canvas-node-id]').first().evaluate(el => {
    const m = new DOMMatrix(el.parentElement.style.transform);
    return { x: m.m41, y: m.m42, zoom: m.a };
  });
  const view = await readView();
  assert.ok(Math.abs(view.x - expectedView.pan_x) < 0.01);
  assert.ok(Math.abs(view.y - expectedView.pan_y) < 0.01);
  assert.ok(Math.abs(view.zoom - expectedView.zoom) < 0.00001);
  const noteText = await page.locator('.canvas-note input, .canvas-note textarea').evaluateAll(elements => elements.map(el => el.value));
  for (const text of ['多步对话', '分层编辑', '维度生成 & 直接参考', '右键可以「复用提示词」哦', '层级调整', '可以批量生成', '右键点击图片，找到分层编辑']) assert.ok(noteText.includes(text), text);
  await page.waitForFunction(() => [...document.querySelectorAll('.canvas-node.is-asset img')].every(image => image.complete && image.naturalWidth > 0));
  await importFolder();
  assert.equal(await page.locator('[data-canvas-node-id]').count(), visible.length);
  assert.deepEqual(await readView(), view);
  assert.deepEqual(errors, []);
  await mkdir('.tmp', { recursive: true });
  await page.screenshot({ path: '.tmp/onboarding-pack-v0917.png' });
  console.log('PASS v0917 pack: visible cards, exact positions/sizes, notes, media, viewport restore and repeat import.');
} catch (error) {
  console.error(await page.evaluate(() => ({ nodes: document.querySelectorAll('[data-canvas-node-id]').length,
    calls: window.calls?.slice(-12), errorText: document.querySelector('.canvas-workspace')?.textContent?.slice(-500) })));
  throw error;
} finally {
  await browser.close();
  await server.close();
}
