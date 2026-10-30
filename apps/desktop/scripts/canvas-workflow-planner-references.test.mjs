import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({plugins: [{ name: 'enable-hidden-workflow-test', transform(code, id) { if (id.endsWith('/src/lib/featureFlags.ts')) return code.replace('export const WORKFLOW_PLANNER_ENABLED = false;', 'export const WORKFLOW_PLANNER_ENABLED = true;'); } }],  configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1605, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:1605/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const base = window.snapshot().nodes[0];
    await api.projectCanvasNodeCreate({ ...base, id: 'brief', kind: 'note', assetId: null, x: 20, y: 30, payloadJson: JSON.stringify({ cells: [[{ id: 'text', text: '保留版式。'.repeat(150) + '末尾要求：紫心宝螺', content_type: 'text' }]] }) });
    const c = canvasWorkflowController('p'); await c.load();
    await c.edit([{ ...newWorkflowNode('planner', 420, 60, 'jimeng'), id: 'planner', inputs: { text: [{ canvasNodeId: 'brief', cellId: 'text' }], image: [{ assetId: 'existing', assetNodeId: 'old' }] } }]);
    window.save();
  });
  await page.reload();
  const editor = page.getByRole('textbox', { name: '工作流需求', exact: true });
  await editor.waitFor();
  assert.equal(await editor.getAttribute('contenteditable'), 'true');
  await editor.fill('按照 '); await editor.press('End'); await editor.pressSequentially('@');
  const list = page.getByRole('listbox', { name: '收到的内容' }); await list.waitFor();
  assert.equal(await list.getByRole('option').count(), 2);
  await list.getByRole('option').filter({ hasText: '文本 1' }).click();
  await editor.pressSequentially(' 的要求，用 @');
  await list.getByRole('option').filter({ hasText: '图片来源 1' }).click();
  await editor.pressSequentially(' 作为产品参考。');
  assert.equal(await editor.locator('[data-reference-id]').count(), 2);
  await page.evaluate(() => window.save()); await page.reload(); await editor.waitFor();
  assert.equal(await editor.locator('[data-reference-id]').count(), 2, 'inline references survive reload');
  await page.locator('.workflow-card.is-planner').screenshot({ path: '../../.tmp/workflow-planner-references.png' });
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    window.requests = [];
    api.agentDsWorkflowStart = async (...args) => { window.requests.push(args); return { path: 'pending', autoDelivered: false }; };
    api.agentDsWorkflowResult = async () => null;
  });
  await page.getByRole('button', { name: '编排工作流', exact: true }).click();
  await page.getByRole('button', { name: '取消等待', exact: true }).waitFor();
  assert.equal(await editor.getAttribute('contenteditable'), 'false', 'waiting prevents prompt changes');
  const request = await page.evaluate(() => window.requests[0]);
  assert.equal(request[1], '按照 【source1.text：文本 1】 的要求，用 【source2.image：图片来源 1】 作为产品参考。');
  const context = JSON.parse(request[2]);
  assert.ok(context.sources[0].preview.endsWith('末尾要求：紫心宝螺'), 'explicitly referenced text is not silently truncated');
  assert.equal(context.sources[1].id, 'source2');
  assert.ok(!request[1].includes('@['));
  assert.ok(context.sources.every(source => !source.input && !source.contentKey), 'internal binding IDs are not sent to model');
  await page.getByRole('button', { name: '取消等待', exact: true }).click();
  await page.getByRole('button', { name: '编排工作流', exact: true }).waitFor();

  const result = await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { compilePlanningPrompt, plannerContextKey } = await import('/src/lib/workflowPlanner.ts');
    const { normalizeWorkflowInputSlots } = await import('/src/lib/canvasWorkflow.ts');
    const { captureCanvasClipboard, cloneCanvasClipboard } = await import('/src/lib/canvasClipboard.ts');
    const c = canvasWorkflowController('p'), owner = structuredClone(c.document.nodes[0]);
    const sources = owner.planning.sources;
    let checks = 0; const check = (value, message) => { checks++; if (!value) throw Error(message); };
    const repeated = { ...owner, prompt: owner.prompt + ` 再核对 @[${owner.promptReferences[0].id}]` };
    check(compilePlanningPrompt(repeated, sources).match(/source1.text/g).length === 2, 'repeated references retain source identity');
    const changed = structuredClone(owner); changed.promptReferences[0].slot = 2;
    check(plannerContextKey(changed) !== plannerContextKey(owner), 'reference-only change invalidates request context');
    check(compilePlanningPrompt({ ...owner, prompt: '普通需求' }, sources) === '普通需求', 'plain prompt remains supported despite unused references');
    let failed = false; try { compilePlanningPrompt({ ...owner, prompt: '@[unknown]' }, sources); } catch { failed = true; }
    check(failed, 'unknown token rejected');
    const canvas = await api.projectCanvasGet('p');
    const clipboard = captureCanvasClipboard('p', new Set(['planner', 'old', 'brief']), canvas.nodes, [], [], c.document.nodes);
    const cloned = cloneCanvasClipboard(clipboard, 'p', 100, 100), copied = cloned.workflow[0];
    check(!copied.planning && copied.promptReferences[0].input.canvasNodeId !== 'brief' && copied.promptReferences[1].input.assetNodeId !== 'old', 'copy remaps reference identity and clears request');
    const copiedSources = sources.map(source => ({ ...source, input: copied.inputs[source.type][0] }));
    check(compilePlanningPrompt(copied, copiedSources) === compilePlanningPrompt(owner, sources), 'copied reference meaning preserved');
    await c.edit([{ ...owner, inputs: { text: owner.inputs.text, image: [] } }]);
    const sentBefore = window.requests.length;
    failed = false; try { await c.planner.start(owner.id); } catch (error) { failed = error.message.includes('重新按 @'); }
    check(failed && window.requests.length === sentBefore, 'disconnected mention blocked before sending');
    await c.edit([owner]); await c.planner.start(owner.id);
    await c.edit(c.document.nodes.map(node => ({ ...node, promptReferences: changed.promptReferences })));
    api.agentDsWorkflowResult = async requestId => ({ schemaVersion: 2, requestId, phase: 'proposal', revision: 1,
      text: JSON.stringify({ schemaVersion: 2, summary: '海报', sourceUses: [], nodes: [{ id: 'draw', kind: 'generation', prompt: '海报' }], outputs: [{ node: 'draw', label: '海报' }] }) });
    try { await c.planner.collect(owner.id); } catch {}
    check(c.document.nodes.length === 1 && c.document.nodes[0].planning.status === 'failed' && c.document.nodes[0].planning.error.includes('需求或来源已变化'), 'late result cannot apply after reference retargeting');

    const imageInputs = ['first', 'middle', 'last'].map((assetId, index) => ({ assetId, slot: index + 1 }));
    const imageOwner = normalizeWorkflowInputSlots({ ...owner, inputs: { image: imageInputs }, prompt: '@[second]',
      promptReferences: [{ id: 'second', type: 'image', slot: 2, input: imageInputs[1], assetId: 'middle', label: '图片来源 2' },
        { id: 'third', type: 'image', slot: 3, input: imageInputs[2], label: '图片来源 3' }] });
    const compacted = normalizeWorkflowInputSlots({ ...imageOwner, inputs: { image: [imageInputs[0], imageInputs[2]] } });
    const imageSources = compacted.inputs.image.map((input, index) => ({ id: `source${index + 1}`, type: 'image', input, label: input.assetId }));
    check(compacted.inputs.image.map(input => input.slot).join(',') === '1,2', 'deleting the middle source compacts planner pipe numbers');
    const legacyInput = { assetId: 'last' }, legacyRef = { id: 'legacy-third', type: 'image', input: legacyInput, assetId: 'last', label: '图片 3.1' };
    const legacyPlanner = normalizeWorkflowInputSlots({ ...owner, planning: undefined, inputs: { image: [{ assetId: 'first' }, legacyInput] },
      prompt: '@[legacy-third]', promptReferences: [legacyRef] });
    check(legacyPlanner.promptReferences[0].slot === 2 && legacyPlanner.promptReferences[0].label === '图片来源 2', 'legacy source-based planner mention migrates by surviving source rather than old displayed number');
    const missingLegacyPlanner = normalizeWorkflowInputSlots({ ...owner, planning: undefined, inputs: { image: [{ assetId: 'first' }, legacyInput] },
      prompt: '@[legacy-middle]', promptReferences: [{ ...legacyRef, id: 'legacy-middle', input: { assetId: 'middle' }, label: '图片 2.1' }] });
    check(missingLegacyPlanner.promptReferences[0].slot === undefined, 'deleted legacy source does not bind to an unrelated current pipe with the same number');
    failed = false; try { compilePlanningPrompt(missingLegacyPlanner, imageSources); } catch { failed = true; }
    check(failed, 'missing legacy planner source remains disconnected during compilation');
    const oldSnapshot = { ...compacted, promptReferences: compacted.promptReferences.map(ref => ref.id === 'second' ? { ...ref, input: imageInputs[1], assetId: 'middle' } : ref) };
    check(compilePlanningPrompt(oldSnapshot, imageSources) === '【source2.image：图片来源 2】', 'numbered mention reads the current second pipe despite its old source snapshot');
    failed = false; try { compilePlanningPrompt({ ...compacted, prompt: '@[third]' }, imageSources); } catch { failed = true; }
    check(failed, 'missing third pipe stays disconnected even though its old asset is now the second pipe');
    const restoredPipe = normalizeWorkflowInputSlots({ ...compacted, prompt: '@[third]', inputs: { image: [...compacted.inputs.image, { assetId: 'replacement' }] } });
    const restoredSources = restoredPipe.inputs.image.map((input, index) => ({ id: `source${index + 1}`, type: 'image', input, label: input.assetId }));
    check(compilePlanningPrompt(restoredPipe, restoredSources) === '【source3.image：图片来源 3】', 'adding a new third source restores the third numbered mention');
    const childFirst = [{ ...imageSources[0], id: 'source2_cell1', parentId: 'source2', input: { ...imageSources[0].input, slot: 2 } }, ...imageSources];
    check(compilePlanningPrompt(oldSnapshot, childFirst) === '【source2.image：图片来源 2】', 'child source cannot replace the top-level numbered pipe');

    const brief = canvas.nodes.find(node => node.id === 'brief');
    for (const id of ['brief-middle', 'brief-last']) await api.projectCanvasNodeCreate({ ...brief, id,
      payloadJson: JSON.stringify({ cells: [[{ id: 'text', text: `${id}。`.repeat(150) + `末尾：${id}`, content_type: 'text' }]] }) });
    const textInputs = ['brief', 'brief-middle', 'brief-last'].map((canvasNodeId, index) => ({ canvasNodeId, cellId: 'text', slot: index + 1 }));
    const textOwner = normalizeWorkflowInputSlots({ ...owner, planning: undefined, inputs: { text: textInputs }, prompt: '使用 @[second-text]',
      promptReferences: [{ id: 'second-text', type: 'text', slot: 2, input: textInputs[1], label: '文本 2' }] });
    await c.edit([textOwner]);
    await c.edit([{ ...c.document.nodes[0], inputs: { text: [textInputs[0], textInputs[2]] } }]);
    await c.planner.start(owner.id);
    const lastRequest = window.requests.at(-1), lastContext = JSON.parse(lastRequest[2]);
    check(lastRequest[1] === '使用 【source2.text：文本 2】', 'planner delivery follows the second surviving text input');
    check(lastContext.sources[1].preview.endsWith('末尾：brief-last'), 'newly occupying referenced text pipe is delivered without truncation');
    await c.planner.cancel(owner.id);
    await c.edit([owner]);
    return { checks };
  });
  // Deleting a mention chip leaves only the user's remaining sentence in the delivered prompt.
  await editor.fill('只保留这段需求');
  await page.getByRole('button', { name: '编排工作流', exact: true }).click();
  await page.getByRole('button', { name: '取消等待', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.requests.at(-1)[1]), '只保留这段需求');
  await page.getByRole('button', { name: '取消等待', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log('planner references: native editor, persistence, scoped delivery, full text, cancellation, copy, stale/disconnected references:', result);
} finally { await browser.close(); await server.close(); }
