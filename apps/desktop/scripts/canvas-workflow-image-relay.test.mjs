import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ root: process.cwd(), cacheDir: '.tmp/legacy-image-relay-vite', optimizeDeps: { entries: ['scripts/fixtures/canvas-reference/preview.html'] }, server: { host: '127.0.0.1', port: 1697, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
try {
  await page.goto('http://127.0.0.1:1697/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  const result = await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { readCanvasNote } = await import('/src/lib/canvasNotes.ts');
    const { canvasInputValue } = await import('/src/lib/canvasSessionOutputs.ts');
    const { useStore } = await import('/src/store.ts');
    const check = (ok, message) => { if (!ok) throw Error(message); };
    const waitFor = async predicate => { for (let n = 0; n < 600; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('timed out'); };
    const base = window.snapshot().nodes[0];
    const table = id => window.snapshot().nodes.find(node => node.id === id && node.hiddenAt == null);
    const draw = () => ({ ...newWorkflowNode('generation', 20, 200, 'codex'), id: 'draw', prompt: '画产品' });
    const sink = id => ({ ...newWorkflowNode('instruction', 900, 200, ''), id, action: 'reuse' });
    // Existing projects can contain this native table, hidden writer and latest-row binding.
    const c = new CanvasWorkflowController('legacy-relay'); await c.load();
    const tableId = 'historical-results';
    const cell = { id: 'first-image', content_type: 'image', text: '' };
    await api.projectCanvasNodeCreate({ ...base, projectId: c.projectId, id: tableId, kind: 'note', assetId: null, role: null,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], cells: [[cell]] }) });
    const writer = { ...newWorkflowNode('text', 450, 200, ''), id: 'historical-writer',
      textTarget: { nodeId: tableId, cellId: cell.id, append: true, image: true, automaticImageRelay: true },
      inputs: { image: [{ nodeId: 'draw', portId: 'image' }] } };
    const consumer = { ...sink('sink'), inputs: { image: [{ canvasNodeId: tableId, cellId: '*latest-image' }] } };
    await c.edit([draw(), writer, consumer]);
    useStore.setState({ cloudEntitlement: { policy: { can_use_byo: true, max_parallel_jobs: 100 } } });
    // Each delivery stores a fresh row; a consumer reads the final row without replaying the generator.
    let consumed;
    api.generationHistory = async id => { consumed = id; return { turns: [{ prompt: `from ${id}` }], references: [] }; };
    for (const assetId of ['a', 'b']) {
      await c.edit(c.document.nodes.map(node => node.id === 'draw' ? { ...node, outputs: { image: { type: 'image', assetIds: [assetId] } } } : node));
      await c.start(writer.id, true);
      check(c.document.run.status === 'done', JSON.stringify(c.issue));
    }
    const note = readCanvasNote(table(tableId));
    check(note.cells.length === 2 && note.cells[0][0].image_refs[0].asset_id === 'a' && note.cells[1][0].image_refs[0].asset_id === 'b', 'rerun appends and retains earlier image');
    await c.start('sink', true);
    check(c.document.run.status === 'done' && consumed === 'b', 'consumer receives latest saved row');
    const reload = new CanvasWorkflowController(c.projectId); await reload.load();
    check(reload.document.nodes.find(node => node.id === 'sink').inputs.image[0].canvasNodeId === tableId, 'reload preserves original table binding');
    check(canvasInputValue(table(tableId), '*latest-image', window.snapshot().nodes).assetIds.join() === 'b', 'reload latest value');
    // Pending sessions remain cells; downstream image and latest-text consumers wait for actual pixels.
    let sessionId = 'pending-' + crypto.randomUUID(), jobId = crypto.randomUUID();
    await api.projectCanvasNodeCreate({ ...base, id: sessionId, projectId: c.projectId, kind: 'prompt', assetId: null, role: null,
      payloadJson: JSON.stringify({ schema_version: 1, status: 'running', job_id: jobId, turn_key: 'one' }) });
    await c.edit(c.document.nodes.map(node => node.id === 'draw' ? { ...node, outputs: { image: { type: 'image', nodeIds: [sessionId] } } } : node));
    await c.start(writer.id, true);
    consumed = undefined; const waiting = c.start('sink', true);
    await waitFor(() => c.document.run?.steps.sink?.detail === '等待上游生成图片');
    check(!consumed && readCanvasNote(table(tableId)).cells.at(-1)[0].generation_ref.session_node_id === sessionId, 'waiting consumer does not erase pending cell');
    const appendSession = async () => {
      const id = 'pending-' + crypto.randomUUID(), job = crypto.randomUUID();
      await api.projectCanvasNodeCreate({ ...base, id, projectId: c.projectId, kind: 'prompt', assetId: null, role: null,
        payloadJson: JSON.stringify({ schema_version: 1, status: 'running', job_id: job, turn_key: 'one' }) });
      const note = readCanvasNote(table(tableId));
      await api.projectCanvasNoteUpdate(tableId, JSON.stringify({ ...note, cells: [...note.cells, [{ ...note.cells[0][0], id: crypto.randomUUID(), text: '', image_refs: [], generation_ref: { session_node_id: id } }]] }));
      return { id, job };
    };
    const second = await appendSession(); sessionId = second.id; jobId = second.job;
    await api.projectCanvasNodeCreate({ ...base, id: 'result-' + crypto.randomUUID(), projectId: c.projectId, assetId: 'c', role: 'output', payloadJson: JSON.stringify({ execution: { job_id: jobId, turn_key: 'one' } }) });
    await api.projectCanvasNodeUpdate(sessionId, { payloadJson: JSON.stringify({ status: 'done', job_id: jobId, turn_key: 'one' }) });
    await waiting;
    check(c.document.run.status === 'done' && consumed === 'c', 'latest image follows appended session without waiting for old row to finish');
    const textReceiver = { ...base, id: 'text-receiver-' + crypto.randomUUID(), projectId: c.projectId, kind: 'note', role: null, assetId: null,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', cells: [[{ id: 'text-target', text: '' }]], text: '', member_ids: [] }) };
    await api.projectCanvasNodeCreate(textReceiver);
    await api.projectCanvasNodeUpdate(sessionId, { payloadJson: JSON.stringify({ status: 'running', job_id: jobId, turn_key: 'one' }) });
    // Hide the former output so this is genuinely a pending source again.
    const output = window.snapshot().nodes.find(node => node.role === 'output' && JSON.parse(node.payloadJson).execution?.job_id === jobId);
    await api.projectCanvasNodeRemove(output.id);
    const textWriter = { ...newWorkflowNode('text', 0, 0, ''), id: 'text-writer', inputs: { text: [{ canvasNodeId: tableId, cellId: '*latest' }] }, textTarget: { nodeId: textReceiver.id, cellId: 'text-target' } };
    await c.edit([...c.document.nodes, textWriter]);
    const textWaiting = c.start('text-writer', true);
    await waitFor(() => c.document.run?.steps['text-writer']?.detail === '等待上游生成图片');
    const third = await appendSession();
    await api.projectCanvasNodeCreate({ ...base, id: 'result-' + crypto.randomUUID(), projectId: c.projectId, assetId: 'd', role: 'output', payloadJson: JSON.stringify({ execution: { job_id: jobId, turn_key: 'one' } }) });
    await api.projectCanvasNodeUpdate(sessionId, { payloadJson: JSON.stringify({ status: 'done', job_id: jobId, turn_key: 'one' }) });
    await new Promise(resolve => setTimeout(resolve, 1600));
    check(c.document.run.steps['text-writer'].status !== 'done', 'latest text still waits for newly appended pending row');
    await api.projectCanvasNodeCreate({ ...base, id: 'result-' + crypto.randomUUID(), projectId: c.projectId, assetId: 'b', role: 'output', payloadJson: JSON.stringify({ execution: { job_id: third.job, turn_key: 'one' } }) });
    await api.projectCanvasNodeUpdate(third.id, { payloadJson: JSON.stringify({ status: 'done', job_id: third.job, turn_key: 'one' }) });
    await textWaiting;
    check(c.document.run.status === 'done' && readCanvasNote(table(textReceiver.id)).cells[0][0].image_refs?.[0]?.asset_id === 'b', 'latest text re-reads newest row and its exact image refs after waiting');
    const fourth = await appendSession();
    const rows = { ...newWorkflowNode('loop', 0, 0, ''), id: 'rows', loopMode: 'rows', inputs: { text: [{ canvasNodeId: tableId, cellId: '*latest' }] } };
    const rowSink = { ...sink('row-sink'), inputs: { image: [{ nodeId: 'rows', portId: 'image' }] } };
    await c.edit([...c.document.nodes, rows, rowSink]);
    const rowsWaiting = c.start('rows');
    await waitFor(() => c.document.run?.steps.rows?.detail === '等待上游生成图片');
    await api.projectCanvasNodeCreate({ ...base, id: 'result-' + crypto.randomUUID(), projectId: c.projectId, assetId: 'a', role: 'output', payloadJson: JSON.stringify({ execution: { job_id: fourth.job, turn_key: 'one' } }) });
    await api.projectCanvasNodeUpdate(fourth.id, { payloadJson: JSON.stringify({ status: 'done', job_id: fourth.job, turn_key: 'one' }) });
    await rowsWaiting;
    check(c.document.run.status === 'done' && c.document.run.loop.completed.length === 1 && consumed === 'a', 'latest row loop waits then reads a single resolved row');
    const fifth = await appendSession();
    const imageWriter = { ...textWriter, id: 'image-writer', inputs: { image: [{ canvasNodeId: tableId, cellId: '*latest-image' }] }, textTarget: { ...textWriter.textTarget, image: true } };
    await c.edit([...c.document.nodes.filter(node => node.id !== 'text-writer'), imageWriter]);
    await Promise.race([c.start('image-writer', true), new Promise((_, reject) => setTimeout(() => reject(Error('image writer waited for pixels')), 2000))]);
    check(c.document.run.status === 'done' && readCanvasNote(table(textReceiver.id)).cells[0][0].generation_ref?.session_node_id === fifth.id, 'latest image writer stores pending session immediately');
    consumed = undefined; const emptyWaiting = c.start('sink', true);
    await waitFor(() => c.document.run?.steps.sink?.detail === '等待上游生成图片');
    const beforeEmpty = readCanvasNote(table(tableId));
    await api.projectCanvasNoteUpdate(tableId, JSON.stringify({ ...beforeEmpty, cells: [...beforeEmpty.cells, [{ id: crypto.randomUUID(), text: '', content_type: 'text' }]] }));
    await emptyWaiting;
    check(c.document.run.status === 'failed' && !consumed, 'a new empty last row errors instead of falling back to previous images');
    return 'PASS: historical image relay survives reload, appends reruns and follows the latest pending image and text';
  });
  assert.match(result, /^PASS:/); console.log(result);
} finally { await browser.close(); await server.close(); }
