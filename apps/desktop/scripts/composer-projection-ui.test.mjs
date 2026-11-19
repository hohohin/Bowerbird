import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/composer-projection';
await mkdir(output, { recursive: true });
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 18981, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
try {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/library-creation-parity/preview.html?source-library&detail-route&canvas-library`);
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await page.getByRole('navigation', { name: '首页' }).getByRole('button', { name: '素材库', exact: true }).click();
  const dock = page.locator('.library-composer .creation-dock');
  async function assertCollapsedBackground(theme) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await page.waitForTimeout(80);
    const collapsedMask = await dock.evaluate(async element => {
      const surface = element.querySelector('.composer-projection-surface');
      const field = surface.getBoundingClientRect(), box = element.getBoundingClientRect();
      const image = new Image(); image.src = getComputedStyle(surface).maskImage.slice(5, -2); await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = field.width; canvas.height = field.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const alpha = x => context.getImageData(Math.round(x - field.left), Math.round(box.top + box.height / 2 - field.top), 1, 1).data[3];
      return { center: alpha(box.left + box.width / 2), nearLeft: alpha(box.left + 20), nearRight: alpha(box.right - 20) };
    });
    assert.ok(Object.values(collapsedMask).every(alpha => alpha > 240), `collapsed background remains visible: ${theme} ${JSON.stringify(collapsedMask)}`);
    await page.screenshot({ path: `${output}/collapsed-${theme}.png` });
  }
  for (const theme of ['dark', 'light']) await assertCollapsedBackground(theme);
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await dock.getByRole('button', { name: '展开创作描述', exact: true }).click();
  let editor = dock.locator('.ProseMirror');
  await editor.fill('');
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${output}/initial.png` });
  const projection = await dock.evaluate(async element => {
    const surface = element.querySelector('.composer-projection-surface');
    const field = surface.getBoundingClientRect();
    const writing = element.querySelector('.ProseMirror').getBoundingClientRect();
    const tags = [...element.querySelectorAll('.library-composer-target, .composer-mode-picker > button')].map(node => node.getBoundingClientRect());
    const image = new Image();
    image.src = getComputedStyle(surface).maskImage.slice(5, -2);
    await image.decode();
    const probe = document.createElement('canvas'); probe.width = field.width; probe.height = field.height;
    const ctx = probe.getContext('2d'); ctx.drawImage(image, 0, 0);
    const alpha = (x, y = probe.height - 30) => ctx.getImageData(Math.max(0, Math.min(probe.width - 1, Math.round(x))), Math.max(0, Math.min(probe.height - 1, Math.round(y))), 1, 1).data[3];
    const railX = tags[0].left + tags[0].width / 2 - field.left;
    const middleX = (tags[0].left + element.getBoundingClientRect().right) / 2 - field.left;
    const arc = element.querySelector('.composer-projection-arc path');
    const arcY = x => {
      let low = 0, high = arc.getTotalLength();
      for (let i = 0; i < 20; i++) { const mid = (low + high) / 2; if (arc.getPointAtLength(mid).x < x) low = mid; else high = mid; }
      return arc.getPointAtLength((low + high) / 2).y;
    };
    return { blur: getComputedStyle(surface).backdropFilter,
      left: alpha(tags[0].left - field.left - 140), right: alpha(element.getBoundingClientRect().right - field.left + 140),
      center: alpha(writing.left + writing.width / 2 - field.left),
      tags: tags.map(box => alpha(box.left + box.width / 2 - field.left, box.top + box.height / 2 - field.top)),
      above: [railX, middleX, element.getBoundingClientRect().right - field.left - 50].map(x => alpha(x, arcY(x) - 24)),
      atArc: alpha(middleX, arcY(middleX)), arcAbove: alpha(middleX, arcY(middleX) - 2), arcBelow: alpha(middleX, arcY(middleX) + 2),
      arcLeft: arc.getPointAtLength(0).x + field.left, arcRight: arc.getPointAtLength(arc.getTotalLength()).x + field.left,
      tagLeft: tags[0].left, dockRight: element.getBoundingClientRect().right,
      writingGap: writing.left - Math.max(...tags.slice(1).map(box => box.right)),
      sideFade: Array.from({ length: 240 }, (_, i) => alpha(tags[0].left - field.left - 80 + i)),
      gap: parseFloat(getComputedStyle(element.querySelector('.composer-mode-picker')).gap) };
  });
  assert.match(projection.blur, /url\("?#composer-contour-.*-dark/, 'approved contour film replaces background blur');
  assert.ok(projection.left < 8 && projection.right < 8, `materials beside the composer remain clear: ${JSON.stringify(projection)}`);
  assert.ok(projection.center > 240, 'feathering preserves the reading area');
  assert.ok(projection.above.every(alpha => alpha < 8), `blur stays below the arc: ${JSON.stringify(projection)}`);
  assert.ok(projection.arcAbove < 80 && projection.arcBelow > 180, `feathering meets the arc without a clear gap: ${projection.atArc}`);
  assert.ok(projection.arcLeft >= projection.tagLeft - 50 && projection.arcRight <= projection.dockRight + 40, 'HUD arc stays local to the composer');
  assert.ok(projection.writingGap >= 16 && projection.writingGap <= 48, `mode tags sit close to the input: ${projection.writingGap}`);
  assert.ok(projection.sideFade.some(alpha => alpha > 30 && alpha < 220)
    && projection.sideFade.every((alpha, i, values) => !i || Math.abs(alpha - values[i - 1]) < 70), 'side blur dissolves gradually rather than ending at a vertical edge');
  assert.ok(Math.abs(projection.gap - 3.312) < .1, 'rail spacing matches the approved preview');
  assert.ok((await editor.boundingBox()).height <= 36, 'empty input has one line, with no reserved reference height');
  const oneLine = (await dock.boundingBox()).height;
  await editor.fill('第一行\n第二行\n第三行');
  assert.ok((await dock.boundingBox()).height >= oneLine + 55, 'newlines grow the composer');
  await editor.fill('输入光标');
  await editor.press('Home');
  await page.waitForTimeout(80);
  const caret = dock.locator('.composer-terminal-caret');
  await caret.waitFor({ state: 'visible' });
  const start = await caret.boundingBox();
  assert.equal(start.width, 4, 'terminal caret is a narrow block');
  await editor.press('ArrowRight');
  await page.waitForTimeout(80);
  assert.ok((await caret.boundingBox()).x > start.x + 10, 'block follows actual insertion position');
  await editor.press('Shift+ArrowRight');
  await page.waitForTimeout(80);
  assert.equal(await caret.isVisible(), false, 'selection hides block');
  await editor.fill('');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '你好', selectionStart: 2, selectionEnd: 2 });
  await page.waitForTimeout(80);
  assert.equal(await editor.innerText(), '你好', 'IME composition remains native');
  assert.equal(await caret.isVisible(), true, 'composition keeps its block caret');
  await cdp.send('Input.insertText', { text: '你好' });
  await page.waitForTimeout(80);
  assert.equal(await editor.innerText(), '你好', 'Chinese composition commits once');
  await cdp.detach();
  await editor.fill('');
  assert.equal(await editor.evaluate(el => getComputedStyle(el, '::before').opacity), '0', 'focus hides placeholder');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    for (const mode of ['图片', '视频', '对话']) {
      await dock.getByRole('button', { name: mode, exact: true }).click();
      assert.equal(await dock.getByRole('button', { name: mode, exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await dock.locator('.composer-mode-picker > button[aria-pressed="true"]').count(), 1);
      await dock.locator('.composer-reference-hint').waitFor({ state: 'visible' });
      assert.equal(await dock.locator('.composer-reference-hint').innerText(), '双击添加素材');
      const hintSize = await dock.locator('.composer-reference-hint').evaluate(node => parseFloat(getComputedStyle(node).fontSize));
      const inputSize = await dock.locator('.ProseMirror').evaluate(node => parseFloat(getComputedStyle(node).fontSize));
      assert.ok(hintSize <= 12 && hintSize < inputSize, `${theme}/${mode}: material hint stays smaller than input text (${hintSize}px / ${inputSize}px)`);
    }
    await dock.getByRole('button', { name: '图片', exact: true }).click();
    await page.screenshot({ path: `${output}/before-menu.png` });
    await dock.getByRole('combobox', { name: '选择项目', exact: true }).click();
    const menu = page.getByRole('listbox', { name: '选择项目', exact: true });
    await menu.waitFor();
    await page.screenshot({ path: `${output}/${theme}-menu.png` });
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    const dots = dock.locator('.composer-projection-dots');
    const pixels = () => dots.evaluate(canvas => canvas.toDataURL());
    const before = await pixels();
    await page.waitForTimeout(420);
    assert.notEqual(await pixels(), before, `${theme}: dots breathe visibly`);
    assert.equal(await dock.locator('.composer-cross-matrix').count(), 3);
    const beforeMove = await dock.locator('.composer-cross-matrix').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).transform));
    await page.mouse.move(1250, 800); await page.waitForTimeout(250);
    const afterMove = await dock.locator('.composer-cross-matrix').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).transform));
    assert.notDeepEqual(afterMove, beforeMove, 'depth layers respond to pointer');
    assert.equal(new Set(afterMove).size, 3, 'layers move at different depths');
    await page.screenshot({ path: `${output}/${theme}.png` });
    await page.screenshot({ path: `${output}/${theme}-detail.png`, clip: { x: 0, y: 590, width: 1440, height: 310 } });
    await dock.locator('.composer-collapse').click();
    await dock.getByRole('button', { name: '展开创作描述', exact: true }).waitFor();
    await assertCollapsedBackground(theme);
    await dock.getByRole('button', { name: '展开创作描述', exact: true }).click();
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(180);
  const still = await dock.locator('.composer-projection-dots').evaluate(canvas => canvas.toDataURL());
  await page.waitForTimeout(420);
  assert.equal(await dock.locator('.composer-projection-dots').evaluate(canvas => canvas.toDataURL()), still, 'reduced motion keeps the dot field still');
  assert.deepEqual(errors, []);
  console.log('PASS: real composer projection, themes, modes, menu, caret and reduced motion');
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` });
  console.log({ errors });
  throw error;
} finally { await browser.close(); await server.close(); }
