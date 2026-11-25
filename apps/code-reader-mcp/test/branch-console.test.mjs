import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { callTool } from '../core.mjs';
import { createSnapshotReader } from '../snapshot-store.mjs';
import { fixture } from './branch-fixture.mjs';
import { startBranchConsole } from '../branch-console.mjs';

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

test('console reuses a matching instance and exports the current working tree from the top action', async t => {
  const f = await fixture(t);
  const port = Number(new URL(f.app.origin).port);
  const second = await startBranchConsole(f.root, f.output, port);
  assert.equal(second.reused, true);
  assert.equal(second.origin, f.app.origin);
  await second.close();
  await assert.rejects(startBranchConsole(f.root, f.output + '.other', port), { code: 'EADDRINUSE' });
  const response = await fetch(f.app.origin + '/api/export', {
    method: 'POST', headers: { Origin: f.app.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: true }),
  });
  assert.equal(response.status, 202);
  const state = await f.finished();
  assert.equal(state.job.status, 'done');
  assert.equal(state.snapshot.branch, 'main');
  assert.equal(state.snapshot.isDirty, true);
  assert.equal((await fetch(f.app.origin + '/api/services', { headers: { Origin: 'https://elsewhere.invalid' } })).status, 403);
});

test('service startup protects origin, validates local setup, excludes healthy peers and serializes launch requests', async t => {
  const secret = 'MCP_UPDATE_KEY=private-value';
  const states = { gpt: { state: 'stopped' }, gemini: { state: 'healthy' } };
  const attempts = [];
  const { promise, reject } = Promise.withResolvers();
  const f = await fixture(t, {
    probe: async () => states,
    launchServices: async (root, targets) => { attempts.push(targets); await promise; },
  });
  const address = f.app.origin + '/api/services/start';
  const post = (origin = f.app.origin, body = {}) => fetch(address, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post('https://elsewhere.invalid')).status, 403);
  assert.equal((await fetch(address, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await new Promise((resolve, fail) => {
    request(address, { method: 'POST', headers: { Host: 'elsewhere.invalid', Origin: f.app.origin } }, res => {
      res.resume();
      resolve(res.statusCode);
    }).once('error', fail).end();
  })), 403);
  assert.equal((await post(f.app.origin, { script: secret })).status, 400);
  assert.match(await (await post()).text(), /先更新快照/);
  assert.equal((await f.post('main', false)).status, 202);
  await f.finished();
  const missing = await post();
  assert.equal(missing.status, 409);
  assert.match(await missing.text(), /缺少 GPT 隧道密钥文件/);
  states.gpt.state = 'healthy';
  states.gemini.state = 'stopped';
  assert.match(await (await post()).text(), /缺少 Gemini 本机配置/);
  assert.deepEqual(attempts, []);
  states.gpt.state = 'stopped';
  states.gemini.state = 'healthy';
  await writeFile(path.join(f.root, '.env.tunnel'), secret);
  const replies = await Promise.all([post(), post()]);
  assert.deepEqual(replies.map(res => res.status).sort(), [202, 409]);
  assert.deepEqual(attempts, [['gpt']]);
  const serving = () => fetch(f.app.origin + '/api/services').then(res => res.json());
  assert.equal((await serving()).combined, 'starting');
  reject(new Error(secret + ' oauthClient adminPassword access_token'));
  const status = await serving();
  assert.equal(status.combined, 'stopped');
  assert.equal(status.startup.status, 'failed');
  assert.doesNotMatch(JSON.stringify(status), /private-value|MCP_UPDATE_KEY|oauthClient|adminPassword|access_token/);
  states.gpt.state = 'healthy';
  assert.equal((await post()).status, 200);
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
