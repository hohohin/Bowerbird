import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { startBrowserDrag, finishBrowserDrag } from './fixtures/explorer/native-drag.mjs';
import { feedFixture, syntheticImage, pinMarkup, cardCss } from './fixtures/pinterest-feed-drag/page.mjs';
import { lensFixture, imageFor } from './fixtures/pinterest-layout/page.mjs';

const output = process.env.BOWERBIRD_PINTEREST_FEED_OUTPUT || '.tmp/pinterest-feed-drag';
await mkdir(output, { recursive: true });
const [candidates, drag, layout] = await Promise.all([
  readFile('../extension/candidate-utils.js', 'utf8'),
  readFile(process.env.BOWERBIRD_EXPLORER_DRAG_PATH || 'src-tauri/src/commands/source_browser_drag.js', 'utf8'),
  readFile('src-tauri/src/commands/source_browser_pinterest_layout.js', 'utf8'),
]);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
const coverageOutput = process.env.BOWERBIRD_PINTEREST_FEED_COVERAGE_PATH;
const coverageEntries = [];
const coveredPages = new Set();

async function collectCoverage(page) {
  if (coveredPages.delete(page)) coverageEntries.push(...await page.coverage.stopJSCoverage());
}
const cases = (process.env.BOWERBIRD_PINTEREST_FEED_CASES || 'hover,top-wash,transparent,detail-image,lens-hover,save,text,modal-blank,modal-text,backdrop,opaque-panel,arbitrary-overlay,other-host,nested-other-pin,neighbor-pin').split(',');

async function createPage(kind) {
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  if (coverageOutput) {
    await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true });
    coveredPages.add(page);
    const close = page.close.bind(page);
    page.close = async options => { await collectCoverage(page); return close(options); };
  }
  page.setDefaultTimeout(6000);
  await page.addInitScript(() => {
    window.notices = []; window.open = url => { window.notices.push(String(url)); return null; };
    window.addEventListener('pointerdown', event => { window.downTarget = event.target; }, true);
  });
  await page.addInitScript(candidates);
  await page.addInitScript(drag.replace('__BOWERBIRD_DRAG_BRIDGE__', 'bowerbird-explorer://pinterest-feed')
    + (coverageOutput ? '\n//# sourceURL=bowerbird-source-browser-drag.js' : ''));
  if (kind === 'lens-hover') await page.addInitScript(layout);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'i.pinimg.com') return route.fulfill({ contentType: 'image/svg+xml', body: url.pathname.includes('/target.svg') ? syntheticImage : imageFor(url.href) });
    if (url.hostname === 'www.pinterest.com' || url.hostname === 'feed.test') return route.fulfill({ contentType: 'text/html', body: kind === 'lens-hover' ? lensFixture() : feedFixture(kind) });
    return route.abort();
  });
  await page.goto(kind === 'other-host' ? 'https://feed.test/' : kind === 'lens-hover' ? 'https://www.pinterest.com/lens-search/' : kind === 'detail-image' ? 'https://www.pinterest.com/pin/1001/' : 'https://www.pinterest.com/');
  if (kind === 'lens-hover') {
    await page.setViewportSize({ width: 480, height: 700 });
    await page.evaluate(({ markup, css }) => {
      const style = document.createElement('style'); style.textContent = css + '#native-grid #card{left:0;top:0;width:100%;height:340px}#native-grid #pin-link,#native-grid #pin-image{width:100%}#drop{left:auto}'; document.head.append(style);
      document.querySelector('[data-grid-item="1"]').innerHTML = markup;
      window.dispatchEvent(new Event('resize'));
    }, { markup: pinMarkup(), css: cardCss() });
  }
  await page.evaluate(() => Promise.all([...document.images].map(image => image.decode())));
  return page;
}

