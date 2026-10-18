import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1684, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
try {
  await page.goto('http://127.0.0.1:1684/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  console.log(await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { CanvasWorkflowController, canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { readCanvasNote } = await import('/src/lib/canvasNotes.ts');
    const { hiddenWorkflowSessionIds, resolveGenerationCells } = await import('/src/lib/canvasSessionOutputs.ts');
    const { useStore } = await import('/src/store.ts');
    const check = (ok, message) => { if (!ok) throw Error(message); };
    const bounded = promise => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Error('workflow waited for background generation')), 6000))]);
    const base = window.snapshot().nodes[0], pending = [], jobs = new Map(), calls = [];
    let c, rejectSubmit = false, cancelled = [];
    useStore.setState({ cloudEntitlement: { balances: { daily: 0, sub: 0, topup: 0 }, policy: { can_use_byo: true, can_use_cloud: true, max_parallel_jobs: 100 } } });
    api.agentDsWorkflowGenerationJob = async (jobId, turnKey) => jobs.get(jobId)?.turnKey === turnKey ? jobs.get(jobId) : null;
    api.cancelCodexCreate = async id => { cancelled.push(id); };
    api.codexCreateImage = async args => {
      calls.push(args);
      const step = Object.values(c.document.run.steps).find(step => step.jobId === args.jobId);
      check(step?.generationSubmission === 'pending' && step.turnKey === args.turnKey, 'submission identity must be durable before IPC');
      check(!args.internalAgent && args.conversationId === args.jobId, 'use ordinary independent generation session');
      if (rejectSubmit) throw Error('provider rejected');
      const id = `gen-prompt:${args.jobId}:${args.turnKey}:0`;
      await api.projectCanvasNodeCreate({ ...base, id, projectId: c.projectId, kind: 'prompt', assetId: null, role: null, hiddenAt: null,
        x: 700, y: 200, width: 300, height: 240, payloadJson: JSON.stringify({ schema_version: 1, job_id: args.jobId, turn_key: args.turnKey, text: args.prompt, status: 'running', provider: args.provider }) });
      jobs.set(args.jobId, { status: 'running', images: [], turnKey: args.turnKey });
      const completion = new Promise(resolve => pending.push({ args, id, release: resolve }));
      useStore.getState().applyGenChunk({ kind: 'started', job_id: args.jobId });
      await completion;
      return 'provider-session';
    };
    const draw = provider => ({ ...newWorkflowNode('generation', 80, 100, provider), id: 'draw', prompt: '画产品', ratio: '3:4' });
    const setup = async (provider = 'codex', loop = false) => {
      c = new CanvasWorkflowController('generation-session-' + crypto.randomUUID()); await c.load();
      const node = draw(provider);
      if (loop) {
        node.inputs.image = [{ nodeId: 'loop', portId: 'image' }];
        node.prompt = '画产品 @[input]';
        node.promptReferences = [{ id: 'input', type: 'image', label: '图片来源 1', input: node.inputs.image[0] }];
      }
      await c.edit(loop ? [{ ...newWorkflowNode('loop', 0, 0, provider), id: 'loop', inputs: { image: [{ assetId: 'a' }, { assetId: 'b' }] } }, node] : [node]);
    };
    for (const provider of ['codex', 'jimeng', 'bowerbird-cloud-image_hd']) {
      await setup(provider, true);
      await bounded(c.start('loop'));
      check(c.document.run.status === 'done' && c.document.run.loop.completed.length === 2, JSON.stringify(c.issue));
      const sessions = c.document.nodes.find(n => n.id === 'draw').sessionNodeIds;
      check(sessions.length === 2 && sessions[0] !== sessions[1], 'each loop item owns an independent session');
      check(calls.slice(-2).every(call => call.provider === provider && call.ratio === '3:4' && jobs.get(call.jobId).status === 'running'), 'card provider/ratio retained and loop does not await images');
      check(!hiddenWorkflowSessionIds(c.document.nodes).size, 'image sessions must be visible');
      const before = calls.length;
      c = new CanvasWorkflowController(c.projectId); await c.load(); await c.continue();
      check(calls.length === before, 'completed reload must not resubmit');
    }
    // Submission receipt lost after the native started event: recover exact identity only.
    await setup(); await bounded(c.start('draw', true));
    const saved = structuredClone(c.document), beforeRecovery = calls.length;
    saved.run.status = 'running'; saved.run.steps.draw.status = 'running'; saved.run.steps.draw.generationSubmission = 'pending';
    saved.nodes[0].outputs = {}; saved.runs = [saved.run];
    sessionStorage.setItem('workflow-' + c.projectId, JSON.stringify({ revision: 20, document: saved }));
    c = new CanvasWorkflowController(c.projectId); await c.load(); await bounded(c.continue());
    check(c.document.run.status === 'done' && calls.length === beforeRecovery, 'interrupted submit recovers without resubmission');
    const unknown = structuredClone(saved); jobs.delete(unknown.run.steps.draw.jobId);
    sessionStorage.setItem('workflow-' + c.projectId, JSON.stringify({ revision: 21, document: unknown }));
    c = new CanvasWorkflowController(c.projectId); await c.load(); await bounded(c.continue());
    check(c.document.run.status === 'waiting' && calls.length === beforeRecovery, 'unknown submission remains parked');
    await c.stop();
    // A rejected submission has no output session value.
    await setup(); rejectSubmit = true; await bounded(c.start('draw', true)); rejectSubmit = false;
    check(c.document.run.status === 'failed' && !c.document.nodes[0].outputs.image, 'rejected request must not pretend to be submitted');

    // Real content writer receives pending session immediately; failure retries just delivery.
    await setup();
    const receiver = { ...base, id: 'session-receiver', projectId: c.projectId, kind: 'note', assetId: null, role: null, hiddenAt: null,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], cells: [[{ id: 'cell', text: '' }, { id: 'neighbor', text: '保留' }]] }) };
    await api.projectCanvasNodeCreate(receiver);
    const writer = { ...newWorkflowNode('text', 0, 0, ''), id: 'writer', textTarget: { nodeId: receiver.id, cellId: 'cell', image: true }, inputs: { image: [{ nodeId: 'draw', portId: 'image' }] } };
    await c.edit([draw('codex'), writer]);
    const update = api.projectCanvasNoteUpdate;
    api.projectCanvasNoteUpdate = async () => { throw Error('write interrupted'); };
    await bounded(c.start('draw', true));
    check(c.document.run.status === 'waiting' && c.document.run.steps.draw.status === 'done', 'delivery failure parks writer, not completed submit');
    const beforeDelivery = calls.length, sessionId = c.document.nodes[0].outputs.image.nodeIds[0];
    api.projectCanvasNoteUpdate = update;
    c = new CanvasWorkflowController(c.projectId); await c.load(); await bounded(c.continue());
    const note = readCanvasNote(window.snapshot().nodes.find(n => n.id === receiver.id));
    check(c.document.run.status === 'done' && calls.length === beforeDelivery, 'reload retries only delivery');
    check(note.cells[0][0].generation_ref?.session_node_id === sessionId && note.cells[0][1].text === '保留', 'exact pending session delivered without touching neighbor');
    const original = window.snapshot().nodes.find(n => n.id === sessionId);
    await api.projectCanvasNodeUpdate(sessionId, { payloadJson: JSON.stringify({ ...JSON.parse(original.payloadJson), status: 'done' }) });
    await api.projectCanvasNodeCreate({ ...base, id: 'session-output', projectId: c.projectId, assetId: 'b', role: 'output', hiddenAt: null,
      payloadJson: JSON.stringify({ execution: { job_id: c.document.run.steps.draw.jobId, turn_key: c.document.run.steps.draw.turnKey } }) });
    check(resolveGenerationCells(note, window.snapshot().nodes).cells[0][0].image_refs[0].asset_id === 'b', 'completed image resolves inside original cell');

    // A consuming generation must still await pixels. Stopping it leaves submitted source alive.
    await setup();
    const consumer = { ...draw('codex'), id: 'consumer', prompt: '画产品 @[input]', inputs: { image: [{ nodeId: 'draw', portId: 'image' }] },
      promptReferences: [{ id: 'input', type: 'image', label: '图片来源 1', input: { nodeId: 'draw', portId: 'image' } }] };
    await c.edit([draw('codex'), consumer]);
    const beforeChain = calls.length, chain = c.start('draw');
    while (!c.document.nodes[0].outputs.image) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 80));
    check(calls.length === beforeChain + 1, 'dependent image generation waits for source pixels');
    const sourceJob = c.document.run.steps.draw.jobId;
    await c.stop(); await bounded(chain);
    check(!cancelled.includes(sourceJob), 'submitted session continues after workflow stop');
    // Legacy running records keep their old completion-based recovery contract.
    const legacy = structuredClone(saved); delete legacy.run.steps.draw.generationSubmission; legacy.runs = [legacy.run];
    sessionStorage.setItem('workflow-legacy-generation', JSON.stringify({ revision: 1, document: legacy }));
    api.recentGenSessions = async () => [{ id: legacy.run.steps.draw.jobId, status: 'done', turns: [{ turn_key: legacy.run.steps.draw.turnKey, images: ['b.png'] }] }];
    api.localAgentFindAssetId = async () => 'b';
    const recovered = new CanvasWorkflowController('legacy-generation'); await recovered.load(); await recovered.continue();
    check(recovered.document.run.status === 'done' && recovered.document.nodes[0].outputs.image.assetIds[0] === 'b', 'legacy record still retrieves completed pixels');

    // Leave a real, pending generation card/session pair for UI assertions.
    c = canvasWorkflowController('p'); await c.load(); await c.edit([draw('codex')]);
    await bounded(c.start('draw', true));
    const uiSession = c.document.nodes[0].outputs.image.nodeIds[0];
    const snapshot = window.snapshot(); snapshot.nodes = snapshot.nodes.filter(n => n.id === 'old' || n.id === uiSession);
    snapshot.view = { ...snapshot.view, panX: 40, panY: 50, zoom: 0.8 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    for (const job of pending) job.release();
    return 'PASS: three providers, nonblocking loops, exact recovery, unknown/rejected submissions, cell delivery/retry, completion, consumer waiting, stop and legacy recovery';
  }));
  await page.reload();
  const card = page.locator('[data-workflow-card="draw"]'); await card.waitFor();
  await card.getByText('已提交生成', { exact: true }).waitFor();
  const link = page.locator('[data-workflow-session-link]'); await link.waitFor();
  const id = await link.getAttribute('data-workflow-session-link');
  await page.locator(`[data-canvas-node-id="${id}"]`).waitFor();
  assert.match(await link.getAttribute('class'), /is-image/);
  assert.equal(await page.locator('[data-workflow-generated-link]').count(), 0);
  await mkdir('.tmp/workflow', { recursive: true });
  await page.screenshot({ path: '.tmp/workflow/generation-session-aligned.png' });
  const standalonePath = await link.getAttribute('d');
  await card.getByRole('button', { name: '生成历史', exact: true }).click();
  await page.locator(`[data-workflow-history-session="${id}"]`).click();
  await page.locator('.project-inspector-shell').waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(async sessionId => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    await api.projectCanvasNodeCreate({ ...window.snapshot().nodes[0], id: 'ui-container', kind: 'note', assetId: null, role: null,
      x: 1100, y: 450, width: 400, height: 240, payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], cells: [[{ id: 'ui-cell', text: '' }]] }) });
    await canvasWorkflowController('p').storeCellGeneration('ui-container', 'ui-cell', sessionId);
    window.save();
  }, id);
  await page.reload(); await link.waitFor();
  assert.equal(await page.locator(`[data-canvas-node-id="${id}"]`).count(), 0, 'embedded session has no duplicate card');
  assert.notEqual(await link.getAttribute('d'), standalonePath, 'automatic image wire follows the embedded cell');
  await card.getByRole('button', { name: '生成历史', exact: true }).click();
  await page.locator(`[data-workflow-history-session="${id}"]`).waitFor();
  console.log('PASS: visible session, image-port wire, submitted status, original inspector, embedded wire and history retained');
} finally { await browser.close(); await server.close(); }
