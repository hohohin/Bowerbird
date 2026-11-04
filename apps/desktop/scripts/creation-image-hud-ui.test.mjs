import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/creation-image-hud';
await mkdir(output, { recursive: true });
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 17948, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const modal = page.locator('.creation-image-preview');
const mainImage = modal.locator('.creation-image-preview-image img:not(.creation-image-preview-thumbnail)');
const inspector = modal.getByRole('region', { name: '图片详情', exact: true });
const scale = () => modal.getByLabel('图片缩放比例').innerText();
const wait = () => page.waitForTimeout(300);
const hudGroups = modal.locator('.creation-image-preview-image-head > *, .creation-image-preview-image-foot > *');
const hudBoxes = () => hudGroups.evaluateAll(elements => elements.map(el => {
  const { x, y, width, height } = el.getBoundingClientRect();
  return { x, y, width, height };
}));
async function assertHudAccessible() {
  const host = await modal.boundingBox();
  const panels = await modal.locator('.creation-image-preview-conversation.is-ready:not(.is-leaving)').all();
  const panelBoxes = await Promise.all(panels.map(panel => panel.boundingBox()));
  for (const box of await hudBoxes()) {
    assert.ok(box.x >= host.x + 15 && box.y >= host.y + 15
      && box.x + box.width <= host.x + host.width - 15 && box.y + box.height <= host.y + host.height - 15, 'all four HUD groups stay inside the safe viewport');
    for (const panel of panelBoxes) assert.ok(box.x + box.width <= panel.x || box.x >= panel.x + panel.width
      || box.y + box.height <= panel.y || box.y >= panel.y + panel.height, 'HUD groups avoid the side panels');
  }
}
try {
  await page.goto('http://127.0.0.1:17948/scripts/fixtures/creation-image-review/preview.html?deferred');
  await page.waitForFunction(() => document.querySelector('.creation-image-preview-image img')?.naturalWidth > 0 && window.__reviewPending?.length === 5);
  await wait();
  const pendingInspector = modal.locator('.creation-image-preview-inspector');
  const conversation = modal.locator('section[aria-label="独立会话面板"]');
  assert.equal(await pendingInspector.isVisible(), false, 'inspector does not flash empty content while data is pending');
  assert.equal(await conversation.isVisible(), false, 'conversation waits for its data');
  const beforeData = await mainImage.boundingBox();
  await mainImage.hover(); await page.mouse.wheel(0, -100); await wait();
  assert.ok(parseInt(await scale()) > 100, 'image remains interactive while both panels are loading');
  await modal.getByRole('button', { name: '适应画面', exact: true }).click();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('[aria-hidden="true"]')), false, 'loading panels cannot receive keyboard focus');
  await page.screenshot({ path: `${output}/projection-image-first.png` });
  await page.evaluate(() => {
    window.__reviewHold.delete('generation_history');
    window.__reviewPending.filter(item => item.command === 'generation_history').forEach(item => item.resolve());
  });
  await conversation.waitFor({ state: 'visible' });
  assert.equal(await pendingInspector.isVisible(), false, 'a slow inspector does not delay the ready conversation');
  assert.deepEqual(await mainImage.boundingBox(), beforeData, 'revealing a conversation does not move the image');
  await page.evaluate(() => {
    window.__reviewHold.clear();
    window.__reviewPending.forEach(item => item.resolve());
  });
  await inspector.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('.creation-image-preview-inspector')?.getAnimations().some(animation => animation.animationName === 'creation-image-preview-panel-in'));
  await page.waitForTimeout(420);
  assert.deepEqual(await mainImage.boundingBox(), beforeData, 'revealing the inspector preserves the image placement');
  await page.mouse.move(720, 505); await wait();
  const neutralLeft = await inspector.boundingBox(), neutralRight = await conversation.boundingBox();
  await page.mouse.move(80, 505); await wait();
  const leftwardLeft = await inspector.boundingBox(), leftwardRight = await conversation.boundingBox();
  assert.ok(leftwardLeft.height < neutralLeft.height - 4 && leftwardRight.height > neutralRight.height + 4,
    'looking left sinks the whole left panel and raises the whole right panel around the shared center');
  await page.screenshot({ path: `${output}/shared-plane-left.png` });
  await page.mouse.move(1360, 505); await wait();
  assert.ok((await inspector.boundingBox()).height > neutralLeft.height + 4 && (await conversation.boundingBox()).height < neutralRight.height - 4,
    'looking right reverses the depth of both panels');
  await page.screenshot({ path: `${output}/shared-plane-right.png` });
  await page.mouse.move(1400, 920); await wait();
  const firstDepth = await modal.locator('.creation-image-preview-image-depth').evaluate(el => getComputedStyle(el).transform);
  const firstPlane = await inspector.evaluate(el => getComputedStyle(el).transform);
  const firstTitle = await inspector.getByRole('heading', { name: '图片详情', exact: true }).boundingBox();
  const firstFrame = await modal.locator('.creation-image-preview-projection').evaluate(el => getComputedStyle(el).transform);
  await page.mouse.move(700, 900); await wait();
  assert.notEqual(await modal.locator('.creation-image-preview-image-depth').evaluate(el => getComputedStyle(el).transform), firstDepth, 'image backing planes follow shared project-card perspective');
  assert.notEqual(await inspector.evaluate(el => getComputedStyle(el).transform), firstPlane, 'the entire inspector follows the shared perspective');
  assert.notDeepEqual(await inspector.getByRole('heading', { name: '图片详情', exact: true }).boundingBox(), firstTitle, 'panel text moves with its surface');
  assert.equal(await inspector.locator('.creation-image-preview-conversation-plane').evaluate(el => getComputedStyle(el).transform), 'none', 'the backing no longer moves separately from its text');
  assert.equal(await modal.evaluate(el => getComputedStyle(el.querySelector('.creation-image-preview-backdrop'), '::before').content), 'none', 'the previous moving light field is removed');
  assert.notEqual(await modal.locator('.creation-image-preview-projection').evaluate(el => getComputedStyle(el).transform), firstFrame, 'the shared projection frame responds with depth');
  assert.deepEqual(await mainImage.boundingBox(), beforeData, 'projection feedback does not move the image');
  const title = inspector.getByRole('heading', { name: '图片详情', exact: true });
  await title.hover(); await page.mouse.down();
  const heldTitle = await title.boundingBox();
  const heldRight = await conversation.boundingBox();
  await page.mouse.move(700, 100); await wait();
  assert.deepEqual(await title.boundingBox(), heldTitle, 'selecting text freezes the complete panel at its current orientation');
  assert.deepEqual(await conversation.boundingBox(), heldRight, 'selecting either panel freezes the other side of the shared plane too');
  await page.mouse.up(); await wait();
  assert.notDeepEqual(await title.boundingBox(), heldTitle, 'panel following resumes after the selection gesture');
  await inspector.getByRole('button', { name: '修改指令', exact: true }).click();
  const category = inspector.locator('textarea').first();
  await category.fill('临时校验');
  const editingPanel = await inspector.evaluate(el => getComputedStyle(el).transform);
  const editingRight = await conversation.boundingBox();
  await page.mouse.move(1300, 100); await wait();
  assert.equal(await inspector.evaluate(el => getComputedStyle(el).transform), editingPanel, 'typing holds the panel still while the pointer moves elsewhere');
  assert.deepEqual(await conversation.boundingBox(), editingRight, 'typing freezes the shared plane rather than separating the panels');
  const beforeCollapse = await mainImage.boundingBox();
  await inspector.getByRole('button', { name: '收起图片详情面板', exact: true }).click();
  await pendingInspector.waitFor({ state: 'hidden' });
  assert.deepEqual(await mainImage.boundingBox(), beforeCollapse, 'collapsing the inspector preserves image position and scale');
  assert.equal(await conversation.isVisible(), true, 'the conversation stays open independently');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '显示图片详情', 'focus returns to the available reopen control');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('[aria-hidden="true"]')), false, 'collapsed inspector content is excluded from keyboard navigation');
  await page.screenshot({ path: `${output}/inspector-collapsed.png` });
  await modal.getByRole('button', { name: '显示图片详情', exact: true }).click();
  await inspector.waitFor({ state: 'visible' });
  assert.equal(await category.inputValue(), '临时校验', 'collapse/reopen preserves unfinished inspector edits');
  assert.deepEqual(await mainImage.boundingBox(), beforeCollapse, 'reopening does not reframe the image');
  await inspector.getByRole('button', { name: '修改指令', exact: true }).click();
  await page.mouse.move(700, 900); await wait();
  assert.equal(await modal.getAttribute('data-panels-locked'), null, 'removing an inline editor releases the shared motion lock');
  // Both toggles remain available while the reading panels are hidden.
  await modal.getByRole('button', { name: '收起图片详情', exact: true }).click();
  await modal.getByRole('button', { name: '收起会话', exact: true }).click();
  await pendingInspector.waitFor({ state: 'hidden' }); await conversation.waitFor({ state: 'hidden' });
  assert.deepEqual(await mainImage.boundingBox(), beforeCollapse, 'hiding both panels preserves the free image stage');
  await modal.getByRole('button', { name: '显示会话', exact: true }).click();
  await conversation.waitFor({ state: 'visible' });
  await modal.getByRole('button', { name: '显示图片详情', exact: true }).click();
  await inspector.waitFor({ state: 'visible' }); await wait();
  await assertHudAccessible();
  await inspector.locator('.asset-detail-panel').evaluate(el => el.scrollTop = 0);
  await page.screenshot({ path: `${output}/projection-ready-dark.png` });
  await page.evaluate(() => document.documentElement.dataset.theme = 'light'); await wait();
  await page.screenshot({ path: `${output}/projection-ready-light.png` });
  // A pending request completing after close must not recreate a preview.
  await page.evaluate(() => {
    window.__reviewHold = new Set(['generation_history', 'list_analyses_by_asset', 'list_asset_tags', 'list_asset_collections']);
    window.__reviewPending = [];
  });
  await page.getByRole('button', { name: '重播', exact: true }).click();
  await page.waitForFunction(() => window.__reviewPending.length === 5);
  await modal.getByRole('button', { name: '关闭预览', exact: true }).click();
  await modal.waitFor({ state: 'detached' });
  await page.evaluate(() => { window.__reviewHold.clear(); window.__reviewPending.forEach(item => item.resolve()); });
  await wait();
  assert.equal(await modal.count(), 0, 'late panel data does not reopen a closed image');
  await page.evaluate(() => {
    window.__reviewHold = new Set(['generation_history', 'list_analyses_by_asset', 'list_asset_tags', 'list_asset_collections']);
    window.__reviewPending = [];
  });
  await page.getByRole('button', { name: '重播', exact: true }).click();
  await page.waitForFunction(() => window.__reviewPending.length === 5);
  await page.evaluate(() => {
    window.__reviewHold.clear();
    window.__reviewPending.forEach(item => item.command === 'generation_history' ? item.reject(new Error('fixture unavailable')) : item.resolve());
  });
  await inspector.waitFor({ state: 'visible' });
  await conversation.getByRole('alert').waitFor();
  await conversation.getByRole('button', { name: '重试', exact: true }).click();
  await conversation.getByRole('button', { name: '点击放大', exact: true }).first().waitFor();

  const heldImages = [];
  const holdOriginal = route => new Promise(resolve => heldImages.push(async action => { await route[action](); resolve(); }));
  await page.route(/preset-14\.png$/, holdOriginal);
  await page.goto('http://127.0.0.1:17948/scripts/fixtures/creation-image-review/preview.html', { waitUntil: 'domcontentloaded' });
  await modal.locator('.asset-detail-panel').waitFor({ state: 'attached' });
  await wait();
  assert.equal(await pendingInspector.isVisible(), false, 'fast metadata cannot overtake a slow first image');
  assert.equal(await conversation.isVisible(), false);
  await Promise.all(heldImages.splice(0).map(release => release('abort')));
  await page.unroute(/preset-14\.png$/, holdOriginal);
  await inspector.waitFor({ state: 'visible' });
  assert.equal(await modal.getByText('图片暂时无法读取', { exact: true }).isVisible(), true, 'failed originals still allow details to appear');

  await page.route(/preset-14\.png$/, holdOriginal);
  await page.goto('http://127.0.0.1:17948/scripts/fixtures/creation-image-review/preview.html?thumbnail', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.creation-image-preview-thumbnail')?.naturalWidth > 0);
  await inspector.waitFor({ state: 'visible' });
  assert.equal(await mainImage.evaluate(img => img.complete), false, 'cached thumbnail paints before a slow original');
  await modal.getByRole('button', { name: '放大图片', exact: true }).click();
  const thumbnailScale = await scale();
  await Promise.all(heldImages.splice(0).map(release => release('continue')));
  await page.unroute(/preset-14\.png$/, holdOriginal);
  await page.waitForFunction(() => document.querySelector('.creation-image-preview-image img:not(.creation-image-preview-thumbnail)')?.naturalWidth > 0);
  assert.equal(await scale(), thumbnailScale, 'replacing the thumbnail with the original preserves zoom');

  await page.goto('http://127.0.0.1:17948/scripts/fixtures/creation-image-review/preview.html');
  await mainImage.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.creation-image-preview img')].every(img => img.complete && img.naturalWidth > 0));
  await wait();
  await modal.getByRole('button', { name: '点击放大', exact: true }).first().click();
  const nested = page.locator('.media-lightbox');
  const nestedImage = nested.locator('img');
  await nestedImage.waitFor();
  await page.waitForFunction(() => document.querySelector('.media-lightbox img')?.naturalWidth > 0);
  const nestedBase = await nestedImage.boundingBox();
  await nestedImage.hover(); await page.mouse.wheel(0, 100); await wait();
  assert.deepEqual(await nestedImage.boundingBox(), nestedBase, 'existing lightbox retains its default minimum zoom');
  await page.mouse.wheel(0, -100); await wait();
  assert.ok((await nestedImage.boundingBox()).width > nestedBase.width, 'existing lightbox still zooms with the shared hook');
  assert.equal(await scale(), '100%', 'nested image does not change the free-stage image');
  await nested.getByRole('button', { name: '关闭（Esc）', exact: true }).click();
  await nested.waitFor({ state: 'detached' });
  const initial = await mainImage.boundingBox();
  const initialHud = await hudBoxes();
  await modal.getByRole('button', { name: '缩小图片', exact: true }).click();
  const smallHud = await hudBoxes();
  smallHud.forEach((box, index) => {
    assert.ok(Math.abs(box.x - initialHud[index].x) > 10 && Math.abs(box.y - initialHud[index].y) > 10, 'all four labels track the changed image corners');
    assert.deepEqual([box.width, box.height], [initialHud[index].width, initialHud[index].height], 'label dimensions stay constant while the image scales');
  });
  const smallImage = await mainImage.boundingBox();
  await mainImage.hover(); await page.mouse.down();
  await page.mouse.move(smallImage.x + smallImage.width / 2 + 20, smallImage.y + smallImage.height / 2 + 18); await page.mouse.up();
  const shiftedHud = await hudBoxes(), shiftedImage = await mainImage.boundingBox();
  shiftedHud.forEach((box, index) => {
    assert.ok(Math.abs(box.x - smallHud[index].x - (shiftedImage.x - (initial.x + initial.width * .1))) < 1, 'labels follow image translation horizontally');
    assert.ok(Math.abs(box.y - smallHud[index].y - (shiftedImage.y - (initial.y + initial.height * .1))) < 1, 'labels follow image translation vertically');
  });
  await assertHudAccessible();
  await modal.getByRole('button', { name: '适应画面', exact: true }).click();
  assert.deepEqual(await hudBoxes(), initialHud, 'fit restores all four labels to their image corners');
  const anchor = { x: initial.x + initial.width * .65, y: initial.y + initial.height * .45 };
  await page.mouse.move(anchor.x, anchor.y);
  await page.mouse.wheel(0, -100); await wait();
  const enlarged = await mainImage.boundingBox();
  assert.ok(enlarged.width > initial.width);
  assert.ok(Math.abs((anchor.x - enlarged.x) / enlarged.width - .65) < .002, 'wheel zoom preserves the image point under the cursor horizontally');
  assert.ok(Math.abs((anchor.y - enlarged.y) / enlarged.height - .45) < .002, 'wheel zoom preserves the image point under the cursor vertically');
  await modal.getByRole('button', { name: '放大图片', exact: true }).click();
  await wait();
  const hit = await mainImage.evaluate((image, initial) => document.elementFromPoint(initial.x + initial.width + 20, initial.y + initial.height / 2) === image, initial);
  assert.equal(hit, true, 'enlarged image remains visible and interactive outside its original bounds');
  const beforeDrag = await mainImage.boundingBox();
  await page.mouse.move(initial.x + initial.width / 2, initial.y + initial.height / 2);
  await page.mouse.down(); await page.mouse.move(initial.x + initial.width / 2 + 90, initial.y + initial.height / 2 + 45, { steps: 6 }); await page.mouse.up();
  const afterDrag = await mainImage.boundingBox();
  assert.ok(Math.abs(afterDrag.x - beforeDrag.x - 90) < 1 && Math.abs(afterDrag.y - beforeDrag.y - 45) < 1, 'drag freely moves the image');
  await page.mouse.move(1420, 940); await page.mouse.down(); await page.mouse.move(1290, 910, { steps: 6 }); await page.mouse.up();
  const afterStageDrag = await mainImage.boundingBox();
  assert.deepEqual(afterStageDrag, afterDrag, 'pressing and moving on empty stage never pans the image');
  assert.equal(await modal.count(), 1, 'a blank-area drag is not treated as a click to close');
  await page.mouse.move(1420, 940); await page.mouse.down(); await page.mouse.move(1300, 900); await page.mouse.move(1420, 940); await page.mouse.up();
  assert.equal(await modal.count(), 1, 'returning a blank-area drag to its starting point does not dismiss');
  const beforePanelWheel = await scale();
  const scrollPanel = inspector.locator('.asset-detail-panel');
  await scrollPanel.hover(); await page.mouse.wheel(0, 280); await wait();
  assert.equal(await scale(), beforePanelWheel, 'scrolling details does not zoom the image');
  assert.ok(await scrollPanel.evaluate(el => el.scrollTop) > 0, 'details retain independent scrolling');
  await scrollPanel.evaluate(el => el.scrollTop = 0);
  const panelBounds = await inspector.boundingBox();
  await page.mouse.move(panelBounds.x + 30, panelBounds.y + 40); await wait();
  const firstPoint = await inspector.evaluate(el => getComputedStyle(el).transform);
  await page.mouse.move(panelBounds.x + 180, panelBounds.y + 160); await wait();
  assert.notEqual(await inspector.evaluate(el => getComputedStyle(el).transform), firstPoint, 'whole-panel perspective responds without a panel spotlight');
  assert.equal(await inspector.evaluate(el => getComputedStyle(el, '::after').content), 'none');
  await page.screenshot({ path: `${output}/dark-free-stage.png` });
  for (let step = 0; step < 3; step++) await modal.getByRole('button', { name: '放大图片', exact: true }).click();
  await wait(); await assertHudAccessible();
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme); await wait();
    await page.screenshot({ path: `${output}/glass-overlap-${theme}.png` });
  }
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await modal.getByRole('button', { name: '适应画面', exact: true }).click();
  assert.deepEqual(await mainImage.boundingBox(), initial, 'fit recovers the original placement');
  await mainImage.hover(); await page.mouse.down(); await page.mouse.move(-700, 480, { steps: 10 }); await page.mouse.up();
  assert.ok((await mainImage.boundingBox()).x + initial.width < 0, 'image can be freely moved beyond the viewport');
  assert.equal(await modal.count(), 1, 'releasing an image drag outside its view does not close it');
  await assertHudAccessible();
  await modal.getByRole('button', { name: '适应画面', exact: true }).click();
  assert.deepEqual(await mainImage.boundingBox(), initial, 'fixed reset remains available after the image leaves view');
  await page.mouse.move(1420, 940); await page.mouse.wheel(0, 100); await wait();
  assert.equal(await scale(), '100%', 'empty stage does not manipulate the image');
  await mainImage.hover(); await page.mouse.wheel(0, 100); await wait();
  assert.ok(parseInt(await scale()) < 100, 'wheel on the image still zooms below the initial size');
  await modal.getByRole('button', { name: '适应画面', exact: true }).click();
  await mainImage.click();
  await inspector.getByRole('heading', { name: '图片详情', exact: true }).click();
  assert.equal(await modal.count(), 1, 'clicking the image or panel does not close the preview');
  await page.mouse.click(1420, 940);
  await modal.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '重播', exact: true }).click();
  await inspector.waitFor({ state: 'visible' }); await wait();
  for (const width of [1440, 800]) {
    await page.setViewportSize({ width, height: 960 });
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme); await wait();
      await assertHudAccessible();
      for (const button of await modal.locator('.creation-image-preview-hud button').all()) {
        const box = await button.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width && box.y + box.height <= 960, 'docked HUD controls remain accessible');
      }
      await page.screenshot({ path: `${output}/${theme}-${width}.png` });
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole('button', { name: '查看普通图片', exact: true }).click(); await wait();
  assert.equal(await mainImage.isVisible(), true);
  assert.equal(await inspector.isVisible(), true);
  assert.equal(await modal.getByRole('region', { name: '独立会话面板' }).count(), 0);
  assert.equal(await modal.getByRole('button', { name: /收起会话|显示会话/ }).count(), 0);
  await page.screenshot({ path: `${output}/imported-light.png` });
  // Exercise the same image anchor at wide and tall aspect ratios without changing fixture data.
  for (const ratio of [2.4, .3]) {
    await modal.locator('.creation-image-preview-figure').evaluate((el, ratio) => el.style.setProperty('--image-ratio', ratio), String(ratio));
    await wait(); await assertHudAccessible();
    for (let step = 0; step < 6; step++) await modal.getByRole('button', { name: '放大图片', exact: true }).click();
    await wait(); await assertHudAccessible();
    await modal.getByRole('button', { name: '适应画面', exact: true }).click();
  }
  await modal.locator('.creation-image-preview-figure').evaluate(el => el.style.setProperty('--image-ratio', String(1086 / 1448)));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await modal.evaluate(el => el.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length), 0);
  await modal.getByRole('button', { name: '收起图片详情', exact: true }).click();
  await pendingInspector.waitFor({ state: 'hidden' });
  await modal.getByRole('button', { name: '显示图片详情', exact: true }).click();
  await inspector.waitFor({ state: 'visible' });
  assert.equal(await inspector.evaluate(el => getComputedStyle(el).transform), 'none', 'reduced motion also disables shared-plane perspective');
  await modal.getByRole('button', { name: '关闭预览', exact: true }).click();
  await modal.waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 375, height: 900 });
  await page.getByRole('button', { name: '重播', exact: true }).click();
  await mainImage.waitFor();
  await inspector.waitFor({ state: 'visible' }); await wait();
  await assertHudAccessible();
  await page.screenshot({ path: `${output}/docked-375.png` });
  await page.mouse.click(8, 75);
  await modal.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log('PASS shared-plane opposing depth, shared edit locks, independent inspector/conversation toggles, preserved image and draft, attached HUD, progressive loading, themes and reduced motion');
} finally { await browser.close(); await server.close(); }
