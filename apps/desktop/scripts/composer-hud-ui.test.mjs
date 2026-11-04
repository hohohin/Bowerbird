import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/composer-hud';
await mkdir(output, { recursive: true });
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 18967, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const url = `${server.resolvedUrls.local[0]}scripts/fixtures/library-creation-parity/preview.html?source-library&detail-route&canvas-library`;
const settle = () => page.waitForTimeout(400);
async function bottomGap(dock) {
  return dock.evaluate(element => innerHeight - element.getBoundingClientRect().bottom);
}
async function waitCollapsed(dock) {
  await page.waitForFunction(element => element.classList.contains('is-collapsed'), await dock.elementHandle());
}
async function singleRow(dock) {
  const layout = await dock.locator('.composer-toolbar').evaluate(toolbar => ({
    centers: [...toolbar.querySelectorAll('.composer-video-fields > *, .composer-add-material, .composer-help, .composer-send')]
      .map(element => element.getBoundingClientRect()).filter(rect => rect.width && rect.height).map(rect => rect.y + rect.height / 2),
    width: toolbar.clientWidth, scroll: toolbar.scrollWidth,
  }));
  assert.ok(layout.centers.every(center => Math.abs(center - layout.centers[0]) < 1), `single footer row: ${layout.centers}`);
  assert.ok(layout.scroll <= layout.width, 'footer controls do not overflow');
}
async function leftRail(dock, hasProject = false) {
  const layout = await dock.evaluate(element => {
    const rect = node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, bottom: box.bottom }; };
    return { modes: [...element.querySelectorAll('.composer-mode-picker > button')].map(rect), editor: rect(element.querySelector('.ProseMirror')),
      project: element.querySelector('.library-composer-target') ? rect(element.querySelector('.library-composer-target')) : null };
  });
  assert.ok(layout.modes.length >= 3, 'image, video and chat remain available');
  assert.ok(layout.modes.every((mode, index) => Math.abs(mode.x - layout.modes[0].x) < 1
    && mode.right <= layout.editor.x && (!index || mode.y >= layout.modes[index - 1].bottom)), `modes form a vertical rail left of the input: ${JSON.stringify(layout)}`);
  if (hasProject) assert.ok(layout.project && layout.project.bottom <= layout.modes[0].y, 'project selector sits above the modes');
  assert.equal(await dock.locator('.composer-mode-status').count(), 0, 'redundant creation status is removed');
}
async function opticalSurface(dock) {
  const material = await dock.evaluate(element => {
    const surface = element.querySelector('.composer-hud-surface');
    const close = element.querySelector('.composer-collapse');
    const textFilters = [];
    for (let node = element.querySelector('.ProseMirror'); node && node !== element.parentElement; node = node.parentElement) textFilters.push(getComputedStyle(node).filter);
    return { masks: [getComputedStyle(surface), getComputedStyle(surface, '::before'), getComputedStyle(surface, '::after')].map(style => style.maskImage),
      closeBackground: getComputedStyle(close).backgroundColor, textFilters };
  });
  assert.ok(material.masks.some(mask => /\b19px\b/.test(mask)), 'only the narrow outer 19px feathers into the canvas');
  assert.equal(material.closeBackground, 'rgba(0, 0, 0, 0)', 'HUD close control has a transparent face');
  assert.ok(material.textFilters.every(filter => filter === 'none'), 'optical blur does not affect the input text');
}
async function referenceProjection(dock, theme) {
  const editor = dock.locator('.ProseMirror');
  const ids = await page.evaluate(() => window.store.getState().assets.slice(0, 2).map(asset => asset.id).reverse());
  await editor.fill('清晨的薄雾掠过山脊，镜头缓慢推进。');
  await editor.press('End'); await editor.press('Enter');
  await page.waitForFunction(element => {
    const paragraph = element.lastElementChild, selection = getSelection();
    return paragraph?.textContent === '' && selection?.isCollapsed && paragraph.contains(selection.anchorNode);
  }, await editor.elementHandle());
  for (const id of ids) await page.evaluate(id => window.dispatchEvent(new CustomEvent('bowerbird://board-asset-picked', { detail: id })), id);
  const strip = dock.locator('.composer-references');
  await strip.locator('.composer-reference').nth(1).waitFor();
  assert.deepEqual(await strip.locator('.composer-reference').evaluateAll(buttons => buttons.map(button => button.dataset.assetId)), ids, 'thumbnail order follows the editor references, not the library order');
  assert.deepEqual(await strip.locator('.composer-reference-index').allTextContents(), ['01', '02']);
  assert.deepEqual(await editor.locator('[data-asset-id]').evaluateAll(chips => chips.map(chip => chip.dataset.assetId)), ids, 'inline chips remain the source of the references');
  const images = strip.locator('img');
  assert.equal(await images.count(), 2);
  await images.evaluateAll(images => Promise.all(images.map(image => image.decode().catch(() => {}))));
  assert.ok(await images.evaluateAll(images => images.every(image => {
    const rect = image.getBoundingClientRect();
    return image.naturalWidth > 0 && rect.height >= 40 && rect.height <= 90 && rect.width <= 123;
  })), 'small reference images render without displacing the large writing area');
  assert.ok((await editor.boundingBox()).height >= 180, 'reference thumbnails preserve a large editable area');
  await page.waitForFunction(({ element, lastId }) => {
    const selection = getSelection();
    if (!selection?.isCollapsed || !selection.anchorNode || !element.contains(selection.anchorNode)) return false;
    const before = document.createRange(), after = document.createRange();
    before.selectNodeContents(element); before.setEnd(selection.anchorNode, selection.anchorOffset);
    after.selectNodeContents(element); after.setStart(selection.anchorNode, selection.anchorOffset);
    return !!before.cloneContents().querySelector(`[data-asset-id="${lastId}"]`)
      && !after.cloneContents().querySelector('[data-asset-id]') && after.toString() === '';
  }, { element: await editor.elementHandle(), lastId: ids[1] });
  for (let count = 0; count < 3 && await editor.locator(`[data-asset-id="${ids[1]}"]`).count(); count++) await page.keyboard.press('Backspace');
  assert.equal(await editor.locator(`[data-asset-id="${ids[1]}"]`).count(), 0, 'Backspace removes the inline reference after the verified caret');
  await strip.locator(`[data-asset-id="${ids[1]}"]`).waitFor({ state: 'detached' });
  assert.deepEqual(await strip.locator('.composer-reference').evaluateAll(buttons => buttons.map(button => button.dataset.assetId)), [ids[0]], 'Backspace removes the same reference from the thumbnail strip');
  assert.deepEqual(await strip.locator('.composer-reference-index').allTextContents(), ['01']);
  await page.evaluate(id => window.dispatchEvent(new CustomEvent('bowerbird://board-asset-picked', { detail: id })), ids[1]);
  await strip.locator('.composer-reference').nth(1).waitFor();
  await dock.getByRole('button', { name: '退出创作模式', exact: true }).click();
  await waitCollapsed(dock);
  assert.equal(await strip.isVisible(), false, 'collapsed composer hides reference previews');
  assert.equal(await editor.locator('[data-asset-id]').count(), 2, 'collapse keeps editor references');
  await dock.getByRole('button', { name: '展开创作描述', exact: true }).click();
  await strip.waitFor(); await settle();
  await page.mouse.move(20, 160);
  await dock.screenshot({ path: `${output}/references-${theme}.png` });
}
try {
  await page.goto(url);
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  const home = page.locator('.library-composer .creation-dock');
  await home.waitFor(); await settle();
  assert.ok(Math.abs(await bottomGap(home)) < 1, 'inactive home composer touches the window bottom');
  await home.getByRole('button', { name: '展开创作描述', exact: true }).click();
  await home.locator('.ProseMirror').fill('清晨的薄雾掠过山脊，镜头缓慢推进。\n第二行内容仍保留在草稿中。');
  await home.getByRole('button', { name: '退出创作模式', exact: true }).click(); await settle();
  await waitCollapsed(home);
  assert.ok(Math.abs(await bottomGap(home)) < 1);
  assert.equal(await home.locator('.composer-editor-scroll .collection-scroll-viewport').evaluate(element => element.clientHeight), 36);
  assert.match(await home.locator('.ProseMirror').innerText(), /清晨的薄雾/);
  await page.screenshot({ path: `${output}/home-rest.png` });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await home.getByRole('button', { name: '展开创作描述', exact: true }).click();
    const motion = await home.evaluate(element => ({ name: getComputedStyle(element).animationName, filter: getComputedStyle(element).filter }));
    assert.notEqual(motion.name, 'none', 'opening has a transition'); assert.equal(motion.filter, 'none', 'text is never blurred');
    await settle();
    await home.getByRole('button', { name: '图片', exact: true }).click();
    await home.locator('.ProseMirror').fill('');
    const disabledSend = home.locator('.generation-send-button:disabled');
    await disabledSend.waitFor();
    assert.ok(await disabledSend.evaluate(button => Number(getComputedStyle(button).opacity) < 1
      && getComputedStyle(button, '::before').display === 'none' && getComputedStyle(button, '::after').display === 'none'
      && getComputedStyle(button.querySelector('svg')).filter === 'none'), 'unavailable sending is dimmed and loses the active optical glow');
    await home.locator('.ProseMirror').fill('清晨的薄雾掠过山脊，镜头缓慢推进。'); await settle();
    await leftRail(home, true); await opticalSurface(home);
    const writing = await home.locator('.ProseMirror').boundingBox();
    assert.ok(writing.height >= 180, `expanded input provides a large editable area: ${writing.height}`);
    if (theme === 'dark') {
      await home.getByRole('button', { name: '放大编辑文本', exact: true }).click();
      const document = page.getByRole('textbox', { name: '文档正文', exact: true });
      await document.waitFor(); assert.match(await document.innerText(), /清晨的薄雾/);
      await page.getByRole('button', { name: '返回', exact: true }).click();
      await document.waitFor({ state: 'detached' });
    }
    const project = home.getByRole('combobox', { name: '选择项目', exact: true });
    await project.click({ position: { x: 12, y: 6 } });
    const projects = page.getByRole('listbox', { name: '选择项目', exact: true });
    await projects.waitFor();
    assert.ok(await projects.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.right <= innerWidth; }));
    await page.keyboard.press('Escape'); await projects.waitFor({ state: 'detached' });
    assert.equal(await project.evaluate(element => element === document.activeElement), true, 'project tab restores focus');
    await project.press('Enter'); await projects.waitFor();
    const destination = await projects.getByRole('option').nth(1).innerText();
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await projects.waitFor({ state: 'detached' });
    assert.equal(await project.innerText(), destination, 'project tab selects the keyboard destination');
    await project.press('Home'); await projects.waitFor(); await page.keyboard.press('Enter');
    await projects.waitFor({ state: 'detached' });
    assert.equal(await project.innerText(), '选择项目');
    const profile = home.getByRole('button', { name: '品牌规范', exact: true });
    await profile.click();
    const profilePanel = home.locator('.composer-profile-panel');
    await profilePanel.getByRole('combobox', { name: '品牌视觉规范', exact: true }).waitFor();
    assert.equal(await profile.getAttribute('aria-expanded'), 'true');
    await profile.press('Escape'); await profilePanel.waitFor({ state: 'detached' });
    assert.equal(await profile.evaluate(element => element === document.activeElement), true, 'brand menu Escape restores its trigger');
    await profile.click(); await profilePanel.waitFor(); await profile.click();
    await profilePanel.waitFor({ state: 'detached' });
    await profile.click(); await profilePanel.waitFor();
    await home.locator('.ProseMirror').click({ position: { x: 20, y: 20 } });
    await profilePanel.waitFor({ state: 'detached' });
    assert.equal(await home.evaluate(element => element.classList.contains('is-collapsed')), false, 'clicking the text closes only the brand menu');
    await referenceProjection(home, theme);
    await home.locator('.ProseMirror').focus(); await settle();
    assert.ok(await bottomGap(home) >= 12, 'expanded composer floats above the edge');
    await page.screenshot({ path: `${output}/home-${theme}.png` });
    await home.screenshot({ path: `${output}/hud-rail-${theme}.png` });
    await home.getByRole('button', { name: '视频', exact: true }).click(); await settle();
    await home.locator('.ProseMirror').fill('清晨的薄雾掠过山脊，镜头缓慢推进。');
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 900 }); await settle(); await singleRow(home);
      assert.ok(await home.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; }));
      await leftRail(home, true);
    }
    await home.locator('.model-select-trigger').click();
    const menu = page.getByRole('dialog', { name: '视频模型', exact: true });
    await menu.waitFor();
    assert.ok(await menu.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.right <= innerWidth; }));
    await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
    assert.equal(await home.locator('.model-select-trigger').evaluate(element => element === document.activeElement), true);
    await home.locator('.ProseMirror').focus();
    await page.mouse.move(20, 160); await settle();
    await home.screenshot({ path: `${output}/video-${theme}.png` });
    await page.setViewportSize({ width: 1440, height: 900 });
    await home.getByRole('button', { name: '退出创作模式', exact: true }).click(); await settle();
    await waitCollapsed(home);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await home.getByRole('button', { name: '展开创作描述', exact: true }).click();
  assert.equal(await home.evaluate(element => getComputedStyle(element).animationName), 'none');
  await home.getByRole('button', { name: '退出创作模式', exact: true }).click();
  await waitCollapsed(home);
  assert.ok(Math.abs(await bottomGap(home)) < 1);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(url);
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  const canvas = page.locator('.canvas-workspace .creation-dock');
  await canvas.locator('.ProseMirror').fill('将光线、留白与材质组织成一个安静的镜头。'); await settle();
  await canvas.getByRole('button', { name: '品牌规范', exact: true }).click();
  await canvas.locator('.composer-profile-panel').waitFor();
  const canvasStage = await page.locator('.canvas-workspace .canvas-stage').boundingBox();
  await page.mouse.click(canvasStage.x + canvasStage.width - 40, canvasStage.y + 100);
  await canvas.locator('.composer-profile-panel').waitFor({ state: 'detached' });
  await canvas.locator('.ProseMirror').focus(); await settle();
  await leftRail(canvas); await opticalSurface(canvas);
  await page.screenshot({ path: `${output}/canvas.png` });
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await opticalSurface(canvas);
  await page.screenshot({ path: `${output}/canvas-light.png` });
  await canvas.getByRole('button', { name: '视频', exact: true }).click();
  await page.setViewportSize({ width: 900, height: 900 }); await settle(); await singleRow(canvas);
  assert.ok(await canvas.locator('.composer-toolbar').evaluate(element => element.scrollWidth <= element.clientWidth), 'canvas footer does not overflow at 900px');
  await page.emulateMedia({ forcedColors: 'active' });
  assert.ok(await canvas.locator('.composer-mode-picker').evaluate(picker => {
    const selected = getComputedStyle(picker.querySelector('button[aria-pressed="true"]'));
    const other = getComputedStyle(picker.querySelector('button[aria-pressed="false"]'));
    return selected.backgroundColor !== 'rgba(0, 0, 0, 0)' && selected.backgroundColor !== other.backgroundColor
      && selected.color !== selected.backgroundColor;
  }), 'high-contrast selection keeps a distinct filled background and readable text');
  await page.emulateMedia({ forcedColors: 'none' });
  assert.deepEqual(errors, []);
  console.log('PASS optical HUD home/canvas, vertical project/mode rail, project and brand menus, large clear input, ordered reference thumbnails and Backspace, first-line draft, video single row and reduced motion');
} finally { await browser.close(); await server.close(); }
