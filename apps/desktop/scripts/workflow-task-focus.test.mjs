import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveWorkflowTaskFocus } from '../src/lib/workflowTaskFocus.ts';
const node = { id: 'h3', kind: 'comfy-video' };
function document(run) { return { nodes: [node], run }; }
test('running, failed and completed workflow cards resolve only through their execution owner', () => {
  for (const status of ['running', 'waiting', 'failed', 'done', 'stopped']) {
    const run = { threadId: 't', status, order: ['h3'], steps: {} };
    assert.deepEqual(resolveWorkflowTaskFocus(document(run), 'h3', 't', true), { state: 'ready', node });
    assert.equal(resolveWorkflowTaskFocus(document(run), 'h3', 'wrong', true).state, 'rejected');
    assert.equal(resolveWorkflowTaskFocus(document(run), 'h3', 't', false).state, 'rejected');
  }
});
test('step ownership is sufficient, an unrelated run and inherited property are not', () => {
  assert.equal(resolveWorkflowTaskFocus(document({ threadId: 't', order: [], steps: { h3: {} } }), 'h3', 't', true).state, 'ready');
  assert.equal(resolveWorkflowTaskFocus(document({ threadId: 't', order: [], steps: Object.create({ h3: {} }) }), 'h3', 't', true).state, 'rejected');
  assert.equal(resolveWorkflowTaskFocus(document({ threadId: 't', order: ['other'], steps: { other: {} } }), 'h3', 't', true).state, 'rejected');
});
test('waits for missing card, rejects missing thread, and respects canonical runs over legacy run', () => {
  const run = { threadId: 't', order: ['h3'], steps: {} };
  assert.equal(resolveWorkflowTaskFocus(document(run), 'missing', 't', true).state, 'pending');
  assert.equal(resolveWorkflowTaskFocus(document(run), 'h3', null, true).state, 'rejected');
  assert.equal(resolveWorkflowTaskFocus({ ...document(run), runs: [] }, 'h3', 't', true).state, 'rejected');
});
