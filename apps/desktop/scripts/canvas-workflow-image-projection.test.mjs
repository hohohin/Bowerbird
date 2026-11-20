import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, cacheDir: '.tmp/workflow-image-projection-vite',
  server: { middlewareMode: true, hmr: false, watch: null } });
try {
  const { hiddenWorkflowSessionIds, workflowImageCardProjection, workflowImageGenerationActivity } =
    await server.ssrLoadModule('/src/lib/canvasSessionOutputs.ts');
  const { canvasConversationCards } = await server.ssrLoadModule('/src/lib/canvasConversationCards.ts');
  const { newWorkflowNode } = await server.ssrLoadModule('/src/lib/canvasWorkflow.ts');
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
  const projection = (nodes, cards = [workflow], options = {}, unavailable) => workflowImageCardProjection(
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
    const { running, jobId, failed, session: active } = workflowImageGenerationActivity(workflow, step, nodes, jobs);
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
  assert.equal(workflowImageGenerationActivity(workflow, undefined, [done], continuation).running, false);

  const secondImage = image('second-image', 'job2', 'second', 3);
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
  console.log('workflow image projection: async task ownership, original output identity, gallery dissolution and workflow exceptions passed');
} finally {
  await server.close();
}
