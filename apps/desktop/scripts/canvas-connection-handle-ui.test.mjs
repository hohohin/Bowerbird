import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const cache = '.tmp/canvas-connection-handle-vite';
const server = await createServer({ configFile: false, cacheDir: cache, optimizeDeps: { entries: [], include: ['react', 'react-dom/client', 'react-dom'] },
  server: { host: '127.0.0.1', port: 17948, strictPort: true, hmr: false, watch: null } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/connection-handle', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://127.0.0.1:17948/connection-handle');
  await page.evaluate(async cache => {
    const [{ default: React }, { default: { createRoot } }, { default: { flushSync } }, { CanvasConnectionHandle }] = await Promise.all([
      import(`/${cache}/deps/react.js`), import(`/${cache}/deps/react-dom_client.js`), import(`/${cache}/deps/react-dom.js`),
      import('/src/components/CanvasConnectionHandle.tsx'),
    ]);
    window.events = [];
    const root = createRoot(document.getElementById('root'));
    window.renderHandles = ({ zoom = 1, active = false, disabled = false, overlap = false, selected = true } = {}) => flushSync(() => root.render(React.createElement('div', {
      id: 'plane', style: { position: 'absolute', left: 200, top: 200, transform: `scale(${zoom})`, transformOrigin: '0 0', '--canvas-zoom': zoom },
    }, React.createElement('article', { id: 'card', className: `canvas-note ${selected ? 'is-selected' : ''}`, style: { position: 'relative', width: 300, height: 200, background: '#202020', '--bb-muted': '#aaa', '--bb-ink': '#dcdcdc', '--bb-blue': '#8faab8', '--bb-surface': '#222' } },
      React.createElement('textarea', { id: 'text', defaultValue: 'Editable content', style: { position: 'absolute', left: 20, top: 40, width: 240, height: 110 } }),
      ...['input', 'output'].map(side => React.createElement(CanvasConnectionHandle, {
        key: side, side, active, disabled,
        onPointerDown: event => { event.preventDefault(); event.stopPropagation(); window.events.push(['pointer', side]); },
        onClick: event => { if (event.detail === 0) window.events.push(['keyboard', side]); },
      }))), overlap && React.createElement('article', { id: 'neighbor', className: 'canvas-note is-selected', style: { position: 'absolute', left: 340, top: 0, width: 300, height: 200, background: '#202020' } },
      React.createElement(CanvasConnectionHandle, { side: 'input', 'data-neighbor': true,
        onPointerDown: event => { event.preventDefault(); event.stopPropagation(); window.events.push(['pointer', 'neighbor']); },
      })))));
    window.renderHandles();
  }, cache);
  const output = page.getByRole('button', { name: '添加下游', exact: true });
  const input = page.getByRole('button', { name: '添加上游', exact: true });
  const glyph = output.locator('.canvas-connection-glyph');
  const bounds = async locator => locator.boundingBox();
  const glyphOffset = () => glyph.evaluate(element => {
    const m = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: m.m41, y: m.m42 };
  });
  const approx = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < .1, `${label}: ${actual} vs ${expected}`);
  const visible = async (side, shown) => page.waitForFunction(({ side, shown }) => {
    const style = getComputedStyle(document.querySelector(`#card [data-canvas-connect-side="${side}"]`));
    return style.opacity === (shown ? '1' : '0') && style.pointerEvents === 'auto';
  }, { side, shown });
  await page.evaluate(() => window.renderHandles({ selected: false }));
  await page.mouse.move(900, 700);
  await visible('output', false);
  await page.mouse.move(140, 300);
  await visible('input', true);
  await page.mouse.move(900, 700);
  await visible('input', false);
  await page.mouse.move(560, 300);
  await visible('output', true);
  await page.mouse.click(560, 300);
  assert.deepEqual(await page.evaluate(() => window.events), [['pointer', 'output']], 'the enlarged outer zone reveals and starts a connection without first hovering the card');
  await page.evaluate(() => { window.events = []; });
  await page.mouse.move(900, 700);
  await visible('output', false);
  await page.locator('#card').hover();
  await visible('output', true);
  await page.mouse.move(518, 300);
  await visible('output', true);
  await page.mouse.move(900, 700);
  await visible('output', false);
  await output.focus();
  await visible('output', true);
  await output.evaluate(element => element.blur());
  await visible('output', false);
  await page.evaluate(() => document.getElementById('card').dataset.canvasConnectionSource = 'input');
  await visible('input', true);
  await visible('output', false);
  await page.evaluate(() => delete document.getElementById('card').dataset.canvasConnectionSource);
  await page.evaluate(() => window.renderHandles());
  await visible('output', true);
  const appearance = await glyph.evaluate(element => {
    const style = getComputedStyle(element);
    return [style.borderTopWidth, style.borderRadius, style.backgroundColor, getComputedStyle(element.querySelector('svg')).strokeLinecap];
  });
  assert.deepEqual(appearance, ['0px', '0px', 'rgba(0, 0, 0, 0)', 'butt'], 'industrial plus uses straight strokes without a circular plate');
  for (const zoom of [.1, .5, 1, 2.5]) {
    await page.evaluate(zoom => window.renderHandles({ zoom }), zoom);
    const card = await bounds(page.locator('#card'));
    const out = await bounds(output), incoming = await bounds(input);
    approx(out.width, 92.16, `output hit width at ${zoom}`);
    approx(out.height, 92.16, `output hit height at ${zoom}`);
    approx(incoming.width, 92.16, `input hit width at ${zoom}`);
    approx(out.x + out.width / 2 - card.x - card.width, 18, 'output offset');
    approx(card.x - incoming.x - incoming.width / 2, 18, 'input offset');
    approx((await bounds(glyph)).width, 25.2, 'glyph width');
    assert.equal(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.canvas-connection-handle'), {
      x: card.x + card.width - 1, y: card.y + card.height / 2,
    }), false, 'outward heat area does not steal even the last pixel of card content');
  }
  await page.evaluate(() => window.renderHandles());
  const original = await bounds(output);
  const center = { x: original.x + original.width / 2, y: original.y + original.height / 2 };
  await page.mouse.move(center.x + 25, center.y + 15);
  await page.waitForTimeout(230);
  const offset = await glyphOffset();
  assert.ok(offset.x > 0 && offset.y > 0 && Math.hypot(offset.x, offset.y) <= 8.01, 'glyph approaches pointer within 8px');
  assert.deepEqual(await bounds(output), original, 'magnetic feedback never moves the hit area');
  await mkdir('.tmp/canvas-connection-handle', { recursive: true });
  await page.screenshot({ path: '.tmp/canvas-connection-handle/magnetic.png', clip: { x: 130, y: 150, width: 450, height: 300 } });
  await page.mouse.down();
  await page.waitForTimeout(30);
  approx((await glyphOffset()).x, 0, 'pressed glyph stops magnetic motion');
  await page.mouse.up();
  await page.mouse.move(900, 700);
  await page.waitForTimeout(230);
  approx((await glyphOffset()).x, 0, 'leave resets magnetic motion');
  for (const [side, control, x, edge] of [['output', output, 501, 500], ['input', input, 199, 200]]) {
    await page.mouse.move(x, 300);
    await page.waitForTimeout(230);
    const box = await bounds(control.locator('.canvas-connection-glyph'));
    assert.ok(side === 'output' ? box.x >= edge - .1 : box.x + box.width <= edge + .1, `${side} frame stays outside the card while following inward`);
  }
  await page.locator('#text').fill('Can select and edit near the socket');
  assert.equal(await page.locator('#text').inputValue(), 'Can select and edit near the socket');
  await output.focus();
  await page.keyboard.press('Enter');
  assert.ok((await page.evaluate(() => window.events)).some(([kind, side]) => kind === 'keyboard' && side === 'output'), 'keyboard activates button');
  await page.evaluate(() => window.renderHandles({ active: true }));
  await page.mouse.move(center.x + 25, center.y + 15);
  await page.waitForTimeout(230);
  approx((await glyphOffset()).x, 0, 'connection state disables follow');
  await page.evaluate(() => window.renderHandles());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.mouse.move(900, 700);
  await page.mouse.move(center.x + 25, center.y + 15);
  await page.waitForTimeout(50);
  approx((await glyphOffset()).x, 0, 'reduced motion uses static glyph');
  await page.screenshot({ path: '.tmp/canvas-connection-handle/reduced-motion.png', clip: { x: 130, y: 150, width: 450, height: 300 } });
  await page.evaluate(() => window.renderHandles({ disabled: true }));
  assert.equal(await output.isDisabled(), true);
  assert.equal(await output.evaluate(element => getComputedStyle(element).pointerEvents), 'none', 'disabled hot zones cannot intercept the canvas');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => { window.events = []; window.renderHandles({ overlap: true }); });
  await page.mouse.move(510, 300);
  assert.equal(await page.evaluate(() => document.elementFromPoint(510, 300)?.hasAttribute('data-neighbor')), true, 'fixture makes farther neighbor topmost');
  assert.equal(await output.getAttribute('data-connection-hover'), 'true', 'nearest underlying socket receives hover');
  await page.mouse.down();
  await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => window.events), [['pointer', 'output']], 'overlap starts the nearer source exactly once');
  await page.mouse.move(530, 300);
  await page.mouse.down();
  await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => window.events), [['pointer', 'output'], ['pointer', 'neighbor']], 'nearest receiving socket wins on other side of overlap');
  await page.evaluate(() => window.renderHandles());
  await page.mouse.move(900, 700);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => {
      const light = theme === 'light';
      document.body.style.backgroundColor = light ? '#e7e7e7' : '#141414';
      const card = document.getElementById('card');
      card.style.backgroundColor = light ? '#f7f7f7' : '#1e1e1e';
      card.style.setProperty('--bb-ink', light ? '#2b2b2b' : '#dcdcdc');
      card.style.setProperty('--bb-blue', light ? '#496775' : '#8faab8');
      const text = document.getElementById('text');
      text.style.background = 'transparent';
      text.style.color = light ? '#2b2b2b' : '#dcdcdc';
      text.style.border = '0';
    }, theme);
    await page.waitForTimeout(180);
    await page.screenshot({ path: `.tmp/canvas-connection-handle/hatched-${theme}.png`, clip: { x: 130, y: 150, width: 450, height: 300 } });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: direct hot-zone reveal, fixed 92.16px hit area/25.2px glyph across 10–250% zoom, bounded magnetic movement, unclipped frame, stable hit area, press/reset, editing, keyboard, active/reduced motion and nearest overlapping socket selection');
} finally { await browser?.close(); await server.close(); }
