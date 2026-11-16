import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsQueue } from '../src/lib/settingsQueue.ts';

const deferred = () => Promise.withResolvers();
function fixture() {
  let disk = { theme: 'light', sound: false };
  let ui = disk, failure;
  let read = async () => disk;
  const writes = [];
  const queue = settingsQueue(() => read(), async value => {
    const gate = deferred();
    writes.push(gate);
    await gate.promise;
    disk = value;
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