async function captureAt(page, point) {
  let session, timeout;
  try {
    await Promise.race([(async () => {
      const started = await startBrowserDrag(page, point.x, point.y); session = started.session;
      const drop = await page.locator('#drop').boundingBox();
      await finishBrowserDrag(session, started.data, drop.x + drop.width / 2, drop.y + drop.height / 2); session = null;
    })(), new Promise((_, reject) => { timeout = setTimeout(() => { void page.close(); reject(new Error('Bounded native drag timed out')); }, 8000); })]);
    return await page.evaluate(() => ({ payload: window.dropPayload ? JSON.parse(window.dropPayload) : null,
      target: window.downTarget?.id, notices: window.notices,
      shade: document.querySelector('#top-wash') && getComputedStyle(document.querySelector('#top-wash')).backgroundColor,
      gradient: document.querySelector('#hover-hit') && getComputedStyle(document.querySelector('#hover-hit')).backgroundImage }));
  } finally { clearTimeout(timeout); await session?.detach().catch(() => {}); }
}

async function rejectedGesture(page, kind) {
  if (kind === 'text') {
    await page.mouse.move(160, 190);
    await page.locator('#label').waitFor({ state: 'visible' });
  }
  const selectors = { save: '#save', text: '#label', 'modal-text': '#modal-text' };
  const point = selectors[kind] ? await page.locator(selectors[kind]).evaluate(element => {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) throw new Error('Gesture target is not visible');
    return { x: rect.x + 8, y: rect.y + 12 };
  }) : { x: 160, y: kind === 'modal-blank' ? 300 : 190 };
  const session = await page.context().newCDPSession(page);
  const intercepted = [];
  session.on('Input.dragIntercepted', ({ data }) => intercepted.push(data));
  let timeout;
  try {
    await Promise.race([(async () => {
      await session.send('Input.setInterceptDrags', { enabled: true });
      await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
      for (let step = 1; step <= 8; step++) await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + step * 18, y: point.y, button: 'left', buttons: 1 });
      await page.waitForTimeout(80);
      if (intercepted.length) await session.send('Input.dispatchDragEvent', { type: 'dragCancel', x: point.x + 144, y: point.y, data: intercepted.at(-1) });
      await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + 144, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
    })(), new Promise((_, reject) => { timeout = setTimeout(() => { void page.close(); reject(new Error('Bounded negative gesture timed out')); }, 8000); })]);
    assert.equal(intercepted.some(data => data.items.some(item => item.mimeType === 'application/x-bowerbird-explorer' || item.data.startsWith('bowerbird-explorer:'))), false, `${kind}: protected content does not produce capture data`);
    assert.equal(await page.evaluate(() => window.notices.some(url => new URL(url).pathname === '/start')), false, `${kind}: no capture notice`);
    if (kind === 'modal-text') assert.ok((await page.evaluate(() => String(getSelection()))).length >= 5, 'modal paragraph remains selectable');
  } finally { clearTimeout(timeout); await session.detach().catch(() => {}); }
}

try {
  for (const kind of cases) {
    const page = await createPage(kind);
    try {
      if (!['hover', 'top-wash', 'transparent', 'detail-image', 'lens-hover'].includes(kind)) {
        await rejectedGesture(page, kind); results.push({ kind, passed: true }); continue;
      }
      const image = await page.locator('#pin-image').boundingBox();
      const result = await captureAt(page, { x: image.x + image.width / 2, y: image.y + (kind === 'top-wash' ? 25 : 120) });
      assert.ok(result.payload, `hovered Pin image must produce capture data: ${JSON.stringify(result)}`);
      assert.equal(result.payload.imageUrl, 'https://i.pinimg.com/originals/target.svg');
      assert.equal(result.payload.pageUrl, 'https://www.pinterest.com/pin/1001/');
      assert.equal(result.notices.filter(url => new URL(url).pathname === '/start').length, 1);
      results.push({ kind, passed: true });
    } catch (error) { results.push({ kind, passed: false, error: error.message }); if (!page.isClosed()) await page.screenshot({ path: `${output}/${kind}.png` }); }
    finally { await page.close(); }
  }
  await writeFile(`${output}/result.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  assert.equal(results.filter(result => !result.passed).length, 0, 'Pinterest feed dragging works without opening Pin details');
} finally {
  try {
    for (const page of coveredPages) if (!page.isClosed()) await collectCoverage(page);
    if (coverageOutput) await writeFile(coverageOutput, JSON.stringify(coverageEntries));
  } finally { await browser.close(); }
}
