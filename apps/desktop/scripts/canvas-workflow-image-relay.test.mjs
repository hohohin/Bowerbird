import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1697, strictPort: true, hmr: false, watch: null } });
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
    const expectError = async promise => { let rejected = false; try { await promise; } catch { rejected = true; } check(rejected, 'expected rejection'); };
    const base = window.snapshot().nodes[0];
    const table = id => window.snapshot().nodes.find(node => node.id === id && node.hiddenAt == null);
    const draw = () => ({ ...newWorkflowNode('generation', 20, 200, 'codex'), id: 'draw', prompt: '画产品' });
    const sink = id => ({ ...newWorkflowNode('instruction', 900, 200, ''), id, action: 'reuse' });
    const setup = async (nodes = [draw(), sink('sink')]) => {
      const c = new CanvasWorkflowController('relay-' + crypto.randomUUID()); await c.load(); await c.edit(nodes); return c;
    };
    useStore.setState({ cloudEntitlement: { policy: { can_use_byo: true, max_parallel_jobs: 100 } } });
    let c = await setup();
    let first = await c.connectGenerationImage('draw', 'sink', 'image');
    const writer = c.document.nodes.find(node => node.textTarget?.nodeId === first.node.id);
    check(first.created && readCanvasNote(first.node).cells.length === 1 && writer.textTarget.append, 'new empty history card and append writer');
    check(c.document.nodes.find(node => node.id === 'sink').inputs.image[0].cellId === '*latest-image', 'consumer follows latest row');
    check(!first.before.nodes.some(node => node.id === writer.id) && first.after.nodes.some(node => node.id === writer.id), 'undo captures exact mutation');
    const again = await c.connectGenerationImage('draw', 'sink', 'image');
    check(!again.created && again.node.id === first.node.id && c.document.nodes.filter(node => node.textTarget).length === 1, 'duplicate wire is idempotent');
    await c.edit([...c.document.nodes, sink('other')]);
    const other = await c.connectGenerationImage('draw', 'other', 'image');
    check(!other.created && other.node.id === first.node.id, 'one source shares one automatic history card');
    // Each delivery stores a fresh row; a consumer reads the final row without replaying the generator.
    let consumed;
    api.generationHistory = async id => { consumed = id; return { turns: [{ prompt: `from ${id}` }], references: [] }; };
    for (const assetId of ['a', 'b']) {
      await c.edit(c.document.nodes.map(node => node.id === 'draw' ? { ...node, outputs: { image: { type: 'image', assetIds: [assetId] } } } : node));
      await c.start(writer.id, true);
      check(c.document.run.status === 'done', JSON.stringify(c.issue));
    }
    const note = readCanvasNote(table(first.node.id));
    check(note.cells.length === 2 && note.cells[0][0].image_refs[0].asset_id === 'a' && note.cells[1][0].image_refs[0].asset_id === 'b', 'rerun appends and retains earlier image');
    await c.start('sink', true);
    check(c.document.run.status === 'done' && consumed === 'b', 'consumer receives latest saved row');
    c = new CanvasWorkflowController(c.projectId); await c.load();
    check((await c.connectGenerationImage('draw', 'sink', 'image')).node.id === first.node.id, 'reload preserves and reuses relay');
    check(canvasInputValue(table(first.node.id), '*latest-image', window.snapshot().nodes).assetIds.join() === 'b', 'reload latest value');
    // Replacing a legacy direct input retains its numbered pipe and active reference.
    const binding = { nodeId: 'draw', portId: 'image', slot: 3 };
    const generation = { ...draw(), id: 'consumer', x: 900, prompt: '使用 @[ref]', inputs: { image: [{ assetId: 'a' }, { assetId: 'b' }, binding] }, promptReferences: [{ id: 'ref', type: 'image', slot: 3, label: '图片来源 3', input: binding }] };
    c = await setup([draw(), generation]);
    const migrated = await c.connectGenerationImage('draw', 'consumer', 'image');
    const updated = c.document.nodes.find(node => node.id === 'consumer');
    check(updated.inputs.image.length === 3 && updated.inputs.image[2].slot === 3 && updated.promptReferences[0].input.canvasNodeId === migrated.node.id, 'slot and @ binding survive relay insertion');
    // Revision/native failures leave neither half persisted; explicit retry uses the same identity.
    for (const fault of ['failWorkflowSave', 'failNodeSave']) {
      c = await setup(); const before = await api.canvasWorkflowGet(c.projectId); const count = window.snapshot().nodes.length;
      window[fault] = true; await expectError(c.connectGenerationImage('draw', 'sink', 'image')); window[fault] = false;
      check(window.snapshot().nodes.length === count && (await api.canvasWorkflowGet(c.projectId)).revision === before.revision, 'failed atomic save has no native/workflow half');
      const pendingId = c.document.nodes.find(node => node.textTarget).textTarget.nodeId;
      await c.retrySave();
      check(table(pendingId) && (await api.canvasWorkflowGet(c.projectId)).document.nodes.some(node => node.textTarget?.nodeId === pendingId), 'retry commits both halves with original identity');
      const reload = new CanvasWorkflowController(c.projectId); await reload.load();
      check((await reload.connectGenerationImage('draw', 'sink', 'image')).node.id === pendingId, 'retry then reload still deduplicates');
    }
    c = await setup(); const count = window.snapshot().nodes.length;
    const locked = c.isLocked; c.isLocked = id => id === 'draw';
    await expectError(c.connectGenerationImage('draw', 'sink', 'image')); c.isLocked = locked;
    check(window.snapshot().nodes.length === count, 'locked source creates nothing');
    const circular = { ...draw(), prompt: '使用 @[text]', inputs: { text: [{ nodeId: 'sink', portId: 'text' }] }, promptReferences: [{ id: 'text', type: 'text', label: '文本 1', input: { nodeId: 'sink', portId: 'text' } }] };
    await c.edit([circular, sink('sink')]);
    await expectError(c.connectGenerationImage('draw', 'sink', 'image'));
    check(window.snapshot().nodes.length === count, 'cycle creates nothing');
    await c.edit([{ ...draw(), generation: { media: 'video' } }, sink('sink')]);
    await expectError(c.connectGenerationImage('draw', 'sink', 'image'));
    // Pending sessions remain cells; downstream image and latest-text consumers wait for actual pixels.
    c = await setup(); let sessionId = 'pending-' + crypto.randomUUID(), jobId = crypto.randomUUID();
    await api.projectCanvasNodeCreate({ ...base, id: sessionId, projectId: c.projectId, kind: 'prompt', assetId: null, role: null,
      payloadJson: JSON.stringify({ schema_version: 1, status: 'running', job_id: jobId, turn_key: 'one' }) });
    await c.edit(c.document.nodes.map(node => node.id === 'draw' ? { ...node, outputs: { image: { type: 'image', nodeIds: [sessionId] } } } : node));
    const pending = await c.connectGenerationImage('draw', 'sink', 'image');
    consumed = undefined; const waiting = c.start('sink', true);
    await waitFor(() => c.document.run?.steps.sink?.detail === '等待上游生成图片');
    check(!consumed && readCanvasNote(table(pending.node.id)).cells[0][0].generation_ref.session_node_id === sessionId, 'waiting consumer does not erase pending cell');
    const appendSession = async () => {
      const id = 'pending-' + crypto.randomUUID(), job = crypto.randomUUID();
      await api.projectCanvasNodeCreate({ ...base, id, projectId: c.projectId, kind: 'prompt', assetId: null, role: null,
        payloadJson: JSON.stringify({ schema_version: 1, status: 'running', job_id: job, turn_key: 'one' }) });
      const note = readCanvasNote(table(pending.node.id));
      await api.projectCanvasNoteUpdate(pending.node.id, JSON.stringify({ ...note, cells: [...note.cells, [{ ...note.cells[0][0], id: crypto.randomUUID(), text: '', image_refs: [], generation_ref: { session_node_id: id } }]] }));
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
    const textWriter = { ...newWorkflowNode('text', 0, 0, ''), id: 'text-writer', inputs: { text: [{ canvasNodeId: pending.node.id, cellId: '*latest' }] }, textTarget: { nodeId: textReceiver.id, cellId: 'text-target' } };
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
    const rows = { ...newWorkflowNode('loop', 0, 0, ''), id: 'rows', loopMode: 'rows', inputs: { text: [{ canvasNodeId: pending.node.id, cellId: '*latest' }] } };
    const rowSink = { ...sink('row-sink'), inputs: { image: [{ nodeId: 'rows', portId: 'image' }] } };
    await c.edit([...c.document.nodes, rows, rowSink]);
    const rowsWaiting = c.start('rows');
    await waitFor(() => c.document.run?.steps.rows?.detail === '等待上游生成图片');
    await api.projectCanvasNodeCreate({ ...base, id: 'result-' + crypto.randomUUID(), projectId: c.projectId, assetId: 'a', role: 'output', payloadJson: JSON.stringify({ execution: { job_id: fourth.job, turn_key: 'one' } }) });
    await api.projectCanvasNodeUpdate(fourth.id, { payloadJson: JSON.stringify({ status: 'done', job_id: fourth.job, turn_key: 'one' }) });
    await rowsWaiting;
    check(c.document.run.status === 'done' && c.document.run.loop.completed.length === 1 && consumed === 'a', 'latest row loop waits then reads a single resolved row');
    const fifth = await appendSession();
    const imageWriter = { ...textWriter, id: 'image-writer', inputs: { image: [{ canvasNodeId: pending.node.id, cellId: '*latest-image' }] }, textTarget: { ...textWriter.textTarget, image: true } };
    await c.edit([...c.document.nodes.filter(node => node.id !== 'text-writer'), imageWriter]);
    await Promise.race([c.start('image-writer', true), new Promise((_, reject) => setTimeout(() => reject(Error('image writer waited for pixels')), 2000))]);
    check(c.document.run.status === 'done' && readCanvasNote(table(textReceiver.id)).cells[0][0].generation_ref?.session_node_id === fifth.id, 'latest image writer stores pending session immediately');
    consumed = undefined; const emptyWaiting = c.start('sink', true);
    await waitFor(() => c.document.run?.steps.sink?.detail === '等待上游生成图片');
    const beforeEmpty = readCanvasNote(table(pending.node.id));
    await api.projectCanvasNoteUpdate(pending.node.id, JSON.stringify({ ...beforeEmpty, cells: [...beforeEmpty.cells, [{ id: crypto.randomUUID(), text: '', content_type: 'text' }]] }));
    await emptyWaiting;
    check(c.document.run.status === 'failed' && !consumed, 'a new empty last row errors instead of falling back to previous images');
    // A queued, older edit must never borrow a later relay creation payload.
    c = await setup();
    const originalGet = api.projectCanvasGet, originalSave = api.canvasWorkflowSave;
    let enterGet, releaseGet, releaseSave, held = false;
    const reachedGet = new Promise(resolve => { enterGet = resolve; });
    const getGate = new Promise(resolve => { releaseGet = resolve; });
    const saveGate = new Promise(resolve => { releaseSave = resolve; });
    const records = [];
    api.projectCanvasGet = async projectId => { if (projectId === c.projectId && !held) { held = true; enterGet(); await getGate; } return originalGet(projectId); };
    const connecting = c.connectGenerationImage('draw', 'sink', 'image'); await reachedGet;
    api.canvasWorkflowSave = async (...args) => { records.push(args); if (records.length === 1) await saveGate; return originalSave(...args); };
    const editA = c.edit(c.document.nodes.map(node => node.id === 'sink' ? { ...node, prompt: 'A' } : node));
    const editB = c.edit(c.document.nodes.map(node => node.id === 'sink' ? { ...node, prompt: 'B' } : node));
    releaseGet(); await waitFor(() => c.document.nodes.some(node => node.textTarget)); releaseSave();
    await Promise.all([editA, editB, connecting]);
    api.projectCanvasGet = originalGet; api.canvasWorkflowSave = originalSave;
    check(records.length === 3 && !records[0][3] && !records[1][3] && records[2][3], 'native payload belongs only to its own queued snapshot');
    check(c.document.nodes.find(node => node.id === 'sink').prompt === 'B', 'concurrent unrelated definition edit is retained');
    return 'PASS: atomic creation/retry, existing output seed, repeat/reload reuse, slot references, append/latest output, pending image/text wait, locks/cycles and concurrent saves';
  });
  assert.match(result, /^PASS:/); console.log(result);
} finally { await browser.close(); await server.close(); }
