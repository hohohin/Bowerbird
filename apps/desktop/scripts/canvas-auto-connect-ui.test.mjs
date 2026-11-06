import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/canvas-auto-connect-vite', server: { host: '127.0.0.1', port: 17958, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
page.setDefaultTimeout(12000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
async function openConnectionMenu(control) {
  await control.focus();
  await control.press('Enter');
}
async function assertMenuLayout(menu) {
  const layout = await menu.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { bounds: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      viewport: { width: innerWidth, height: innerHeight },
      rows: [...element.querySelectorAll('button[role="menuitem"]')].map(button => {
        const box = button.getBoundingClientRect();
        return { left: box.left, top: box.top, width: box.width, height: box.height, bottom: box.bottom };
      }) };
  });
  assert.ok(layout.bounds.left >= 7 && layout.bounds.top >= 7);
  assert.ok(layout.bounds.right <= layout.viewport.width - 7 && layout.bounds.bottom <= layout.viewport.height - 7);
  for (const [index, row] of layout.rows.entries()) {
    assert.ok(row.height >= 32, 'each menu item has a complete clickable row');
    assert.ok(row.width > 180, 'menu items occupy one column rather than wrapping inline');
    if (index) {
      assert.ok(row.top >= layout.rows[index - 1].bottom - .5, 'menu items never overlap');
      assert.ok(Math.abs(row.left - layout.rows[0].left) < 1, 'menu items share one left edge');
    }
  }
}
await page.route('**/fixture/document.png', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#748d81"/></svg>' }));
const state = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document);
const target = id => page.locator(`[data-workflow-card="${id}"]`);
const card = id => page.locator(`[data-workflow-card="${id}"],[data-canvas-node-id="${id}"]`).first();
const handle = (id, side) => page.locator(`[data-workflow-card="${id}"] [data-canvas-connect-side="${side}"],[data-canvas-node-id="${id}"] [data-canvas-connect-side="${side}"],[data-workflow-material="${id}"] [data-canvas-connect-side="${side}"]`).first();
const output = () => page.locator('[data-canvas-node-id="script"] [data-canvas-connect-side="output"]');
async function assertHandleVisible(id, side, shown) {
  await page.waitForFunction(({ id, side, shown }) => {
    const button = document.querySelector(`[data-workflow-card="${id}"] [data-canvas-connect-side="${side}"],[data-canvas-node-id="${id}"] [data-canvas-connect-side="${side}"],[data-workflow-material="${id}"] [data-canvas-connect-side="${side}"]`);
    return button && getComputedStyle(button).opacity === (shown ? '1' : '0') && getComputedStyle(button).pointerEvents === 'auto';
  }, { id, side, shown });
}
async function clickOutput() {
  const box = await output().boundingBox();
  await page.mouse.click(box.x + box.width / 2 + 42, box.y + box.height / 2);
}
async function holdOutput() {
  const box = await output().boundingBox();
  await page.mouse.move(box.x + box.width / 2 + 42, box.y + box.height / 2);
  await page.mouse.down();
  await page.locator('.workflow-wires .is-draft').waitFor();
}
async function dragHandleToCard(sourceId, side, targetId) {
  await card(sourceId).hover();
  const from = await handle(sourceId, side).boundingBox(), to = await card(targetId).boundingBox();
  assert.ok(from && to, 'real card and connection control must have geometry');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(100, to.height / 2), { steps: 16 });
  assert.equal(await handle(sourceId, side).locator('.canvas-connection-glyph').evaluate(element => getComputedStyle(element).opacity), '0', 'dragging hides the initiating marker on native, material and workflow cards');
  const feedback = await page.locator('[data-connection-target]').getAttribute('aria-label', { timeout: 300 }).catch(() => null);
  await page.mouse.up();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return feedback;
}
const dragToCard = id => dragHandleToCard('script', 'output', id);
async function waitInputs(id, count) {
  await page.waitForFunction(({ id, count }) => {
    const node = JSON.parse(sessionStorage.getItem('workflow-p'))?.document.nodes.find(node => node.id === id);
    return Object.values(node?.inputs ?? {}).flat().length === count;
  }, { id, count });
}

