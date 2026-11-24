import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { callTool } from '../core.mjs';
import { createSnapshotReader } from '../snapshot-store.mjs';
import { fixture } from './branch-fixture.mjs';

test('console publishes local branch commits and dirty working trees without touching primary index, files or checkout', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.branches.map(row => row.branch).sort(), ['broken', 'main', 'topic/green']);
  assert.deepEqual(f.branches.filter(row => row.current).map(row => row.branch), ['main']);
  const before = f.git('status', '--porcelain');
  const worktrees = f.git('worktree', 'list', '--porcelain');
  const indexFile = path.join(f.root, '.git/index');
  const index = await readFile(indexFile);
  const reader = createSnapshotReader(f.output);
  for (const [branch, clean, content] of [['main', false, 'working tree'], ['topic/green', true, 'topic commit'], ['main', true, 'initial']]) {
    assert.equal((await f.post(branch, clean)).status, 202);
    const { job, snapshot } = await f.finished();
    assert.equal(job.status, 'done', JSON.stringify(job));
    assert.equal(job.coverageStatus, 'checked');
    assert.equal(job.exportedFiles, 1);
    const data = reader();
    const overview = callTool(data, 'project_overview');
    assert.equal(overview.branch, branch);
    assert.equal(overview.isDirty, !clean);
    assert.equal(overview.revision, f.git('rev-parse', 'refs/heads/' + branch).trim());
    assert.equal(snapshot.revision, overview.revision);
    assert.equal(snapshot.createdAt, overview.createdAt);
    assert.equal(callTool(data, 'read_file', { path: 'PROJECT.md' }).lines[0].text, content);
    assert.equal(f.git('status', '--porcelain'), before);
    assert.deepEqual(await readFile(indexFile), index);
    assert.equal(f.git('worktree', 'list', '--porcelain'), worktrees);
  }
  const saved = await readFile(f.output);
  const oldSnapshot = reader();
  const batch = await Promise.all([f.post('broken'), f.post('broken')]);
  assert.deepEqual(batch.map(result => result.status).sort(), [202, 409]);
  const { job } = await f.finished();
  assert.equal(job.status, 'failed');
  assert.equal(job.coverageStatus, 'incomplete');
  assert.match(job.error, /apps\/a\/large\.ts/);
  assert.equal(reader(), oldSnapshot);
  assert.deepEqual(await readFile(f.output), saved);
  assert.deepEqual(await readFile(indexFile), index);
  assert.equal(f.git('status', '--porcelain'), before);
  assert.equal(f.git('worktree', 'list', '--porcelain'), worktrees);
  assert.equal(f.git('branch', '--show-current').trim(), 'main');

  // Force the checkout itself to fail before the exporter starts reading files.
  const attributes = path.join(f.root, '.git/info/attributes');
  await writeFile(attributes, 'PROJECT.md filter=unavailable-fixture\n');
  f.git('config', 'filter.unavailable-fixture.required', 'true');
  assert.equal((await f.post('topic/green')).status, 202);
  const failedCheckout = await f.finished();
  assert.equal(failedCheckout.job.status, 'failed');
  assert.match(failedCheckout.job.error, /filter|checkout/i);
  await unlink(attributes);
  assert.equal(f.git('worktree', 'list', '--porcelain'), worktrees);
  assert.equal(f.git('status', '--porcelain'), before);
  assert.deepEqual(await readFile(f.output), saved);
});

test('console rejects foreign Host and Origin, absent POST Origin, stale or forged selections', async t => {
  const f = await fixture(t);
  const badHostStatus = await new Promise((resolve, reject) => {
    request(f.app.origin, { headers: { Host: 'elsewhere.invalid' } }, res => {
      res.resume();
      resolve(res.statusCode);
    }).once('error', reject).end();
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await f.post('main', false, { Origin: 'https://elsewhere.invalid' })).status, 403);
  assert.equal((await fetch(f.app.origin + '/api/export', { method: 'POST' })).status, 403);
  assert.equal((await f.post('--config')).status, 400);
  assert.equal((await f.post('HEAD~1')).status, 409);
  assert.equal((await f.post('topic/green', false)).status, 409);
  f.git('branch', '-f', 'topic/green', 'HEAD');
  assert.equal((await f.post('topic/green')).status, 409);
  assert.equal((await f.state()).job.status, 'idle');
  const html = await fetch(f.app.origin).then(response => response.text());
  assert.match(html, /更新后，GPT/);
});
