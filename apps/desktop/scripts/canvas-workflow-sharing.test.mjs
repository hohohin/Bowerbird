import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1665, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
page.setDefaultTimeout(12000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:1665/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  console.log(await page.evaluate(async () => {
    const { newWorkflowNode, workflowOrder, compileGenerationPrompt, generationInputNode, workflowInputValues } = await import('/src/lib/canvasWorkflow.ts');
    const { captureWorkflowTemplate, parseWorkflowTemplate, instantiateWorkflowTemplate, reconfigureTemplateInstance } = await import('/src/lib/workflowTemplates.ts');
    const { includeTemplateContent, materializeTemplateContent, templateInputValue } = await import('/src/lib/workflowTemplateContent.ts');
    const { buildWorkflowPlan } = await import('/src/lib/workflowPlanner.ts');
    const { workflowLoopRows, workflowLoopOutputs, workflowLoopScope } = await import('/src/lib/workflowLoop.ts');
    const { emptyCanvasCell } = await import('/src/lib/canvasNotes.ts');
    const { api } = await import('/src/lib/api.ts');
    const { CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    let checks = 0; const check = (ok, why) => { checks++; if (!ok) throw Error(why); };
    const rejects = work => { try { work(); return false; } catch { return true; } };
    const loop = { ...newWorkflowNode('loop', 100, 100, 'sender-provider'), id: 'sender-loop', loopMode: 'rows', loopStartItem: 2,
      inputs: { text: [{ canvasNodeId: 'sender-table', cellId: '*text' }] }, outputs: workflowLoopOutputs({ text: 'private-output', assetIds: [] }, 7) };
    const profile = { ...newWorkflowNode('visual-profile', 500, 100, 'sender-provider'), id: 'sender-profile', profileId: 'private-profile', profileName: 'private-brand',
      profileCache: { inputKey: 'private-cache', profileId: 'private-profile' }, outputs: { 'visual-profile': { type: 'visual-profile', profileId: 'private-profile', version: 9 } } };
    const agent = { ...newWorkflowNode('agent', 900, 100, 'sender-provider'), id: 'sender-agent', agentTransport: 'codex-cli', prompt: '处理 @[row]，第 @[iteration] 轮',
      inputs: { text: [{ nodeId: loop.id, portId: 'text' }, { nodeId: loop.id, portId: 'iteration' }], 'visual-profile': [{ nodeId: profile.id, portId: 'visual-profile' }] },
      promptReferences: [{ id: 'row', label: '当前行', type: 'text', input: { nodeId: loop.id, portId: 'text' } }, { id: 'iteration', label: '当前轮次', type: 'text', input: { nodeId: loop.id, portId: 'iteration' } }], sessionNodeIds: ['private-session'], describeCache: { instruction: 'private', results: [] } };
    const nodes = [loop, profile, agent], boundary = {};
    const template = captureWorkflowTemplate(nodes, new Set(nodes.map(n => n.id)), '循环与视觉规范', boundary);
    check(template.schemaVersion === 4 && template.inputs[0].whole, 'v4 retains whole-table input');
    check(!/private-|sender-|profileId|sessionNodeIds|describeCache/.test(JSON.stringify(template)), 'portable definitions omit sender state and personal profile');
    check(template.plan.nodes.find(n => n.kind === 'loop').loopStartItem === 2, 'selected start item retained');
    const blank = captureWorkflowTemplate([profile], new Set([profile.id]), '只分享规范卡');
    check(instantiateWorkflowTemplate(blank, {}, {}, 'receiver', [], 0, 0)[1].profileId === undefined, 'bound profile exports and restores as empty profile card');
    check(rejects(() => buildWorkflowPlan(JSON.stringify(template.plan), newWorkflowNode('planner', 0, 0, ''), [], [])), 'planner still rejects unsupported loop plans');
    for (const mutate of [t => t.plan.nodes[1].loopMode = 'unknown', t => t.plan.nodes[1].loopStartItem = 0, t => t.plan.nodes[2].profileId = 'private', t => t.plan.nodes[1].outputs = {}, t => t.plan.nodes[3].agentTransport = 'unknown', t => t.schemaVersion = 3,
      t => t.plan.edges.find(e => e.output === 'iteration').from = 'card2', t => t.plan.edges.push({ from: 'card3', to: 'card1', output: 'text', input: 'text' })]) {
      const bad = structuredClone(template); mutate(bad); check(rejects(() => parseWorkflowTemplate(JSON.stringify(bad))), 'invalid portable graph rejected');
    }
    const emptyBindings = {};
    const importsBefore = window.calls.filter(c => c.command === 'import_image_bytes').length;
    await materializeTemplateContent(template, emptyBindings, 'p', 2000, 0);
    check(emptyBindings.source1.cellId === '*text', 'no-content import creates whole-table placeholder');
    check(window.calls.filter(c => c.command === 'import_image_bytes').length === importsBefore, 'empty card import never imports image bytes');
    const restored = instantiateWorkflowTemplate(template, emptyBindings, {}, 'receiver-provider', [], 0, 0);
    check(restored.every(n => !nodes.some(old => old.id === n.id) && !Object.keys(n.outputs).length && !n.sessionNodeIds), 'fresh cards have no execution state');
    check(restored[3].agentTransport === 'codex-cli', 'loop agent retains selected channel');
    const loopState = workflowLoopScope(restored, workflowOrder(restored, restored[0].id));
    check(loopState.startIndex === 1 && loopState.bodyIds.includes(restored[3].id), 'loop scope reconstructed from wires');
    restored[1].outputs = workflowLoopOutputs({ text: '接收方内容', assetIds: [] }, 1);
    restored[2].outputs = { 'visual-profile': { type: 'visual-profile', profileId: 'receiver-profile', version: 1 } };
    const compiled = compileGenerationPrompt(restored[3], workflowInputValues(restored, generationInputNode(restored[3])));
    check(compiled.prompt.includes('接收方内容') && compiled.prompt.includes('2'), 'current row and iteration references remap');
    const edited = structuredClone(restored); edited[1].loopStartItem = 3;
    check(rejects(() => reconfigureTemplateInstance(edited, edited[0].id, emptyBindings, {}, () => false)), 'reconfigure cannot overwrite edited loop config');
    const table = { ...window.snapshot().nodes[0], id: 'sender-table', kind: 'note', assetId: null, role: null, payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [],
      cells: [['甲', 'A'], ['乙', 'B'], ['丙', 'C']].map((row, r) => row.map((text, c) => ({ ...emptyCanvasCell(), id: `s${r}${c}`, text }))) }) };
    const value = templateInputValue(boundary.source1, 'text', nodes, [table]);
    const carried = await includeTemplateContent(template, { source1: value }, false, true);
    const carriedBindings = {}; await materializeTemplateContent(carried, carriedBindings, 'p', 2500, 0);
    const runnable = instantiateWorkflowTemplate(carried, carriedBindings, {}, 'receiver', [], 0, 0);
    const rows = workflowLoopRows(runnable[1], runnable, window.snapshot().nodes);
    check(rows.length === 3 && rows[1].text.includes('乙') && rows[1].text.includes('B'), 'carried table restores actual rows, not one flattened cell');
    const requests = [];
    const originals = { start: api.agentDsWorkflowStart, result: api.agentDsWorkflowResult, get: api.visualProfileGet, generation: api.agentDsWorkflowGenerationRequest };
    api.agentDsWorkflowStart = async (...args) => { requests.push(args); return { autoDelivered: true, path: 'isolated' }; };
    api.agentDsWorkflowResult = async requestId => ({ schemaVersion: 1, requestId, text: '完成' });
    api.agentDsWorkflowGenerationRequest = async () => null;
    api.visualProfileGet = async id => ({ id, name: '接收方规范', status: 'confirmed', version: 1, rules: [], summary: '接收方规则', sourceAssetIds: [], conflicts: [], contentThemes: [] });
    try {
      runnable[2].profileId = 'receiver-profile';
      const c = new CanvasWorkflowController('sharing-runtime'); await c.load(); await c.edit(runnable); await c.start(runnable[0].id);
      check(c.document.run.status === 'done', `imported loop completes: ${JSON.stringify(c.document.run.steps)}`);
      check(requests.length === 2 && requests[0].slice(1, 3).join('\n').includes('2') && requests[1].slice(1, 3).join('\n').includes('3'), `starts at selected item with correct iteration prompts: ${JSON.stringify(requests.map(args => args.slice(1, 3)))}`);
      check(requests.every(args => args[7] === 'codex-cli' && args[10]?.profileId === 'receiver-profile'), 'uses recipient profile and original channel');
      check(new Set(requests.map(args => args[0])).size === 2, 'new task identity for each item');
      const reloaded = new CanvasWorkflowController('sharing-runtime'); await reloaded.load(); await reloaded.continue();
      check(requests.length === 2 && reloaded.document.run.status === 'done', 'completed import reload does not re-run');
    } finally { api.agentDsWorkflowStart = originals.start; api.agentDsWorkflowResult = originals.result; api.visualProfileGet = originals.get; api.agentDsWorkflowGenerationRequest = originals.generation; }
    const imagesLoop = { ...loop, loopMode: 'images', inputs: { image: [{ assetId: 'existing' }] } };
    const imageAgent = { ...agent, inputs: { image: [{ nodeId: loop.id, portId: 'image' }] }, prompt: '分析当前图片', promptReferences: [] };
    const imagesTemplate = captureWorkflowTemplate([imagesLoop, imageAgent], new Set([loop.id, agent.id]), '逐图循环');
    const imagesRestored = instantiateWorkflowTemplate(imagesTemplate, { source1: { assetId: 'existing' } }, {}, 'receiver', [], 0, 0);
    check(imagesRestored[1].loopMode === 'images' && imagesRestored[2].inputs.image[0].nodeId === imagesRestored[1].id, 'image loop and implicit Agent image input survive');
    const layout = [loop, profile, agent].map((n, i) => ({ id: `item${i}`, node: `card${i + 1}`, x: i * 400, y: 0, width: 320, height: 400, enclosed: false }));
    window.sharingTemplate = { ...template, layout };
    const snapshot = window.snapshot(); snapshot.nodes = snapshot.nodes.filter(n => n.id === 'old'); snapshot.view = { ...snapshot.view, zoom: 1, panX: 40, panY: 90 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    sessionStorage.setItem('workflow-p', JSON.stringify({ revision: 1, document: { schema_version: 1, nodes, run: null } }));
    sessionStorage.setItem('sharing-template', JSON.stringify(window.sharingTemplate));
    return { checks };
  }));
  await page.reload(); await page.locator('[data-workflow-card="sender-loop"]').waitFor();
  const first = await page.locator('[data-workflow-card="sender-loop"]').boundingBox();
  const last = await page.locator('[data-workflow-card="sender-agent"]').boundingBox();
  await page.mouse.move(first.x - 15, first.y - 15); await page.mouse.down();
  await page.mouse.move(last.x + last.width + 15, Math.max(first.y + first.height, last.y + last.height) + 20, { steps: 10 }); await page.mouse.up();
  await page.locator('[data-workflow-card="sender-loop"] header').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '导出工作流数据包', exact: true }).click();
  await page.getByRole('dialog', { name: '导出工作流数据包', exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.getByRole('checkbox', { name: '带上素材', exact: true }).isChecked(), false);
  assert.equal(await page.getByRole('checkbox', { name: '带上文本', exact: true }).isChecked(), false);
  await page.getByRole('button', { name: '导出数据包', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const raw = await page.evaluate(() => sessionStorage.getItem('workflow-template-export'));
  assert.ok(!/private-|sender-|profileId|data:image/.test(raw));
  assert.equal(JSON.parse(raw).plan.nodes.filter(n => n.kind === 'loop').length, 1);
  await page.locator('[data-workflow-card="sender-loop"] header').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '导入工作流数据包', exact: true }).click();
  await page.getByLabel('选择工作流数据包', { exact: true }).setInputFiles({ name: 'loop.bbworkflow.json', mimeType: 'application/json', buffer: Buffer.from(raw) });
  await page.getByText('已导入模板，请配置当前画板的输入素材。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '添加子流程到画板', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const imported = await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.filter(n => !n.id.startsWith('sender-')));
  assert.equal(imported.find(n => n.kind === 'loop').loopStartItem, 2);
  assert.equal(imported.find(n => n.kind === 'loop').inputs.text[0].cellId, '*text');
  assert.equal(imported.find(n => n.kind === 'visual-profile').profileId, undefined);
  assert.equal(imported.find(n => n.kind === 'agent').inputs['visual-profile'][0].nodeId, imported.find(n => n.kind === 'visual-profile').id);
  assert.equal(await page.evaluate(() => window.calls.filter(c => /agent_ds_workflow_start|generate|visual_profile_extract|read_image_data_url|import_image_bytes/.test(c.command)).length), 0);
  await page.reload(); await page.locator('.workflow-template-instance').waitFor();
  assert.deepEqual(errors, []);
  console.log('workflow sharing: loop config, row/iteration wires, recipient profile, empty import, execution and reload passed');
} finally { await browser.close(); await server.close(); }
