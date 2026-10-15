import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1658, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
  await page.goto('http://127.0.0.1:1658/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  console.log(await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { emptyCanvasCell } = await import('/src/lib/canvasNotes.ts');
    const { canvasContentInput, contentInputPort } = await import('/src/lib/canvasContentInput.ts');
    const { captureCanvasClipboard, cloneCanvasClipboard } = await import('/src/lib/canvasClipboard.ts');
    const check = (ok, message) => { if (!ok) throw Error(message); };
    const read = id => JSON.parse(window.snapshot().nodes.find(n => n.id === id).payloadJson);
    const cell = (id, text = '') => ({ ...emptyCanvasCell(), id, text });
    const base = window.snapshot().nodes[0];
    const make = async (id, cells) => api.projectCanvasNodeCreate({ ...base, id, kind: 'note', role: null, assetId: null, x: 600, y: 100, width: 450, height: 240,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], cells }) });
    await make('row', [[cell('a', '邻格保留'), cell('b')], [cell('c', '行标题'), cell('d')]]);
    await make('column', [[cell('e', '邻列'), cell('f', '列标题')], [cell('g'), cell('h')]]);
    const source = { ...newWorkflowNode('skill', 0, 0, ''), id: 'source', outputs: { image: { type: 'image', assetIds: ['a', 'b', 'c'] }, text: { type: 'text', text: '一' } } };
    let c = new CanvasWorkflowController('axis'); await c.load(); await c.edit([source]);
    await c.bindTextInput('row', 'row:c', { nodeId: 'source', portId: 'image' }, 'image');
    let rw = c.document.nodes.find(n => n.textTarget?.nodeId === 'row');
    check(read('row').cells.length === 2 && read('row').cells[0].length === 4, 'row extends only columns');
    check(read('row').cells[1].slice(1).map(c => c.image_refs[0].asset_id).join(',') === 'a,b,c', 'row order');
    check(read('row').cells[0][0].text === '邻格保留' && read('row').cells[1][0].text === '行标题', 'neighbors preserved');
    await c.start(rw.id, true);
    check(read('row').cells[1].slice(1).map(c => c.image_refs[0].asset_id).join(',') === 'a,b,c,a,b,c', 'rerun appends horizontally');
    await c.bindTextInput('column', 'column:f', { nodeId: 'source', portId: 'image' }, 'image');
    const cw = c.document.nodes.find(n => n.textTarget?.nodeId === 'column');
    check(read('column').cells.length === 4 && read('column').cells[0].length === 2, 'column extends only rows');
    check(read('column').cells.slice(1).map(r => r[1].image_refs[0].asset_id).join(',') === 'a,b,c', 'column order');
    await c.bindTextInput('row', 'row:c', { nodeId: 'source', portId: 'text' }, 'text');
    check(read('row').cells[1].at(-1).text === '一', 'text/image share row');
    const update = api.projectCanvasNoteUpdate;
    for (const after of [false, true]) {
      let fail = true;
      api.projectCanvasNoteUpdate = async (id, payload) => {
        if (id === 'column' && fail) { fail = false; if (after) await update(id, payload); throw Error('模拟写入中断'); }
        return update(id, payload);
      };
      const before = read('column').cells.length;
      await c.start(cw.id, true); check(c.document.run.status === 'waiting', 'delivery waits');
      const saved = c.document.run.steps[cw.id].contentTarget.cellIds;
      c = new CanvasWorkflowController('axis'); await c.load(); await c.continue();
      check(c.document.run.status === 'done', JSON.stringify(c.issue));
      check(read('column').cells.length === before + 3 && saved.every(id => read('column').cells.flat().filter(cell => cell.id === id).length === 1), 'reload adds exactly one batch');
      api.projectCanvasNoteUpdate = update;
    }
    const note = read('row'); note.cells.unshift(note.cells[0].map((_, i) => cell('insert-' + i)));
    note.cells = note.cells.map(row => row.slice(1)); await update('row', JSON.stringify(note));
    rw = c.document.nodes.find(n => n.id === rw.id);
    check(contentInputPort(read('row'), rw.textTarget) === 'row:d', 'axis survives anchor deletion and insertion');
    await c.start(rw.id, true);
    check(read('row').cells[2].slice(-3).map(c => c.image_refs[0].asset_id).join(',') === 'a,b,c', 'insertion does not redirect');
    check(!read('row').cells[0].some(c => c.image_refs?.length), 'inserted row unchanged');
    for (const axis of ['row', 'column']) {
      const n = { schema_version: 1, note_type: 'text', text: '', member_ids: [], cells: [[cell('root')]] };
      const target = { nodeId: 'x', cellId: 'delivery', append: true, appendAxis: axis, axisCellIds: ['root'] };
      const r = canvasContentInput(n, target, { type: 'text', table: { rows: [['甲', ''], ['@图片1', '乙']], imageCells: [[1, 0]] }, imageRefs: [{ token: '@图片1', asset_id: 'a' }] });
      check(r.note.cells.flat().map(c => c.text).join('|') === '甲||@图片1|乙', 'table order and blanks');
      check(r.note.cells.flat()[2].content_type === 'image' && r.note.cells.flat()[2].image_refs[0].asset_id === 'a', 'mixed media');
      const pending = canvasContentInput(n, target, { type: 'image', assetIds: ['b'], nodeIds: ['turn-1', 'turn-2'] });
      check(pending.note.cells.flat().length === 3 && pending.note.cells.flat()[1].generation_ref.session_node_id === 'turn-1', 'pending sessions split');
    }
    const clip = captureCanvasClipboard('axis', new Set(['row']), window.snapshot().nodes, [], [], c.document.nodes);
    const copy = cloneCanvasClipboard(clip, 'axis', 0, 0);
    const copied = copy.workflow.find(n => n.textTarget?.appendAxis === 'row');
    check(contentInputPort(JSON.parse(copy.nodes[0].payloadJson), copied.textTarget)?.startsWith('row:'), 'copy retains axis');
    const removed = read('row'); removed.cells.splice(2, 1); await update('row', JSON.stringify(removed));
    let rejected = false; try { await c.start(rw.id, true); } catch { rejected = true; }
    check(rejected, 'deleted axis rejected');
    await make('reserved', [[cell('reserve-a'), cell('reserve-b')]]);
    await c.edit([...c.document.nodes, { ...newWorkflowNode('agent', 0, 0, ''), id: 'pending', prompt: '等待' }]);
    await c.bindTextInput('reserved', 'reserve-b', { nodeId: 'pending', portId: 'text' }, 'text');
    await c.bindTextInput('reserved', 'row:reserve-a', { nodeId: 'source', portId: 'text' }, 'text');
    check(read('reserved').cells[0][1].text === '' && read('reserved').cells[0][2].text === '一', 'reserved empty cell protected');
    await make('loop-source', [[cell('l1', '第一项')], [cell('l2', '第二项')]]);
    await make('loop-target', [[cell('lt')]]);
    const loop = { ...newWorkflowNode('loop', 0, 0, ''), id: 'axis-loop', loopMode: 'rows', inputs: { text: [{ canvasNodeId: 'loop-source', cellId: '*text' }] } };
    await c.edit([...c.document.nodes, loop]);
    await c.bindTextInput('loop-target', 'row:lt', { nodeId: loop.id, portId: 'text' }, 'text');
    await c.start(loop.id);
    check(c.document.run.status === 'done' && read('loop-target').cells[0].map(cell => cell.text).join(',') === '第一项,第二项', 'loop appends each item along the same row');
    return 'PASS row/column delivery, reruns, recovery before/after save, insert/delete, mixed tables, sessions, copy, reserved cells';
  }));
  await page.evaluate(async () => {
    const s = window.snapshot(), base = s.nodes[0];
    s.nodes = [{ ...base, id: 'ui-card', kind: 'note', role: null, assetId: null, x: 500, y: 80, width: 500, height: 300,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], cells: [[{ id: 'u-a', text: '' }, { id: 'u-b', text: '' }], [{ id: 'u-c', text: '' }, { id: 'u-d', text: '' }]] }) }];
    sessionStorage.setItem('reference-fixture', JSON.stringify(s));
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const c = canvasWorkflowController('p'); await c.load();
    await c.edit([{ ...newWorkflowNode('skill', 20, 80, ''), id: 'ui-source', outputs: { image: { type: 'image', assetIds: ['a', 'b', 'c'] } } }]);
  });
  await page.reload();
  const card = page.locator('[data-canvas-node-id="ui-card"]'); await card.waitFor();
  await page.getByRole('button', { name: '适应内容', exact: true }).click();
  assert.equal(await card.locator('[data-workflow-text-input=""]').count(), 0);
  assert.equal(await card.locator('.workflow-axis-input').count(), 8);
  const source = page.locator('[data-workflow-card="ui-source"]');
  await source.getByRole('button', { name: '输出：图片', exact: true }).click();
  await card.hover(); await card.getByRole('button', { name: '第 2 行图片输入', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-canvas-node-id="ui-card"] .canvas-image-content img').length === 3);
  assert.equal(await card.getByRole('row').count(), 2);
  await card.hover();
  for (const port of await card.locator('.workflow-axis-input').all()) {
    assert.ok(await port.evaluate(e => { const r = e.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === e; }), 'axis socket unobstructed');
  }
  await page.screenshot({ path: '.tmp/workflow/content-axis-inputs.png' });
  await page.evaluate(() => window.save());
  await page.reload(); await card.waitFor(); await card.hover();
  assert.equal(await page.locator('path[data-workflow-text-link]').count(), 1);
  await card.getByRole('button', { name: '第 2 行图片输入', exact: true }).click({ button: 'right' });
  await page.waitForFunction(() => !JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.some(n => n.textTarget));
  await page.waitForFunction(() => document.querySelectorAll('[data-canvas-node-id="ui-card"] .canvas-image-content img').length === 3);
  console.log('PASS axis sockets, pointer connection, expansion, hit targets, persisted wire and disconnect');
} finally { await browser.close(); await server.close(); }
