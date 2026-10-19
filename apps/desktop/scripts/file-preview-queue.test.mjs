import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFilePreviewQueue } from '../src/lib/filePreviewQueue.ts';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('visible items precede prefetch; cancelled pending work is never loaded', async () => {
  const started = []; const finish = [];
  const queue = createFilePreviewQueue(path => { started.push(path); return new Promise(resolve => finish.push(resolve)); }, 1);
  queue.request('near', 'near', 1, () => {});
  queue.request('visible', 'visible', 0, () => {});
  const cancelled = queue.request('gone', 'gone', 0, () => {});
  cancelled.cancel();
  await tick(); assert.deepEqual(started, ['visible']);
  finish.shift()('visible.jpg'); await tick();
  assert.deepEqual(started, ['visible', 'near']);
  finish.shift()('near.jpg'); await tick();
  assert.equal(queue.peek('visible'), 'visible.jpg');
});

test('same version shares extraction, cancelled subscribers get no updates', async () => {
  let count = 0; let finish; const received = [];
  const queue = createFilePreviewQueue(() => { count++; return new Promise(resolve => { finish = resolve; }); });
  const first = queue.request('v1', 'image', 1, () => received.push('cancelled'));
  queue.request('v1', 'image', 0, value => received.push(value));
  await tick(); first.cancel(); finish('thumb.jpg'); await tick();
  assert.equal(count, 1); assert.deepEqual(received, ['thumb.jpg']);
  assert.equal(queue.peek('v1'), 'thumb.jpg');
  assert.equal(queue.peek('v2'), undefined);
});

test('failure releases capacity and priority can change before execution', async () => {
  const started = [];
  const queue = createFilePreviewQueue(async path => { started.push(path); if (path === 'bad') throw new Error('bad'); return path; }, 1);
  queue.request('bad', 'bad', 0, () => {});
  queue.request('near', 'near', 1, () => {});
  queue.request('now-visible', 'now-visible', 1, () => {}).priority(0);
  await tick(); await tick();
  assert.deepEqual(started, ['bad', 'now-visible', 'near']);
  assert.equal(queue.peek('bad'), undefined);
  assert.equal(queue.peek('near'), 'near');
});
