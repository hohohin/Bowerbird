import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: '.tmp/auto-connect-runtime-vite', optimizeDeps: { entries: ['scripts/fixtures/canvas-reference/preview.html'] },
  server: { host: '127.0.0.1', port: 1749, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
try {
  await page.goto('http://127.0.0.1:1749/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  const result = await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { CanvasWorkflowController, filterAutomaticMediaValues } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { emptyWorkflow, newWorkflowNode, compileGenerationPrompt, compileAgentPrompt, workflowInputValues, generationInputNode } = await import('/src/lib/canvasWorkflow.ts');
    const { videoFrameInputValues } = await import('/src/lib/workflowVideoFrames.ts');
    const { captureWorkflowTemplate, instantiateWorkflowTemplate, reconfigureTemplateInstance, parseWorkflowTemplate } = await import('/src/lib/workflowTemplates.ts');
    const { includeTemplateContent } = await import('/src/lib/workflowTemplateContent.ts');
    const check = (ok, reason) => { if (!ok) throw Error(reason); };
    const rejects = async (work, reason) => { let failed = false; try { await work(); } catch { failed = true; } check(failed, reason); };
    const docs = new Map(); let saves = 0, failSave = false, runs = 0;
    const table = { ...window.snapshot().nodes[0], id: 'content', kind: 'note', assetId: null, role: null,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', cells: [[{ id: 'first', text: '' }]], text: '', member_ids: [] }) };
    const canvas = { ...window.snapshot(), nodes: [table] };
    api.canvasWorkflowAuthorize = async () => {};
    api.canvasWorkflowGet = async id => structuredClone(docs.get(id) ?? { revision: 0, document: emptyWorkflow() });
    api.canvasWorkflowSave = async (id, revision, document, createdContent) => {
      if (failSave) throw Error('simulated atomic save failure');
      saves++;
      docs.set(id, structuredClone({ revision: revision + 1, document }));
      if (createdContent) canvas.nodes.push({ ...createdContent, hiddenAt: null });
      return revision + 1;
    };
    api.projectCanvasGet = async () => structuredClone(canvas);
    api.projectThreadCreate = async () => { runs++; throw Error('connecting must not execute'); };
    api.getAssetsByIds = async ids => ids.map(id => ({ id, duration: ['video', 'audio'].includes(id) ? 10 : null, store_path: `${id}.${id === 'video' ? 'mp4' : id === 'audio' ? 'mp3' : 'png'}` }));
    const controller = new CanvasWorkflowController('auto-runtime'); await controller.load();
    const source = { ...newWorkflowNode('instruction', 0, 0, 'codex'), id: 'source', action: 'reuse',
      outputs: { text: { type: 'text', text: 'reference text' }, image: { type: 'image', assetIds: ['photo'] } } };
    const target = { ...newWorkflowNode('generation', 400, 0, 'codex'), id: 'target', prompt: 'draw' };
    const imageOnly = { ...newWorkflowNode('instruction', 400, 300, 'codex'), id: 'image-only', action: 'reuse' };
    await controller.edit([source, target, imageOnly]);
    const outputs = [{ type: 'text', binding: { nodeId: 'source', portId: 'text' } },
      { type: 'image', media: 'image', binding: { nodeId: 'source', portId: 'image' } }];
    let beforeSaves = saves;
    const connected = await controller.connectAutomatic(outputs, { nodeId: 'target' });
    let receiver = controller.document.nodes.find(node => node.id === 'target');
    const connection = receiver.inputs.text[0].autoConnect;
    check(saves === beforeSaves + 1, 'two types save once');
    check(receiver.inputs.image[0].autoConnect === connection, 'one gesture identity');
    const compiled = compileGenerationPrompt(receiver, workflowInputValues(controller.document.nodes, generationInputNode(receiver)));
    check(compiled.prompt.includes('reference text') && compiled.assetIds.join() === 'photo', 'connected inputs reach request without at mentions');
    beforeSaves = saves; await controller.connectAutomatic(outputs, { nodeId: 'target' });
    check(saves === beforeSaves, 'duplicate gesture is a no-op');
    await controller.connectAutomatic(outputs, { nodeId: 'image-only' });
    check(!controller.document.nodes.find(node => node.id === 'image-only').inputs.text?.length, 'image receiver excludes text');
    const reloaded = new CanvasWorkflowController('auto-runtime'); await reloaded.load();
    check(reloaded.document.nodes.find(node => node.id === 'target').inputs.text[0].autoConnect === connection, 'metadata survives reload');
    await controller.disconnectAutomatic(connection);
    receiver = controller.document.nodes.find(node => node.id === 'target');
    check(!receiver.inputs.text.length && !receiver.inputs.image.length, 'disconnect removes complete logical link');
    await controller.edit(connected.after.nodes);
    check(controller.document.nodes.find(node => node.id === 'target').inputs.image.length === 1, 'undo restores both bindings');

    beforeSaves = saves;
    const fresh = { ...newWorkflowNode('generation', 800, 0, 'codex'), id: 'fresh', prompt: 'fresh' };
    await controller.connectAutomatic(outputs, { nodeId: 'fresh' }, { createNodes: [fresh] });
    check(saves === beforeSaves + 1 && docs.get('auto-runtime').document.nodes.find(node => node.id === 'fresh').inputs.text.length, 'create and connect save once');
    const blocked = { ...newWorkflowNode('instruction', 1200, 0, 'codex'), id: 'blocked' };
    beforeSaves = saves;
    await rejects(() => controller.connectAutomatic([{ type: 'text', binding: outputs[0].binding }], { nodeId: 'blocked' }, { createNodes: [blocked] }), 'incompatible new card rejected');
    check(saves === beforeSaves && !controller.document.nodes.some(node => node.id === 'blocked'), 'incompatible gesture has no partial node');
    await rejects(() => controller.connectAutomatic([{ type: 'image', binding: { nodeId: 'target', portId: 'image' } }], { nodeId: 'source' }), 'cycle rejected before save');

    beforeSaves = saves;
    const noteBefore = canvas.nodes.find(node => node.id === 'content').payloadJson;
    await controller.connectAutomatic(outputs, { canvasNodeId: 'content' });
    const writers = controller.document.nodes.filter(node => node.textTarget?.nodeId === 'content');
    check(writers.length === 2 && saves === beforeSaves + 1, 'native receiver commits two writers once');
    check(new Set(writers.map(node => node.textTarget.cellId)).size === 2, 'writers own distinct stable destinations');
    const nativeConnection = writers[0].inputs.text?.[0]?.autoConnect ?? writers[0].inputs.image?.[0]?.autoConnect;
    beforeSaves = saves; await controller.connectAutomatic(outputs, { canvasNodeId: 'content' });
    check(saves === beforeSaves, 'native duplicate does not allocate writer');
    check(runs === 0, 'connection itself does not start tasks');
    const rejectExecution = api.projectThreadCreate;
    api.projectThreadCreate = async value => value;
    api.projectCanvasNoteUpdate = async (id, payloadJson) => { canvas.nodes.find(node => node.id === id).payloadJson = payloadJson; };
    api.projectCanvasNodeUpdate = async (id, update) => Object.assign(canvas.nodes.find(node => node.id === id), update);
    for (const writer of writers) {
      await controller.start(writer.id, true);
      check(controller.document.run.status === 'done', 'native writer executes successfully: ' + JSON.stringify(controller.document.run));
    }
    const delivered = JSON.parse(canvas.nodes.find(node => node.id === 'content').payloadJson).cells.flat();
    check(delivered.some(cell => cell.text === 'reference text') && delivered.some(cell => cell.image_refs?.some(ref => ref.asset_id === 'photo')), 'native graph delivers both content types into real cells');
    const contentAfterDelivery = canvas.nodes.find(node => node.id === 'content').payloadJson;
    check(contentAfterDelivery !== noteBefore, 'delivery updates content');
    api.projectThreadCreate = rejectExecution;
    await controller.disconnectAutomatic(nativeConnection);
    check(!controller.document.nodes.some(node => node.textTarget?.nodeId === 'content') && canvas.nodes.find(node => node.id === 'content').payloadJson === contentAfterDelivery, 'disconnect preserves delivered native content');

    for (const axis of ['row', 'column']) {
      const id = `${axis}-content`;
      canvas.nodes.push({ ...table, id, payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', cells: [
        [{ id: `${id}-a`, text: 'keep A' }, { id: `${id}-b`, text: 'keep B' }],
        [{ id: `${id}-c`, text: 'keep C' }, { id: `${id}-d`, text: 'keep D' }],
      ], text: '', member_ids: [] }) });
      const destination = { canvasNodeId: id, cellId: `${axis}:${id}-a` };
      beforeSaves = saves; await controller.connectAutomatic(outputs, destination);
      const axisWriters = controller.document.nodes.filter(node => node.textTarget?.nodeId === id);
      check(saves === beforeSaves + 1 && axisWriters.length === 2 && axisWriters.every(node => node.textTarget.appendAxis === axis), 'axis accepts both types in one edit');
      beforeSaves = saves; await controller.connectAutomatic(outputs, destination);
      check(saves === beforeSaves, 'same axis duplicate is a no-op');
      api.projectThreadCreate = async value => value;
      for (const writer of axisWriters) { await controller.start(writer.id, true); check(controller.document.run.status === 'done', 'axis writer completes'); }
      const cells = JSON.parse(canvas.nodes.find(node => node.id === id).payloadJson).cells;
      const received = axis === 'row' ? cells[0] : cells.map(row => row[0]);
      check(received.some(cell => cell.text === 'reference text') && received.some(cell => cell.image_refs?.some(ref => ref.asset_id === 'photo')), 'axis deliveries use distinct cells');
      check(cells.flat().filter(cell => /^keep /.test(cell.text)).length === 4, 'axis delivery preserves existing content');
      api.projectThreadCreate = rejectExecution;
      const group = Object.values(axisWriters[0].inputs).flat()[0].autoConnect;
      await controller.disconnectAutomatic(group);
    }
    beforeSaves = saves;
    const textCell = delivered.find(cell => cell.text === 'reference text');
    await controller.connectAutomatic(outputs, { canvasNodeId: 'content', cellId: textCell.id });
    const fixedWriter = controller.document.nodes.find(node => node.textTarget?.nodeId === 'content');
    check(saves === beforeSaves + 1 && fixedWriter.inputs.text?.length && !fixedWriter.inputs.image?.length, 'explicit text cell receives only text');
    canvas.groups.push({ id: 'media-folder' });
    for (const [ordinal, id] of ['photo', 'video', 'audio'].entries()) {
      canvas.nodes.push({ ...table, id: `group-${id}`, kind: 'asset', assetId: id, payloadJson: null });
      canvas.groupItems.push({ groupId: 'media-folder', nodeId: `group-${id}`, ordinal });
    }
    await controller.connectAutomatic([{ type: 'image', binding: { groupId: 'media-folder', assetIds: ['photo', 'video', 'audio'] } }], { canvasNodeId: 'content' });
    const groupWriter = controller.document.nodes.find(node => node.textTarget?.nodeId === 'content' && node.inputs.image?.[0]?.groupId);
    api.projectThreadCreate = async value => value;
    await controller.start(groupWriter.id, true);
    check(controller.document.run.status === 'done', 'automatic media folder writer completes');
    check(controller.document.nodes.find(node => node.id === groupWriter.id).outputs.image.assetIds.join() === 'photo,video', 'folder refresh retains video before receiver filters out audio');
    api.projectThreadCreate = rejectExecution;

    const draw = { ...newWorkflowNode('generation', 0, 600, 'codex'), id: 'draw', prompt: 'draw' };
    const reuse = { ...newWorkflowNode('instruction', 400, 600, 'codex'), id: 'reuse', action: 'reuse' };
    await controller.edit([...controller.document.nodes, draw, reuse]);
    beforeSaves = saves;
    const relayResult = await controller.connectAutomatic([{ type: 'image', media: 'image', binding: { nodeId: 'draw', portId: 'image' } }], { nodeId: 'reuse' });
    check(saves === beforeSaves + 1 && relayResult.createdNodeIds.length === 1, 'relay and consumer commit once');
    check(controller.document.nodes.find(node => node.id === 'reuse').inputs.image[0].cellId === '*latest-image', 'generation retains latest history delivery');
    beforeSaves = saves;
    await controller.connectAutomatic([{ type: 'image', media: 'image', binding: { nodeId: 'draw', portId: 'image' } }], { nodeId: 'reuse' });
    check(saves === beforeSaves, 'relay duplicate respects single-input receiver');
    const completion = { ...newWorkflowNode('trigger', 900, 600, 'codex'), id: 'completion' };
    beforeSaves = saves;
    const triggerConnection = await controller.connectAutomatic([{ type: 'image', media: 'image', binding: { nodeId: 'draw', portId: 'image' } }], { nodeId: completion.id }, { createNodes: [completion] });
    const completionInput = controller.document.nodes.find(node => node.id === completion.id).inputs.completion[0];
    check(saves === beforeSaves + 1 && completionInput.nodeId === 'draw' && !completionInput.canvasNodeId && !completionInput.mediaFilter && triggerConnection.createdNodeIds.join() === completion.id, 'completion event keeps producer identity even when image relay exists');

    const filterNode = { ...target, inputs: { image: [{ assetId: 'photo', autoConnect: 'filter', mediaFilter: ['image'] }] } };
    const values = { image: [{ type: 'image', assetIds: ['photo', 'video', 'audio'] }] };
    await filterAutomaticMediaValues(filterNode, values);
    check(values.image[0].assetIds.join() === 'photo', 'mixed media projected by actual asset metadata');
    const textSource = { type: 'text', text: '视频@图片1 图片@图片2', assetIds: ['video', 'photo'], imageRefs: [{ asset_id: 'video', token: '@图片1' }, { asset_id: 'photo', token: '@图片2' }], table: { rows: [['视频@图片1', '图片@图片2']] } };
    const textNode = { ...target, inputs: { text: [{ canvasNodeId: 'content', cellId: '*text', autoConnect: 'filter-text', mediaFilter: ['image'] }] } };
    const texts = { text: [textSource] };
    await filterAutomaticMediaValues(textNode, texts);
    const filteredText = compileGenerationPrompt(textNode, texts);
    check(filteredText.prompt.includes('视频 图片@图片1') && !filteredText.prompt.includes('视频@图片1'), 'filtered inline reference cannot alias another attachment');
    const filteredTable = compileAgentPrompt({ ...textNode, kind: 'agent', agentTransport: 'local-ds' }, texts);
    check(JSON.stringify(filteredTable).includes('图片@图片1') && !JSON.stringify(filteredTable).includes('视频@图片1'), 'filtered table cells cannot alias another attachment');
    check(textSource.assetIds.join() === 'video,photo' && textSource.text.includes('视频@图片1') && textSource.table.rows[0][0] === '视频@图片1', 'receiver filtering never mutates upstream output');
    await rejects(() => filterAutomaticMediaValues(filterNode, { image: [{ type: 'image', assetIds: ['video'] }] }), 'empty compatible projection fails');
    const videoNode = { ...target, generation: { media: 'video' }, inputs: { image: [{ assetNodeId: 'video-card', assetId: 'video', autoConnect: 'video', mediaFilter: ['video'] }] } };
    const videos = { image: [{ type: 'image', assetIds: ['video'] }] };
    await filterAutomaticMediaValues(videoNode, videos);
    check(videoFrameInputValues(videoNode, videos, []).length === 0 && videos.image[0].assetIds[0] === 'video', 'new video connection stays raw video');
    await rejects(() => filterAutomaticMediaValues({ ...videoNode, generation: { media: 'image' } }, { image: [{ type: 'image', assetIds: ['video'] }] }), 'changed receiver mode rejects old video mapping');
    const legacy = { ...videoNode, kind: 'instruction', inputs: { image: [{ assetNodeId: 'video-card', assetId: 'video' }] } };
    check(videoFrameInputValues(legacy, videos, []).length === 1, 'legacy explicit frame connection preserved');

    const templateNodes = connected.after.nodes.filter(node => node.id === 'source' || node.id === 'target');
    const templateTrigger = { ...newWorkflowNode('trigger', 0, 0, 'codex'), id: 'template-trigger' };
    templateTrigger.inputs.completion = [{ nodeId: 'target', portId: 'image', autoConnect: 'completion-group' }];
    templateNodes[0].inputs.signal = [{ nodeId: templateTrigger.id, portId: 'signal', autoConnect: 'signal-group' }];
    templateNodes.unshift(templateTrigger);
    const template = captureWorkflowTemplate(templateNodes, new Set(templateNodes.map(node => node.id)), 'automatic template');
    check(template.schemaVersion === 5 && !JSON.stringify(template).includes(connection), 'portable automatic template replaces graph identity with aliases');
    check(template.plan.edges.filter(edge => edge.autoConnect).length === 4 && template.plan.edges.some(edge => edge.from === 'start' && edge.autoConnect), 'template keeps automatic control and both consumed content types');
    check((await includeTemplateContent(template, {}, false, false)).schemaVersion === 5, 'attachment preparation retains v5 protocol');
    const instantiate = () => instantiateWorkflowTemplate(template, {}, {}, 'codex', [], 0, 0);
    const instance = instantiate(), otherInstance = instantiate();
    const instanceTarget = instance.find(node => node.kind === 'generation'), instanceSource = instance.find(node => node.kind === 'instruction');
    const group = instanceTarget.inputs.text[0].autoConnect;
    check(instance[0].inputs.completion[0].nodeId === instanceTarget.id && instance[0].inputs.completion[0].autoConnect !== 'completion-group', 'template completion preserves producer and has a fresh group');
    check(group && group === instanceTarget.inputs.image[0].autoConnect && group !== connection && group !== otherInstance.find(node => node.kind === 'generation').inputs.text[0].autoConnect, 'instances preserve grouping but never share logical connection IDs');
    check(instanceTarget.inputs.image[0].mediaFilter.join() === 'image', 'template restores image acceptance filter');
    instanceSource.outputs = structuredClone(source.outputs);
    const request = compileGenerationPrompt(instanceTarget, workflowInputValues(instance, generationInputNode(instanceTarget)));
    check(request.prompt.includes('reference text') && request.assetIds.join() === 'photo', 'template input contributes without explicit prompt references');
    const configured = reconfigureTemplateInstance(instance, instance[0].id, {}, {}, () => false);
    const configuredTarget = configured.find(node => node.kind === 'generation');
    check(configuredTarget.inputs.text[0].autoConnect === configuredTarget.inputs.image[0].autoConnect && configuredTarget.id === instanceTarget.id, 'reconfigure retains automatic semantics and card endpoints');
    const boundary = captureWorkflowTemplate([templateNodes.find(node => node.id === 'target')], new Set(['target']), 'boundary automatic');
    const publicBindings = Object.fromEntries(boundary.inputs.map(input => [input.id, input.type === 'text' ? { canvasNodeId: 'content', cellId: textCell.id, autoConnect: 'foreign' } : { assetId: 'photo', autoConnect: 'foreign', mediaFilter: ['audio'] }]));
    const boundaryInstance = instantiateWorkflowTemplate(boundary, publicBindings, {}, 'codex', [], 0, 0);
    check(boundaryInstance[1].inputs.text[0].autoConnect === boundaryInstance[1].inputs.image[0].autoConnect && boundaryInstance[1].inputs.text[0].autoConnect !== 'foreign' && boundaryInstance[1].inputs.image[0].mediaFilter.join() === 'image', 'external inputs use template semantics instead of foreign graph metadata');
    for (const mutate of [value => value.schemaVersion = 4, value => value.plan.edges.find(edge => edge.autoConnect).autoConnect = 'private-id', value => value.plan.edges.find(edge => edge.mediaFilter).mediaFilter = ['image', 'image']]) {
      const invalid = structuredClone(template); mutate(invalid); await rejects(() => parseWorkflowTemplate(JSON.stringify(invalid)), 'malformed portable metadata rejected');
    }
    const persisted = JSON.stringify(docs.get('auto-runtime'));
    failSave = true;
    await rejects(() => controller.connectAutomatic(outputs, { nodeId: 'failure' }, { createNodes: [{ ...fresh, id: 'failure' }] }), 'save failure surfaced');
    check(JSON.stringify(docs.get('auto-runtime')) === persisted && runs === 0, 'failure leaves durable graph intact and no connection executes models');
    return 'PASS automatic runtime: atomic multi-content/new-card/relay/native/axis commits and delivery, duplicate/reload/undo/disconnect, cycles/media filtering/old frames, portable template grouping and compilation, failed save and zero model execution';
  });
  assert.match(result, /^PASS/); console.log(result);
} finally { await browser.close(); await server.close(); }
