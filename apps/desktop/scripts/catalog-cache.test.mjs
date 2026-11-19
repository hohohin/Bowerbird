import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogCache, patchCatalogPage } from '../src/lib/catalogCache.ts';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
test('panes share in-flight reads and retain the result after readers leave', async () => {
  const cache = createCatalogCache(), task = deferred();
  let reads = 0;
  const load = () => { reads++; return task.promise; };
  const first = cache.read('all:images', load), second = cache.read('all:images', load);
  assert.equal(first, second);
  task.resolve(['asset']);
  await first;
  assert.deepEqual(await cache.read('all:images', load), ['asset']);
  assert.equal(reads, 1);
});
test('invalidation retains visible data and a late read cannot overwrite a newer revision', async () => {
  const cache = createCatalogCache();
  await cache.read('page', async () => ['before']);
  cache.invalidate();
  assert.deepEqual(cache.peek('page').value, ['before']);
  assert.equal(cache.fresh(cache.peek('page')), false);
  const old = deferred(), current = deferred();
  const oldRead = cache.read('page', () => old.promise);
  cache.invalidate();
  const currentRead = cache.read('page', () => current.promise);
  current.resolve(['after']); await currentRead;
  old.resolve(['obsolete']); await oldRead;
  assert.deepEqual(cache.peek('page').value, ['after']);
  assert.equal(cache.fresh(cache.peek('page')), true);
});
test('failed revalidation preserves the snapshot and allows retry', async () => {
  const cache = createCatalogCache();
  await cache.read('page', async () => ['before']);
  cache.invalidate();
  await assert.rejects(cache.read('page', async () => { throw Error('offline'); }));
  assert.deepEqual(cache.peek('page').value, ['before']);
  assert.deepEqual(await cache.read('page', async () => ['recovered']), ['recovered']);
});
test('snapshots are bounded by LRU and isolate query scopes', async () => {
  const cache = createCatalogCache(2);
  await cache.read('project:A:images', async () => ['A']);
  await cache.read('project:B:images', async () => ['B']);
  cache.peek('project:A:images');
  await cache.read('project:A:texts', async () => ['document']);
  assert.equal(cache.peek('project:B:images'), undefined);
  assert.deepEqual(cache.entries('project:A:').map(([, snapshot]) => snapshot.value), [['A'], ['document']]);
});
test('aged snapshots remain displayable but are revalidated on the next read', async () => {
  const cache = createCatalogCache(2, 0);
  await cache.read('page', async () => ['before']);
  assert.equal(cache.fresh(cache.peek('page')), false);
  assert.deepEqual(cache.peek('page').value, ['before']);
  assert.deepEqual(await cache.read('page', async () => ['after']), ['after']);
});

const asset = (id, thumb = null) => ({ id, name: `${id}.png`, store_path: `/${id}.png`, file_mtime: 1, width: 10, height: 10, thumb_path: thumb });
test('preview patch updates heads, group members and references without changing identities or names', () => {
  const original = asset('shared');
  const entry = { id: 'reference', asset_id: original.id, asset: original, version: 'v1', is_reference: true, name: 'custom.bowerbird' };
  const reference = { ...original, connectionEntry: entry };
  const head = { ...asset('head'), connectionGroup: [reference] };
  const page = { assets: [original, reference, head], groups: { gallery: [original] }, revision: 8 };
  const next = patchCatalogPage(page, { assets: [{ ...original, thumb_path: '/preview.jpg', name: 'obsolete.png', width: 20 }], versions: { shared: 'v1' } });
  assert.equal(next.revision, 8);
  assert.equal(next.assets[0].name, 'shared.png');
  assert.equal(next.assets[1].connectionEntry.id, 'reference');
  assert.equal(next.assets[1].connectionEntry.name, 'custom.bowerbird');
  assert.equal(next.assets[1].connectionEntry.asset.thumb_path, '/preview.jpg');
  assert.equal(next.assets[2].connectionGroup[0].thumb_path, '/preview.jpg');
  assert.equal(next.groups.gallery[0].width, 20);
  assert.equal(patchCatalogPage(next, { assets: [{ ...original, thumb_path: '/old.jpg' }], versions: { shared: 'old' } }).assets[1], next.assets[1]);
  assert.equal(patchCatalogPage(next, { assets: [{ ...original, file_mtime: 0, thumb_path: '/old.jpg' }] }), next);
  assert.equal(patchCatalogPage(next, { assets: [{ ...original, thumb_path: '/late.jpg' }], versions: { shared: 'old' } }).assets[0], next.assets[0], 'an unversioned plain card never replaces a different existing thumbnail');
});
test('preview completion only invalidates color-filtered snapshots and patches a pending page result', async () => {
  const cache = createCatalogCache(), original = asset('one'), pending = deferred();
  await cache.read('overview:all', async () => ({ total: 1 }));
  await cache.read('overview:red', async () => ({ total: 0 }), true);
  const read = cache.read('pages:all:0', () => pending.promise);
  cache.updatePreviews({ assets: [{ ...original, thumb_path: '/ready.jpg' }] });
  pending.resolve({ assets: [original], groups: {} });
  const page = await read;
  assert.equal(page.assets[0].thumb_path, '/ready.jpg');
  assert.equal(cache.fresh(cache.peek('overview:all')), true);
  assert.equal(cache.fresh(cache.peek('pages:all:0')), true);
  assert.equal(cache.fresh(cache.peek('overview:red')), false);
  assert.equal(cache.revision(), 0);
  assert.equal(cache.revision(true), 1);
});
test('progress patches cached and pending folder snapshots without invalidating pages or changing counts', async () => {
  const cache = createCatalogCache(), pending = deferred();
  const folder = { id: 'child', root_id: 'root', count: 80, scanning: true, error: null };
  await cache.read('folders:cached', async () => [folder]);
  const read = cache.read('folders:pending', () => pending.promise);
  cache.updateConnectionProgress({ rootId: 'root', scanning: false, error: null });
  pending.resolve([folder]);
  assert.deepEqual(await read, [{ ...folder, scanning: false }]);
  assert.deepEqual(cache.peek('folders:cached').value, [{ ...folder, scanning: false }]);
  assert.equal(cache.fresh(cache.peek('folders:cached')), true);
});
