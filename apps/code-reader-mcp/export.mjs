import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, realpath, open, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedFile, safePath, redact, digest, MAX_FILE_BYTES, MAX_SNAPSHOT_BYTES } from './core.mjs';
import { references, candidates, coreSource, testFile, relatedTest } from './dependencies.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Reviewed exceptions may be shared before their implementation is committed.
export const EXPLICIT_FILES = [
  'dev-doc/Bowerbird开发计划.md',
  'macOS/RELEASE-READINESS.md',
  'apps/agent-worker/src/control-plane/control-transport.ts',
  'apps/agent-worker/src/control-plane/control-transport.test.ts',
  'apps/desktop/src/lib/settingsQueue.ts',
  'apps/desktop/scripts/settings-queue.test.mjs',
  'apps/cloud/supabase/migrations/0091_agent_model_usage_settlement.sql',
  'apps/cloud/scripts/agent-model-usage-settlement-db.test.mjs',
  'apps/cloud/scripts/check-vps-release-health.mjs',
  'apps/cloud/scripts/ga-local-mixed-capacity.mjs',
  'apps/cloud/supabase/migrations/0092_file_speech.sql',
  'apps/cloud/supabase/migrations/0093_file_speech_storage_mime.sql',
  'apps/cloud/supabase/migrations/0094_chat_daily_limits.sql',
  'apps/cloud/supabase/migrations/0095_chat_model_usage.sql',
  'apps/cloud/supabase/migrations/0096_chat_paid_billing.sql',
  'apps/cloud/supabase/migrations/0098_file_speech_pilot.sql',
  'apps/cloud/supabase/migrations/0099_file_speech_repeat_test_account.sql',
  'apps/cloud/scripts/chat-paid-db.fixture.mjs',
  'apps/cloud/supabase/functions/chat-worker/index_test.ts',
];
export async function readSource(root, relative) {
  if (!allowedFile(relative)) throw new Error('Excluded path');
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Link excluded');
  }
  const resolved = await realpath(current);
  const inside = path.relative(canonicalRoot, resolved);
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('Outside root');
  const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw new Error('Non-regular, linked or oversized file');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_FILE_BYTES || buffer.subarray(0, length).includes(0)) throw new Error('Oversized or binary file');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally { await handle.close(); }
}

