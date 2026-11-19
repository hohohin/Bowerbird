import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/canvas-text-focus';
await mkdir(output, { recursive: true });
const server = await createServer({
  cacheDir: `${output}/vite`,
  server: { host: '127.0.0.1', port: 17942, strictPort: true, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const card = page.locator('[data-canvas-node-id="editing"]');
const first = card.getByRole('textbox', { name: '第 1 行第 1 列', exact: true });
const second = card.getByRole('textbox', { name: '第 1 行第 2 列', exact: true });
const camera = () => page.locator('.canvas-plane').evaluate(element => {
  const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
  return { zoom: matrix.a, x: matrix.e, y: matrix.f };
});
const settle = () => page.evaluate(async () => {
  let previous = '', stable = 0;
  for (let frame = 0; frame < 150 && stable < 42; frame++) {
    await new Promise(requestAnimationFrame);
    const value = getComputedStyle(document.querySelector('.canvas-plane')).transform;
    stable = value === previous ? stable + 1 : 0;
    previous = value;
  }
});
const unchanged = async (before, message) => {
  await settle();
  assert.deepEqual(await camera(), before, message);
};
const centered = async input => {
  const { bounds, visible } = await input.evaluate(async element => {
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      const stage = document.querySelector('.canvas-stage').getBoundingClientRect();
      let left = stage.left, right = stage.right, top = stage.top, bottom = stage.bottom;
      const library = document.querySelector('.canvas-source-panel');
      if (library && library.checkVisibility()) {
        const box = library.getBoundingClientRect();
        if (box.left <= left + 1 && box.right > left && box.right < right) left = box.right;
      }
      const composer = document.querySelector('.canvas-composer-host');
      if (composer?.checkVisibility()) {
        const box = composer.getBoundingClientRect();
        if (box.top > top && box.top < bottom) bottom = box.top;
      }
      return { bounds: bounds.toJSON(), visible: { x: (left + right) / 2, y: (top + bottom) / 2 } };
    };
    let result = measure();
    for (let frame = 0; frame < 120; frame++) {
      if (Math.abs(result.bounds.x + result.bounds.width / 2 - result.visible.x) < 40
        && Math.abs(result.bounds.y + result.bounds.height / 2 - result.visible.y) < 40) break;
      await new Promise(requestAnimationFrame);
      result = measure();
    }
    return result;
  });
  assert.ok(bounds, 'focused editor remains visible');
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - visible.x) < 40,
    `editor centered horizontally: ${JSON.stringify({ bounds, visible })}`);
  assert.ok(Math.abs(bounds.y + bounds.height / 2 - visible.y) < 40,
    `editor centered vertically: ${JSON.stringify({ bounds, visible })}`);
  assert.equal(await input.evaluate(element => element === document.activeElement), true, 'editing focus remains on the textbox');
  await settle();
};
const reset = async (zoom = 0.65, oversized = false) => {
  await page.evaluate(async ({ zoom, oversized }) => {
    const snapshot = window.snapshot();
    const base = snapshot.nodes[0];
    const cell = (id, text) => ({ id, text, content_type: 'text', bold: false, italic: false, align: 'left' });
    snapshot.nodes = [{
      ...base, id: 'editing', kind: 'note', role: null, assetId: null,
      x: 140, y: 100, width: oversized ? 2200 : 460, height: oversized ? 1200 : 260,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [],
        cells: [[cell('a', '可编辑文本第一行 ABCDE\n第二行保持不变'), ...oversized ? [] : [cell('b', '另一个单元格')]]] }),
    }, {
      ...base, id: 'readonly', kind: 'prompt', role: null, assetId: null,
      x: 850, y: 100, width: 260, height: 180,
      payloadJson: JSON.stringify({ schema_version: 1, text: '已完成会话的只读文本', status: 'succeeded' }),
    }];
    snapshot.edges = [];
    snapshot.view = { ...snapshot.view, zoom, panX: 30, panY: 30 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    sessionStorage.setItem('workflow-p', JSON.stringify({ revision: 1, document: {
      schema_version: 1, run: null, nodes: [
        { ...newWorkflowNode('generation', 650, 420, 'codex'), id: 'generation', prompt: '工作流富文本指令' },
        { ...newWorkflowNode('instruction', 1100, 420, 'codex'), id: 'instruction', prompt: '工作流反推要求' },
      ],
    } }));
  }, { zoom, oversized });
  await page.reload();
  await first.waitFor();
  await page.evaluate(() => window.store.setState({ canvasLibraryOpen: false, boardOpen: false }));
  await settle();
};

