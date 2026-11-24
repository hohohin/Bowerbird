import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startBranchConsole } from '../branch-console.mjs';
import { MAX_FILE_BYTES } from '../core.mjs';

export async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bb-console-test-'));
  let app;
  t.after(async () => {
    if (app) await app.close();
    assert.equal(path.dirname(dir), os.tmpdir());
    await rm(dir, { recursive: true, force: true });
  });
  const root = path.join(dir, 'repo');
  const output = path.join(dir, 'shared', 'snapshot.json');
  await mkdir(path.join(root, 'apps/a'), { recursive: true });
  const git = (...args) => execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const project = path.join(root, 'PROJECT.md');
  await writeFile(project, 'initial');
  git('add', 'PROJECT.md');
  git('commit', '-m', 'main');
  git('switch', '-c', 'topic/green');
  await writeFile(project, 'topic commit');
  git('commit', '-am', 'topic');
  git('switch', '-c', 'broken');
  await writeFile(path.join(root, 'apps/a/main.ts'), "import './large';");
  await writeFile(path.join(root, 'apps/a/large.ts'), 'x'.repeat(MAX_FILE_BYTES + 1));
  git('add', 'apps');
  git('commit', '-m', 'broken dependency');
  git('switch', 'main');
  await writeFile(project, 'staged');
  git('add', 'PROJECT.md');
  await writeFile(project, 'working tree');
  await writeFile(path.join(root, 'untracked.txt'), 'untracked');
  app = await startBranchConsole(root, output, 0);
  const state = () => fetch(app.origin + '/api/status').then(res => res.json());
  const branches = await fetch(app.origin + '/api/branches').then(res => res.json());
  const post = (branch, clean = true, headers = {}) => fetch(app.origin + '/api/export', {
    method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ branch, clean, revision: branches.find(row => row.branch === branch)?.revision ?? '0'.repeat(40) }),
  });
  async function finished() {
    for (let i = 0; i < 400; i++) {
      const current = await state();
      if (current.job.status !== 'running') return current;
      await delay(30);
    }
    assert.fail('Export did not finish');
  }
  return { root, output, git, app, state, branches, post, finished };
}
