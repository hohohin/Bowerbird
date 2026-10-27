import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/library-selection-integrated';
await mkdir(output, { recursive: true });
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 17927, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(12000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
await page.addInitScript(() => {
  window.selectionEntries = [];
  document.addEventListener('animationstart', event => {
    const mark = event.target.closest?.('.library-selection-mark');
    if (mark) window.selectionEntries.push({ id: mark.closest('[data-asset-id]')?.dataset.assetId, name: event.animationName });
  });
});
const library = () => page.locator('.categorized-library');
const media = id => library().locator(`[data-asset-id="selection-${id}"]`);
const slots = root => root.locator('.folder-media-card').evaluateAll(elements => elements.slice(0, 12).map(element => ({ id: element.dataset.assetId ?? element.getAttribute('aria-label'), width: element.offsetWidth, height: element.offsetHeight, transform: element.style.transform })));
async function waitForMedia() {
  await page.locator('.catalog-view-wipe').waitFor({ state: 'detached' });
  await media(0).waitFor();
  await page.waitForTimeout(500);
}
async function clearSelection() {
  await library().getByRole('button', { name: '取消选择', exact: true }).click();
  await page.waitForTimeout(350);
  assert.equal(await library().locator('.library-selection-mark').count(), 0);
}
async function verifyMenuTargets(assetId, ids, context) {
  await page.waitForFunction(id => window.store.getState().contextMenu?.assetId === id, assetId);
  assert.deepEqual(await page.evaluate(() => {
    const menu = window.store.getState().contextMenu;
    return { assetId: menu.assetId, targets: menu.fileSelection?.assets.map(asset => asset.id) };
  }), { assetId, targets: ids }, `${context}: menu targets remain independent of the visual selection`);
}
async function closeMenu(scene) {
  // The lightweight home fixture has no global menu renderer; the project fixture does.
  if (scene === 'project') {
    await page.getByRole('menu').first().waitFor();
    await page.keyboard.press('Escape');
  } else await page.evaluate(() => window.store.getState().closeContextMenu());
  await page.waitForFunction(() => window.store.getState().contextMenu === null);
}
async function verifyUnselected(card, context) {
  assert.equal(await card.getAttribute('aria-pressed'), 'false', `${context}: opening a menu does not select the card`);
  assert.equal(await card.locator('.library-selection-mark').count(), 0, `${context}: no selection decoration`);
  assert.ok(await card.evaluate(element => {
    const style = getComputedStyle(element.querySelector('.folder-media-preview'));
    return ['none', '1'].includes(style.scale) && style.transform === 'none';
  }), `${context}: the preview keeps its original scale instead of shrinking to 88%`);
}
async function installMedia() {
  await page.evaluate(async () => {
    window.selectionMode = (await import('/src/lib/localFileMode.ts')).useLocalFileMode;
    const previous = window.__TAURI_INTERNALS__.invoke;
    const assets = Array.from({ length: 90 }, (_, index) => {
      const height = [160, 240, 360][index % 3];
      // Deliberately mismatch one thumbnail's natural ratio and catalog metadata
      // to exercise the actual object-fit:contain paint rectangle.
      const imageHeight = index === 2 ? 480 : height;
      const thumb = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="${imageHeight}"><rect width="240" height="${imageHeight}" fill="${['#8ba4a8', '#cfb694', '#8a9e88'][index % 3]}"/><path d="M0 0L240 ${imageHeight}M240 0L0 ${imageHeight}" stroke="white" opacity=".18"/><text x="16" y="38" fill="white" font-family="sans-serif" font-size="20">${index + 1}</text></svg>`);
      return { id: `selection-${index}`, name: `素材${index}.png`, ext: 'png', source: 'imported', width: 240, height, store_path: `/selection/${index}.png`, thumb_path: thumb };
    });
    const video = { ...assets[0], id: 'selection-video', name: '片段.mp4', ext: 'mp4', store_path: '/selection/clip.mp4' };
    const entries = [{ name: '文件夹', path: '/selection/folder', directory: true }, ...assets.slice(0, 3).map(asset => ({ name: asset.name, path: asset.store_path, directory: false, preview: asset.thumb_path })), { name: video.name, path: video.store_path, directory: false, preview: video.thumb_path }];
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === 'material_catalog') return { tags: [{ id: 'selection', name: '选中动效', count: 90, projectCount: 90, description: '' }], collections: [{ id: 'selection-collection', name: '示例集合', kind: 'collection', parent_id: null }], prompts: [], tag_asset_ids: { selection: assets.map(asset => asset.id) } };
      if (command === 'material_catalog_assets') return [...assets, video];
      if (command === 'get_assets_by_ids') return [...assets, video].filter(asset => args.assetIds.includes(asset.id));
      if (command === 'external_files_index') return [...assets, video].find(asset => asset.store_path === args.path);
      if (command === 'file_colors') return [];
      if (command === 'file_workspace_status') return { config: { root: '/selection', places: [], projects: {} }, proposed_root: '/selection' };
      if (command === 'external_files_browse') return { path: '/selection', parent: null, total: entries.length, entries };
      if (command === 'external_files_preview' || command === 'external_files_media') return assets.find(asset => asset.store_path === args.path)?.thumb_path ?? assets[0].thumb_path;
      if (command === 'folder_classification_view') return { root: '/selection', record: { version: 1, recursive: false, labels: [], pictures: [] } };
      return previous(command, args);
    };
    window.store.getState().setThumbnailWidth('library', 180);
    window.selectionMode.getState().openBrowser();
  });
  await page.locator('.local-file-workspace').waitFor();
  await page.evaluate(() => { window.selectionMode.getState().setCatalogView('all'); });
  await waitForMedia();
}

async function verifySelected(card, context) {
  assert.equal(await card.getAttribute('aria-pressed'), 'true', `${context}: selected semantics remain on the card`);
  const state = await card.evaluate(element => {
    const mark = element.querySelector('.library-selection-mark');
    const preview = element.querySelector('.folder-media-preview'), image = preview.querySelector('img');
    const box = element.getBoundingClientRect(), inner = preview.getBoundingClientRect();
    return { markCount: element.querySelectorAll('.library-selection-mark').length, ariaHidden: mark?.getAttribute('aria-hidden'), inert: mark && [mark, ...mark.querySelectorAll('*')].every(part => getComputedStyle(part).pointerEvents === 'none'), scaleX: inner.width / box.width, scaleY: inner.height / box.height, opacity: getComputedStyle(preview).opacity, filter: getComputedStyle(preview).filter, imageOpacity: image && getComputedStyle(image).opacity, oldMarker: getComputedStyle(element, '::after').content };
  });
  assert.equal(state.markCount, 1, `${context}: one shared selection overlay`);
  assert.equal(state.ariaHidden, 'true'); assert.ok(state.inert);
  assert.ok(Math.abs(state.scaleX - .88) < .01 && Math.abs(state.scaleY - .88) < .01, `${context}: media shrinks uniformly within its original slot: ${JSON.stringify(state)}`);
  assert.equal(state.opacity, '1'); assert.equal(state.filter, 'none');
  if (state.imageOpacity) assert.equal(state.imageOpacity, '1');
  assert.ok(['none', 'normal'].includes(state.oldMarker), `${context}: old hover/selected dots do not cover the new mark`);
  const shape = await card.evaluate(element => {
    const image = element.querySelector('.folder-media-preview img');
    const box = image.getBoundingClientRect();
    const ratio = getComputedStyle(image).objectFit === 'contain' ? Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight) : null;
    const width = ratio == null ? box.width : image.naturalWidth * ratio, height = ratio == null ? box.height : image.naturalHeight * ratio;
    const preview = { width, height, x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, left: box.x + (box.width - width) / 2, right: box.x + (box.width + width) / 2 };
    const mark = element.querySelector('.library-selection-mark');
    const center = mark.querySelector('.library-selection-center').getBoundingClientRect();
    const aim = mark.querySelector('.library-selection-aim');
    const scale = aim.getBoundingClientRect().width / parseFloat(getComputedStyle(aim).width);
    const rays = ['top-right', 'bottom-right', 'bottom-left', 'top-left'].map(corner => {
      const ray = mark.querySelector(`.library-selection-ray.is-${corner}`), line = getComputedStyle(ray, '::after');
      return { angle: parseFloat(getComputedStyle(ray).rotate), color: line.backgroundColor, start: parseFloat(line.left) * scale };
    });
    const leftPath = mark.querySelector('.library-selection-bracket.is-left path'), rightPath = mark.querySelector('.library-selection-bracket.is-right path');
    const left = leftPath.getBoundingClientRect(), right = rightPath.getBoundingClientRect(), stroke = parseFloat(getComputedStyle(leftPath).strokeWidth) / 2;
    return { width: preview.width, height: preview.height, previewX: preview.x + preview.width / 2, previewY: preview.y + preview.height / 2, centerX: center.x + center.width / 2, centerY: center.y + center.height / 2, centerRadius: Math.hypot(center.width, center.height) / 2, scale, rays, bracketOutside: left.right + stroke < preview.left && right.left - stroke > preview.right };
  });
  assert.ok(shape.bracketOutside, `${context}: complete brackets remain outside the inset preview`);
  assert.ok(Math.abs(shape.previewX - shape.centerX) < .1 && Math.abs(shape.previewY - shape.centerY) < .1, `${context}: center marker stays at the media center`);
  const angle = Math.atan2(shape.height, shape.width) * 180 / Math.PI;
  for (const [index, ray] of shape.rays.entries()) {
    assert.ok(Math.abs(ray.angle - [-angle, angle, 180 - angle, 180 + angle][index]) < .1, `${context}: white ray ${index} points toward the actual painted media corner (${ray.angle} versus ${angle})`);
    assert.equal(ray.color, 'rgb(247, 248, 246)');
    assert.ok(ray.start - shape.centerRadius > 2.5 * shape.scale, `${context}: ray ${index} remains detached from the center square`);
  }
}

async function verifySelectionAnimation(card, context) {
  const result = await card.evaluate(element => {
    const mark = element.querySelector('.library-selection-mark');
    const animations = mark.getAnimations({ subtree: true });
    const timings = animations.map(animation => ({ name: animation.animationName, end: animation.effect.getComputedTiming().endTime }));
    const frames = [0, 150, 190, 230, 270, 300].map(time => {
      animations.forEach(animation => { animation.pause(); animation.currentTime = time; });
      const preview = element.querySelector('.folder-media-preview');
      return { time, signal: Number(getComputedStyle(mark.querySelector('.library-selection-signal')).opacity), image: getComputedStyle(preview).opacity, center: Number(getComputedStyle(mark.querySelector('.library-selection-center')).opacity) };
    });
    animations.forEach(animation => animation.finish());
    return { timings, frames };
  });
  assert.equal(result.timings.length, 12, `${context}: one selection starts all shared mark parts`);
  assert.ok(result.timings.every(timing => Math.abs(timing.end - 300) < .01), `${context}: the complete selection animation fits in 300ms`);
  assert.ok(result.frames.every(frame => frame.image === '1'), `${context}: only the mark flickers`);
  assert.equal(result.frames[0].center, 0); assert.equal(result.frames.at(-1).center, 1);
  assert.ok(result.frames[1].signal < result.frames[2].signal && result.frames[3].signal < result.frames[4].signal && result.frames[5].signal === 1, `${context}: two decoration-only flashes settle fully visible`);
}

try {
  for (const scene of ['home', 'project']) {
    await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' });
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`http://127.0.0.1:17927/scripts/fixtures/${scene === 'home' ? 'library-tactical/preview.html' : 'canvas-reference/preview.html?source-library'}`);
    if (scene === 'project') {
      await page.waitForFunction(() => document.querySelector('.canvas-workspace')?.getAttribute('aria-busy') === 'false');
      await page.locator('.canvas-stage').focus(); await page.keyboard.press('Tab');
    }
    await library().waitFor();
    await installMedia();
    const before = await slots(library());
    const initialAnimations = await page.evaluate(() => window.selectionEntries.length);
    for (const input of ['right-click', 'keyboard']) {
      if (input === 'right-click') await media(0).click({ button: 'right' });
      else await media(0).press('Shift+F10');
      await verifyMenuTargets('selection-0', ['selection-0'], `${scene} ${input}`);
      await page.mouse.move(0, 0); await page.waitForTimeout(350);
      await verifyUnselected(media(0), `${scene} ${input}`);
      assert.equal(await library().locator('.folder-media-card[aria-pressed="true"]').count(), 0);
      assert.equal(await library().locator('.catalog-selection').count(), 0, 'menu invocation does not enter selection mode');
      await closeMenu(scene);
      await verifyUnselected(media(0), `${scene} dismissed ${input}`);
    }
    assert.equal(await page.evaluate(() => window.selectionEntries.length), initialAnimations, 'mouse and keyboard menus never start selection animations');
    await media(0).click({ modifiers: ['Control'] });
    await verifySelectionAnimation(media(0), scene);
    await media(2).click({ modifiers: ['Shift'] });
    await page.mouse.move(0, 0); await page.waitForTimeout(360);
    assert.equal(await library().locator('.folder-media-card[aria-pressed="true"]').count(), 3, `${scene}: Ctrl/Shift selects a real range`);
    assert.deepEqual(await slots(library()), before, `${scene}: selection does not resize or redistribute masonry slots`);
    for (const id of [0, 1, 2]) await verifySelected(media(id), `${scene} mixed-ratio card ${id}`);
    const selectedIds = ['selection-0', 'selection-1', 'selection-2'];
    const selectionAnimations = await page.evaluate(() => window.selectionEntries.length);
    for (const id of [1, 3]) {
      await media(id).click({ button: 'right' });
      await verifyMenuTargets(`selection-${id}`, id === 1 ? selectedIds : ['selection-3'], `${scene} ${id === 1 ? 'inside' : 'outside'} selection`);
      assert.deepEqual(await library().locator('.folder-media-card[aria-pressed="true"]').evaluateAll(elements => elements.map(element => element.dataset.assetId)), selectedIds, 'right-click preserves the existing selected group');
      if (id === 3) await verifyUnselected(media(3), `${scene} unselected menu target`);
      await closeMenu(scene);
      assert.deepEqual(await library().locator('.folder-media-card[aria-pressed="true"]').evaluateAll(elements => elements.map(element => element.dataset.assetId)), selectedIds, 'dismissing the menu preserves the existing selected group');
    }
    assert.equal(await page.evaluate(() => window.selectionEntries.length), selectionAnimations, 'right-click does not replay or replace the selected group animation');
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await media(0).hover();
    await media(0).dispatchEvent('dragstart', { dataTransfer: transfer });
    await page.waitForTimeout(220);
    assert.ok(await media(0).evaluate(element => element.closest('.library-motion-root').dataset.libraryDragging === 'true' && getComputedStyle(element).translate === 'none' && element.querySelector('.library-selection-mark').getAnimations({ subtree: true }).every(animation => animation.playState !== 'running')), `${scene}: drag uses a stable selection mark without hover displacement`);
    await media(0).dispatchEvent('dragend', { dataTransfer: transfer }); await transfer.dispose();
    await page.mouse.move(0, 0); await page.waitForTimeout(350);
    if (scene === 'project') {
      // Dragging from the canvas library intentionally exposes the canvas.
      await page.locator('.canvas-stage').focus(); await page.keyboard.press('Tab');
      await waitForMedia();
    }
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    assert.ok(await media(0).evaluate(element => element.closest('.library-motion-root').dataset.libraryMotionPaused === 'true' && element.querySelector('.library-selection-mark').getAnimations({ subtree: true }).every(animation => animation.playState !== 'running')), `${scene}: hidden libraries do not animate selection`);
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(350);
    for (const theme of ['dark', 'light']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await page.screenshot({ path: `${output}/${scene}-${theme}.png` });
    }
    if (scene === 'home') {
      const entriesBefore = await page.evaluate(() => window.selectionEntries.filter(entry => entry.id === 'selection-0').length);
      await page.evaluate(() => document.activeElement?.blur());
      await library().locator('.catalog-scroller').evaluate(element => { element.scrollTop = element.scrollHeight; });
      await media(0).waitFor({ state: 'detached' });
      await library().locator('.catalog-scroller').evaluate(element => { element.scrollTop = 0; });
      await waitForMedia();
      await verifySelected(media(0), 'virtualized selected card restored');
      assert.equal(await page.evaluate(() => window.selectionEntries.filter(entry => entry.id === 'selection-0').length), entriesBefore, 'scrolling a previously selected card back into view does not replay selection');
    }
    await clearSelection();
    assert.deepEqual(await slots(library()), before, `${scene}: clearing selection preserves masonry slots`);
    assert.ok(await media(0).evaluate(element => {
      const card = element.getBoundingClientRect(), preview = element.querySelector('.folder-media-preview').getBoundingClientRect();
      return Math.abs(card.width - preview.width) < .1 && Math.abs(card.height - preview.height) < .1;
    }), 'deselecting restores the full-size media');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await media(0).click({ modifiers: ['Control'] }); await page.mouse.move(0, 0);
    await verifySelected(media(0), `${scene} reduced motion`);
    assert.equal(await media(0).locator('.library-selection-mark').evaluate(element => element.getAnimations({ subtree: true }).length), 0, 'reduced motion starts directly at the selected terminal state');
    await clearSelection();
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    if (scene === 'home') {
      for (const interruption of ['hidden', 'drag']) {
        const previousStarts = await page.evaluate(() => window.selectionEntries.filter(entry => entry.id === 'selection-0' && entry.name === 'library-select-center').length);
        await media(0).click({ modifiers: ['Control'] });
        await page.waitForFunction(previous => window.selectionEntries.filter(entry => entry.id === 'selection-0' && entry.name === 'library-select-center').length > previous, previousStarts);
        assert.equal(await media(0).locator('.library-selection-mark.is-entering').count(), 1, 'test interrupts an active selection entrance');
        const starts = await page.evaluate(() => window.selectionEntries.filter(entry => entry.id === 'selection-0' && entry.name === 'library-select-center').length);
        if (interruption === 'hidden') {
          await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
          await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
        } else {
          const transfer = await page.evaluateHandle(() => new DataTransfer());
          await media(0).dispatchEvent('dragstart', { dataTransfer: transfer });
          await media(0).dispatchEvent('dragend', { dataTransfer: transfer });
          await transfer.dispose();
        }
        await page.mouse.move(0, 0); await page.waitForTimeout(350);
        assert.equal(await page.evaluate(() => window.selectionEntries.filter(entry => entry.id === 'selection-0' && entry.name === 'library-select-center').length), starts, `${interruption} recovery does not replay an interrupted entrance`);
        assert.equal(await media(0).locator('.library-selection-mark.is-entering').count(), 0);
        await verifySelected(media(0), `${interruption} recovery terminal state`);
        await clearSelection();
      }
      const sizeSlider = library().getByRole('slider', { name: '主页素材大小', exact: true });
      const originalZoom = await sizeSlider.inputValue();
      await sizeSlider.press('Home');
      // The desktop shell has a 760px minimum; 840px gives eight exact 96px columns.
      await page.setViewportSize({ width: 840, height: 900 });
      await page.waitForTimeout(400);
      const minimumWidth = await media(0).evaluate(element => element.getBoundingClientRect().width);
      assert.ok(Math.abs(minimumWidth - 96) < .1, `fixture exercises an actual 96px card, received ${minimumWidth}px`);
      await media(0).click({ modifiers: ['Control'] }); await page.mouse.move(0, 0); await page.waitForTimeout(350);
      await verifySelected(media(0), 'minimum 96px media card including bracket strokes');
      await page.screenshot({ path: `${output}/minimum-96.png` });
      await clearSelection();
      await page.setViewportSize({ width: 1400, height: 900 });
      await library().getByRole('spinbutton', { name: '主页素材大小数值', exact: true }).fill(originalZoom);
      await library().getByRole('spinbutton', { name: '主页素材大小数值', exact: true }).press('Enter');
      await page.waitForTimeout(400);
    }

    if (scene === 'home') {
      for (const [name, kind] of [['标签分类', 'tags'], ['集合分类', 'collections']]) {
        await page.getByRole('tab', { name, exact: true }).click();
        if (kind === 'collections') await library().getByRole('treeitem', { name: '示例集合', exact: true }).click();
        await waitForMedia();
        await media(0).click({ modifiers: ['Control'] }); await page.mouse.move(0, 0); await page.waitForTimeout(350);
        await verifySelected(media(0), `${scene} ${kind} uses the same selected card`);
        await clearSelection();
      }
    } else {
      await page.getByRole('tab', { name: '项目素材', exact: true }).click();
      await waitForMedia();
      await media(0).click({ modifiers: ['Control'] }); await page.mouse.move(0, 0); await page.waitForTimeout(350);
      await verifySelected(media(0), 'project source uses the same selected card');
      await clearSelection();
    }

    await page.evaluate(() => window.selectionMode.getState().openBrowser());
    const files = page.locator('.local-file-workspace');
    const directory = files.getByRole('button', { name: '文件夹 文件夹', exact: true });
    const fileImage = files.getByRole('button', { name: '素材0.png', exact: true });
    await fileImage.waitFor(); await page.waitForTimeout(700);
    const fileSlots = await slots(files);
    const fileAnimations = await page.evaluate(() => window.selectionEntries.length);
    for (const input of ['right-click', 'keyboard']) {
      if (input === 'right-click') await fileImage.click({ button: 'right' });
      else await fileImage.press('Shift+F10');
      await verifyMenuTargets('selection-0', ['selection-0'], `${scene} file ${input}`);
      await page.mouse.move(0, 0); await page.waitForTimeout(350);
      await verifyUnselected(fileImage, `${scene} file ${input}`);
      assert.equal(await files.locator('.folder-media-card[aria-pressed="true"]').count(), 0);
      assert.equal(await files.locator('.folder-selection-bar').count(), 0);
      await closeMenu(scene);
      await verifyUnselected(fileImage, `${scene} file dismissed ${input}`);
    }
    assert.equal(await page.evaluate(() => window.selectionEntries.length), fileAnimations, 'file menus never start selection animations');
    await directory.click({ modifiers: ['Control'] });
    assert.equal(await directory.getAttribute('aria-pressed'), 'true');
    assert.equal(await directory.locator('.library-selection-mark').count(), 0, 'directory tiles retain their existing selection outline');
    assert.ok(await directory.evaluate(element => { const style = getComputedStyle(element.querySelector('.folder-media-preview')); return style.transform === 'none' && ['none', '1'].includes(style.scale); }), 'directory preview is never inset');
    await fileImage.click({ modifiers: ['Control'] });
    const fileVideo = files.getByRole('button', { name: '片段.mp4', exact: true });
    await fileVideo.click({ modifiers: ['Control'] }); await page.mouse.move(0, 0); await page.waitForTimeout(350);
    await verifySelected(fileImage, `${scene} file image`); await verifySelected(fileVideo, `${scene} file video`);
    assert.deepEqual(await slots(files), fileSlots, 'local file selection leaves layout intact');
    await page.screenshot({ path: `${output}/${scene}-files.png` });
    await files.getByRole('button', { name: '取消文件选择', exact: true }).click();
    assert.equal(await files.locator('.library-selection-mark').count(), 0);
  }
  assert.deepEqual(errors, []);
  console.log('PASS shared production library selection: home/project flat/tag/collection and file image/video, independent mouse/keyboard menu targets, preserved multi-selection, untouched directories, stable slots, corner-aligned white rays, 300ms flashes, virtual remount, drag/hidden and reduced motion.');
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` });
  throw error;
} finally {
  await browser.close(); await server.close();
}
