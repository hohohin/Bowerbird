import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, cacheDir: '.tmp/workflow-image-projection-vite',
  server: { middlewareMode: true, hmr: false, watch: null } });
try {
  const { hiddenWorkflowSessionIds, workflowGenerationCardProjection, workflowGenerationActivity } =
    await server.ssrLoadModule('/src/lib/canvasSessionOutputs.ts');
  const { canvasConversationCards } = await server.ssrLoadModule('/src/lib/canvasConversationCards.ts');
  const { newWorkflowNode } = await server.ssrLoadModule('/src/lib/canvasWorkflow.ts');
  const { firstWorkflowVideoOutputPoint, workflowArrangementEdges } = await server.ssrLoadModule('/src/lib/canvasOutputPlacement.ts');
  const group = 'workflow:["p","generator"]';
  const node = (id, kind, data, createdAt = 0) => ({ id, kind, projectId: 'p', hiddenAt: null, createdAt, payloadJson: JSON.stringify(data) });
  const session = (id, job, status, extra = {}, createdAt = 0) => node(id, 'prompt',
    { job_id: job, turn_key: id, status, workflow_generation_group: group, ...extra }, createdAt);
  const image = (id, job, turn, createdAt) => ({
    ...node(id, 'asset', { execution: { job_id: job, turn_key: turn }, snapshot: { name: 'image.png', width: 190, height: 150 } }, createdAt),
    role: 'output', assetId: 'image',
  });
  const first = session('first', 'job1', 'done');
  const second = session('second', 'job2', 'queued', {}, 2);
  const workflow = { ...newWorkflowNode('generation', 0, 0, 'codex'), id: 'generator', sessionNodeIds: ['first', 'second'],
    activeSessionNodeId: 'second', outputs: { image: { nodeIds: ['second'], type: 'image' } } };
  const firstImage = image('first-image', 'job1', 'first', 1);
  const duplicate = { ...firstImage, id: 'copied-reference', role: 'reference' };
  const projection = (nodes, cards = [workflow], options = {}, unavailable) => workflowGenerationCardProjection(
    { nodes: cards, run: null, schema_version: 1, ...options }, nodes, canvasConversationCards(nodes, {}), unavailable);
  const one = projection([first, firstImage, duplicate]);
  assert.equal(one.anchors.get('generator')?.id, 'first');
  assert.equal(one.origins.get('first-image')?.id, 'generator');
  assert.equal(one.origins.has('copied-reference'), false, 'another canvas instance of the same asset is not the delivered output');
  assert.equal(projection([first, { ...firstImage, hiddenAt: 20 }]).anchors.size, 0);
  assert.equal(projection([first, { ...firstImage, payloadJson: '{' }]).anchors.size, 0, 'invalid projection payload cannot replace the source');
  assert.equal(projection([first, firstImage], [workflow], {}, new Set(['first-image'])).anchors.size, 0, 'an undrawable product cannot replace the source');

  assert.deepEqual([...hiddenWorkflowSessionIds([workflow], [second])], ['second']);
  assert.equal(hiddenWorkflowSessionIds([workflow], [first, firstImage, second]).has('second'), false);
  const activity = (step, nodes, jobs = {}) => {
    const { running, jobId, failed, session: active } = workflowGenerationActivity(workflow, { status: 'running', steps: { [workflow.id]: step } }, nodes, jobs);
    return { running, jobId, failed, sessionId: active?.id };
  };
  assert.deepEqual(activity({ status: 'done', jobId: 'job2', turnKey: 'second' }, [second]),
    { running: true, jobId: 'job2', failed: false, sessionId: 'second' });
  assert.deepEqual(activity({ status: 'running', jobId: 'job3', turnKey: 'third' }, [first]),
    { running: true, jobId: 'job3', failed: false, sessionId: undefined });
  const failed = session('second', 'job2', 'failed', {}, 2);
  assert.deepEqual(activity(undefined, [first, failed]), { running: false, jobId: 'job2', failed: true, sessionId: 'second' });
  assert.deepEqual([...hiddenWorkflowSessionIds([workflow], [failed])], ['second'], 'first failure belongs to the generation card');
  assert.equal(hiddenWorkflowSessionIds([workflow], [first, firstImage, failed]).has('second'), false, 'rerun failure stays on the existing gallery');
  assert.equal(projection([first, firstImage, failed]).anchors.get('generator')?.id, 'first');
  const cancelled = session('second', 'job2', 'cancelled', {}, 2);
  const liveError = { job2: { running: false, turns: [{ turnKey: 'second', error: 'stopped' }] } };
  assert.equal(activity(undefined, [cancelled], liveError).failed, false);
  assert.equal(activity(undefined, [second], liveError).failed, true, 'matching live failure precedes the canvas snapshot');
  const done = session('second', 'job2', 'done', {}, 2);
  const continuation = { job2: { running: true, turns: [{ turnKey: 'second' }, { turnKey: 'continued' }] } };
  assert.equal(workflowGenerationActivity(workflow, undefined, [done], continuation).running, false);

  const secondImage = image('second-image', 'job2', 'second', 3);
  const submitted = { id: 'current-run', status: 'done', steps: { generator: { status: 'done', generationSubmission: 'submitted', jobId: 'job2', turnKey: 'second' } } };
  const submittedActivity = (nodes, jobs = {}, displayable) => workflowGenerationActivity(workflow, submitted, nodes, jobs, displayable);
  assert.equal(submittedActivity([first, firstImage]).running, true, 'a saved handoff owns its live card before the current session or job reaches the projection');
  assert.equal(submittedActivity([first, firstImage], { job2: { running: false, turns: [{ turnKey: 'another-turn', images: ['older.png'] }] } }).running, true);
  assert.equal(submittedActivity([first, firstImage, failed]).terminal, 'failed');
  assert.equal(submittedActivity([first, firstImage, cancelled]).terminal, 'cancelled');
  assert.equal(submittedActivity([first, firstImage, done]).awaitingOutput, true, 'a success receipt alone cannot close a current live expansion');
  assert.equal(submittedActivity([first, firstImage, done, secondImage], {}, new Set(['first-image'])).terminal, undefined);
  assert.equal(submittedActivity([first, firstImage, done, secondImage]).terminal, 'done');
  const removed = submittedActivity([first, firstImage, done, { ...secondImage, hiddenAt: 4 }]);
  assert.equal(submittedActivity([first, firstImage, done, { ...secondImage, assetId: null }]).awaitingOutput, false,
    'a deleted original remains an exact historical tombstone and cannot restart delivery');
  assert.equal(removed.running || removed.awaitingOutput, false, 'an explicitly removed historical output is not a pending delivery');
  const splitting = { generation_group_dissolved: true };
  const split = projection([session('first', 'job1', 'done', splitting), session('second', 'job2', 'done', splitting, 2), firstImage, secondImage]);
  assert.equal(split.anchors.get('generator')?.id, 'second-image');
  assert.equal(split.origins.get('first-image')?.id, 'generator', 'both historical products retain exact source after dissolving the gallery');
  assert.equal(split.origins.get('second-image')?.id, 'generator');

  const loop = { ...newWorkflowNode('loop', 0, 0, ''), id: 'loop' };
  const trigger = { ...newWorkflowNode('trigger', 0, 0, ''), id: 'trigger', inputs: { signal: [{ canvasNodeId: 'first' }] } };
  const table = node('table', 'note', { schema_version: 1, note_type: 'text', member_ids: [],
    cells: [[{ id: 'cell', text: '', content_type: 'image' }]] });
  const writer = { ...newWorkflowNode('text', 0, 0, ''), id: 'writer', inputs: { image: [{ nodeId: 'generator', portId: 'image' }] },
    textTarget: { nodeId: 'table', cellId: 'cell', image: true } };
  assert.equal(projection([first, firstImage], [loop, { ...workflow, inputs: { image: [{ nodeId: 'loop' }] } }]).anchors.size, 0);
  assert.equal(projection([first, firstImage], [workflow, trigger]).anchors.size, 0);
  assert.equal(projection([first, firstImage, table], [workflow, writer]).anchors.size, 0);
  assert.equal(projection([first, firstImage], [workflow], { runs: [{ status: 'running', steps: {}, loop: { bodyIds: ['generator'] } }] }).anchors.size, 0);

  const remote = { ...workflow, generation: { media: 'video' }, outputs: { image: { type: 'image', assetIds: ['clip'] } } };
  const remoteOutput = { ...image('gen-output:job1:first:clip', 'job1', 'first', 1), assetId: 'clip',
    payloadJson: JSON.stringify({ execution: { job_id: 'job1', turn_key: 'first' }, snapshot: { name: 'clip' } }) };
  const local = { ...newWorkflowNode('comfy-video', 120, 80, ''), id: 'local' };
  const localOutput = { ...node('workflow-comfy:local-job', 'asset', { workflow_source: 'local', snapshot: { name: 'clip' } }), role: 'output', assetId: 'clip' };
  const currentLocal = { ...local, resultNodeIds: [localOutput.id], outputs: { image: { type: 'image', assetIds: ['clip'] } } };
  const videoReference = { ...localOutput, id: 'same-asset-reference', role: 'reference' };
  const upstream = { ...newWorkflowNode('agent', 0, 0, ''), id: 'upstream' };
  const downstream = { ...newWorkflowNode('agent', 0, 0, ''), id: 'downstream', inputs: { image: [{ nodeId: 'local', portId: 'image' }] } };
  const linkedLocal = { ...currentLocal, inputs: { text: [{ nodeId: 'upstream', portId: 'text' }] } };
  const videoCanvas = [first, remoteOutput, localOutput, videoReference];
  const videoDocument = { schema_version: 1, run: null, nodes: [upstream, remote, linkedLocal, downstream] };
  const videoConversations = canvasConversationCards(videoCanvas, {}, hiddenWorkflowSessionIds(videoDocument.nodes));
  const videoProjection = workflowGenerationCardProjection(videoDocument, videoCanvas, videoConversations);
  assert.equal(videoProjection.anchors.get(remote.id)?.id, remoteOutput.id, 'old remote snapshot may omit its filename extension');
  assert.equal(videoProjection.anchors.get(local.id)?.id, localOutput.id);
  assert.equal(videoProjection.origins.has(videoReference.id), false, 'same asset at another canvas instance has no generation origin');
  const edges = workflowArrangementEdges(videoDocument.nodes, videoCanvas, videoConversations, videoProjection.anchors);
  assert.ok(edges.some(edge => edge.fromNodeId === upstream.id && edge.toNodeId === localOutput.id));
  assert.ok(edges.some(edge => edge.fromNodeId === localOutput.id && edge.toNodeId === downstream.id));
  const oldImage = { ...firstImage, outputIsVideo: false };
  const newVideo = { ...image('gen-output:job2:second:clip', 'job2', 'second', 3), assetId: 'clip', outputIsVideo: true,
    payloadJson: JSON.stringify({ execution: { job_id: 'job2', turn_key: 'second' }, workflow_generation_group: group }) };
  const switched = (source, nodes) => {
    const hidden = hiddenWorkflowSessionIds([source], nodes);
    const conversations = canvasConversationCards(nodes, {}, hidden);
    const projection = workflowGenerationCardProjection({ ...videoDocument, nodes: [source] }, nodes, conversations);
    return { conversations, projection };
  };
  const beforeVideo = switched(remote, [first, oldImage]);
  assert.equal(beforeVideo.projection.anchors.size, 0, 'a current video card is not replaced by older image output');
  const afterVideo = switched(remote, [first, oldImage, done, newVideo]);
  assert.equal(afterVideo.projection.anchors.get(remote.id)?.id, newVideo.id);
  assert.equal(afterVideo.conversations.cards.get(first.id)?.outputs[0]?.id, oldImage.id, 'delivering video preserves the old image gallery');
  const backToImage = switched(workflow, [first, oldImage, done, newVideo]);
  assert.equal(backToImage.projection.anchors.get(workflow.id)?.id, first.id);
  assert.equal(backToImage.projection.origins.has(newVideo.id), false, 'a restored image card cannot route to historical video');
  const waitingVideo = { status: 'waiting', steps: { [remote.id]: { status: 'waiting', videoJobActive: true } } };
  assert.equal(workflowGenerationActivity(remote, waitingVideo, [], {}).running, true);
  assert.equal(workflowGenerationActivity(remote, waitingVideo, [done], {}).running, false);
  assert.equal(workflowGenerationActivity(remote, undefined, [second], {}).running, true);
  const localRun = { status: 'running', steps: { [local.id]: { status: 'running', comfyOptimization: {} } } };
  assert.equal(workflowGenerationActivity(local, localRun, [], {}).running, true);
  assert.equal(workflowGenerationActivity(local, { ...localRun, status: 'stopped' }, [], {}).running, false);
  assert.equal(workflowGenerationActivity(local, { status: 'done', steps: { [local.id]: { status: 'done', jobId: 'local-job' } } }, [], {}).running, false);

  const point = (nodes, cards = [local], runs) => firstWorkflowVideoOutputPoint(
    { nodes, threads: [], groups: [], groupItems: [] }, { schema_version: 1, run: null, nodes: cards, runs }, local);
  assert.deepEqual(point([videoReference]), { x: 120, y: 80 });
  assert.equal(point([localOutput], [currentLocal]), undefined, 'a visible output keeps the normal subsequent result placement');
  assert.equal(point([localOutput], [local], [{ status: 'done', steps: { local: { status: 'done', jobId: 'local-job' } } }]), undefined);
  assert.deepEqual(point([{ ...localOutput, hiddenAt: 10 }], [currentLocal]), { x: 120, y: 80 });
  assert.equal(point([], [local, { ...trigger, inputs: { image: [{ nodeId: 'local', portId: 'image' }] } }]), undefined);
  assert.equal(point([], [{ ...local, inputs: { signal: [{ nodeId: 'loop' }] } }, loop]), undefined);
  assert.equal(point([table], [local, { ...writer, inputs: { image: [{ nodeId: 'local', portId: 'image' }] } }]), undefined);
  assert.equal(point([], [local], [{ status: 'running', steps: {}, loop: { bodyIds: ['local'] } }]), undefined);

  const hyperframes = { ...node('workflow-video:request', 'asset', { workflow_source: upstream.id, snapshot: { name: 'film' } }), role: 'output', assetId: 'clip' };
  assert.equal(workflowGenerationCardProjection(videoDocument, [hyperframes], canvasConversationCards([hyperframes], {})).origins.size, 0);
  console.log('workflow video projection: exact provenance, activity, placement, wire anchors and orchestration exceptions passed');
  console.log('workflow image projection: async task ownership, original output identity, gallery dissolution and workflow exceptions passed');
} finally {
  await server.close();
}
