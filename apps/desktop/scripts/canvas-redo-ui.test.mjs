import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { selectCanvasTool } from './fixtures/canvas-reference/place-card.mjs';

const server = await createServer({ cacheDir: '.tmp/canvas-redo/vite', server: { host: '127.0.0.1', port: 17944, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const card = id => page.locator(`[data-canvas-node-id="${id}"]`);
const undo = page.getByRole('button', { name: '撤销画布操作', exact: true });
const redo = page.getByRole('button', { name: '重做画布操作', exact: true });
const workflowCard = id => page.locator(`[data-workflow-card="${id}"]`);
const savedWorkflow = predicate => page.waitForFunction(
  source => new Function('document', `return (${source})(document)`)(JSON.parse(sessionStorage.getItem('workflow-p')).document),
  predicate.toString(),
);
const redoAvailable = () => page.locator('button[aria-label="重做画布操作"]:enabled').waitFor();
const text = id => card('content').getByRole('textbox', { name: id, exact: true });

try {
  await page.goto('http://127.0.0.1:17944/scripts/fixtures/canvas-reference/preview.html');
  await card('old').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot(), base = snapshot.nodes[0];
    snapshot.nodes = [
      { ...base, id: 'content', kind: 'note', assetId: null, role: null, x: 480, y: 120, width: 550, height: 290, zIndex: 10,
        payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '\t原文字', member_ids: [],
          cells: [[{ id: 'image-cell', text: '', content_type: 'image', image_refs: [{ token: '图1', asset_id: 'a' }] },
            { id: 'text-cell', text: '原文字' }]] }) },
      { ...base, id: 'source', assetId: 'b', x: 70, y: 130 },
      { ...base, id: 'other', assetId: 'c', x: 70, y: 420 },
    ];
    snapshot.edges = []; snapshot.view = { ...snapshot.view, panX: 35, panY: 40, zoom: 0.8 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    localStorage.setItem('bowerbird.canvasSnapEnabled', 'false');
  });
  await page.reload();
  await card('content').waitFor();
  assert.equal(await redo.isDisabled(), true);
  const name = page.locator('[data-card-name="content"] input');
  const originalName = await name.inputValue();
  await name.fill('重做名称'); await name.press('Enter');
  await savedWorkflow(doc => doc.cardNames.content === '重做名称');
  const clearImage = card('content').getByRole('button', { name: '清空第 1 行第 1 列图片', exact: true });
  const image = card('content').locator('[data-canvas-cell="image-cell"] img');
  await clearImage.click({ force: true });
  await image.waitFor({ state: 'detached' });
  await undo.click(); await image.waitFor();
  await undo.click();
  await page.waitForFunction(expected => document.querySelector('[data-card-name="content"] input').value === expected, originalName);
  await text('第 1 行第 2 列').focus();
  await page.keyboard.press('Control+y');
  await savedWorkflow(doc => doc.cardNames.content === '重做名称');
  assert.equal(await redo.isEnabled(), true, 'the first redo preserves the second redo entry');
  await page.keyboard.press('Meta+Shift+z');
  await image.waitFor({ state: 'detached' });
  assert.equal(await redo.isDisabled(), true);
  await undo.click(); await image.waitFor();
  await text('第 1 行第 2 列').fill('新编辑清空重做');
  assert.equal(await redo.isDisabled(), true);
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await image.count(), 1);

  await page.evaluate(() => { window.failNoteSave = true; });
  await clearImage.click({ force: true });
  const retry = page.getByRole('button', { name: '重试保存画板', exact: true });
  await retry.waitFor();
  await undo.click(); await image.waitFor();
  await redo.click(); await image.waitFor({ state: 'detached' });
  await page.evaluate(() => { window.failNoteSave = false; });
  await retry.click();
  await page.waitForFunction(() => !JSON.parse(window.snapshot().nodes.find(node => node.id === 'content').payloadJson).cells[0][0].image_refs.length);
  await undo.click(); await image.waitFor();

  await card('source').click({ modifiers: ['Control'], position: { x: 40, y: 40 } });
  await card('source').focus(); await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => window.snapshot().nodes.find(node => node.id === 'source').x > 70);
  await undo.click();
  await page.waitForFunction(() => window.snapshot().nodes.find(node => node.id === 'source').x === 70);
  await redo.click();
  await page.waitForFunction(() => window.snapshot().nodes.find(node => node.id === 'source').x > 70);

  await page.mouse.click(1500, 800);
  const source = await card('source').boundingBox();
  const cell = await card('content').locator('[data-canvas-cell="text-cell"]').boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(cell.x + cell.width / 2, cell.y + cell.height / 2, { steps: 8 });
  await page.getByRole('tooltip', { name: '松开放入单元格', exact: true }).waitFor();
  await page.mouse.up();
  await card('source').waitFor({ state: 'detached' });
  await undo.click(); await card('source').waitFor();
  assert.equal(await text('第 1 行第 2 列').inputValue(), '新编辑清空重做');
  await redo.click(); await card('source').waitFor({ state: 'detached' });
  assert.equal(await card('other').count(), 1);
  await undo.click(); await card('source').waitFor();

  const restoredSource = await card('source').boundingBox();
  const other = await card('other').boundingBox();
  await page.mouse.move(restoredSource.x + 70, restoredSource.y + 70);
  await page.mouse.down();
  await page.mouse.move(other.x + 70, other.y + 70, { steps: 8 });
  await page.getByRole('tooltip', { name: '松开创建素材组', exact: true }).waitFor();
  await page.mouse.up();
  const folder = page.locator('.canvas-node.is-folder');
  await folder.waitFor();
  const folderId = await folder.getAttribute('data-canvas-node-id');
  await undo.click(); await folder.waitFor({ state: 'detached' });
  await redo.click(); await card(folderId).waitFor();
  await page.waitForFunction(() => window.snapshot().groupItems.length === 2);
  await card(folderId).click();
  const member = card(folderId).locator('[data-canvas-folder-asset-id="source"]');
  await member.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移出画布', exact: true }).click();
  await member.waitFor({ state: 'detached' });
  await undo.click(); await member.waitFor();
  await redo.click(); await member.waitFor({ state: 'detached' });
  await undo.click(); await member.waitFor();
  await page.waitForFunction(() => window.snapshot().groupItems.map(item => item.nodeId).sort().join() === 'other,source');

  await selectCanvasTool(page, '气泡便签');
  await page.mouse.click(1050, 650);
  const bubble = page.locator('[data-canvas-node-id^="bubble-"]');
  await bubble.waitFor();
  const bubbleId = await bubble.getAttribute('data-canvas-node-id');
  await undo.click(); await bubble.waitFor({ state: 'detached' });
  await redoAvailable();
  await redo.click(); await card(bubbleId).waitFor();
  await undo.click(); await bubble.waitFor({ state: 'detached' });

  await page.evaluate(async () => {
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const controller = canvasWorkflowController('p');
    await controller.load();
    const producer = { ...newWorkflowNode('instruction', 420, 460, 'codex'), id: 'producer' };
    const consumer = { ...newWorkflowNode('generation', 850, 460, 'codex'), id: 'consumer',
      inputs: { text: [{ nodeId: 'producer', portId: 'text', slot: 1 }] } };
    const writer = { ...newWorkflowNode('text', 0, 0, ''), id: 'writer', textTarget: { nodeId: 'content', cellId: 'text-cell' },
      inputs: { text: [{ nodeId: 'producer', portId: 'text' }] } };
    await controller.edit([producer, consumer, writer]);
    const done = (id, order) => ({ id, startId: order[0], threadId: 'thread', order, status: 'done', steps: {} });
    const runs = [done('removed-run', ['producer', 'writer']), done('kept-run', ['consumer'])];
    await controller.save({ ...controller.document, runs, run: runs[1] });
    window.save();
  });
  await page.reload(); await workflowCard('producer').waitFor();
  assert.equal(await redo.isDisabled(), true, 'history is session-scoped');
  const removeProducer = workflowCard('producer').getByRole('button', { name: '删除卡片', exact: true });
  await removeProducer.click(); await workflowCard('producer').waitFor({ state: 'detached' });
  await savedWorkflow(doc => doc.nodes.length === 1);

  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const save = api.canvasWorkflowSave;
    api.canvasWorkflowSave = async (...args) => {
      api.canvasWorkflowSave = save;
      await new Promise(resolve => { window.releaseHistoryWrite = resolve; });
      return save(...args);
    };
  });
  await undo.click(); await workflowCard('producer').waitFor();
  await page.waitForFunction(() => !!window.releaseHistoryWrite);
  await redo.click();
  assert.equal(await workflowCard('producer').count(), 1, 'redo waits for the undo write');
  await page.evaluate(() => window.releaseHistoryWrite());
  await savedWorkflow(doc => doc.nodes.length === 3 && doc.runs.length === 2);

  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const controller = canvasWorkflowController('p');
    const nodes = controller.document.nodes;
    window.clearExtraConnection = () => controller.edit(nodes);
    await controller.edit(nodes.map(node => node.id !== 'consumer' ? node : {
      ...node, inputs: { ...node.inputs, extra: [{ nodeId: 'producer', portId: 'text' }] },
    }));
  });
  await redo.click();
  assert.equal(await workflowCard('producer').count(), 1, 'a new external wire blocks deletion replay');
  assert.equal(await redo.isEnabled(), true);
  await page.evaluate(() => window.clearExtraConnection());
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const controller = canvasWorkflowController('p');
    const { runs, run } = controller.document;
    window.releaseRunLock = () => controller.save({ ...controller.document, runs, run });
    const active = { id: 'active', startId: 'producer', status: 'running', order: ['producer'],
      lockedNodeIds: ['producer'], steps: { producer: { status: 'running' } } };
    await controller.save({ ...controller.document, runs: [...runs, active], run: active });
  });
  await redo.click();
  assert.equal(await workflowCard('producer').count(), 1, 'a running card blocks deletion replay');
  assert.equal(await redo.isEnabled(), true);
  await page.evaluate(() => window.releaseRunLock());
  await redo.click(); await workflowCard('producer').waitFor({ state: 'detached' });
  await savedWorkflow(doc => doc.nodes.length === 1 && doc.runs.map(run => run.id).join() === 'kept-run');
  await undo.click(); await workflowCard('producer').waitFor();
  await savedWorkflow(doc => doc.nodes.some(node => node.id === 'writer') && doc.runs.map(run => run.id).join() === 'removed-run,kept-run');

  await workflowCard('producer').getByLabel('指令功能').click();
  await page.getByRole('option', { name: /复用/ }).click();
  await savedWorkflow(doc => doc.nodes.some(node => node.id === 'producer' && node.action === 'reuse'));
  assert.equal(await redo.isDisabled(), true, 'a new workflow edit discards the undone deletion');
  await undo.click();
  await savedWorkflow(doc => doc.nodes.some(node => node.id === 'producer' && node.action === 'describe'));
  await workflowCard('producer').getByLabel('指令功能').focus();
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await redo.isEnabled(), true, 'a focused workflow form keeps its own shortcut');
  await workflowCard('producer').getByRole('button', { name: '复制卡片', exact: true }).focus();
  await page.keyboard.press('Control+Shift+z');
  await savedWorkflow(doc => doc.nodes.some(node => node.id === 'producer' && node.action === 'reuse'));
  assert.equal(await redo.isDisabled(), true);

  await page.locator('.canvas-stage').focus();
  await page.evaluate(async () => {
    const { captureCanvasClipboard, serializeCanvasClipboard } = await import('/src/lib/canvasClipboard.ts');
    const snapshot = window.snapshot();
    const { document: workflow } = JSON.parse(sessionStorage.getItem('workflow-p'));
    const selection = new Set(['producer', 'consumer', 'content', snapshot.groups[0].id]);
    const clipboard = captureCanvasClipboard('p', selection, snapshot.nodes, snapshot.groups, snapshot.groupItems, workflow.nodes);
    const data = new DataTransfer();
    data.setData('text/plain', serializeCanvasClipboard(clipboard));
    document.querySelector('.canvas-stage').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await savedWorkflow(doc => doc.nodes.filter(node => node.kind !== 'text').length === 4);
  await page.waitForFunction(() => window.snapshot().groups.length === 2);
  const pasted = () => page.evaluate(() => {
    const snapshot = window.snapshot();
    const { document } = JSON.parse(sessionStorage.getItem('workflow-p'));
    const copy = document.nodes.find(node => node.id !== 'producer' && node.kind === 'instruction');
    const group = snapshot.groups[1];
    return { copyId: copy.id, wires: document.nodes.find(node => node.id !== 'consumer' && node.kind === 'generation').inputs,
      groupId: group.id, members: snapshot.groupItems.filter(item => item.groupId === group.id).map(item => item.nodeId) };
  });
  const firstPaste = await pasted();
  await undo.click();
  await savedWorkflow(doc => doc.nodes.length === 3);
  await page.waitForFunction(() => window.snapshot().groups.length === 1);
  await redoAvailable(); await redo.click();
  await savedWorkflow(doc => doc.nodes.filter(node => node.kind !== 'text').length === 4);
  await page.waitForFunction(() => window.snapshot().groups.length === 2);
  assert.deepEqual(await pasted(), firstPaste, 'mixed paste restores card, group and wire identities');
  assert.deepEqual(errors, []);
  console.log('PASS canvas/workflow redo, toolbar and keyboard, branching, moved material, original card identity, write lock, wiring and run history.');
} finally {
  await browser.close();
  await server.close();
}
