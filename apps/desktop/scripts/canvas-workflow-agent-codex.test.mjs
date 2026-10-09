import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const production = process.env.BOWERBIRD_WORKFLOW_PRODUCTION === '1';
const server = await createServer({ cacheDir: production ? '.tmp/workflow-agent-production-'+'canvas-workflow-agent-codex.test.mjs' : undefined, define: production ? { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' } : undefined, configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1642, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
try {
  await page.goto('http://127.0.0.1:1642/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  for (const name of ['新增技能卡片', '工作流模板库', '新增工作流助手']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
  await page.getByRole('button', { name: '新增 Agent 卡片', exact: true }).click();
  const agent = page.locator('.workflow-card.is-agent');
  await agent.getByRole('button', { name: '输出：返回图片', exact: true }).waitFor();
  await page.getByRole('combobox', { name: 'Agent 执行引擎' }).selectOption('cloud');
  assert.equal(await agent.getByRole('button', { name: '输出：返回图片', exact: true }).count(), 0);
  await page.getByRole('combobox', { name: 'Agent 执行引擎' }).selectOption('codex-cli');
  await agent.getByRole('button', { name: '输出：返回图片', exact: true }).waitFor();
  await page.reload();
  const selector = page.getByRole('combobox', { name: 'Agent 执行引擎' });
  await selector.waitFor();
  assert.equal(await selector.inputValue(), 'codex-cli');
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode, workflowOutputs } = await import('/src/lib/canvasWorkflow.ts');
    const { useStore } = await import('/src/store.ts');
    const check = (ok, message) => { if (!ok) throw Error(message); };
    const calls = [], cancelled = [], results = new Map();
    let hold = false, failure = false;
    useStore.setState({ cloudAuth: null, cloudEntitlement: null, defaultProvider: 'codex', activeGenProvider: 'jimeng' });
    api.cloudAgentStart = async () => { throw Error('Codex card must not invoke Cloud DSH'); };
    api.agentDsWorkflowGenerationRequest = async () => null;
    api.agentDsWorkflowCancel = async id => { cancelled.push(id); };
    api.agentDsWorkflowStart = async (...args) => {
      calls.push(args);
      const [id, instruction, source, purpose, images, scope, provider, transport] = args;
      check(transport === 'codex-cli' && purpose === 'agent-text', 'selected CLI reaches IPC');
      check(instruction === '分析图片并输出表格' && source === '{}', 'free image task preserves instruction');
      check(images.length === 1 && images[0] && scope.nodeId === 'agent', 'images and per-card identity reach IPC');
      check(provider === 'codex', 'starred image provider remains independent from selected Agent transport');
      results.set(id, failure ? { schemaVersion: 1, requestId: id, error: 'CLI 未登录' } : {
        schemaVersion: 1, requestId: id, text: JSON.stringify({ format: 'bowerbird-table', columns: ['项目', '说明'], rows: [['图像', '已分析']] }), images: ['result.png'],
      });
      return { autoDelivered: true, path: 'isolated-codex-request' };
    };
    api.agentDsWorkflowResult = async id => hold ? null : results.get(id);
    api.agentDsWorkflowIngestImages = async () => api.getAssetsByIds(['a']);
    const c = new CanvasWorkflowController('codex-agent'); await c.load();
    const agent = { ...newWorkflowNode('agent', 0, 0, ''), id: 'agent', agentTransport: 'codex-cli', prompt: '分析图片并输出表格', inputs: { image: [{ assetId: 'a' }] } };
    const base = window.snapshot().nodes[0];
    await api.projectCanvasNodeCreate({ ...base, id: 'codex-image-target', kind: 'note', role: null, assetId: null,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', title: 'Codex 图片接收', text: '', member_ids: [],
        cells: [[{ id: 'image-cell', text: '' }, { id: 'neighbor', text: '保留邻格' }]] }) });
    const writer = { ...newWorkflowNode('text', 0, 0, ''), id: 'image-writer', textTarget: { nodeId: 'codex-image-target', cellId: 'image-cell', image: true },
      inputs: { image: [{ nodeId: agent.id, portId: 'image' }] } };
    const targetCells = () => JSON.parse(window.snapshot().nodes.find(node => node.id === 'codex-image-target').payloadJson).cells;
    check(workflowOutputs(agent).some(port => port.type === 'image'), 'CLI exposes image output');
    await c.edit([agent, writer]); await c.start('agent', true);
    check(c.document.run.status === 'done' && calls.length === 1, 'CLI completes without cloud login');
    const output = c.document.nodes.find(node => node.id === 'agent').outputs;
    check(output.text.table.rows[0][1] === '已分析' && output.image.assetIds[0] === 'a', 'table and image output use shared result delivery');
    check(c.document.run.steps[writer.id].status === 'done' && targetCells()[0][0].image_refs[0].asset_id === 'a'
      && targetCells()[0][1].text === '保留邻格', 'Codex image output is actually written into connected content cell');
    check(c.document.run.steps.agent.localAgentTransport === 'codex-cli', 'transport is frozen with request before submission');
    // Recover a submitted request without another call, even if the saved card selection differs.
    const saved = structuredClone(c.document);
    saved.nodes.find(node => node.id === 'agent').agentTransport = 'local-ds';
    saved.run.status = 'running'; saved.run.steps.agent.status = 'running';
    saved.run.steps[writer.id] = { status: 'pending' };
    saved.runs = saved.runs.map(run => run.id === saved.run.id ? saved.run : run);
    sessionStorage.setItem('workflow-codex-recovery', JSON.stringify({ revision: 1, document: saved }));
    const recovered = new CanvasWorkflowController('codex-recovery'); await recovered.load(); await recovered.continue();
    check(calls.length === 1 && recovered.document.run.status === 'done', 'recovery fetches original CLI result without submitting');
    check(recovered.document.run.steps[writer.id].status === 'done' && targetCells()[0][0].image_refs[0].asset_id === 'a', 'recovery completes connected image delivery');
    const unknown = structuredClone(saved);
    unknown.run.status = 'waiting'; unknown.run.loop = {};
    unknown.run.steps.agent.status = 'failed';
    unknown.runs = unknown.runs.map(run => run.id === unknown.run.id ? unknown.run : run);
    sessionStorage.setItem('workflow-codex-unknown', JSON.stringify({ revision: 1, document: unknown }));
    const interrupted = new CanvasWorkflowController('codex-unknown'); await interrupted.load();
    const readResult = api.agentDsWorkflowResult;
    api.agentDsWorkflowResult = async id => ({ schemaVersion: 1, requestId: id, error: 'interrupted', submissionUnknown: true });
    let retryError;
    try { await interrupted.retryLoop(interrupted.document.run.id); } catch (error) { retryError = error.message; }
    check(retryError?.includes('状态未知') && calls.length === 1, 'unknown interrupted CLI request cannot be silently resubmitted by loop retry');
    api.agentDsWorkflowResult = readResult;
    failure = true; await c.start('agent', true);
    check(c.document.run.status === 'failed' && c.issue.message.includes('CLI 未登录'), 'CLI failure stops downstream and exposes cause');
    failure = false; hold = true;
    const running = c.start('agent', true);
    while (calls.length < 3) await new Promise(resolve => setTimeout(resolve, 10));
    await c.stop(); await running;
    check(cancelled.includes(calls[2][0]) && c.document.run.status === 'stopped', 'stop cancels this CLI request');
    hold = false;
    check(c.document.nodes.find(node => node.id === 'agent').outputs.text === undefined, 'late result never populates stopped card');
    check(calls.every(call => call[8] === false), 'ordinary card follow-ups retain their session');
    const beforeLoop = calls.length;
    const loop = { ...newWorkflowNode('loop', 0, 0, ''), id: 'loop', inputs: { image: [{ assetId: 'a' }, { assetId: 'b' }] } };
    const loopAgent = { ...agent, inputs: { image: [{ nodeId: 'loop', portId: 'image' }] } };
    const batch = new CanvasWorkflowController('codex-isolated-loop'); await batch.load();
    await batch.edit([loop, loopAgent, writer]); await batch.start('loop', true);
    check(batch.document.run.status === 'done' && calls.length === beforeLoop + 2, 'two loop items execute once each');
    check(calls.slice(beforeLoop).every(call => call[8] === true), 'every Codex loop item requests an isolated session');
    check(calls[beforeLoop][0] !== calls[beforeLoop + 1][0], 'items keep separate request identities');
    const savedLoop = structuredClone(batch.document);
    savedLoop.run.status = 'running'; savedLoop.run.steps.agent.status = 'running';
    savedLoop.runs = savedLoop.runs.map(run => run.id === savedLoop.run.id ? savedLoop.run : run);
    sessionStorage.setItem('workflow-codex-loop-recovery', JSON.stringify({ revision: 1, document: savedLoop }));
    const loopRecovery = new CanvasWorkflowController('codex-loop-recovery'); await loopRecovery.load(); await loopRecovery.continue();
    check(loopRecovery.document.run.status === 'done' && calls.length === beforeLoop + 2, 'isolated loop recovery fetches the same request without a fresh model call');
  });
  console.log(production ? 'PRODUCTION' : 'DEV');
  console.log('PASS Codex Agent selector, image/table delivery, frozen transport, isolated loop sessions/recovery, errors and cancellation');
} finally { await browser.close(); await server.close(); }