try {
  await page.goto('http://127.0.0.1:17942/scripts/fixtures/canvas-reference/preview.html?source-library');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await reset();
  const initial = await camera();
  await page.evaluate(() => {
    window.focusCameraSamples = [];
    const start = performance.now();
    document.querySelector('.canvas-stage').addEventListener('click', () => {
      const click = performance.now();
      const sample = () => {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.canvas-plane')).transform);
        window.focusCameraSamples.push({ time: performance.now() - click, zoom: matrix.a, x: matrix.e, y: matrix.f, commits: window.canvasCommits });
        if (performance.now() - start < 1000) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, { once: true });
  });
  await first.click();
  await centered(first);
  await settle();
  const samples = await page.evaluate(() => window.focusCameraSamples);
  await writeFile(`${output}/motion-samples.json`, JSON.stringify(samples, null, 2));
  const moving = samples.filter(sample => Math.abs(sample.zoom - initial.zoom) > 0.001);
  assert.ok(moving[0]?.time < 100, `focus starts without the old 500ms wait: ${moving[0]?.time}`);
  assert.ok(samples.filter(sample => sample.zoom > initial.zoom + 0.01 && sample.zoom < 1.19).length >= 3, 'zoom has several intermediate frames');
  const final = await camera();
  const middle = samples.filter(sample => sample.zoom > initial.zoom + 0.01 && sample.zoom < 1.19);
  assert.ok(middle.at(-1).commits - middle[0].commits <= 2, 'camera frames do not trigger continuous React commits');
  assert.ok(samples.every(sample => Math.abs((sample.x - initial.x) / (final.x - initial.x) - (sample.zoom - initial.zoom) / (final.zoom - initial.zoom)) < 0.001), 'pan and zoom follow the same easing curve');
  assert.ok(samples.some(sample => Math.abs(sample.x - initial.x) > 2 && Math.abs(sample.x - final.x) > 2), 'pan has an intermediate position');
  assert.ok(moving.find(sample => sample.zoom >= 1.199)?.time < 500, 'short transition completes promptly');
  console.log(`PASS motion starts at ${moving[0].time.toFixed(1)}ms, reaches final zoom at ${moving.find(sample => sample.zoom >= 1.199).time.toFixed(1)}ms`);
  assert.ok((await camera()).zoom >= 1.2, 'small text boxes enlarge to a readable zoom');
  assert.ok((await camera()).zoom > initial.zoom);
  const focused = await camera();
  await first.click({ position: { x: 18, y: 18 } });
  await unchanged(focused, 'a second click inside the same editor does not move the view');
  await first.press('Home');
  await first.press('Shift+End');
  assert.ok(await first.evaluate(element => element.selectionEnd > element.selectionStart), 'text selection is retained');
  await unchanged(focused, 'selecting text does not move the view');
  const selectionBox = await first.boundingBox();
  await page.mouse.move(selectionBox.x + 12, selectionBox.y + 14);
  await page.mouse.down();
  await page.mouse.move(selectionBox.x + 100, selectionBox.y + 14, { steps: 10 });
  await page.mouse.up();
  assert.ok(await first.evaluate(element => element.selectionEnd > element.selectionStart), 'pointer drag selects text');
  await unchanged(focused, 'drag-selecting inside the focused editor does not move the view');
  await first.press('End');
  await first.pressSequentially('!');
  assert.match(await first.inputValue(), /!/);
  await unchanged(focused, 'typing does not move the view');
  await second.click();
  await centered(second);
  assert.notEqual((await camera()).x, focused.x, 'another cell receives its own camera focus');
  console.log('PASS text cells: enlargement, centering, repeat click, selection, typing and switching');

  await reset(1.6);
  await first.click();
  await centered(first);
  assert.equal((await camera()).zoom, 1.6, 'editing never reduces an already larger zoom');
  await reset(0.85, true);
  await first.click({ position: { x: 100, y: 80 } });
  await centered(first);
  assert.ok((await camera()).zoom >= 0.85, 'an oversized editor does not zoom the canvas out');

  for (const [id, name] of [['generation', '卡片指令'], ['instruction', '反推要求']]) {
    await reset();
    const input = page.locator(`[data-workflow-card="${id}"]`).getByRole('textbox', { name, exact: true });
    await input.click();
    await centered(input);
    assert.ok((await camera()).zoom >= 1.2, `${id} editor enlarges`);
  }
  console.log('PASS larger zoom, oversized text and workflow native/rich text editors');
  await reset();
  const title = page.locator('[data-card-name="editing"] input');
  await title.click();
  await centered(title);
  assert.ok((await camera()).zoom >= 1.2, 'inline card names enlarge like text editors');
  console.log('PASS inline card name');

  await reset();
  let before = await camera();
  const composer = page.locator('.canvas-composer-host .creation-editor .ProseMirror[contenteditable="true"]');
  await composer.click();
  await unchanged(before, 'floating composer does not move the canvas camera');
  await reset();
  before = await camera();
  await first.click();
  await composer.click();
  await unchanged(await camera(), 'switching to the composer stops the transition at its current position');
  assert.equal(await composer.evaluate(element => element === document.activeElement), true, 'canceled focus does not steal the composer caret');
  console.log('PASS composer focus and transition cancellation');
  for (const attribute of ['readonly', 'disabled']) {
    await reset();
    before = await camera();
    await first.evaluate((element, attribute) => element.setAttribute(attribute, ''), attribute);
    const box = await first.boundingBox();
    await page.mouse.click(box.x + 18, box.y + 16);
    await unchanged(before, `${attribute} text boxes do not focus the camera`);
  }
  await reset();
  before = await camera();
  await page.locator('[data-canvas-node-id="readonly"] .canvas-prompt-content').click();
  await unchanged(before, 'read-only session content does not trigger text focus zoom');
  await reset();
  before = await camera();
  const handle = await card.locator('.canvas-text-handle').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 80, handle.y + handle.height / 2 + 45, { steps: 12 });
  await page.mouse.up();
  await unchanged(before, 'dragging the card does not focus or zoom the editor');
  await page.waitForFunction(() => window.snapshot().nodes.find(node => node.id === 'editing').x !== 140);
  console.log('PASS readonly/disabled content and card drag');

  await reset();
  await first.click();
  await centered(first);
  await page.evaluate(() => window.store.setState({ canvasLibraryOpen: true }));
  await page.locator('.canvas-source-panel').waitFor({ state: 'visible' });
  await page.locator('.canvas-source-panel').evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})));
  });
  const resize = await page.getByRole('separator', { name: '调整素材库宽度' }).boundingBox();
  const panel = await page.locator('.canvas-source-panel').boundingBox();
  await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2);
  await page.mouse.down();
  await page.mouse.move(resize.x + resize.width / 2 + 560 - panel.width, resize.y + resize.height / 2, { steps: 12 });
  await page.mouse.up();
  await second.click();
  await centered(second);
  await page.screenshot({ path: `${output}/focused-with-library.png` });
  assert.deepEqual(errors, []);
  console.log('PASS composer/read-only/drag exclusions and visible canvas center with library open');
  await reset();
  await first.dblclick({ position: { x: 18, y: 16 } });
  await centered(first);
  assert.ok(await first.evaluate(element => element.selectionEnd > element.selectionStart), 'the first double-click still selects a word');
  await reset();
  let doubleClickBox = await first.boundingBox();
  await page.mouse.click(doubleClickBox.x + 18, doubleClickBox.y + 16);
  await page.waitForTimeout(400);
  doubleClickBox = await first.boundingBox();
  await page.mouse.click(doubleClickBox.x + 18, doubleClickBox.y + 16, { clickCount: 2 });
  await centered(first);
  assert.ok(await first.evaluate(element => element.selectionEnd > element.selectionStart), 'a spaced double-click keeps native word selection');
  console.log('PASS first double-click retains text focus and word selection');

  for (const interrupt of ['pointerdown', 'wheel', 'editor-wheel', 'blur']) {
    await reset();
    const stopped = await first.evaluate(async (element, interrupt) => {
      element.focus();
      element.click();
      for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame);
      const plane = document.querySelector('.canvas-plane');
      const start = new DOMMatrixReadOnly(getComputedStyle(plane).transform);
      if (interrupt === 'blur') window.dispatchEvent(new Event('blur'));
      else if (interrupt === 'wheel') document.querySelector('.canvas-stage').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 60 }));
      else if (interrupt === 'editor-wheel') element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 60 }));
      else element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, buttons: 1 }));
      await new Promise(requestAnimationFrame);
      const end = new DOMMatrixReadOnly(getComputedStyle(plane).transform);
      return { startZoom: start.a, startY: start.f, camera: { zoom: end.a, x: end.e, y: end.f } };
    }, interrupt);
    assert.ok(stopped.startZoom > 0.65 && stopped.startZoom < 1.19, `${interrupt} interrupts an active transition`);
    assert.equal(stopped.camera.zoom, stopped.startZoom, `${interrupt} freezes the current zoom`);
    if (interrupt === 'wheel') assert.ok(Math.abs(stopped.camera.y - stopped.startY + 60) < 0.01, `wheel immediately takes control of the camera: ${JSON.stringify(stopped)}`);
    if (interrupt === 'editor-wheel') assert.equal(stopped.camera.y, stopped.startY, 'scrolling text stops the transition without panning the canvas');
    await unchanged(stopped.camera, `${interrupt} prevents a delayed camera jump`);
  }

  await reset();
  await first.evaluate(async element => {
    element.focus();
    element.click();
    for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame);
    const next = document.querySelector('[data-canvas-node-id="editing"] textarea[aria-label="第 1 行第 2 列"]');
    next.focus();
    next.click();
  });
  await second.pressSequentially('续写');
  await centered(second);
  assert.match(await second.inputValue(), /续写/, 'typing during the transition keeps the text and caret');
  const saved = await camera();
  await page.waitForFunction(expected => {
    const view = window.snapshot().view;
    return Math.abs(view.zoom - expected.zoom) < 0.001 && Math.abs(view.panX - expected.x) < 0.01 && Math.abs(view.panY - expected.y) < 0.01;
  }, saved);
  await page.evaluate(() => window.save());
  await page.reload();
  await first.waitFor();
  await unchanged(saved, 'the completed camera position survives a reload');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await reset();
  await first.click();
  assert.equal((await camera()).zoom, 1.2, 'reduced motion reaches the final zoom immediately');
  await unchanged(await camera(), 'reduced motion has no later transition');
  assert.deepEqual(errors, []);
  console.log('PASS smooth frames, gesture interruption, rapid editor switching, typing, persistence and reduced motion');
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await browser.close();
  await server.close();
}
