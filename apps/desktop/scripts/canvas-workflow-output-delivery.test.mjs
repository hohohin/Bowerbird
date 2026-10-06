import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1640, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
try {
  await page.goto('http://127.0.0.1:1640/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  console.log(await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { useStore } = await import('/src/store.ts');
    const { CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const check = (ok, message) => { if (!ok) throw Error(message); };
    const node = (id, kind, extra = {}) => ({ ...newWorkflowNode(kind, 0, 0, 'codex'), id, ...extra });
    const base = window.snapshot().nodes[0];
    const read = id => JSON.parse(window.snapshot().nodes.find(n => n.id === id).payloadJson).cells.flat();
    const makeTable = async id => api.projectCanvasNodeCreate({ ...base, id, kind: 'note', assetId: null, role: null, payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], cells: [[{ id: 'target', text: '' }, { id: 'keep', text: '手写内容' }]] }) });
    const writer = (id, table, source, type) => node(id, 'text', { textTarget: { nodeId: table, cellId: 'target', image: type === 'image' }, inputs: { [type]: [source] } });
    const create = async (name, nodes) => { const c = new CanvasWorkflowController(name); await c.load(); await c.edit(nodes); return c; };
    let submissions = 0, writes = [], failTable = '', release, started;
    api.localAgentFindAssetId = async () => 'existing';
    const update = api.projectCanvasNoteUpdate;
    api.projectCanvasNoteUpdate = async (id, payload) => {
      if (failTable === id) { failTable = ''; throw Error('模拟接收卡写入失败'); }
      writes.push(id); return update(id, payload);
    };
    useStore.setState({ startGeneration: async (...args) => {
      submissions++;
      const identity = args[12];
      if (started) { started(); await new Promise(resolve => { release = resolve; }); }
      useStore.setState(s => ({ genJobs: { ...s.genJobs, [identity.jobId]: { turns: [{ turnKey: identity.turnKey, images: ['existing.png'] }] } } }));
      return { accepted: true };
    } });
    await makeTable('receiver'); await makeTable('relay');
    const generator = node('gen', 'generation', { prompt: 'test' });
    const receiver = writer('writer', 'receiver', { nodeId: 'gen', portId: 'image' }, 'image');
    const relay = writer('relay-writer', 'relay', { canvasNodeId: 'receiver', cellId: '*' }, 'image');
    const childInput = { canvasNodeId: 'relay', cellId: '*' };
    const child = node('child', 'generation', { prompt: '@[image]', inputs: { image: [childInput] }, promptReferences: [{ id: 'image', type: 'image', input: childInput, label: '图片' }] });
    const c = await create('output-single', [generator, receiver, relay, child]);
    await c.start('gen', true);
    check(c.document.run.status === 'done' && read('receiver')[0].image_refs?.[0].asset_id === 'existing', 'single generation delivers its output to the connected content card');
    check(read('relay')[0].image_refs?.[0].asset_id === 'existing' && submissions === 1, 'content relays update without starting downstream generation');
    check(read('receiver')[1].text === '手写内容' && writes.filter(id => id === 'receiver').length === 1, 'neighbor is preserved and each receiver is written once');
    writes = []; await c.start('gen');
    check(submissions === 3 && writes.filter(id => id === 'receiver').length === 1, 'full flow also delivers once and starts its downstream consumer');

    // A failed receiver is its own step; the producer remains durably complete.
    failTable = 'receiver'; await c.start('gen', true);
    check(c.document.run.steps.gen.status === 'done' && c.document.run.steps.writer.status === 'failed', 'write failure is attributed to delivery, not generation');
    const count = submissions;
    const retry = new CanvasWorkflowController('output-single'); await retry.load(); await retry.continue();
    check(retry.document.run.status === 'done' && submissions === count, 'failed delivery can resume without resubmitting generation');
    const persisted = structuredClone(c.document);
    // Simulate interruption after producer completion, before receiver completion.
    persisted.run.status = 'running'; persisted.run.steps.writer.status = 'running';
    persisted.runs = persisted.runs.map(run => run.id === persisted.run.id ? persisted.run : run);
    sessionStorage.setItem('workflow-output-recovery', JSON.stringify({ revision: 1, document: persisted }));
    const recovered = new CanvasWorkflowController('output-recovery'); await recovered.load(); await recovered.continue();
    check(recovered.document.run.status === 'done' && submissions === count, 'reload finishes delivery without resubmitting generation');

    // Every text/image producer uses the same scheduled delivery path.
    await makeTable('text-output'); await makeTable('image-output');
    const reuse = node('reuse', 'instruction', { action: 'reuse', inputs: { image: [{ assetId: 'existing' }] } });
    const r = await create('output-reuse', [reuse, writer('text-writer', 'text-output', { nodeId: 'reuse', portId: 'text' }, 'text'), writer('image-writer', 'image-output', { nodeId: 'reuse', portId: 'image' }, 'image')]);
    await r.start('reuse', true);
    check(read('text-output')[0].text.includes('清晨场景') && read('image-output')[0].image_refs?.[0].asset_id === 'existing', 'reuse delivers both output ports');
    useStore.setState({ cloudAuth: { logged_in: true, user_id: 'test' }, cloudEntitlement: { user_id: 'test', is_test_account: true, policy: { can_use_agent_runs: true, max_parallel_agent_runs: 1, allowed_agent_skills: ['bowerbird-unified-agent'], agent_budget_options: ['controlled-standard'] } }, openCloudAgentRun: () => {} });
    let skillSubmissions = 0;
    api.cloudAgentStart = async () => { skillSubmissions++; return { runId: 'skill-job' }; };
    api.cloudAgentGet = async () => ({ runId: 'skill-job', status: 'succeeded', snapshot: { run: {}, events: [] } });
    api.cloudAgentIngestArtifacts = async () => [{ id: 'existing' }];
    const skill = node('skill', 'skill', { prompt: '生成图片' });
    const s = await create('output-skill', [skill, writer('skill-writer', 'image-output', { nodeId: 'skill', portId: 'image' }, 'image')]);
    writes = []; await s.start('skill', true);
    check(s.document.run.status === 'waiting' && !writes.length, 'waiting skill does not write a premature result');
    const skillRecovery = new CanvasWorkflowController('output-skill'); await skillRecovery.load(); await skillRecovery.continue();
    check(skillRecovery.document.run.status === 'done' && skillSubmissions === 1 && writes.length === 1, 'skill recovery delivers once without resubmission');

    api.agentDsWorkflowStart = async () => ({ autoDelivered: true, path: 'isolated' });
    api.agentDsWorkflowResult = async requestId => ({ schemaVersion: 1, requestId, text: 'Agent 文字结果' });
    api.describeAsset = async () => 'caption';
    api.listAnalysesByAsset = async () => [{ id: 'caption', payload: JSON.stringify({ sections: [{ title: '画面', body: '蓝色背景' }] }) }];
    useStore.setState({ defaultUnderstandProvider: 'bowerbird-cloud' });
    const dataUrl = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
    api.layerWorkspaceLoad = async () => ({ document: { schemaVersion: 1, width: 8, height: 8, layers: [{ id: 'layer', name: '图层', dataUrl, x: 0, y: 0, width: 8, height: 8, opacity: 1, visible: true, background: true }] } });
    api.layerExport = async () => ({ id: 'existing' });
    for (const [producer, type, expected] of [
      [node('agent', 'agent', { prompt: '返回文字' }), 'text', 'Agent 文字结果'],
      [node('describe', 'instruction', { action: 'describe', inputs: { image: [{ assetId: 'existing' }] } }), 'text', '蓝色背景'],
      [node('layers', 'instruction', { action: 'layers', inputs: { image: [{ assetId: 'existing' }] } }), 'image', 'existing'],
    ]) {
      const table = type === 'text' ? 'text-output' : 'image-output';
      const controller = await create(`output-${producer.id}`, [producer, writer(`${producer.id}-writer`, table, { nodeId: producer.id, portId: type }, type)]);
      writes = []; await controller.start(producer.id, true);
      check(controller.document.run.status === 'done', `${producer.id}: ${JSON.stringify(controller.issue)}`);
      const cell = read(table)[0];
      check((type === 'text' ? cell.text.includes(expected) : cell.image_refs[0].asset_id === expected) && writes.length === 1, `${producer.id} single run delivers exactly once`);
    }

    // Late producer completion after stop must not deliver to the receiver.
    const stop = await create('output-stop', [generator, receiver]);
    const submitted = new Promise(resolve => { started = resolve; });
    writes = []; const running = stop.start('gen', true); await submitted;
    api.cancelCodexCreate = async () => {};
    const stopping = stop.stop(); release(); await Promise.all([running, stopping]); started = null;
    check(!writes.length && stop.document.run.status === 'stopped', 'stopped output is not delivered');
    return 'single/full generation, relay, reuse, skill, Agent, describe, layers, write failure, reload and stop passed';
  }));
  // The visible failure action also survives a reload and never calls the producer again.
  await page.reload();
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { useStore } = await import('/src/store.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    api.localAgentFindAssetId = async () => 'existing';
    await api.projectCanvasNodeCreate({ ...window.snapshot().nodes[0], id: 'ui-target', kind: 'note', assetId: null, role: null, payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], cells: [[{ id: 'target', text: '', bold: false, italic: false, align: 'left' }]] }) });
    useStore.setState({ cloudAuth: null, startGeneration: async (...args) => {
      const identity = args[12];
      useStore.setState(s => ({ genJobs: { ...s.genJobs, [identity.jobId]: { turns: [{ turnKey: identity.turnKey, images: ['existing.png'] }] } } }));
      return { accepted: true };
    } });
    const c = canvasWorkflowController('p'); await c.load();
    await c.edit([
      { ...newWorkflowNode('generation', 0, 0, 'codex'), id: 'ui-gen', prompt: 'test' },
      { ...newWorkflowNode('text', 0, 0, ''), id: 'ui-writer', textTarget: { nodeId: 'ui-target', cellId: 'target', image: true }, inputs: { image: [{ nodeId: 'ui-gen', portId: 'image' }] } },
    ]);
    api.projectCanvasNoteUpdate = async () => { throw Error('模拟内容写入失败'); };
    await c.start('ui-gen', true);
    if (c.document.run.status !== 'waiting' || !c.issue) throw Error(JSON.stringify({ run: c.document.run, issue: c.issue }));
    window.save();
  });
  await page.getByRole('alert', { name: '工作流问题' }).getByRole('button', { name: '重试写入内容卡' }).waitFor();
  await page.reload();
  await page.getByRole('alert', { name: '工作流问题' }).getByRole('button', { name: '重试写入内容卡' }).waitFor();
  await page.evaluate(async () => {
    const { useStore } = await import('/src/store.ts');
    useStore.setState({ startGeneration: async () => { throw Error('交付重试不应调用生成'); } });
  });
  await page.getByRole('alert', { name: '工作流问题' }).getByRole('button', { name: '重试写入内容卡' }).click();
  await page.waitForFunction(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    return canvasWorkflowController('p').document.run.status === 'done';
  });
  await page.getByRole('alert', { name: '工作流问题' }).waitFor({ state: 'detached' });
  console.log('visible delivery retry survives reload and completes without generating again');
} catch (error) {
  console.error(await page.evaluate(() => ({ alerts: [...document.querySelectorAll('[role="alert"]')].map(n => n.textContent), cards: [...document.querySelectorAll('[data-workflow-card]')].map(n => n.getAttribute('data-workflow-card')) })));
  throw error;
} finally { await browser.close(); await server.close(); }
