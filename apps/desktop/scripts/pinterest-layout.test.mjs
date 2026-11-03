import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { lensFixture, imageFor } from './fixtures/pinterest-layout/page.mjs';
import { startBrowserDrag, finishBrowserDrag } from './fixtures/explorer/native-drag.mjs';

const output = process.env.BOWERBIRD_PINTEREST_LAYOUT_OUTPUT || '.tmp/pinterest-layout';
await mkdir(output, { recursive: true });
const baseline = process.env.BOWERBIRD_PINTEREST_LAYOUT_BASELINE === '1';
const path = process.env.BOWERBIRD_PINTEREST_LAYOUT_PATH || 'src-tauri/src/commands/source_browser_pinterest_layout.js';
let layout = '';
if (!baseline) {
  try { layout = await readFile(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; console.log('Layout adapter absent: running the unmodified Lens baseline'); }
}
const [candidates, drag] = await Promise.all([
  readFile('../extension/candidate-utils.js', 'utf8'), readFile('src-tauri/src/commands/source_browser_drag.js', 'utf8'),
]);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=OverlayScrollbar'] });
const results = [];
const coverageOutput = process.env.BOWERBIRD_PINTEREST_LAYOUT_COVERAGE_PATH;
const coverageEntries = [];
const coveredPages = new Set();

async function collectCoverage(page) {
  if (coveredPages.delete(page)) coverageEntries.push(...await page.coverage.stopJSCoverage());
}

async function pageFor(width, url = 'https://www.pinterest.com/lens-search/?synthetic=1') {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  if (coverageOutput) {
    await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true });
    coveredPages.add(page);
    const close = page.close.bind(page);
    page.close = async options => { await collectCoverage(page); return close(options); };
  }
  page.setDefaultTimeout(6000);
  const errors = [], remote = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.dragNotices = []; window.open = url => { window.dragNotices.push(String(url)); return null; }; });
  await page.addInitScript(candidates);
  await page.addInitScript(drag.replace('__BOWERBIRD_DRAG_BRIDGE__', 'bowerbird-explorer://pinterest-layout'));
  if (layout) await page.addInitScript(layout + (coverageOutput ? '\n//# sourceURL=bowerbird-pinterest-layout.js' : ''));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'i.pinimg.com') return route.fulfill({ contentType: 'image/svg+xml', body: imageFor(url.href) });
    if (url.hostname === 'www.pinterest.com' || url.hostname === 'pinterest.test') return route.fulfill({ contentType: 'text/html',
      headers: { 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https://i.pinimg.com; frame-src https://www.pinterest.com" }, body: lensFixture() });
    remote.push(url.href); return route.abort();
  });
  await page.goto(url);
  await page.evaluate(() => Promise.all([...document.images].map(image => image.decode())));
  await page.waitForTimeout(400);
  return { page, errors, remote };
}

async function geometry(page) {
  return page.evaluate(() => {
    const source = document.querySelector('[data-test-id="visual-search-image-container"]');
    const image = document.querySelector('#source-image');
    const results = document.querySelector('#results');
    const grid = document.querySelector('#native-grid');
    const content = document.querySelector('#site-content');
    const rect = element => element.getBoundingClientRect().toJSON();
    const cards = [...grid.children].map(rect);
    return { width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
      contentWidth: content?.getBoundingClientRect().width || document.documentElement.clientWidth,
      source: rect(source), image: rect(image), fit: getComputedStyle(image).objectFit,
      result: rect(results), grid: rect(grid), cards, nativeLayout: window.layoutRuns.at(-1),
      sameNodes: window.originalPins.every((node, index) => node === grid.children[index]),
      overlap: cards.some((a, index) => cards.slice(index + 1).some(b => a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1)),
      sourceControlsVisible: [...source.querySelectorAll('[data-test-id="visual-search-cropper"], [data-source-action]')].some(element => element.getClientRects().length && getComputedStyle(element).display !== 'none'),
    };
  });
}

