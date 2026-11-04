import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { indicatorSignature as indicator } from './fixtures/library-creation-parity/indicator-signature.mjs';
const frozen = JSON.parse(await readFile(new URL('./fixtures/library-creation-parity/canvas-indicator-baseline.json', import.meta.url), 'utf8'));
const output = '.tmp/library-creation-parity';
await mkdir(output, { recursive: true });
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 18951, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(7000);
const errors = [], remote = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => { if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue(); remote.push(route.request().url()); return route.abort(); });
const composer = page.getByRole('region', { name: '素材库创作', exact: true });
const editor = composer.locator('.ProseMirror');
const preview = page.getByRole('dialog', { name: '图片与会话预览', exact: true });
const idle = () => page.waitForTimeout(700);
const pickCount = () => page.evaluate(() => window.parityPicks.length);
const chipCount = () => editor.locator('[data-asset-id]').count();
const closePreview = async () => { await page.keyboard.press('Escape'); await preview.waitFor({state:'detached'}); };
async function unchangedDraft() { assert.ok((await editor.innerText()).includes('主屏保留的草稿'), 'material navigation keeps the home draft'); }
async function singlePreview(target) {
  const before = { picks: await pickCount(), chips: await chipCount() };
  await target.click(); await preview.waitFor(); await idle();
  assert.equal(await pickCount(), before.picks); assert.equal(await chipCount(), before.chips);
  assert.equal(await page.locator('.media-lightbox').count(), 0, 'creation preview is separate from ordinary media detail');
  const image = await preview.getByRole('region', {name:'放大图片'}).boundingBox();
  const detail = await preview.getByRole('region', {name:'独立会话面板'}).boundingBox();
  assert.ok(image.width > 100 && detail.width > 100 && image.x + image.width <= detail.x + 2, 'home uses the same image/conversation layout');
  await closePreview(); await unchangedDraft();
}
async function doubleReference(target) {
  const picks = await pickCount(), chips = await chipCount();
  await target.dblclick(); await page.waitForFunction(count => window.parityPicks.length > count, picks); await idle();
  assert.equal(await pickCount(), picks + 1, 'double click dispatches exactly one reference');
  assert.equal(await chipCount(), chips + 1, 'double click inserts exactly one editor chip');
  assert.equal(await preview.count(), 0); assert.equal(await page.locator('.media-lightbox').count(), 0);
  assert.equal(await page.evaluate(() => window.store.getState().detailAssetId), null);
  await unchangedDraft();
}
async function openApp() {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/library-creation-parity/preview.html?source-library&detail-route&canvas-library`);
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
}
try {
  await openApp();
  await page.locator('.canvas-composer-host .ProseMirror').fill('画板原草稿');
  const baseline = {};
  for (const theme of ['dark', 'light']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    baseline[theme] = await indicator(page.locator('.canvas-workspace'));
  }
  assert.ok(baseline.dark && baseline.light, 'actual canvas creation indicator is present');
  const hint = page.locator('.canvas-workspace .composer-reference-hint');
  assert.equal(await hint.innerText(), '双击添加素材');
  assert.equal(await hint.isVisible(), true);
  assert.equal(await hint.evaluate(element => {
    return element.closest('.composer-projection') !== null;
  }), true, 'reference hint belongs to the composer, not the top marking');
  assert.equal(await page.locator('.creation-mode-indicator-hint').count(), 0);
  assert.deepEqual(baseline, frozen.themes, 'canvas retains its frozen pre-change deep/light painted appearance');
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await page.getByRole('navigation', { name: '首页' }).getByRole('button', { name: '素材库', exact: true }).click();
  await editor.fill('主屏保留的草稿');
  assert.equal(await page.locator('.library-composer .composer-reference-hint').innerText(), '双击添加素材');
  const observed = {};
  for (const theme of ['dark', 'light']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    observed[theme] = await indicator(page.locator('.home-workspace-route'));
  }
  const addButtonCount = await composer.getByRole('button', { name: '添加参考素材', exact: true }).count();
  const asset = page.locator('.library-home [data-asset-id]').first();
  await asset.waitFor();
  const id = await asset.getAttribute('data-asset-id');
  // Focus/Space occurs before any pointer interaction reaches the newly mounted Home host.
  await asset.focus(); await page.keyboard.press('Space'); await preview.waitFor();
  assert.equal(await pickCount(), 0); assert.equal(await chipCount(), 0, 'first keyboard activation previews without a reference');
  await closePreview();
  await asset.click(); await page.waitForTimeout(650);
  const firstClick = { preview: await preview.count(), references: await editor.locator(`[data-asset-id="${id}"]`).count(), picks: await page.evaluate(() => window.parityPicks.length), prepared: await page.evaluate(() => window.preparedProjects.length) };
  const findings = { baseline, observed, addButtonCount, firstClick, errors, remote };
  await writeFile(`${output}/observed.json`, JSON.stringify(findings, null, 2));
  if (process.argv.includes('--red-probe')) {
    await writeFile(`${output}/red-observed.json`, JSON.stringify(findings, null, 2));
    await page.screenshot({ path: `${output}/red-home.png` });
  }
  assert.deepEqual({ observed, addButtonCount, firstClick }, { observed: baseline, addButtonCount: 0, firstClick: { preview: 1, references: 0, picks: 0, prepared: 0 } }, 'home must keep canvas appearance, material action and single-click preview without inserting or creating a project');
  await closePreview();
  await editor.focus(); await page.keyboard.press('Tab');
  await page.waitForFunction(() => !!document.activeElement?.closest('.library-pane-content[data-active="true"]'));
  assert.equal(await page.evaluate(() => window.store.getState().boardOpen), true);
  await unchangedDraft();
  await editor.focus(); await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.library-home')), false, 'Shift+Tab is not redirected into the library');
  await editor.focus(); await doubleReference(asset);
  const beforeControl = await pickCount();
  for (const modifier of ['Control', 'Meta', 'Shift']) {
    await page.locator('.library-home [data-asset-id]').nth(1).click({modifiers:[modifier]});
    await page.locator('.catalog-selection').waitFor(); await idle();
    assert.equal(await pickCount(), beforeControl, `${modifier} selection does not attach or preview`); assert.equal(await preview.count(),0);
    await page.locator('.catalog-selection').getByRole('button',{name:/取消/}).click();
  }
  await composer.getByRole('button',{name:'退出创作模式',exact:true}).click();
  await asset.click(); await page.getByRole('dialog',{name:/^媒体预览/}).waitFor();
  assert.equal(await pickCount(), beforeControl, 'ordinary browsing keeps media preview behavior');
  await page.keyboard.press('Escape'); await page.locator('.media-lightbox').waitFor({state:'detached'});
  await editor.focus();

  // The visible virtual page can contain assets absent from the shared store cache.
  const scroller = page.locator('.library-home .catalog-scroller');
  await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const paged = page.locator('.library-home [data-asset-id="parity-paged-119"]');
  await paged.waitFor();
  assert.ok(await page.evaluate(() => window.parityCatalogPages.some(read => read.command === 'catalog_page' && read.offset >= 60)), 'the virtual catalog actually reads a later page');
  assert.equal(await page.evaluate(() => [...window.store.getState().assets, ...window.store.getState().promptedAssets].some(asset => asset.id === 'parity-paged-119')), false, 'paged image is absent from both shared caches');
  const reads = await page.evaluate(() => window.parityAssetReads.length);
  await singlePreview(paged);
  assert.ok(await page.evaluate(count => window.parityAssetReads.slice(count).some(ids => ids.includes('parity-paged-119')), reads), 'preview resolves a paged image through authoritative asset IPC');
  const pagedPicks = await pickCount(), pagedChips = await chipCount();
  await paged.focus(); await page.keyboard.press('Enter'); await preview.waitFor(); await idle();
  assert.equal(await pickCount(), pagedPicks); assert.equal(await chipCount(), pagedChips);
  await closePreview();
  await paged.focus(); await page.keyboard.press('Space'); await preview.waitFor();
  assert.equal(await pickCount(), pagedPicks); assert.equal(await chipCount(), pagedChips);
  await closePreview();
  const drag = await paged.boundingBox();
  await page.mouse.move(drag.x + drag.width / 2, drag.y + drag.height / 2); await page.mouse.down();
  await page.mouse.move(drag.x + drag.width / 2 + 4, drag.y + drag.height / 2, { steps: 2 }); await page.mouse.up(); await idle();
  assert.equal(await preview.count(), 0, '4px movement cancels the pending preview');
  assert.equal(await pickCount(), pagedPicks); assert.equal(await chipCount(), pagedChips);
  await paged.focus(); await page.keyboard.press('Space'); await idle();
  assert.equal(await preview.count(), 1, 'keyboard Space still previews after a cancelled pointer drag');
  assert.equal(await pickCount(), pagedPicks); assert.equal(await chipCount(), pagedChips);
  await closePreview();

  const nav = page.getByRole('navigation',{name:'首页'});
  for (const cancel of ['route', 'mode']) {
    await page.evaluate(() => { window.parityHoldAssets = true; window.releaseParityAssets = null; });
    await paged.click(); await page.waitForFunction(() => typeof window.releaseParityAssets === 'function');
    if (cancel === 'route') await nav.getByRole('button',{name:'项目',exact:true}).click();
    else await composer.getByRole('button',{name:'退出创作模式',exact:true}).click();
    await page.evaluate(() => { window.parityHoldAssets = false; window.releaseParityAssets(); }); await idle();
    assert.equal(await preview.count(),0, `${cancel} change discards a late asset read`);
    assert.equal(await pickCount(),pagedPicks);
    if (cancel === 'route') { await nav.getByRole('button',{name:'素材库',exact:true}).click(); await composer.waitFor(); await paged.waitFor(); }
    await editor.focus(); await unchangedDraft();
  }

  // A late read from an older click cannot replace the image selected more recently on this same route.
  await page.evaluate(() => { window.parityHoldAssets = true; window.parityAssetReleases = {}; });
  await paged.click(); await page.waitForFunction(() => !!window.parityAssetReleases['parity-paged-119']);
  const newerPaged = page.locator('.library-home [data-asset-id="parity-paged-118"]');
  await newerPaged.click(); await page.waitForFunction(() => !!window.parityAssetReleases['parity-paged-118']);
  await page.evaluate(() => window.parityAssetReleases['parity-paged-118']());
  await preview.getByRole('img', { name: '分页素材 118', exact: true }).waitFor();
  await page.evaluate(() => { window.parityHoldAssets = false; window.parityAssetReleases['parity-paged-119'](); }); await idle();
  assert.equal(await preview.getByRole('img', { name: '分页素材 118', exact: true }).count(), 1, 'newer image remains visible after the previous IPC returns');
  assert.equal(await preview.getByRole('img', { name: '分页素材 119', exact: true }).count(), 0);
  assert.equal(await pickCount(), pagedPicks); assert.equal(await chipCount(), pagedChips);
  await closePreview(); await unchangedDraft();

  await page.locator('.library-home').getByRole('tab',{name:'集合分类',exact:true}).click();
  const connected = page.locator('[data-connection-entry="parity-entry-1"] .folder-media-card');
  await connected.waitFor();
  await singlePreview(connected); await doubleReference(connected);
  const connectedPicks = await pickCount();
  for (const modifier of ['Control', 'Meta', 'Shift']) {
    await page.locator('[data-connection-entry="parity-entry-2"] .folder-media-card').click({modifiers:[modifier]});
    await page.locator('.connected-selection').waitFor(); await idle();
    assert.equal(await pickCount(),connectedPicks, `${modifier} connected selection does not attach`); assert.equal(await preview.count(),0);
    await page.locator('.connected-selection').getByRole('button',{name:/取消/}).click();
  }

  // Navigate during the single-click delay; the old route must not reopen a preview.
  await connected.click();
  await nav.getByRole('button',{name:'项目',exact:true}).click(); await idle();
  assert.equal(await preview.count(),0); assert.equal(await pickCount(),connectedPicks);
  assert.equal(await composer.count(),0);
  await page.getByRole('button',{name:'打开项目 山野品牌 1',exact:true}).click();
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  const canvasEditor = page.locator('.canvas-composer-host .ProseMirror');
  assert.ok((await canvasEditor.innerText()).includes('画板原草稿'),'returning to canvas restores its independent draft');
  assert.ok(!(await canvasEditor.innerText()).includes('主屏保留的草稿'));
  await canvasEditor.focus();
  const canvasAsset = page.locator('[data-canvas-node-id="old"]');
  await canvasAsset.click(); await preview.waitFor();
  assert.equal(await pickCount(),connectedPicks,'canvas single click still previews');
  await closePreview(); await canvasAsset.dblclick();
  await page.waitForFunction(count=>window.parityPicks.length>count,connectedPicks); await idle();
  assert.equal(await pickCount(),connectedPicks+1,'canvas double click remains exactly one reference');
  assert.equal(await preview.count(),0);
  await page.getByRole('button',{name:'返回主页',exact:true}).click();
  await nav.getByRole('button',{name:'素材库',exact:true}).click(); await composer.waitFor(); await unchangedDraft();
  assert.equal(await page.evaluate(()=>window.preparedProjects.length),0,'preview and references do not prepare any project');
  assert.equal(await page.evaluate(()=>window.generationCalls.length),0,'no interaction submits generation');
  for(const theme of ['dark','light']) { await page.evaluate(value=>document.documentElement.dataset.theme=value,theme); await editor.focus(); await singlePreview(connected); await page.screenshot({path:`${output}/${theme}.png`}); }
  assert.deepEqual(errors, []); assert.deepEqual(remote, []);
  console.log('PASS actual App frozen appearance, material/Tab focus, tag/collection click parity, paged cache-miss resolution, late/out-of-order IPC cancellation, first/after-drag Space and Enter, Control/Meta/Shift selection, independent drafts and unchanged canvas gestures');
} finally { await browser.close(); await server.close(); }
