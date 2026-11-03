import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = process.env.BOWERBIRD_DRAG_VISUAL_OUTPUT || '.tmp/explorer-drag-visual';
const source = await readFile(process.env.BOWERBIRD_DRAG_VISUAL_PATH || 'src/lib/explorerDragVisual.js', 'utf8');
const shapes = [
  { name: 'landscape', width: 480, height: 240 },
  { name: 'portrait', width: 180, height: 480 },
  { name: 'square', width: 320, height: 320 },
  { name: 'transparent', width: 400, height: 260, transparent: true },
];
const labels = [
  { key: 'one', name: '建筑', probability: .52, selected: true },
  { key: 'two', name: '空间设计', probability: .31, selected: false },
  { key: 'three', name: '摄影', probability: .12, selected: false },
  { key: 'no_match', name: '', probability: .05, selected: false },
];
const imageUrl = ({ width, height, transparent }) => `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
  + (transparent ? '' : `<rect width="${width}" height="${height}" fill="#c6d9e3"/>`)
  + `<path d="M0 ${height}L${width / 2} 0L${width} ${height}" fill="#456c88"/>`
  + `<rect width="${width / 8}" height="${height / 8}" fill="#ed665c"/><rect x="${width * 7 / 8}" width="${width / 8}" height="${height / 8}" fill="#efca52"/>`
  + `<rect y="${height * 7 / 8}" width="${width / 8}" height="${height / 8}" fill="#59a77d"/><rect x="${width * 7 / 8}" y="${height * 7 / 8}" width="${width / 8}" height="${height / 8}" fill="#a784c4"/></svg>`)}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
const errors = [];
const coverageOutput = process.env.BOWERBIRD_DRAG_VISUAL_COVERAGE_PATH;
const coverageEntries = [];
const coveredPages = new Set();

async function collectCoverage(page) {
  if (coveredPages.delete(page)) coverageEntries.push(...await page.coverage.stopJSCoverage());
}

async function pageFor(theme = 'light', reduced = false, width = 1120) {
  const page = await browser.newPage({ viewport: { width, height: 700 }, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  if (coverageOutput) {
    await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true });
    coveredPages.add(page);
    const close = page.close.bind(page);
    page.close = async options => { await collectCoverage(page); return close(options); };
  }
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(`<html data-theme="${theme}"><style>html,body{margin:0;width:100%;height:100%;background:${theme === 'dark' ? '#141414' : '#e7e7e7'}}#panel{position:absolute;inset:40px 24px;outline:1px solid ${theme === 'dark' ? '#3d3d3d' : '#c5c5c5'}}#target{position:absolute;left:50%;top:75%;width:80px;height:80px;background:${theme === 'dark' ? '#282828' : '#f7f7f7'}}</style><div id="panel"></div><div id="target"></div></html>`);
  await page.addScriptTag({ content: source + (coverageOutput ? '\n//# sourceURL=bowerbird-explorer-drag-visual.js' : '') });
  return page;
}

async function pick(page, shape, { mode = 'workspace', index = 0, x = 300, y = 330 } = {}) {
  await page.evaluate(({ shape, url, mode, index, x, y }) => {
    window.visuals ??= [];
    const visual = window.createBowerbirdDragVisual(mode === 'source' ? document.body : document.querySelector('#panel'));
    window.visuals[index] = visual;
    visual.pick({ id: `image-${index}`, imageUrl: url }, x, y,
      mode === 'source' ? { left: 20, top: 20, width: shape.width / 4, height: shape.height / 4 } : undefined);
  }, { shape, url: imageUrl(shape), mode, index, x, y });
  const host = page.locator('[data-explorer-drag-visual]').nth(index);
  await host.locator('img').evaluate(img => img.decode());
  await host.locator('.card').waitFor({ state: 'visible' });
  await host.locator('.card').evaluate(async card => { await Promise.all(card.getAnimations().map(animation => animation.finished)); });
  return host;
}

async function geometry(host) {
  return host.evaluate(element => {
    const shadow = element.shadowRoot;
    const card = shadow.querySelector('.card');
    const image = shadow.querySelector('img');
    const paper = image.parentElement;
    const css = getComputedStyle(card);
    const imageCss = getComputedStyle(image);
    const paperCss = getComputedStyle(paper);
    return {
      card: { width: card.offsetWidth, height: card.offsetHeight },
      image: { width: image.clientWidth, height: image.clientHeight, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight },
      padding: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft].map(parseFloat),
      border: [css.borderTopWidth, css.borderRightWidth, css.borderBottomWidth, css.borderLeftWidth].map(parseFloat),
      paper: { width: paper.clientWidth, height: paper.clientHeight, radius: paperCss.borderRadius, clip: paperCss.clipPath },
      fit: imageCss.objectFit, filter: imageCss.filter, opacity: imageCss.opacity,
      pointerEvents: getComputedStyle(element).pointerEvents,
      theme: element.dataset.theme,
    };
  });
}

function assertFullImage(value, label) {
  assert.deepEqual(value.padding, [0, 0, 0, 0], `${label}: thumbnail has no outer padding`);
  assert.ok(Math.abs(value.image.width / value.image.height - value.image.naturalWidth / value.image.naturalHeight) < .02,
    `${label}: thumbnail box follows original aspect, without letterboxing`);
  assert.ok(value.card.width - value.image.width <= 2 && value.card.height - value.image.height <= 2,
    `${label}: frame contains no reserved bands`);
  assert.equal(value.paper.width, value.image.width, `${label}: wrapper fits image width`);
  assert.equal(value.paper.height, value.image.height, `${label}: wrapper fits image height`);
  assert.equal(value.paper.radius, '0px', `${label}: original corners are not rounded away`);
  assert.equal(value.paper.clip, 'none', `${label}: original is not clipped`);
  assert.equal(value.fit, 'contain', `${label}: full image remains visible`);
  assert.equal(value.filter, 'none', `${label}: no filter alters image`);
  assert.equal(value.opacity, '1', `${label}: source alpha is preserved`);
  assert.equal(value.pointerEvents, 'none', `${label}: decoration cannot intercept a drop`);
}