export async function exportSnapshot(root, output) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  const tracked = git('ls-files', '-z', '--cached').split('\0').filter(Boolean);
  const testPaths = ['apps', 'website', 'dev-doc', 'Windows', 'macOS'].flatMap(directory => [
    ...['test', 'tests', 'scripts'].map(folder => `:(glob)${directory}/**/${folder}/**`),
    ...['*.test.*', '*.spec.*', '*_test.*', '*_tests.*', 'test_*'].map(name => `:(glob)${directory}/**/${name}`),
  ]);
  const excludedTrees = ['node_modules', 'target', 'dist', 'build', 'resources', 'binaries', 'fixtures', 'vendor', '.*']
    .map(directory => `:(glob,exclude)**/${directory}/**`);
  const untracked = git('ls-files', '-z', '--others', '--exclude-standard', '--', ...testPaths, ...excludedTrees).split('\0').filter(Boolean);
  const names = [...new Set([...tracked, ...EXPLICIT_FILES])].sort();
  const queued = new Set(names);
  const files = [];
  const included = new Set();
  const contents = new Map();
  const skipped = [];
  const coverage = { status: 'checked', analysis: 'Static literal JS/TS imports, Rust module/include paths and related-test heuristics; dynamic paths are not evaluated.',
    dependencyFiles: [], relatedTestFiles: [], unresolvedCoreDependencies: [], excludedDependencies: [], unresolvedReferences: [] };
  let redactedLines = 0;
  let bytes = 0;
  async function content(name) {
    if (!contents.has(name)) contents.set(name, await readSource(root, name));
    return contents.get(name);
  }
  async function dependency(from, reference) {
    if (reference.kind === 'dynamic') {
      coverage.unresolvedReferences.push({ from, target: 'dynamic-expression', reason: 'Computed path is not evaluated' });
      return;
    }
    const choices = candidates(from, reference);
    let target;
    for (const choice of choices) {
      if (!safePath(choice)) continue;
      try {
        const entry = await lstat(path.join(root, choice));
        if (entry.isFile() || entry.isSymbolicLink()) { target = choice; break; }
      } catch { /* Missing extension alternatives are normal. */ }
    }
    if (!target) {
      coverage.unresolvedReferences.push({ from, target: choices.find(choice => safePath(choice)) ?? 'outside-project', reason: 'No literal local file resolved' });
      return;
    }
    if (included.has(target)) return;
    let reason;
    if (!allowedFile(target)) reason = 'policy';
    else {
      try { await content(target); }
      catch { reason = 'unavailable, linked, binary or oversized'; }
    }
    if (reason) {
      const gap = { from, target, reason };
      // Fixtures, dependencies and generated trees remain intentional exclusions.
      const intentional = /\/(?:fixtures|node_modules|target|dist|build|resources|binaries)\//.test('/' + target) ||
        /\/(?:before-preview|frozen-preview)\/assets\//.test(target);
      if (coreSource(target) && !intentional) coverage.unresolvedCoreDependencies.push(gap);
      else coverage.excludedDependencies.push(gap);
      return;
    }
    if (!queued.has(target)) {
      queued.add(target);
      names.push(target);
      coverage.dependencyFiles.push(target);
    }
  }
  const possibleTests = [...new Set([...tracked, ...untracked])].filter(file => allowedFile(file) && testFile(file));
  let cursor = 0;
  while (true) {
    while (cursor < names.length) {
      const name = names[cursor++];
      if (!allowedFile(name)) { skipped.push({ path: name, reason: 'policy' }); continue; }
      let source;
      try { source = await content(name); }
      catch { skipped.push({ path: name, reason: 'unavailable, linked, binary or oversized' }); continue; }
      const filtered = redact(source);
      bytes += Buffer.byteLength(filtered.content);
      redactedLines += filtered.redactedLines;
      files.push({ path: name, content: filtered.content, sha256: digest(filtered.content) });
      included.add(name);
      for (const reference of references(name, source)) await dependency(name, reference);
      if (bytes > MAX_SNAPSHOT_BYTES || files.length > 10000) throw new Error('Snapshot exceeds limit');
    }
    for (const candidate of possibleTests) {
      if (queued.has(candidate)) continue;
      try {
        if (!relatedTest(candidate, await content(candidate), included)) continue;
        queued.add(candidate);
        names.push(candidate);
        coverage.relatedTestFiles.push(candidate);
      } catch { /* Unreadable tests are not automatically selected. */ }
    }
    if (cursor === names.length) break;
  }
  if (!files.length) throw new Error('No eligible files');
  files.sort((a, b) => a.path.localeCompare(b.path));
  const snapshot = { version: 1, createdAt: new Date().toISOString(), revision: git('rev-parse', 'HEAD').trim(), coverage, files };
  const report = { createdAt: snapshot.createdAt, revision: snapshot.revision, exportedFiles: files.length, redactedLines, skipped, coverage };
  if (coverage.unresolvedCoreDependencies.length) {
    coverage.status = 'incomplete';
    throw Object.assign(new Error('Core source dependencies were not exported: ' + JSON.stringify(coverage.unresolvedCoreDependencies)), { report });
  }
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized) > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot exceeds serialized limit');
  await mkdir(path.dirname(output), { recursive: true });
  // Never overwrite an existing symlink or write through it.
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 });
  await rename(temporary, output);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.join(here, '.local', 'snapshot.json');
  try {
    const report = await exportSnapshot(path.resolve(here, '../..'), output);
    await writeFile(path.join(here, '.local', 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ exportedFiles: report.exportedFiles, redactedLines: report.redactedLines, skippedFiles: report.skipped.length,
      dependencyFiles: report.coverage.dependencyFiles.length, relatedTests: report.coverage.relatedTestFiles.length, snapshot: output }));
  } catch (error) {
    if (error.report) {
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(path.join(here, '.local', 'report.json'), JSON.stringify(error.report, null, 2), { mode: 0o600 });
    }
    console.error(error.message);
    process.exitCode = 1;
  }
}
