import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, mkdir, writeFile, readFile, rm, link, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { exportSnapshot } from '../export.mjs';
import { references, candidates } from '../dependencies.mjs';
import { allowedFile, validateSnapshot, callTool, MAX_FILE_BYTES, redact } from '../core.mjs';

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

test('regular expressions with quotes, slash classes and escaped slashes do not consume imports', () => {
  const code = [
    "const single = /'/g; import './after-single';",
    'const punctuation = /["//]/u; import "./after-slashes";',
    String.raw`const match = () => /a\/b"c/i; import './after-escape';`,
    String.raw`const fake = /from '.\/fake'/; const ratio = 10 / require('./divisor') / 2;`,
  ].join('\n');
  assert.deepEqual(references('apps/a/main.ts', code).map(ref => ref.specifier),
    ['./after-single', './after-slashes', './after-escape', './divisor']);
});

test('post-redaction size limit preserves the prior snapshot', async t => {
  const f = await fixture(t);
  await f.file('PROJECT.md', 'original');
  await f.track(['PROJECT.md']);
  await exportSnapshot(f.dir, f.output);
  const previous = await readFile(f.output);
  const content = '-----BEGIN PRIVATE KEY-----\n' + 'x\n'.repeat(33000) + '-----END PRIVATE KEY-----';
  assert.ok(Buffer.byteLength(content) < MAX_FILE_BYTES);
  assert.ok(Buffer.byteLength(redact(content).content) > MAX_FILE_BYTES);
  await f.file('PROJECT.md', content);
  await assert.rejects(exportSnapshot(f.dir, f.output), /Redacted file exceeds 1 MiB/);
  assert.deepEqual(await readFile(f.output), previous);
});

test('an unsuccessful rename removes the private temporary file', async t => {
  const f = await fixture(t);
  await f.file('PROJECT.md', 'first');
  await f.track(['PROJECT.md']);
  await mkdir(f.output);
  await assert.rejects(exportSnapshot(f.dir, f.output));
  assert.deepEqual((await readdir(path.dirname(f.output))).sort(), ['repo', 'snapshot.json']);
});

test('Windows publication retries sharing errors while the old snapshot remains readable', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await f.file('PROJECT.md', 'old');
  await f.track(['PROJECT.md']);
  await exportSnapshot(f.dir, f.output);
  const previous = await readFile(f.output);
  await f.file('PROJECT.md', 'new');
  const rename = fs.rename;
  const errors = ['EPERM', 'EBUSY'];
  const mock = t.mock.method(fs, 'rename', async (from, to) => {
    assert.deepEqual(await readFile(to), previous);
    if (errors.length) throw Object.assign(new Error('Sharing conflict'), { code: errors.shift() });
    return rename(from, to);
  });
  await exportSnapshot(f.dir, f.output);
  assert.equal(mock.mock.callCount(), 3);
  assert.equal(validateSnapshot(JSON.parse(await readFile(f.output))).files[0].content, 'new');
  assert.deepEqual((await readdir(path.dirname(f.output))).sort(), ['repo', 'snapshot.json']);
});

test('direct detached exports record the commit and count untracked working tree changes', async t => {
  const f = await fixture(t);
  await f.file('PROJECT.md', 'first');
  await f.track(['PROJECT.md']);
  f.git('switch', '--detach', 'HEAD');
  for (const dirty of [false, true]) {
    if (dirty) await f.file('untracked.txt', 'not shared');
    await exportSnapshot(f.dir, f.output);
    const overview = callTool(JSON.parse(await readFile(f.output)), 'project_overview');
    assert.equal(overview.branch, '(detached HEAD)');
    assert.equal(overview.revision, f.git('rev-parse', 'HEAD').toString().trim());
    assert.equal(overview.isDirty, dirty);
    assert.equal(overview.fileCount, 1);
  }
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
