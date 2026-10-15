import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyWorkflow, newWorkflowNode, invalidateWorkflow } from '../src/lib/canvasWorkflow.ts';
import { workflowEditUndo, restoreWorkflowEdit } from '../src/lib/workflowUndo.ts';

const node = id => ({ ...newWorkflowNode('generation', 0, 0, 'codex'), id });
const document = nodes => ({ ...emptyWorkflow(), nodes });

test('undo restores deleted nodes, dependent wiring and invalidated outputs', () => {
  const source = node('source');
  const dependent = { ...node('dependent'), inputs: { image: [{ nodeId: 'source', portId: 'image', slot: 1 }] }, outputs: { image: { type: 'image', assetIds: ['saved'] } } };
  const before = document([source, dependent]);
  const after = document([{ ...dependent, inputs: { image: [] }, outputs: {} }]);
  const undo = workflowEditUndo(before, after);
  const restored = restoreWorkflowEdit(after.nodes, undo);
  assert.deepEqual(restored.find(node => node.id === 'source'), source);
  assert.deepEqual(restored.find(node => node.id === 'dependent'), dependent);
  source.x = 100;
  assert.equal(undo.nodes.find(node => node.id === 'source').before.x, 0, 'history owns its snapshots');
});

test('undo preserves unrelated edits, positions and newer execution output', () => {
  const target = { ...node('target'), prompt: '原始提示词', outputs: { image: { type: 'image', assetIds: ['old'] } } };
  const other = node('other');
  const before = document([target, other]);
  const after = document(invalidateWorkflow([{ ...target, prompt: '新提示词' }, other], target.id));
  const undo = workflowEditUndo(before, after);
  const live = after.nodes.map(node => node.id === 'target' ? { ...node, x: 99, outputs: { image: { type: 'image', assetIds: ['new'] } }, activeSessionNodeId: 'session' } : { ...node, prompt: '其他修改' });
  const restored = restoreWorkflowEdit(live, undo);
  assert.equal(restored[0].prompt, '原始提示词');
  assert.equal(restored[0].x, 99);
  assert.deepEqual(restored[0].outputs, live[0].outputs);
  assert.equal(restored[0].activeSessionNodeId, 'session');
  assert.deepEqual(restored[1], live[1]);
});

test('undo removes newly created cards and optional fields, retaining unrelated additions', () => {
  const before = document([node('original')]);
  const after = document([{ ...before.nodes[0], profileCache: { inputKey: 'a', profileId: 'profile' } }, node('copy')]);
  const restored = restoreWorkflowEdit([...after.nodes, node('later')], workflowEditUndo(before, after));
  assert.deepEqual(restored, [...before.nodes, node('later')]);
});

test('history records only removed runs and ignores a no-op node edit', () => {
  const run = { id: 'done', startId: 'source', threadId: 'thread', status: 'done', order: ['source'], steps: { source: { status: 'done' } } };
  const before = { ...document([node('source')]), run };
  const undo = workflowEditUndo(before, document([]));
  assert.deepEqual(undo.removedRuns, [run]);
  assert.equal(workflowEditUndo(before, structuredClone(before)), null);
});