async function check(name, run) {
  try { const details = await run(); results.push({ name, pass: true, details }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, pass: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
}

try {
  const parity = {};
  for (const theme of ['light', 'dark']) {
    for (const mode of ['source', 'workspace']) {
      const page = await pageFor(theme);
      try {
        const values = [];
        for (const [index, shape] of shapes.entries()) {
          const host = await pick(page, shape, { mode, index, x: 100 + index * 270 });
          values.push(await geometry(host));
        }
        await page.screenshot({ path: `${output}/${theme}-${mode}.png` });
        parity[`${theme}-${mode}`] = values.map(({ card, image }) => ({ card, image }));
        await check(`${theme}-${mode}-aspect-and-frame`, async () => {
          await writeFile(`${output}/${theme}-${mode}-geometry.json`, JSON.stringify(values, null, 2));
          for (const [index, value] of values.entries()) { assertFullImage(value, shapes[index].name); assert.equal(value.theme, theme); }
          return values;
        });
      } finally { await page.close(); }
    }
  }
  await check('source-workspace-parity', async () => {
    assert.deepEqual(parity['light-source'], parity['light-workspace']);
    assert.deepEqual(parity['dark-source'], parity['dark-workspace']);
  });
  await check('preview-replacement-keeps-natural-aspect', async () => {
    const page = await pageFor();
    try {
      const host = await pick(page, shapes[0]);
      const first = await host.locator('img').getAttribute('src');
      await page.evaluate(thumbnail => window.visuals[0].update({ id: 'old-image', thumbnail }), imageUrl(shapes[1]));
      assert.equal(await host.locator('img').getAttribute('src'), first, 'a late preview from another drag cannot replace the image');
      await page.evaluate(thumbnail => window.visuals[0].update({ id: 'image-0', thumbnail }), imageUrl(shapes[1]));
      await host.locator('img').evaluate(async img => { await img.decode(); await new Promise(requestAnimationFrame); });
      const value = await geometry(host);
      assert.equal(value.image.naturalWidth, shapes[1].width);
      assertFullImage(value, 'updated portrait preview');
      return value;
    } finally { await page.close(); }
  });
  for (const width of [360, 900]) {
    await check(`panel-edges-${width}`, async () => {
      const page = await pageFor('dark', true, width);
      try {
        const host = await pick(page, shapes[0]);
        await page.evaluate(labels => window.visuals[0].update({ id: 'image-0', labels }), labels);
        const bounds = await page.locator('#panel').boundingBox();
        for (const [x, y] of [[0, 0], [width, 0], [0, 700], [width, 700]]) {
          await page.evaluate(({ x, y }) => window.visuals[0].move(x, y), { x, y });
          for (const item of await host.locator('.card,.candidate,.grip,.caption').all()) {
            if (!(await item.isVisible())) continue;
            const box = await item.boundingBox();
            assert.ok(box.x >= bounds.x - 1 && box.y >= bounds.y - 1 && box.x + box.width <= bounds.x + bounds.width + 1 && box.y + box.height <= bounds.y + bounds.height + 1,
              `visible carry element remains inside ${width}px panel: ${JSON.stringify(box)}`);
          }
        }
        await page.screenshot({ path: `${output}/edges-${width}.png` });
      } finally { await page.close(); }
    });
  }
  for (const reduced of [false, true]) {
    await check(`land-settle-${reduced ? 'reduced' : 'motion'}`, async () => {
      const page = await pageFor('light', reduced);
      try {
        const host = await pick(page, shapes[1]);
        if (reduced) assert.equal(await host.locator('.card').evaluate(el => el.getAnimations().length), 0);
        await page.evaluate(() => window.visuals[0].land(560, 350));
        assert.equal(await host.locator('.root').getAttribute('data-phase'), 'landing');
        await host.locator('.card').evaluate(async card => { await Promise.all(card.getAnimations().map(animation => animation.finished)); });
        const value = await geometry(host);
        assertFullImage(value, 'landed portrait');
        const box = await host.locator('.card').boundingBox();
        assert.ok(Math.abs(box.x + box.width / 2 - 560) <= 1 && Math.abs(box.y + box.height / 2 - 350) <= 1, 'landing is centered on the drop point');
        assert.equal(await host.locator('.grip').isVisible(), false);
        await page.screenshot({ path: `${output}/landing-${reduced ? 'reduced' : 'motion'}.png` });
        await page.evaluate(() => window.visuals[0].settle(document.querySelector('#target')));
        await host.waitFor({ state: 'detached' });
        const animations = await page.locator('#target').evaluate(el => el.getAnimations().length);
        assert.equal(animations, reduced ? 0 : 1, 'settle respects reduced motion');
      } finally { await page.close(); }
    });
  }
  assert.deepEqual(errors, [], 'no browser errors');
} finally {
  try {
    for (const page of coveredPages) if (!page.isClosed()) await collectCoverage(page);
    if (coverageOutput) await writeFile(coverageOutput, JSON.stringify(coverageEntries));
    await writeFile(`${output}/result.json`, JSON.stringify(results, null, 2));
  } finally { await browser.close(); }
}
assert.equal(results.filter(value => !value.pass).length, 0, 'all shared drag visual cases pass');