function assertLayout(value) {
  assert.ok(value.source.height <= 161, `source preview is at most 160px, got ${value.source.height}`);
  assert.ok(value.image.width > 0 && value.image.height > 0 && value.image.height <= 161, 'original image remains visible at a small height');
  assert.equal(value.fit, 'contain', 'long source uses contain so its contents are not cropped');
  assert.equal(value.sourceControlsVisible, false, 'fixed-coordinate cropper/actions are hidden for the read-only preview');
  assert.ok(value.result.top >= value.source.bottom - 1, 'results flow below the source preview');
  assert.ok(value.result.width >= value.contentWidth - 40, 'results use the content width instead of remaining behind the desktop placeholder');
  assert.ok(value.scrollWidth <= value.width + 1, `no horizontal overflow: ${value.scrollWidth} > ${value.width}`);
  assert.ok(value.cards.every(card => card.left >= -1 && card.right <= value.width + 1), 'all result columns fit inside the viewport');
  assert.equal(value.overlap, false, 'native masonry positions do not overlap');
  assert.equal(value.sameNodes, true, 'original Pin nodes and order are retained');
  assert.ok(Math.abs(value.nativeLayout.width - value.grid.width) < 1, 'site masonry measured the final available width');
}

async function dragResult(page, index) {
  await page.evaluate(() => { document.querySelector('#drop').style.display = 'block'; window.dropPayload = null; });
  const image = page.locator(`[data-grid-item="${index}"] img`);
  await image.scrollIntoViewIfNeeded();
  const rect = await image.boundingBox();
  let session, timeout;
  try {
    await Promise.race([(async () => {
      const started = await startBrowserDrag(page, rect.x + rect.width / 2, Math.max(rect.y + 30, Math.min(rect.y + rect.height / 2, 780)));
      session = started.session;
      await finishBrowserDrag(session, started.data, 40, 880); session = null;
    })(), new Promise((_, reject) => { timeout = setTimeout(() => { void page.close(); reject(new Error('Bounded native drag timed out')); }, 8000); })]);
    const payload = await page.evaluate(() => JSON.parse(window.dropPayload));
    assert.equal(payload.imageUrl, `https://i.pinimg.com/originals/result-${index}.svg`, 'drag keeps the original high-resolution candidate');
    assert.equal(payload.pageUrl, `https://www.pinterest.com/pin/${1000 + index}/`, 'drag keeps the original Pin link, not the Lens URL or source image');
    assert.equal(await page.evaluate(() => window.dragNotices.filter(url => new URL(url).pathname === '/start').length), 1);
  } finally { clearTimeout(timeout); await session?.detach().catch(() => {}); if (!page.isClosed()) await page.evaluate(() => document.querySelector('#drop').style.display = 'none').catch(() => {}); }
}

