import test from 'node:test';
import assert from 'node:assert/strict';
import { agentReminderKey, generationReminderKey, describeReminderKey, orphanReminderKey, readReminderReceipts, saveReminderReceipts, reminderStorageKey } from '../src/lib/taskReminders.ts';

const job = { id: 'job-1', running: false, turns: [{ id: 1, turnKey: 'turn-1', error: 'failed' }] };
const agent = { runId: 'run-1', status: 'awaiting_approval', updatedAt: 1, snapshot: { run: {}, approvals: [{ id: 'approval-1', status: 'pending' }], events: [], artifacts: [], clarifications: [] } };
function memoryStorage() {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test('generation receipts survive recovered ephemeral ids and identify a new failed turn', () => {
  assert.equal(generationReminderKey(job), generationReminderKey({ ...job, turns: [{ ...job.turns[0], id: 200, startedAt: 999 }] }));
  assert.notEqual(generationReminderKey(job), generationReminderKey({ ...job, turns: [...job.turns, { turnKey: 'turn-2', error: 'failed' }] }));
  assert.notEqual(generationReminderKey(job), generationReminderKey({ ...job, id: 'retry-job' }));
  assert.equal(generationReminderKey({ ...job, running: true }), null);
  assert.equal(generationReminderKey({ ...job, turns: [{ turnKey: 'turn-1' }] }), null);
});

test('approval replay and poll timestamps do not revive receipts; a new approval does', () => {
  assert.equal(agentReminderKey(agent), agentReminderKey({ ...agent, updatedAt: 99, snapshot: { ...agent.snapshot, events: [{ seq: 7, type: 'heartbeat' }] } }));
  assert.notEqual(agentReminderKey(agent), agentReminderKey({ ...agent, snapshot: { ...agent.snapshot, approvals: [{ id: 'approval-2', status: 'pending' }] } }));
});

test('new clarification, result revision, failure and status have independent receipts', () => {
  const question = { ...agent, status: 'awaiting_clarification', snapshot: { ...agent.snapshot, clarifications: [{ id: 'question-1', status: 'pending' }] } };
  assert.notEqual(agentReminderKey(question), agentReminderKey({ ...question, snapshot: { ...question.snapshot, clarifications: [{ id: 'question-2', status: 'pending' }] } }));
  const result = { ...agent, status: 'awaiting_result_feedback', snapshot: { ...agent.snapshot, artifacts: [{ id: 'a', sha256: 'v1', downloaded_at: null }] } };
  assert.equal(agentReminderKey(result), agentReminderKey({ ...result, snapshot: { ...result.snapshot, artifacts: [{ id: 'a', sha256: 'v1', downloaded_at: 'later' }] } }));
  assert.notEqual(agentReminderKey(result), agentReminderKey({ ...result, snapshot: { ...result.snapshot, artifacts: [{ id: 'a', sha256: 'v2' }] } }));
  const failure = { ...agent, status: 'failed', snapshot: { ...agent.snapshot, run: { error_code: 'timeout', safe_message: 'timeout' } } };
  assert.notEqual(agentReminderKey(agent), agentReminderKey(failure));
  assert.notEqual(agentReminderKey(failure), agentReminderKey({ ...failure, runId: 'retry-run' }));
  assert.notEqual(agentReminderKey(failure), agentReminderKey({ ...failure, snapshot: { ...failure.snapshot, run: { error_code: 'new-error' } } }));
  assert.equal(agentReminderKey({ ...agent, status: 'running' }), null);
  assert.equal(agentReminderKey({ ...agent, status: 'queued' }), null);
  assert.equal(agentReminderKey({ ...agent, status: 'cancelled' }), null);
});

test('describe retry and orphan status change alert again', () => {
  const failure = { assetId: 'a', failedAt: 1, reason: 'error' };
  assert.notEqual(describeReminderKey(failure), describeReminderKey({ ...failure, failedAt: 2 }));
  assert.notEqual(orphanReminderKey({ submit_id: 'o', gen_status: 'querying' }), orphanReminderKey({ submit_id: 'o', gen_status: 'success' }));
});

test('saved receipts survive a new reader and merge existing receipts without mutating sources', () => {
  const storage = memoryStorage(), scope = reminderStorageKey('library', 'user');
  const before = JSON.stringify({ job, agent });
  const keys = [generationReminderKey(job), agentReminderKey(agent)];
  saveReminderReceipts(storage, scope, keys);
  assert.deepEqual(readReminderReceipts(storage, scope), new Set(keys));
  saveReminderReceipts(storage, scope, ['another']);
  saveReminderReceipts(storage, scope, keys);
  assert.equal(readReminderReceipts(storage, scope).size, 3);
  assert.equal(JSON.stringify({ job, agent }), before);
  assert.equal(readReminderReceipts(storage, reminderStorageKey('other-library', 'user')).size, 0);
  assert.equal(readReminderReceipts(storage, reminderStorageKey('library', 'other-user')).size, 0);
});

test('failed or malformed persistence is reported instead of claiming a clear', () => {
  assert.throws(() => saveReminderReceipts({ getItem: () => null, setItem: () => { throw Error('quota'); } }, 'scope', ['key']), /quota/);
  assert.throws(() => readReminderReceipts({ getItem: () => '{}' }, 'scope'), /格式无效/);
});
