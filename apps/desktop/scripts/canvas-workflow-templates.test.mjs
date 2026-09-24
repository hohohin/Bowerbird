import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1609, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1540, height: 1100 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:1609/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  const result = await page.evaluate(async () => {
    const { newWorkflowNode, workflowOrder, workflowInputValues, generationInputNode, compileGenerationPrompt } = await import('/src/lib/canvasWorkflow.ts');
    const { buildWorkflowPlan } = await import('/src/lib/workflowPlanner.ts');
    const { captureWorkflowTemplate, parseWorkflowTemplate, instantiateWorkflowTemplate, reconfigureTemplateInstance, templateDefinition } = await import('/src/lib/workflowTemplates.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { captureCanvasClipboard, cloneCanvasClipboard } = await import('/src/lib/canvasClipboard.ts');
    const { api } = await import('/src/lib/api.ts');
    let checks = 0; const check = (value, message) => { checks++; if (!value) throw Error(message); };
    const owner = newWorkflowNode('planner', 0, 0, 'private-provider');
    const specs = { summary: '反推并生成', nodes: [{ id: 'start', kind: 'trigger' }, { id: 'read', kind: 'instruction', action: 'describe' }, { id: 'draw', kind: 'generation', prompt: '使用 {{read.text}} 和 {{source1.image}}', ratio: '3:4' }], edges: [
      { from: 'start', output: 'signal', to: 'read', input: 'signal' }, { from: 'source1', output: 'image', to: 'read', input: 'image' }, { from: 'read', output: 'text', to: 'draw', input: 'text' }, { from: 'source1', output: 'image', to: 'draw', input: 'image' }] };
    const original = buildWorkflowPlan(JSON.stringify(specs), owner, [{ id: 'source1', type: 'image', label: '参考', input: { assetId: 'private-asset', assetNodeId: 'private-node' } }], []).nodes;
    original[2].sessionNodeIds = ['private-session']; original[2].outputs.image = { type: 'image', assetIds: ['private-result'] };
    original[2].planning = { requestId: 'private-request' };
    original[1].overwriteDescribe = true;
    const template = captureWorkflowTemplate(original, new Set(original.map(node => node.id)), '商品海报');
    template.parameters = [{ id: 'brief', label: '场景要求', node: 'card2', field: 'suffix', defaultValue: '' }, { id: 'ratio', label: '成品比例', node: 'card2', field: 'ratio', defaultValue: '3:4' }];
    const raw = JSON.stringify(template);
    check(!/private-|assetId|sessionNodeIds|planning|provider/.test(raw), 'portable file has no private bindings, provider, outputs or execution state');
    check(template.inputs.length === 1 && template.outputs.length === 1, 'repeated boundary source deduplicates to one public input');
    const attached = structuredClone(template); attached.schemaVersion = 2;
    attached.inputs[0].content = { images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=' }] };
    check(parseWorkflowTemplate(JSON.stringify(attached)).inputs[0].content.images.length === 1, 'v2 portable attachment accepted');
    for (const mutate of [t => t.schemaVersion = 1, t => t.inputs[0].content.images[0].dataUrl = 'https://example.test/image.png', t => t.inputs[0].content.path = 'private', t => t.inputs[0].content.images[0].assetId = 'private']) {
      const bad = structuredClone(attached); mutate(bad); let blocked = false; try { parseWorkflowTemplate(JSON.stringify(bad)); } catch { blocked = true; } check(blocked, 'portable attachments reject unsupported identity and remote references');
    }
    const instance = instantiateWorkflowTemplate(template, { source1: { assetId: 'existing', assetNodeId: 'old' } }, { brief: '清晨窗边', ratio: '16:9' }, 'jimeng', [], 100, 150);
    check(instance.length === 3 && instance.every(node => node.provider === 'jimeng'), 'recipient provider and fresh cards');
    check(instance[1].overwriteDescribe === true, 'describe overwrite behavior survives capture and compilation');
    check(instance.every(node => !original.some(old => old.id === node.id)) && instance[2].prompt.includes('清晨窗边') && instance[2].ratio === '16:9', 'fresh identity and exposed parameters compiled');
    check(workflowOrder(instance, instance[0].id).length === 3, 'subworkflow uses existing scheduler');
    instance[1].outputs.text = { type: 'text', text: '原文输出' };
    const text = compileGenerationPrompt(instance[2], { ...workflowInputValues(instance, generationInputNode(instance[2])), image: [{ type: 'image', assetIds: ['existing'] }] });
    check(text.prompt.includes('原文输出') && text.assetIds[0] === 'existing', 'internal and recipient-source prompt references resolve');
    instance[2].sessionNodeIds = ['history']; instance[2].resultNodeIds = ['history-card'];
    const downstream = { ...newWorkflowNode('instruction', 0, 0, 'codex'), inputs: { image: [{ nodeId: instance[2].id, portId: 'image' }] }, outputs: { text: { type: 'text', text: 'stale' } } };
    const updated = reconfigureTemplateInstance([...instance, downstream], instance[0].id, { source1: { assetId: 'replacement' } }, { brief: '夜景', ratio: '1:1' }, () => false);
    check(updated[2].id === instance[2].id && updated[2].prompt.includes('夜景') && updated[2].inputs.image[0].assetId === 'replacement', 'reconfiguration preserves public endpoint identities and rebinds references');
    check(updated[2].sessionNodeIds[0] === 'history' && updated[2].resultNodeIds[0] === 'history-card' && !Object.keys(updated[3].outputs).length, 'history retained, downstream cache invalidated');
    let rejected = false; try { reconfigureTemplateInstance(updated, updated[0].id, {}, {}, () => true); } catch { rejected = true; } check(rejected, 'running instance locked');
    const edited = structuredClone(updated); edited[2].prompt += '手工改动';
    rejected = false; try { reconfigureTemplateInstance(edited, edited[0].id, {}, {}, () => false); } catch { rejected = true; } check(rejected, 'manual step edits never overwritten by configuration panel');
    const recaptured = captureWorkflowTemplate(instance, new Set(instance.map(node => node.id)), '复用子图');
    check(!JSON.stringify(recaptured).includes('templateInstance') && recaptured.plan.nodes.length === 3, 'instances can be composed into reusable flattened subgraphs');
    const exportedVersion = structuredClone(template); exportedVersion.name = '模板新版'; exportedVersion.revision = 2;
    check(instance[0].templateInstance.template.name === '商品海报' && instance[0].templateInstance.template.revision === 0, 'instance pins template snapshot independently of library updates');
    for (const mutate of [
      t => t.plan.nodes[1].provider = 'leak', t => t.inputs[0].assetId = 'leak', t => t.plan.edges[1].from = 'invented',
      t => t.outputs[0].node = 'missing', t => t.parameters[0].field = 'execute', t => t.schemaVersion = 99,
      t => t.plan.edges.push({ from: 'card2', output: 'image', to: 'card1', input: 'image' }),
      t => t.inputs.push(t.inputs[0]), t => t.parameters.push(t.parameters[0]), t => t.plan.nodes[2].prompt = '@[private]',
    ]) { const invalid = structuredClone(template); mutate(invalid); rejected = false; try { parseWorkflowTemplate(JSON.stringify(invalid)); } catch { rejected = true; } check(rejected, 'untrusted template rejected: ' + mutate.toString()); }
    rejected = false; try { instantiateWorkflowTemplate(template, {}, {}, 'codex', [], 0, 0); } catch { rejected = true; } check(rejected, 'required material cannot be omitted');
    rejected = false; try { instantiateWorkflowTemplate(template, { source1: { assetId: 'existing' } }, { brief: '{{invented.image}}' }, 'codex', [], 0, 0); } catch { rejected = true; } check(rejected, 'parameter text cannot inject bindings');
    const clipboard = captureCanvasClipboard('p', new Set(instance.map(node => node.id)), [], [], [], instance);
    check(cloneCanvasClipboard(clipboard, 'p', 0, 0).workflow.every(node => !node.templateInstance), 'ordinary clipboard copy cannot configure original instance by stale member IDs');
    const saved = await api.workflowTemplateSave(template);
    rejected = false; try { await api.workflowTemplateSave(template); } catch { rejected = true; } check(rejected, 'stale library update rejected');
    const { CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { useStore } = await import('/src/store.ts');
    const executable = structuredClone(template); executable.plan.nodes[1].action = 'reuse'; delete executable.plan.nodes[1].overwriteDescribe;
    const runtime = new CanvasWorkflowController('template-runtime'); await runtime.load();
    const runNodes = instantiateWorkflowTemplate(executable, { source1: { assetId: 'existing' } }, { brief: '运行参数' }, 'codex', [], 0, 0);
    const originalGenerate = useStore.getState().startGeneration, originalFind = api.localAgentFindAssetId;
    let generatedPrompt = '', generatedAssets;
    api.localAgentFindAssetId = async () => 'existing';
    useStore.setState({ startGeneration: async (...args) => {
      generatedPrompt = args[0]; generatedAssets = args[1]; const identity = args[12];
      useStore.setState(s => ({ genJobs: { ...s.genJobs, [identity.jobId]: { turns: [{ turnKey: identity.turnKey, images: ['result.png'] }] } } }));
      return { accepted: true };
    } });
    try { await runtime.edit(runNodes); await runtime.start(runNodes[0].id);
      check(runtime.document.run.status === 'done' && runtime.document.run.order.length === 3, 'compiled instance completes existing scheduler with mocked provider');
      check(generatedPrompt.includes('保持产品主体') && generatedPrompt.includes('运行参数') && generatedAssets.length === 1, 'runtime forwards upstream text, public parameter and recipient material');
    } finally { api.localAgentFindAssetId = originalFind; useStore.setState({ startGeneration: originalGenerate }); }
    const c = canvasWorkflowController('p'); await c.load();
    const nodes = instantiateWorkflowTemplate(saved, { source1: { assetId: 'existing', assetNodeId: 'old' } }, {}, 'codex', [], 400, 50);
    await c.edit(nodes); window.save();
    window.templateTest = { id: saved.id, root: nodes[0].id, definition: templateDefinition(nodes[2]) };
    return { checks };
  });
  await page.reload(); await page.locator('.workflow-template-instance').waitFor();
  await page.getByRole('button', { name: '配置子流程参数', exact: true }).click();
  await page.getByRole('textbox', { name: '场景要求', exact: true }).fill('柔和日光');
  await page.getByRole('button', { name: '保存子流程参数', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.ok(await page.evaluate(async () => { const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts'); return canvasWorkflowController('p').document.nodes.some(node => node.prompt.includes('柔和日光')); }));
  await page.getByRole('button', { name: '工作流模板库', exact: true }).click();
  await page.getByRole('button', { name: '商品海报 v1', exact: true }).click();
  await page.getByRole('button', { name: '导出分享文件', exact: true }).click();
  await page.getByText('流程文件已导出。接收者在模板库导入后选择自己的输入素材。', { exact: true }).waitFor();
  const exported = await page.evaluate(() => sessionStorage.getItem('workflow-template-export'));
  assert.ok(exported && !exported.includes('private-'));
  await page.locator('input[type=file]').setInputFiles({ name: 'shared.bbworkflow.json', mimeType: 'application/json', buffer: Buffer.from(exported) });
  await page.getByText('已导入模板，请配置当前画板的输入素材。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-template-library')).length), 2);
  await page.getByRole('combobox', { name: '图片输入 1', exact: true }).selectOption({ index: 1 });
  await page.getByRole('textbox', { name: '场景要求', exact: true }).fill('另一用户的海报');
  await page.getByRole('button', { name: '添加子流程到画板', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.workflow-template-instance').count(), 2);
  await page.getByRole('button', { name: '工作流模板库', exact: true }).click();
  await page.getByRole('button', { name: '商品海报 v1', exact: true }).first().click();
  await page.getByRole('button', { name: '编辑模板', exact: true }).click();
  assert.equal(await page.getByRole('checkbox', { name: '步骤 2 · 附加要求', exact: true }).isChecked(), true, 'imported parameter IDs remain editable');
  await page.getByRole('textbox', { name: '模板名称', exact: true }).fill('商品海报新版');
  await page.getByRole('button', { name: '保存模板', exact: true }).click();
  await page.getByRole('button', { name: '商品海报新版 v2', exact: true }).waitFor();
  await page.getByRole('button', { name: '删除模板', exact: true }).click();
  await page.getByRole('button', { name: '确认删除模板', exact: true }).click();
  await page.getByRole('button', { name: '商品海报新版 v2', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.workflow-template-instance').count(), 2, 'library deletion preserves instances');
  assert.equal(await page.getByText('保存选中的步骤', { exact: true }).count(), 0, 'library no longer asks to select cards again');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.evaluate(async () => {
    const snapshot = window.snapshot(); snapshot.nodes = snapshot.nodes.filter(node => node.id === 'old');
    Object.assign(snapshot.nodes[0], { x: 80, y: 100 });
    snapshot.nodes.push({ ...snapshot.nodes[0], id: 'copy', kind: 'note', assetId: null, x: 80, y: 310, width: 220, height: 160,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], cells: [[{ id: 'body', content_type: 'text', text: '选区里的产品文案', bold: false, italic: false, align: 'left' }]] }) });
    snapshot.view = { ...snapshot.view, zoom: 1, panX: 50, panY: 70 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    const { buildWorkflowPlan } = await import('/src/lib/workflowPlanner.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const built = buildWorkflowPlan(JSON.stringify({ summary: '选区', nodes: [{ id: 'start', kind: 'trigger' }, { id: 'draw', kind: 'generation', prompt: '操作指令：用 {{photo.image}} 搭配 {{copy.text}}' }], edges: [
      { from: 'start', output: 'signal', to: 'draw', input: 'signal' }, { from: 'photo', output: 'image', to: 'draw', input: 'image' }, { from: 'copy', output: 'text', to: 'draw', input: 'text' }] }), newWorkflowNode('planner', 0, 0, 'codex'), [
      { id: 'photo', label: '图片', type: 'image', input: { assetId: 'existing', assetNodeId: 'old' } }, { id: 'copy', label: '文案', type: 'text', input: { canvasNodeId: 'copy', cellId: 'body' } }], []).nodes;
    built.forEach((node, i) => Object.assign(node, { x: 370 + i * 370, y: 100 }));
    sessionStorage.setItem('workflow-p', JSON.stringify({ revision: 1, document: { schema_version: 1, nodes: built, run: null } }));
  });
  await page.reload(); await page.locator('.workflow-card.is-generation').waitFor();
  await page.evaluate(() => { window.templateImageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII='; });
  const imageBox = await page.locator('[data-canvas-node-id="old"]').boundingBox();
  const lastBox = await page.locator('.workflow-card.is-generation').boundingBox();
  await page.mouse.move(imageBox.x - 15, imageBox.y - 15); await page.mouse.down();
  await page.mouse.move(lastBox.x + lastBox.width + 15, Math.max(lastBox.y + lastBox.height, imageBox.y + 400) + 15, { steps: 10 }); await page.mouse.up();
  assert.equal(await page.locator('.workflow-card.is-selected').count(), 2);
  assert.ok((await page.locator('[data-canvas-node-id="copy"]').getAttribute('class')).includes('is-selected'));
  const beforeCancel = await page.evaluate(() => sessionStorage.getItem('workflow-template-library'));
  await page.locator('[data-canvas-node-id="old"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '存为模板', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.evaluate(() => sessionStorage.getItem('workflow-template-library')), beforeCancel);
  for (const [images, text] of [[true, true], [false, true], [true, false], [false, false]]) {
    await page.locator('.workflow-card.is-generation header strong').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '存为模板', exact: true }).click();
    await page.getByRole('dialog', { name: '存为模板', exact: true }).waitFor();
    await page.getByRole('textbox', { name: '模板名称', exact: true }).fill(`选区-${images}-${text}`);
    await page.getByRole('checkbox', { name: '带上素材', exact: true }).setChecked(images);
    await page.getByRole('checkbox', { name: '带上文本', exact: true }).setChecked(text);
    if (images && text) await page.screenshot({ path: '../../.tmp/workflow-template-save.png', animations: 'disabled' });
    if (images && text) {
      await page.evaluate(() => { window.failTemplateSave = true; });
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '模拟模板保存失败' }).waitFor();
      assert.equal(await page.getByRole('textbox', { name: '模板名称', exact: true }).inputValue(), '选区-true-true');
      assert.equal(await page.evaluate(() => sessionStorage.getItem('workflow-template-library')), beforeCancel);
      await page.evaluate(() => { window.failTemplateSave = false; });
    }
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const saved = await page.evaluate(name => JSON.parse(sessionStorage.getItem('workflow-template-library')).find(item => item.name === name), `选区-${images}-${text}`);
    assert.equal(saved.plan.nodes.length, 2, 'right-click retains selected steps only');
    assert.equal(!!saved.inputs.find(input => input.type === 'image').content, images);
    assert.equal(!!saved.inputs.find(input => input.type === 'text').content, text);
    assert.ok(saved.plan.nodes[1].prompt.includes('操作指令'));
    assert.equal(JSON.stringify(saved).includes('选区里的产品文案'), text);
    assert.equal(JSON.stringify(saved).includes('data:image/'), images);
    assert.ok(!JSON.stringify(saved).includes('assetId'), 'portable contents contain bytes, not library identities');
  }
  await page.getByRole('button', { name: '工作流模板库', exact: true }).click();
  await page.getByPlaceholder('搜索名称或说明').fill('选区-true-true');
  await page.getByRole('button', { name: '选区-true-true v1', exact: true }).click();
  await page.getByRole('button', { name: '导出分享文件', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-template-export')).schemaVersion === 2);
  const portable = await page.evaluate(() => sessionStorage.getItem('workflow-template-export'));
  await page.locator('input[type=file]').setInputFiles({ name: 'carried.bbworkflow.json', mimeType: 'application/json', buffer: Buffer.from(portable) });
  await page.getByText('已导入模板，请配置当前画板的输入素材。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '添加子流程到画板', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const carried = await page.evaluate(() => ({ snapshot: window.snapshot(), doc: JSON.parse(sessionStorage.getItem('workflow-p')).document, imports: window.calls.filter(call => call.command === 'import_image_bytes') }));
  assert.equal(carried.imports.length, 1);
  assert.equal(carried.imports[0].args.source, 'workflow-template');
  assert.ok(carried.snapshot.nodes.some(node => !['old', 'copy'].includes(node.id) && node.payloadJson.includes('选区里的产品文案')));
  const root = carried.doc.nodes.find(node => node.templateInstance);
  assert.ok(root && !JSON.stringify(root).includes('data:image/'), 'canvas instance does not duplicate embedded files');
  assert.ok(Object.values(root.templateInstance.bindings).every(binding => binding.canvasNodeId !== 'copy' && binding.assetId !== 'existing'));
  await page.getByRole('button', { name: '工作流模板库', exact: true }).click();
  await page.getByRole('button', { name: '选区-true-true v1', exact: true }).first().click();
  await page.screenshot({ path: '../../.tmp/workflow-template-library.png' });
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.calls.filter(call => /generate|agent_run_start|describe/.test(call.command)).length), 0);
  console.log('workflow templates: portable graph, parameters, versioning, persistence, recovery, sharing and UI', result);
} catch (error) { console.error(await page.locator('[role=dialog]').innerText().catch(() => 'No dialog')); console.error(errors, await page.evaluate(() => window.calls.slice(-12))); throw error;
} finally { await browser.close(); await server.close(); }
