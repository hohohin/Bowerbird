import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

// Exercise the native-session event before the workflow's submission receipt,
// then pause the actual cell write. No real provider or user library is used.
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: '.tmp/contained-generation-vite', optimizeDeps: { entries: ['scripts/fixtures/canvas-reference/preview.html'] }, server: { host: '127.0.0.1', port: 1699, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const failures = [], observations = [];
try {
  for (const mode of ['none', 'cell', 'column', 'row', 'relay', 'completion']) {
    const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:1699/scripts/fixtures/canvas-reference/preview.html');
    await page.locator('[data-canvas-node-id="old"]').waitFor();
    await page.evaluate(async mode => {
      const { api } = await import('/src/lib/api.ts');
      const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
      const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
      const c = canvasWorkflowController('p'); await c.load();
      const draw = { ...newWorkflowNode('generation', 80, 100, 'codex'), id: 'draw', prompt: '生成合成测试图片' };
      await c.edit([draw, ...(mode === 'relay' ? [{ ...newWorkflowNode('instruction', 1250, 100, ''), id: 'sink', action: 'reuse' }] : [])]);
      if (mode === 'relay') window.receiverId = (await c.connectGenerationImage('draw', 'sink', 'image')).node.id;
      else if (mode !== 'none') {
        const base = window.snapshot().nodes[0];
        window.receiverId = 'receiver';
        await api.projectCanvasNodeCreate({ ...base, id: 'receiver', kind: 'note', assetId: null, role: null, x: 650, y: 90, width: 360, height: 280,
          payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], cells: [[{ id: 'cell', text: '' }]] }) });
        await c.bindTextInput('receiver', mode === 'column' || mode === 'row' ? `${mode}:cell` : 'cell', { nodeId: 'draw', portId: 'image' }, 'image');
      }
      if (mode === 'completion') await c.edit([...c.document.nodes,
        { ...newWorkflowNode('trigger', 1250, 100, ''), id: 'on-complete', inputs: { completion: [{ nodeId: 'draw', portId: 'image' }] } },
        { ...newWorkflowNode('instruction', 1250, 550, ''), id: 'after-complete', action: 'reuse', inputs: { signal: [{ nodeId: 'on-complete', portId: 'signal' }], image: [{ assetId: 'a' }] } },
      ]);
      const graph = window.snapshot(); graph.nodes = graph.nodes.filter(node => node.id === window.receiverId);
      graph.edges = []; graph.groups = []; graph.groupItems = [];
      graph.view = { ...graph.view, zoom: .85, panX: 50, panY: 50 };
      sessionStorage.setItem('reference-fixture', JSON.stringify(graph));
      sessionStorage.setItem('contained-mode', mode);
    }, mode);
    await page.reload(); await page.locator('[data-workflow-card="draw"]').waitFor();
    await page.evaluate(async () => {
      const { api } = await import('/src/lib/api.ts');
      const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
      const { useStore } = await import('/src/store.ts');
      const c = canvasWorkflowController('p');
      window.sessions = []; window.appeared = []; window.writePaused = false;
      const watch = () => {
        for (const card of document.querySelectorAll('.canvas-prompt-node[data-canvas-node-id]')) if (card.dataset.canvasNodeId.startsWith('gen-prompt:') && !window.appeared.includes(card.dataset.canvasNodeId)) window.appeared.push(card.dataset.canvasNodeId);
      };
      new MutationObserver(watch).observe(document.body, { childList: true, subtree: true });
      useStore.setState({ cloudEntitlement: { balances: { daily: 0, sub: 0, topup: 0 }, policy: { can_use_byo: true, can_use_cloud: true, max_parallel_jobs: 100 } } });
      const update = api.projectCanvasNoteUpdate;
      const pausedSessions = new Set();
      api.projectCanvasNoteUpdate = async (id, json) => {
        const incoming = JSON.parse(json).cells.flat().map(cell => cell.generation_ref?.session_node_id).find(id => id && !pausedSessions.has(id));
        if (incoming) {
          pausedSessions.add(incoming);
          window.writePaused = true;
          await new Promise(resolve => { window.releaseWrite = resolve; });
        }
        return update(id, json);
      };
      api.localAgentFindAssetId = async () => 'b';
      api.codexCreateImage = async args => {
        const id = `gen-prompt:${args.jobId}:${args.turnKey}:0`;
        await api.projectCanvasNodeCreate({ id, projectId: 'p', threadId: 't', kind: 'prompt', role: null, assetId: null, hiddenAt: null,
          x: 1050, y: 450, width: 300, height: 220, zIndex: 1, positionLocked: false, createdAt: 10, updatedAt: 10,
          payloadJson: JSON.stringify({ schema_version: 1, job_id: args.jobId, turn_key: args.turnKey, text: args.prompt, status: 'running', provider: args.provider }) });
        const native = { id, args }; window.sessions.push(native); window.emitChange();
        await new Promise(resolve => { window.releaseStarted = resolve; });
        useStore.getState().applyGenChunk({ kind: 'started', job_id: args.jobId });
        await new Promise(resolve => { native.release = resolve; });
        return 'mock-provider-session';
      };
      window.completeSession = async () => {
        const { id, args, release } = window.sessions.at(-1);
        const node = window.snapshot().nodes.find(node => node.id === id);
        await api.projectCanvasNodeUpdate(id, { payloadJson: JSON.stringify({ ...JSON.parse(node.payloadJson), status: 'done' }) });
        await api.projectCanvasNodeCreate({ ...node, id: `gen-output:${args.jobId}:${args.turnKey}:0`, kind: 'asset', role: 'output', assetId: 'b',
          payloadJson: JSON.stringify({ execution: { job_id: args.jobId, turn_key: args.turnKey } }) });
        useStore.setState(state => ({ genJobs: { ...state.genJobs, [args.jobId]: { ...state.genJobs[args.jobId], running: false } } }));
        window.emitChange(); release();
      };
      window.start = () => { window.writePaused = false; window.run = c.start('draw', true); };
      window.start();
    });
    const inspect = async phase => {
      // Hold each IPC boundary long enough for the creative://changed refresh.
      await page.waitForTimeout(200);
      const data = await page.evaluate(() => ({ sessions: window.sessions.map(session => session.id), visible: [...document.querySelectorAll('.canvas-prompt-node[data-canvas-node-id]')].map(node => node.dataset.canvasNodeId), embedded: [...document.querySelectorAll('[data-cell-generation]')].map(node => node.dataset.cellGeneration) }));
      const outside = data.sessions.filter(id => data.visible.includes(id));
      observations.push({ mode, phase, outside: outside.length, embedded: data.embedded.length });
      if ((mode === 'none' ? outside.length !== data.sessions.length : outside.length !== 0)) failures.push(`${mode}/${phase}: ${outside.length} standalone sessions`);
      return data;
    };
    const runOnce = async (iteration, start = false) => {
      if (start) await page.evaluate(() => window.start());
      try { await page.waitForFunction(count => window.sessions.length === count && window.releaseStarted, iteration); }
      catch (error) { throw new Error(`${mode}/run-${iteration}: ${JSON.stringify(await page.evaluate(() => ({ workflow: JSON.parse(sessionStorage.getItem('workflow-p')).document, sessions: window.sessions.map(session => session.id) })))}`, { cause: error }); }
      await inspect(`before-started-${iteration}`);
      await page.evaluate(() => window.releaseStarted());
      if (mode !== 'none') {
        let paused = true;
        try { await page.waitForFunction(() => window.writePaused, null, { timeout: 2500 }); } catch { paused = false; failures.push(`${mode}: pending session not delivered before completion`); }
        await inspect(`before-cell-write-${iteration}`);
        if (paused) {
          await page.evaluate(() => window.releaseWrite());
          await page.locator(`[data-cell-generation="${(await page.evaluate(() => window.sessions.at(-1).id))}"]`).waitFor();
          await inspect(`pending-in-cell-${iteration}`);
        }
        await page.evaluate(() => window.completeSession());
        if (!paused) { await page.waitForFunction(() => window.writePaused); await page.evaluate(() => window.releaseWrite()); }
      } else await page.evaluate(() => window.completeSession());
      await page.evaluate(() => window.run);
      await inspect(`completed-${iteration}`);
    };
    await runOnce(1);
    if (mode === 'cell') await runOnce(2, true);
    const appeared = await page.evaluate(() => window.appeared);
    if (mode !== 'none' && appeared.length) failures.push(`${mode}: ${appeared.length} sessions flashed outside during delivery`);
    await page.evaluate(() => window.save()); await page.reload(); await page.locator('[data-workflow-card="draw"]').waitFor();
    const persistedSessions = await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'draw').sessionNodeIds);
    for (const id of persistedSessions) {
      const count = await page.locator(`.canvas-prompt-node[data-canvas-node-id="${id}"]`).count();
      if (count !== (mode === 'none' ? 1 : 0)) failures.push(`${mode}/reload: unexpected standalone ${id}`);
    }
    await page.locator('[data-workflow-card="draw"]').getByRole('button', { name: '生成历史', exact: true }).click();
    assert.equal(await page.locator('[data-workflow-history-session]').count(), persistedSessions.length, 'all executions remain accessible through generation history');
    await page.keyboard.press('Escape');
    if (mode === 'cell') {
      const origin = await page.evaluate(async sessionId => {
        const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
        const { newWorkflowNode, workflowCardWidth, workflowPortY } = await import('/src/lib/canvasWorkflow.ts');
        const c = canvasWorkflowController('p'), draw = c.document.nodes.find(node => node.id === 'draw');
        await c.edit([...c.document.nodes, { ...newWorkflowNode('instruction', 1250, 650, ''), id: 'old-session-consumer', action: 'reuse', inputs: { image: [{ canvasNodeId: sessionId, cellId: 'image' }] } }]);
        return `M ${draw.x + workflowCardWidth(draw)} ${workflowPortY(draw, 'output', 'image')} C `;
      }, persistedSessions[0]);
      const oldSessionWire = page.locator('[data-workflow-target="old-session-consumer"]'); await oldSessionWire.waitFor();
      assert.ok((await oldSessionWire.getAttribute('d')).startsWith(origin), 'an old session reference anchors at the visible generator instead of a hidden card');
      await page.evaluate(async () => {
        const { api } = await import('/src/lib/api.ts');
        const table = window.snapshot().nodes.find(node => node.id === 'receiver'), note = JSON.parse(table.payloadJson);
        note.cells = note.cells.map(row => row.map(cell => ({ ...cell, text: '', image_refs: [], generation_ref: undefined })));
        await api.projectCanvasNoteUpdate(table.id, JSON.stringify(note)); window.emitChange();
      });
      await page.waitForTimeout(200);
      assert.equal(await page.locator('.canvas-prompt-node').count(), 0, 'clearing a cell keeps routed sessions in generation history while the wire remains');
      await page.evaluate(async () => {
        const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
        const c = canvasWorkflowController('p'); await c.edit(c.document.nodes.filter(node => !node.textTarget));
      });
      for (const id of persistedSessions) await page.locator(`.canvas-prompt-node[data-canvas-node-id="${id}"]`).waitFor();
    }
    if (mode === 'row') {
      await page.evaluate(async () => {
        const { api } = await import('/src/lib/api.ts'); await api.projectCanvasNodeRemove('receiver'); window.emitChange();
      });
      for (const id of persistedSessions) await page.locator(`.canvas-prompt-node[data-canvas-node-id="${id}"]`).waitFor();
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(JSON.stringify(observations));
  assert.deepEqual(failures, [], 'connected content owns session presentation throughout submission, delivery, rerun and reload');
  console.log('PASS contained generation: standalone control, cell/row/column/relay, pre-started and delivery boundaries, pending completion trigger, rerun history, old-reference wire, clear/disconnect/remove and reload');
} finally { await browser.close(); await server.close(); }