try {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-auto-connect/preview.html`);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const snapshot = window.snapshot();
    snapshot.nodes = [{ id: 'script', projectId: 'p', kind: 'note', assetId: null, role: null, threadId: null, x: 100, y: 190, width: 360, height: 56, zIndex: 1, positionLocked: false, hiddenAt: null, createdAt: 1, updatedAt: 1,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'document', title: '图文来源', text: '# 林间场景\n\n柔和的晨光\n\n<img data-bowerbird-asset="a" data-caption="" />\n', cells: [], member_ids: [] }) }];
    snapshot.edges = []; snapshot.groups = []; snapshot.groupItems = [];
    snapshot.view = { ...snapshot.view, panX: 80, panY: 60, zoom: 1 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const describe = { ...newWorkflowNode('instruction', 650, 70, 'codex'), id: 'describe', action: 'describe' };
    const generator = { ...newWorkflowNode('generation', 650, 440, 'codex'), id: 'generator', prompt: '保持构图，改为秋天' };
    sessionStorage.setItem('workflow-p', JSON.stringify({ revision: 0, document: { schema_version: 1, nodes: [describe, generator], run: null } }));
  });
  await page.reload();
  await output().waitFor();
  await target('generator').waitFor();
  // The typed glyphs are replaced by one common action on a real document card.
  assert.equal(await page.locator('[data-canvas-node-id="script"] [data-canvas-connect-side="output"]').count(), 1);
  assert.equal(await page.locator('[data-canvas-node-id="script"]').getByRole('button', { name: '输出文档图片', exact: true }).count(), 0);

  await page.mouse.move(1200, 80);
  await assertHandleVisible('script', 'output', false);
  await assertHandleVisible('generator', 'input', false);
  for (const [id, side] of [['script', 'output'], ['generator', 'input']]) {
    const box = await handle(id, side).boundingBox();
    await page.mouse.move(box.x + box.width / 2 + (side === 'output' ? 35 : -35), box.y + box.height / 2);
    await assertHandleVisible(id, side, true);
    await page.mouse.move(1200, 80);
    await assertHandleVisible(id, side, false);
  }
  await card('script').hover();
  await assertHandleVisible('script', 'output', true);
  await assertHandleVisible('generator', 'input', false);
  await card('script').click({ position: { x: 60, y: 25 } });
  await page.mouse.move(1200, 80);
  await assertHandleVisible('script', 'output', true);
  await page.mouse.click(1200, 80);
  await assertHandleVisible('script', 'output', false);
  await target('generator').hover();
  await assertHandleVisible('generator', 'input', true);
  await assertHandleVisible('generator', 'output', true);
  await page.mouse.move(1200, 80);
  await assertHandleVisible('generator', 'input', false);
  await handle('generator', 'input').focus();
  await assertHandleVisible('generator', 'input', true);
  await handle('generator', 'input').evaluate(element => element.blur());
  await assertHandleVisible('generator', 'input', false);

  await clickOutput();
  await page.getByRole('menu', { name: '添加下游', exact: true }).waitFor();
  await page.waitForTimeout(220);
  assert.equal(await page.locator('.workflow-wires .is-draft').count(), 0, 'clicking the outer hot zone opens the creation menu without a draft or a delayed hold');
  await page.keyboard.press('Escape');
  await holdOutput();
  await page.mouse.up();
  await page.getByRole('menu', { name: '添加下游', exact: true }).waitFor();
  assert.equal(await page.locator('.workflow-wires .is-draft').count(), 0, 'releasing a stationary hold in its hot zone opens the menu without a self-connection error');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-canvas-node-id="script"] .canvas-connection-glyph')).opacity === '1');
  await page.keyboard.press('Escape');
  await holdOutput();
  assert.equal(await output().locator('.canvas-connection-glyph').evaluate(element => getComputedStyle(element).opacity), '0', 'holding hides the source marker');
  const anchor = await page.locator('.workflow-wires .is-draft').evaluate(element => {
    const point = element.getPointAtLength(0).matrixTransform(element.getScreenCTM());
    const card = document.querySelector('[data-canvas-node-id="script"]').getBoundingClientRect();
    return { x: point.x, y: point.y, right: card.right, middle: card.top + card.height / 2 };
  });
  assert.ok(Math.abs(anchor.x - anchor.right) < 1 && Math.abs(anchor.y - anchor.middle) < 1, `draft begins at the card right midpoint, not the off-center press or magnetic glyph: ${JSON.stringify(anchor)}`);
  const initialDraft = await page.locator('.workflow-wires .is-draft').getAttribute('d');
  await page.mouse.move(1200, 80);
  await assertHandleVisible('script', 'output', true);
  await assertHandleVisible('generator', 'input', false);
  const describeBox = await target('describe').boundingBox();
  await page.mouse.move(describeBox.x + describeBox.width / 2, describeBox.y + 100, { steps: 12 });
  assert.notEqual(await page.locator('.workflow-wires .is-draft').getAttribute('d'), initialDraft, 'held pointer moves the wire');
  await page.mouse.up();
  await waitInputs('describe', 1);
  let doc = await state();
  const describe = doc.nodes.find(node => node.id === 'describe');
  assert.equal(describe.inputs.text?.length ?? 0, 0);
  assert.equal(describe.inputs.image[0].cellId, '*');
  assert.ok(describe.inputs.image[0].autoConnect);

  await dragToCard('generator');
  await waitInputs('generator', 2);
  doc = await state();
  const generator = doc.nodes.find(node => node.id === 'generator');
  assert.equal(generator.prompt, '保持构图，改为秋天', 'connecting never inserts hidden tokens into the user instruction');
  assert.equal(generator.inputs.text[0].cellId, '*text');
  assert.equal(generator.inputs.image[0].cellId, '*');
  const relation = generator.inputs.text[0].autoConnect;
  assert.equal(generator.inputs.image[0].autoConnect, relation);
  assert.equal(await page.locator(`[data-auto-connection="${relation}"]`).count(), 1, 'two internal projections have exactly one visible edge');
  const compiled = await page.evaluate(async () => {
    const { compileGenerationPrompt } = await import('/src/lib/canvasWorkflow.ts');
    const { canvasInputValue } = await import('/src/lib/canvasSessionOutputs.ts');
    const source = window.snapshot().nodes.find(node => node.id === 'script');
    const target = JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'generator');
    return compileGenerationPrompt(target, { text: [canvasInputValue(source, '*text', [source])], image: [canvasInputValue(source, '*', [source])] });
  });
  assert.match(compiled.prompt, /保持构图，改为秋天/);
  assert.match(compiled.prompt, /柔和的晨光/);
  assert.deepEqual(compiled.assetIds, ['a']);

  await dragToCard('generator');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  doc = await state();
  assert.equal(Object.values(doc.nodes.find(node => node.id === 'generator').inputs).flat().length, 2, 'repeated drop is idempotent');
  assert.equal(await page.locator(`[data-auto-connection="${relation}"]`).count(), 1);

  await target('generator').locator('[data-canvas-connect-side="input"]').click({ button: 'right' });
  const disconnect = page.getByRole('menu', { name: '选择要断开的连线', exact: true });
  if (await disconnect.isVisible()) await disconnect.getByRole('menuitem').click();
  await waitInputs('generator', 0);
  await page.keyboard.press('Control+z');
  await waitInputs('generator', 2);
  await page.evaluate(() => window.save());
  await page.reload();
  await output().waitFor();
  await waitInputs('generator', 2);
  const restored = (await state()).nodes.find(node => node.id === 'generator');
  assert.equal(restored.inputs.text[0].autoConnect, restored.inputs.image[0].autoConnect);
  assert.equal(await page.locator(`[data-auto-connection="${restored.inputs.image[0].autoConnect}"]`).count(), 1);

  await page.locator('[data-canvas-node-id="script"]').hover();
  const beforeMenu = await state();
  await holdOutput();
  await target('generator').getByRole('button', { name: '运行此卡片', exact: true }).hover();
  await page.mouse.up();
  await page.locator('.workflow-wires .is-draft').waitFor({ state: 'detached' });
  assert.deepEqual(await state(), beforeMenu, 'finishing on a card button only connects; it does not run the card');
  await holdOutput();
  await page.mouse.move(1100, 180, { steps: 10 });
  await page.mouse.click(1100, 180, { button: 'right' });
  await page.mouse.up();
  await page.locator('.workflow-wires .is-draft').waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('menu').count(), 0, 'right-click cancels without opening a canvas menu');
  assert.deepEqual(await state(), beforeMenu, 'right-click does not change any saved connection');
  await clickOutput();
  await page.getByRole('menu', { name: '添加下游', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  const pending = await output().boundingBox();
  await page.mouse.move(pending.x + pending.width / 2, pending.y + pending.height / 2);
  await page.mouse.down();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(220);
  await page.mouse.up();
  assert.equal(await page.locator('.workflow-wires .is-draft').count(), 0, 'cancelled pending hold cannot revive a draft');
  assert.equal(await page.getByRole('menu').count(), 0, 'cancelled pending hold cannot open a menu on release');
  await card('script').hover();
  const held = await output().boundingBox();
  await page.mouse.move(held.x + held.width / 2, held.y + held.height / 2);
  await page.mouse.down();
  await page.mouse.move(1100, 180, { steps: 10 });
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await page.mouse.up();
  await page.locator('.workflow-wires .is-draft').waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('menu').count(), 0, 'right-click also cancels a held drag without opening the blank menu');
  assert.deepEqual(await state(), beforeMenu);
  await openConnectionMenu(output());
  await page.getByRole('menu', { name: '添加下游', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.deepEqual(await state(), beforeMenu, 'cancelled click menu does not alter the graph');
  const from = await output().boundingBox();
  const stage = await page.locator('.canvas-stage').boundingBox();
  const blank = { x: stage.x + stage.width - 110, y: stage.y + 220 };
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(blank.x, blank.y, { steps: 16 });
  await page.mouse.up();
  const menu = page.getByRole('menu', { name: '添加下游', exact: true });
  await menu.waitFor();
  await assertMenuLayout(menu);
  await mkdir('.tmp/canvas-auto-connect', { recursive: true });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: `.tmp/canvas-auto-connect/connection-menu-${theme}.png` });
  }
  await page.setViewportSize({ width: 820, height: 620 });
  await assertMenuLayout(menu);
  await page.screenshot({ path: '.tmp/canvas-auto-connect/connection-menu-narrow.png' });
  await page.setViewportSize({ width: 1600, height: 1100 });
  assert.equal((await state()).nodes.length, beforeMenu.nodes.length, 'blank drop opens a choice without creating a node');
  await menu.getByRole('menuitem', { name: '图片生成', exact: true }).click();
  await page.waitForFunction(count => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.length === count + 1, beforeMenu.nodes.length);
  const created = (await state()).nodes.find(node => !beforeMenu.nodes.some(previous => previous.id === node.id));
  assert.equal(created.kind, 'generation');
  assert.equal(created.inputs.text.length, 1);
  assert.equal(created.inputs.image.length, 1);
  assert.equal(created.inputs.text[0].autoConnect, created.inputs.image[0].autoConnect);
  await page.getByRole('button', { name: '适应内容', exact: true }).click();
  await mkdir('.tmp/canvas-auto-connect', { recursive: true });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: `.tmp/canvas-auto-connect/${theme}.png` });
  }
  await page.keyboard.press('Control+z');
  await page.waitForFunction(count => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.length === count, beforeMenu.nodes.length);
  assert.ok(!(await state()).nodes.some(node => Object.values(node.inputs).flat().some(input => input.nodeId === created.id)), 'one undo removes the created downstream and every new binding');

  // A fresh graph exercises the reverse gesture and upstream creation without existing wires.
  await page.evaluate(async () => {
    const snapshot = window.snapshot();
    snapshot.nodes = snapshot.nodes.filter(node => node.id === 'script').map(node => ({ ...node, x: 100, y: 190,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'document', title: '纯文本来源', text: '只接收这段文本', cells: [], member_ids: [] }) }));
    snapshot.view = { ...snapshot.view, panX: 80, panY: 60, zoom: 1 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const generator = { ...newWorkflowNode('generation', 650, 190, 'codex'), id: 'reverse', prompt: '生成场景' };
    sessionStorage.setItem('workflow-p', JSON.stringify({ revision: 0, document: { schema_version: 1, nodes: [generator], run: null } }));
  });
  await page.reload();
  await target('reverse').waitFor();
  await dragHandleToCard('reverse', 'input', 'script');
  await waitInputs('reverse', 1);
  const reverse = (await state()).nodes.find(node => node.id === 'reverse');
  assert.equal(reverse.inputs.text[0].canvasNodeId, 'script');
  assert.equal(reverse.inputs.text[0].cellId, '*text');
  assert.equal(reverse.inputs.image?.length ?? 0, 0, 'plain text documents do not create an empty image dependency');
  await page.keyboard.press('Control+z');
  await waitInputs('reverse', 0);
  const beforeUpstream = await state();
  await card('reverse').hover();
  await handle('reverse', 'input').click();
  const upstreamMenu = page.getByRole('menu', { name: '添加上游', exact: true });
  await upstreamMenu.waitFor();
  await assertMenuLayout(upstreamMenu);
  await page.evaluate(() => window.calls.length = 0);
  await upstreamMenu.getByRole('menuitem', { name: '复用提示词', exact: true }).click();
  await waitInputs('reverse', 2);
  const afterUpstream = await state();
  const upstream = afterUpstream.nodes.find(node => node.id !== 'reverse');
  assert.equal(upstream.kind, 'instruction');
  assert.equal(upstream.action, 'reuse');
  assert.equal(afterUpstream.nodes.length, 2);
  const receiving = afterUpstream.nodes.find(node => node.id === 'reverse');
  assert.equal(receiving.inputs.text[0].nodeId, upstream.id);
  assert.equal(receiving.inputs.image[0].nodeId, upstream.id);
  assert.equal(receiving.inputs.text[0].autoConnect, receiving.inputs.image[0].autoConnect);
  const creationSaves = await page.evaluate(() => window.calls.filter(call => call.command === 'canvas_workflow_save'));
  assert.equal(creationSaves.length, 1, 'upstream creation and its bindings are persisted atomically');
  assert.ok(creationSaves[0].args.document.nodes.some(node => node.id === upstream.id));
  await page.keyboard.press('Control+z');
  await waitInputs('reverse', 0);
  assert.deepEqual((await state()).nodes, beforeUpstream.nodes, 'one undo removes the newly created upstream and both projections');

  // Synthetic video metadata is real to the canvas; no frame conversion or provider may run.
  await page.evaluate(async () => {
    const snapshot = window.snapshot();
    snapshot.nodes = [{ ...snapshot.nodes[0], id: 'movie-card', kind: 'asset', assetId: 'movie', x: 100, y: 190, width: 300, height: 220,
      payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: '视频素材', width: 640, height: 360 } }) }];
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    sessionStorage.setItem('reference-drafts', JSON.stringify([{ id: 'movie', name: '视频素材', width: 640, height: 360, duration: 5, ext: 'mp4', source: 'imported', store_path: '/fixture/movie.mp4', thumb_path: '/fixture/document.png' }]));
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const imageOnly = { ...newWorkflowNode('instruction', 650, 70, 'codex'), id: 'image-only', action: 'describe' };
    const video = { ...newWorkflowNode('generation', 650, 440, 'codex'), id: 'video-generator', prompt: '继续这个镜头', generation: { media: 'video', videoOptions: { kind: 'multimodal2video', model_version: 'seedance2.5', duration: 5, video_resolution: '720p' } } };
    sessionStorage.setItem('workflow-p', JSON.stringify({ revision: 0, document: { schema_version: 1, nodes: [imageOnly, video], run: null } }));
  });
  await page.reload();
  await card('movie-card').waitFor();
  await target('video-generator').waitFor();
  await page.mouse.move(1200, 80);
  await assertHandleVisible('movie-card', 'output', false);
  await card('movie-card').hover();
  await assertHandleVisible('movie-card', 'output', true);
  await card('movie-card').click({ modifiers: ['Control'] });
  await page.mouse.move(1200, 80);
  await assertHandleVisible('movie-card', 'output', true);
  await page.mouse.click(1200, 80);
  await assertHandleVisible('movie-card', 'output', false);
  const beforeVideo = await state();
  assert.match(await dragHandleToCard('movie-card', 'output', 'image-only'), /没有可接收|无法接收|不支持|不能接收/);
  assert.deepEqual(await state(), beforeVideo, 'video cannot silently become an image input');
  await dragHandleToCard('movie-card', 'output', 'video-generator');
  await waitInputs('video-generator', 1);
  const videoInput = (await state()).nodes.find(node => node.id === 'video-generator').inputs.image[0];
  assert.equal(videoInput.assetId, 'movie');
  assert.ok(videoInput.autoConnect);
  assert.ok(videoInput.mediaFilter.includes('video'));
  assert.equal(await page.evaluate(() => window.calls.filter(call => /frame|generate|start_run/.test(call.command)).length), 0);

  // The shared feedback prevents invalid edges before any graph mutation.
  await page.evaluate(async () => {
    const snapshot = window.snapshot(); snapshot.nodes = [];
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const nodes = ['a', 'b'].map((id, index) => ({ ...newWorkflowNode('instruction', 100 + index * 550, 140, 'codex'), id, action: 'reuse' }));
    sessionStorage.setItem('workflow-p', JSON.stringify({ revision: 0, document: { schema_version: 1, nodes, run: null } }));
  });
  await page.reload();
  await target('b').waitFor();
  let beforeRejected = await state();
  await dragHandleToCard('a', 'output', 'a');
  assert.deepEqual(await state(), beforeRejected, 'self drop leaves the graph untouched');
  assert.equal(await page.getByRole('menu', { name: '添加下游', exact: true }).count(), 0);
  await dragHandleToCard('a', 'output', 'b');
  await waitInputs('b', 1);
  beforeRejected = await state();
  assert.match(await dragHandleToCard('b', 'output', 'a'), /循环/);
  assert.deepEqual(await state(), beforeRejected, 'a cycle is rejected without altering existing connections');
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const controller = canvasWorkflowController('p');
    const run = { id: 'waiting-fixture', startId: 'b', threadId: 't', order: ['b'], status: 'waiting', steps: { b: { status: 'waiting' } }, lockedNodeIds: ['b'], writeNodeIds: ['b'] };
    await controller.save({ ...controller.document, run, runs: [run] });
  });
  beforeRejected = await state();
  assert.match(await dragHandleToCard('a', 'output', 'b'), /运行|停止/);
  assert.deepEqual(await state(), beforeRejected, 'a running receiver refuses connection changes');
  await card('b').hover();
  assert.ok(await handle('b', 'output').isDisabled(), 'a running source disables its connection handle');

  // Scoped menus retain the simple handles while allowing precise table destinations.
  await page.evaluate(async () => {
    const snapshot = window.snapshot();
    const base = { projectId: 'p', kind: 'note', assetId: null, role: null, threadId: null, width: 400, height: 240, zIndex: 1, positionLocked: false, hiddenAt: null, createdAt: 1, updatedAt: 1 };
    const cell = (id, text = '', image = false) => ({ id, text, content_type: image ? 'image' : 'text', bold: false, italic: false, align: 'left', ...(image ? { image_refs: [{ asset_id: 'a', token: '@图片1' }] } : {}) });
    snapshot.nodes = [
      { ...base, id: 'source-grid', x: 100, y: 120, payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], cells: [[cell('s11', '整行说明'), cell('s12', '指定的第二格')], [cell('s21', '@图片1', true), { ...cell('s22', '@图片1', true), image_refs: [{ asset_id: 'movie', token: '@图片1' }] }]] }) },
      { ...base, id: 'receiver-grid', x: 650, y: 500, payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], cells: [[cell('r11'), cell('r12')], [cell('r21'), cell('r22')]] }) },
    ];
    snapshot.view = { ...snapshot.view, panX: 80, panY: 60, zoom: 1 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const generator = { ...newWorkflowNode('generation', 650, 70, 'codex'), id: 'scoped', prompt: '使用指定内容' };
    sessionStorage.setItem('workflow-p', JSON.stringify({ revision: 0, document: { schema_version: 1, nodes: [generator], run: null,
      cardNames: { 'source-grid': '来源表格', 'receiver-grid': '接收表格', scoped: '指定生成' } } }));
  });
  await page.reload();
  await card('receiver-grid').waitFor();
  const connectingPlane = page.locator('.canvas-plane[data-canvas-connecting]');
  await card('source-grid').hover();
  await openConnectionMenu(handle('source-grid', 'output'));
  let scopeMenu = page.getByRole('menu', { name: '添加下游', exact: true });
  await scopeMenu.waitFor();
  await connectingPlane.waitFor({ state: 'attached' });
  await scopeMenu.hover();
  await page.mouse.wheel(0, 120);
  assert.ok(await scopeMenu.isVisible(), 'wheel inside the menu keeps the connection session open');
  assert.equal(await connectingPlane.count(), 1);
  await scopeMenu.getByRole('menuitem', { name: '指定内容', exact: true }).click();
  await assertMenuLayout(page.getByRole('menu', { name: '指定内容', exact: true }));
  await page.getByRole('menu', { name: '指定内容', exact: true }).getByRole('menuitem', { name: '第 1 行，第 2 列', exact: true }).click();
  scopeMenu = page.getByRole('menu', { name: '添加下游', exact: true });
  await scopeMenu.getByRole('menuitem', { name: '连接已有卡片', exact: true }).click();
  await page.getByRole('menu', { name: '连接已有卡片', exact: true }).getByRole('menuitem', { name: '指定生成', exact: true }).click();
  await waitInputs('scoped', 1);
  const scoped = (await state()).nodes.find(node => node.id === 'scoped');
  assert.equal(scoped.inputs.text[0].cellId, 's12');
  assert.equal(scoped.inputs.image?.length ?? 0, 0);
  await connectingPlane.waitFor({ state: 'detached' });
  await page.keyboard.press('Control+z');
  await waitInputs('scoped', 0);

  await card('source-grid').hover();
  await openConnectionMenu(handle('source-grid', 'output'));
  await page.getByRole('menu', { name: '添加下游', exact: true }).getByRole('menuitem', { name: '指定内容', exact: true }).click();
  await page.getByRole('menu', { name: '指定内容', exact: true }).getByRole('menuitem', { name: '第 2 行，第 2 列', exact: true }).click();
  const videoScopeMenu = page.getByRole('menu', { name: '添加下游', exact: true });
  assert.ok(await videoScopeMenu.getByRole('menuitem', { name: '图片反推', exact: true }).isDisabled(), 'scoped video cells reject an image-only task before execution');
  assert.ok(await videoScopeMenu.getByRole('menuitem', { name: '视频生成', exact: true }).isEnabled(), 'scoped video cells remain usable by video generation');
  await page.keyboard.press('Escape');
  await connectingPlane.waitFor({ state: 'detached' });

  for (const destination of [
    { label: '第 2 行', axis: 'row', ids: ['r21', 'r22'], writers: 2 },
    { label: '第 2 列', axis: 'column', ids: ['r12', 'r22'], writers: 2 },
    { label: '第 2 行，第 2 列', cellId: 'r22', writers: 1 },
  ]) {
    await card('receiver-grid').hover();
    await openConnectionMenu(handle('receiver-grid', 'input'));
    const receiveMenu = page.getByRole('menu', { name: '添加上游', exact: true });
    await receiveMenu.getByRole('menuitem', { name: '指定接收位置', exact: true }).click();
    await page.getByRole('menu', { name: '指定接收位置', exact: true }).getByRole('menuitem', { name: destination.label, exact: true }).click();
    await receiveMenu.getByRole('menuitem', { name: '连接已有卡片', exact: true }).click();
    await page.getByRole('menu', { name: '连接已有卡片', exact: true }).getByRole('menuitem', { name: '来源表格', exact: true }).click();
    await page.waitForFunction(count => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.filter(node => node.textTarget?.nodeId === 'receiver-grid').length === count, destination.writers);
    const writers = (await state()).nodes.filter(node => node.textTarget?.nodeId === 'receiver-grid');
    for (const writer of writers) {
      if (destination.axis) {
        assert.equal(writer.textTarget.appendAxis, destination.axis);
        assert.deepEqual(writer.textTarget.axisCellIds, destination.ids);
      } else assert.equal(writer.textTarget.cellId, destination.cellId);
      assert.equal(Object.values(writer.inputs).flat()[0].canvasNodeId, 'source-grid');
    }
    assert.equal(new Set(writers.flatMap(node => Object.values(node.inputs).flat().map(input => input.autoConnect))).size, 1);
    await connectingPlane.waitFor({ state: 'detached' });
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => !JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.some(node => node.textTarget?.nodeId === 'receiver-grid'));
  }
  const beforeScopeCancel = await state();
  await card('receiver-grid').hover();
  await openConnectionMenu(handle('receiver-grid', 'input'));
  await connectingPlane.waitFor({ state: 'attached' });
  await page.getByRole('menu', { name: '添加上游', exact: true }).getByRole('menuitem', { name: '指定接收位置', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('menu', { name: '指定接收位置', exact: true }).waitFor({ state: 'hidden' });
  await page.keyboard.press('Escape');
  await connectingPlane.waitFor({ state: 'detached' });
  assert.deepEqual(await state(), beforeScopeCancel, 'Escape closes scoped menu and restores the plane without editing');
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.calls.filter(call => /^(codex_create|agent_start|dreamina_generate|cloud_generation)/.test(call.command)).length), 0);
  console.log('PASS unified card connections: click menus, held/dragged wires, hidden source glyph, centered anchor, pending cancel, whole-card/reverse drops, type projection, automatic compile, one edge, duplicate, grouped disconnect, undo/reload, blank/upstream menus, atomic create+connect, true video, self/cycle/run locks, scoped menus, wheel and plane lifecycle');
} finally { await browser.close(); await server.close(); }
