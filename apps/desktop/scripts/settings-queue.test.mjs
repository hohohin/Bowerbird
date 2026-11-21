import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsQueue } from '../src/lib/settingsQueue.ts';

const deferred = () => Promise.withResolvers();
function fixture(initial = {}) {
  let disk = { theme: 'light', sound: false, ...initial };
  let ui = disk, failure;
  let read = async () => disk;
  const writes = [];
  const queue = settingsQueue(() => read(), async value => {
    const gate = deferred();
    writes.push(gate);
    const receipt = await gate.promise;
    disk = value;
    return receipt;
  }, () => ui, (value, error) => { ui = value; failure = error; });
  return { queue, writes, setRead: fn => { read = fn; }, ui: () => ui, disk: () => disk, failure: () => failure };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('old failed write preserves later success and retry applies only failed fields', async () => {
  const f = fixture();
  const a = f.queue.update({ theme: 'dark' }).catch(() => {});
  const b = f.queue.update({ sound: true });
  await settle();
  assert.deepEqual(f.ui(), { theme: 'dark', sound: true });
  assert.equal(f.writes.length, 1);
  f.writes[0].reject(new Error('disk')); await a; await settle();
  assert.deepEqual(f.ui(), { theme: 'light', sound: true });
  f.writes[1].resolve(); await b;
  assert.deepEqual(f.ui(), f.disk());
  const retry = f.queue.retry(); await settle(); f.writes[2].resolve(); await retry;
  await f.queue.load();
  assert.deepEqual(f.disk(), { theme: 'dark', sound: true }); assert.equal(f.failure(), null);
});

test('confirmed first write, failed last write and repeated edits of the same setting', async () => {
  const f = fixture();
  const a = f.queue.update({ theme: 'dark' });
  const b = f.queue.update({ theme: 'light' }).catch(() => {});
  await settle(); f.writes[0].resolve(); await a; await settle();
  f.writes[1].reject(new Error('disk')); await b;
  assert.equal(f.ui().theme, 'dark');
  const c = f.queue.update({ theme: 'dark' }); await settle(); f.writes[2].resolve(); await c;
  assert.equal(f.failure(), null); await f.queue.load(); assert.deepEqual(f.ui(), f.disk());
});

test('slow startup read is reconciled with pending writes', async () => {
  const f = fixture(), gate = deferred();
  f.setRead(() => gate.promise);
  const startup = f.queue.load();
  const edit = f.queue.update({ sound: true });
  await settle(); gate.resolve({ theme: 'dark', sound: false }); await startup;
  assert.deepEqual(f.ui(), { theme: 'dark', sound: true });
  await settle(); f.writes[0].resolve(); await edit;
  assert.deepEqual(f.ui(), f.disk());
});

const mirrorFailed = { semanticIndexApplied: false, semanticIndexError: 'disk_full' };
const mirrorApplied = { semanticIndexApplied: true, semanticIndexError: null };

test('partially applied index settings remain saved and retry only index settings', async () => {
  const f = fixture({ semantic_index_include_generated: true });
  const edit = f.queue.update({ semantic_index_include_generated: false, theme: 'dark' });
  const unrelated = f.queue.update({ sound: true });
  await settle(); f.writes[0].resolve(mirrorFailed); await edit;
  assert.deepEqual(f.failure().patch, { semantic_index_include_generated: false });
  assert.match(f.failure().cause.message, /设置已保存.*磁盘空间不足/);
  assert.equal(f.failure().cause.cause, 'disk_full');
  assert.equal(f.ui().semantic_index_include_generated, false);
  await settle(); f.writes[1].resolve(mirrorFailed); await unrelated;
  assert.deepEqual(f.disk(), { theme: 'dark', sound: true, semantic_index_include_generated: false });
  assert.deepEqual(f.failure().patch, { semantic_index_include_generated: false });

  const retry = f.queue.retry();
  await settle();
  assert.equal(f.writes.length, 3, 'same values still reach native reconciliation');
  f.writes[2].resolve(mirrorApplied); await retry;
  assert.deepEqual(f.ui(), f.disk());
  assert.equal(f.failure(), null);
});

test('a later successful save clears an applied index error and keeps saved preferences', async () => {
  const f = fixture({ semantic_index_automatic: true });
  const first = f.queue.update({ semantic_index_automatic: false });
  await settle(); f.writes[0].resolve(mirrorFailed); await first;
  const second = f.queue.update({ theme: 'dark' });
  await settle(); f.writes[1].resolve(mirrorApplied); await second;
  assert.equal(f.failure(), null);
  assert.deepEqual(f.disk(), { theme: 'dark', sound: false, semantic_index_automatic: false });
});

test('a same-field edit queued during mirror recovery takes precedence on retry', async () => {
  const f = fixture({ semantic_index_interval_minutes: 15 });
  const first = f.queue.update({ semantic_index_interval_minutes: 60 });
  await settle(); f.writes[0].resolve(mirrorFailed); await first;
  const undo = f.queue.update({ semantic_index_interval_minutes: 15 });
  await settle();
  await f.queue.retry();
  assert.equal(f.writes.length, 2);
  f.writes[1].resolve(mirrorApplied); await undo;
  assert.equal(f.disk().semantic_index_interval_minutes, 15);
  assert.equal(f.failure(), null);
});

test('index retry uses the latest confirmed values after a settings reload', async () => {
  const f = fixture({ semantic_index_automatic: true });
  const edit = f.queue.update({ semantic_index_automatic: false });
  await settle(); f.writes[0].resolve(mirrorFailed); await edit;
  f.setRead(async () => ({ theme: 'dark', sound: false, semantic_index_automatic: true }));
  await f.queue.load();
  assert.deepEqual(f.failure().patch, { semantic_index_automatic: true });
  const retry = f.queue.retry();
  await settle(); f.writes[1].resolve(mirrorApplied); await retry;
  assert.deepEqual(f.disk(), { theme: 'dark', sound: false, semantic_index_automatic: true });
  assert.equal(f.failure(), null);
});