const cases = Object.fromEntries([300, 360, 480, 720].map(width => [`width-${width}`, async page => {
  assertLayout(await geometry(page));
  await page.screenshot({ path: `${output}/lens-${width}.png` });
  await dragResult(page, 1);
}]));
cases['spa-and-pagination'] = async page => {
  assertLayout(await geometry(page));
  const original = await page.evaluate(() => window.originalPins.length);
  await page.locator('[data-grid-item="2"] a').click();
  await page.waitForURL('**/pin/1002/');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#detail').isVisible(), true);
  assert.deepEqual(await page.evaluate(() => window.pinClicks), ['/pin/1002/'], 'the original site click handler runs exactly once');
  assert.equal(await page.locator('#source-image').evaluate(image => getComputedStyle(image).objectFit), 'cover', 'Lens-only overrides are removed on the detail route');
  await page.getByRole('button', { name: 'Back to results', exact: true }).click();
  await page.waitForURL('**/lens-search/**');
  await page.waitForTimeout(400);
  assertLayout(await geometry(page));
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForFunction(count => window.appendCount > count, original);
  await page.evaluate(() => Promise.all([...document.images].map(image => image.decode())));
  await page.waitForTimeout(250);
  assertLayout(await geometry(page));
  assert.equal(await page.locator('[data-grid-item]').count(), 12, 'window scrolling still triggers the site-owned next page');
  await page.setViewportSize({ width: 720, height: 900 });
  await page.waitForTimeout(400);
  const wide = await geometry(page); assertLayout(wide);
  await page.setViewportSize({ width: 300, height: 900 });
  await page.waitForTimeout(400);
  const narrow = await geometry(page); assertLayout(narrow);
  assert.ok(wide.nativeLayout.columns > narrow.nativeLayout.columns, 'native masonry recomputes its columns on resize');
};
cases['other-host'] = async page => {
  const value = await geometry(page);
  assert.equal(value.fit, 'cover');
  assert.equal(value.sourceControlsVisible, true, 'matching selectors on another host are untouched');
};
cases['spa-without-dom-change'] = async page => {
  assert.equal((await geometry(page)).fit, 'cover', 'homepage with matching DOM is untouched');
  await page.evaluate(() => history.pushState({}, '', '/lens-search/?synthetic=spa'));
  await page.waitForTimeout(600);
  assertLayout(await geometry(page));
  await page.evaluate(() => history.pushState({}, '', '/pin/9876/'));
  await page.waitForTimeout(600);
  const restored = await geometry(page);
  assert.equal(restored.fit, 'cover', 'route exit restores styles even without a DOM mutation');
  assert.equal(restored.sourceControlsVisible, true, 'route exit restores the original cropper and actions');
  await page.goBack();
  await page.waitForTimeout(600);
  assertLayout(await geometry(page));
};
cases['replace-source-wrappers'] = async page => {
  assertLayout(await geometry(page));
  await page.evaluate(() => {
    const oldMask = document.querySelector('#source-mask');
    window.sourceImageBefore = document.querySelector('#source-image');
    const mask = document.createElement('div'); mask.id = 'source-mask';
    mask.innerHTML = '<div id="source-aspect"></div><div data-test-id="visual-search-cropper"></div>';
    mask.firstElementChild.append(window.sourceImageBefore);
    oldMask.replaceWith(mask);
  });
  await page.waitForTimeout(400);
  assertLayout(await geometry(page));
  assert.equal(await page.evaluate(() => window.sourceImageBefore === document.querySelector('#source-image')), true, 'source image identity survives ancestor replacement');
  await page.locator('#source-image').evaluate(async image => {
    image.src = 'https://i.pinimg.com/originals/source-landscape.svg';
    await image.decode();
  });
  await page.waitForTimeout(300);
  assertLayout(await geometry(page));
  const ratio = await page.locator('#source-image').evaluate(image => {
    const rect = image.getBoundingClientRect();
    return { natural: image.naturalWidth / image.naturalHeight, shown: rect.width / rect.height };
  });
  assert.equal(ratio.natural, 4);
  assert.ok(Math.abs(ratio.shown - ratio.natural) < .01, 'landscape replacement retains all original image content and ratio');
};
cases['sidebar-content-width'] = async page => {
  await page.setViewportSize({ width: 300, height: 900 });
  await page.evaluate(() => {
    const content = document.createElement('div'); content.id = 'site-content';
    content.style.cssText = 'margin-left:72px;width:calc(100% - 72px)';
    document.body.append(content);
    content.append(document.querySelector('#lens-content'), document.querySelector('#detail'));
  });
  await page.waitForTimeout(400);
  const value = await geometry(page);
  assert.equal(value.contentWidth, value.width - 72);
  assertLayout(value);
  assert.equal(value.nativeLayout.columns, 1);
  await page.screenshot({ path: `${output}/lens-300-sidebar.png` });
  await dragResult(page, 1);
};
cases['top-frame-only'] = async page => {
  const attached = page.waitForEvent('frameattached');
  await page.evaluate(() => {
    const frame = document.createElement('iframe'); frame.name = 'nested-lens';
    frame.src = 'https://www.pinterest.com/lens-search/?synthetic=frame'; document.body.append(frame);
  });
  const frame = await attached;
  await frame.waitForURL('**/lens-search/?synthetic=frame');
  await frame.waitForSelector('#source-image');
  await page.waitForTimeout(400);
  assert.equal(await frame.evaluate(() => location.origin), 'https://www.pinterest.com');
  assert.equal(await frame.locator('#source-image').evaluate(image => getComputedStyle(image).objectFit), 'cover', 'exact Pinterest origin in a child frame is not adapted');
  assert.equal(await frame.locator('[data-test-id="visual-search-cropper"]').isVisible(), true);
};

try {
  for (const [name, run] of Object.entries(cases)) {
    const width = Number(name.slice(6)) || 360;
    const { page, errors, remote } = await pageFor(width, name === 'other-host' ? 'https://pinterest.test/lens-search/' : name === 'spa-without-dom-change' ? 'https://www.pinterest.com/' : undefined);
    try { await run(page); assert.deepEqual(errors, []); assert.deepEqual(remote, []); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.message, geometry: await geometry(page).catch(() => null) }); await page.screenshot({ path: `${output}/${name}-failure.png` }).catch(() => {}); }
    finally { await page.close(); }
  }
  await writeFile(`${output}/${baseline ? 'baseline' : 'result'}.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.map(({ name, passed, error }) => ({ name, passed, error })), null, 2));
  assert.equal(results.filter(result => !result.passed).length, 0, 'Pinterest Lens layout behavior passes');
} finally {
  try {
    for (const page of coveredPages) await collectCoverage(page);
    if (coverageOutput) await writeFile(coverageOutput, JSON.stringify(coverageEntries));
  } finally { await browser.close(); }
}
