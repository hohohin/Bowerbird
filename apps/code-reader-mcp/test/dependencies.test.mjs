import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, link } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { exportSnapshot } from '../export.mjs';
import { references, candidates } from '../dependencies.mjs';
import { allowedFile, validateSnapshot, callTool } from '../core.mjs';

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'bb-coverage-'));
  const dir = path.join(temporary, 'repo');
  await mkdir(dir);
  t.after(async () => {
    assert.equal(path.dirname(temporary), os.tmpdir());
    await rm(temporary, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', windowsHide: true });
  git('init');
  async function file(name, content) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  async function track(names) {
    git('add', '--', ...names);
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  }
  return { dir, file, track, git, output: path.join(temporary, 'snapshot.json') };
}

test('literal scanner handles JS/TS forms, Rust attributes, lifetimes and raw strings without executing code', () => {
  const refs = references('apps/a/src/main.ts', `
    // import './comment.ts';
    const text = "from './string.ts'";
    import type { A } from './a.js'; export * from './b';
    import './style.css'; require('./c'); import('./d');
    import('package'); import('./' + name); import(\`./\${name}\`);
  `);
  // Computed import('./' + name) must not be mistaken for a literal module.
  assert.deepEqual(refs.filter(ref => ref.kind !== 'dynamic').map(ref => ref.specifier), ['./a.js', './b', './style.css', './c', './d']);
  assert.equal(refs.filter(ref => ref.kind === 'dynamic').length, 2);
  assert.ok(candidates('apps/a/src/main.ts', refs[0]).includes('apps/a/src/a.ts'));
  const rust = references('apps/a/src/lib.rs', `
    pub fn lifetime<'a>(s: &'a str) -> &'a str { s }
    let windows = r"\\?\\";
    #[cfg(test)] #[path = "local_chat_dsh_host.rs"] mod host;
    const DATA: &str = include_str!(r#"dsh-install/package.json"#);
    mod nested;
  `);
  assert.deepEqual(rust.map(ref => ref.specifier), ['local_chat_dsh_host.rs', 'dsh-install/package.json', 'nested']);
  assert.deepEqual(candidates('apps/a/src/lib.rs', rust[2]), ['apps/a/src/nested.rs', 'apps/a/src/nested/mod.rs']);
});

test('export closes recursive dependencies and discovers related UI/Python tests while preserving Git state', async t => {
  const f = await fixture(t);
  const main = 'apps/desktop/src/main.ts';
  const rust = 'apps/desktop/src-tauri/src/lib.rs';
  await f.file(main, "import './NotificationBell'; import './DshSubscriptionCard.js';");
  await f.file(rust, '#[path = "local_chat_dsh_host.rs"] mod host;');
  await f.track([main, rust]);
  const expected = {
    'apps/desktop/src/NotificationBell.tsx': "export { value } from './lib/dismissedNotices';",
    'apps/desktop/src/lib/dismissedNotices.ts': "import '../NotificationBell'; export const value = 1;",
    'apps/desktop/src/lib/dismissedNotices.test.ts': "import './dismissedNotices';",
    'apps/desktop/src/DshSubscriptionCard.tsx': 'export const card = 1;',
    'apps/desktop/src-tauri/src/local_chat_dsh_host.rs': '#[path = "local_chat_dsh_install.rs"] mod install;',
    'apps/desktop/src-tauri/src/local_chat_dsh_install.rs': 'const PACKAGE: &str = include_str!("dsh-install/package.json");',
    'apps/desktop/src-tauri/src/dsh-install/package.json': '{"name":"fixture"}',
    'apps/desktop/src-tauri/tests/dsh-auto-host.py': '# DSH automatic host test\nAPI_KEY=abcdefghijklmnop',
    'apps/desktop/scripts/notification-bell-dismiss-ui.test.mjs': '// notice dismissal test',
  };
  for (const [name, text] of Object.entries(expected)) await f.file(name, text);
  await f.file('apps/desktop/src/unrelated.ts', 'unrelated');
  await f.file('apps/desktop/scripts/unrelated-network.test.mjs', 'unrelated');
  await f.file('.env.tunnel', 'MCP_UPDATE_KEY=abcdefghijklmnop');
  const before = f.git('status', '--porcelain').toString();
  const report = await exportSnapshot(f.dir, f.output);
  const snapshot = validateSnapshot(JSON.parse(await readFile(f.output, 'utf8')));
  for (const name of Object.keys(expected)) assert.ok(snapshot.files.some(file => file.path === name), name);
  assert.equal(snapshot.files.some(file => file.path.includes('unrelated') || file.path.startsWith('.env')), false);
  assert.ok(snapshot.files.find(file => file.path.endsWith('dsh-auto-host.py')).content.includes('[REDACTED'));
  assert.equal(report.coverage.status, 'checked');
  assert.equal(report.coverage.unresolvedCoreDependencies.length, 0);
  assert.equal(callTool(snapshot, 'project_overview').coverageCheck.relatedTests, 3);
  assert.equal(f.git('status', '--porcelain').toString(), before);
});

test('an existing linked core dependency fails export and preserves the previous snapshot', async t => {
  const f = await fixture(t);
  const main = 'apps/a/src/main.ts';
  await f.file(main, "import './linked';");
  await f.track([main]);
  await f.file('outside.ts', 'private sentinel');
  await link(path.join(f.dir, 'outside.ts'), path.join(f.dir, 'apps/a/src/linked.ts'));
  await writeFile(f.output, 'previous valid snapshot');
  await assert.rejects(exportSnapshot(f.dir, f.output), error => {
    assert.equal(error.report.coverage.status, 'incomplete');
    assert.equal(error.report.coverage.unresolvedCoreDependencies[0].target, 'apps/a/src/linked.ts');
    return true;
  });
  assert.equal(await readFile(f.output, 'utf8'), 'previous valid snapshot');
});

test('intentional exclusions and unresolved runtime references are visible, with legacy coverage marked unknown', async t => {
  const f = await fixture(t);
  await f.file('apps/a/src/main.ts', "import './fixtures/demo.ts'; import './runtime-generated.mjs';");
  await f.file('apps/a/src/fixtures/demo.ts', 'excluded');
  await f.track(['apps/a/src/main.ts']);
  const report = await exportSnapshot(f.dir, f.output);
  assert.equal(report.coverage.excludedDependencies.length, 1);
  assert.equal(report.coverage.unresolvedReferences.length, 1);
  assert.equal(report.coverage.status, 'checked');
  const snapshot = JSON.parse(await readFile(f.output, 'utf8'));
  delete snapshot.coverage;
  assert.equal(callTool(snapshot, 'project_overview').coverageCheck.status, 'not_recorded');
  assert.ok(allowedFile('apps/a/src/auth.ts'));
  assert.ok(allowedFile('apps/a/tests/host.py'));
  assert.equal(allowedFile('apps/a/auth.json'), false);
  assert.equal(allowedFile('apps/a/passwords.py'), false);
});
