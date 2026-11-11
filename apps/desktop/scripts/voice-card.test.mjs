import test from 'node:test';
import assert from 'node:assert/strict';
import { newWorkflowNode, workflowInputs, workflowOutputs } from '../src/lib/canvasWorkflow.ts';
import { planAutomaticConnection } from '../src/lib/workflowAutoConnect.ts';

test('a new voice card accepts a recording; a selected voice accepts script and delivers audio', () => {
  const node = newWorkflowNode('voice', 20, 30, 'local');
  const connect = media => planAutomaticConnection([node], [{ type:'image', media, binding:{assetId:'source'} }], node.id);
  assert.deepEqual(workflowInputs(node).map(p => p.label), ['参考录音']);
  assert.equal(connect('audio').bindings.length, 1);
  assert.equal(connect('image').bindings.length, 0);
  node.voice={id:'speaker'};
  assert.deepEqual(workflowInputs(node).map(p => p.label), ['台词']);
  assert.equal(connect('audio').bindings.length, 0);
  assert.deepEqual(workflowOutputs(node).map(p => p.label), ['配音']);
});
