import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedFile, safePath, redact, digest, validateSnapshot, MAX_FILE_BYTES, MAX_SNAPSHOT_BYTES } from './core.mjs';
import { references, candidates, coreSource, testFile, relatedTest } from './dependencies.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Reviewed exceptions may be shared before their implementation is committed.
export const EXPLICIT_FILES = [
  'apps/code-reader-mcp/branch-console.mjs',
  'apps/code-reader-mcp/console.html',
  'apps/code-reader-mcp/console.js',
];
export async function readSource(root, relative) {
  if (!allowedFile(relative)) throw new Error('Excluded path');
  const canonicalRoot = await fs.realpath(root);
  let current = canonicalRoot;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Link excluded');
  }
  const resolved = await fs.realpath(current);
  const inside = path.relative(canonicalRoot, resolved);
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('Outside root');
  const handle = await fs.open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
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

async function writeAtomic(output, data) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(data); }
    finally { await handle.close(); }
    for (let attempt = 1; ; attempt++) {
      try { await fs.rename(temporary, output); return; }
      catch (error) {
        if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EBUSY'].includes(error.code)) throw error;
        await delay(50 * attempt);
      }
    }
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function exportSnapshot(root, output, { branch, onProgress, beforePublish, reportPath } = {}) {
  const git = (...args) => execFileSync('git', ['--no-optional-locks', '-C', root, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  const revision = git('rev-parse', 'HEAD').trim();
  const worktreeBranch = git('branch', '--show-current').trim();
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
        const entry = await fs.lstat(path.join(root, choice));
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
      const filteredBytes = Buffer.byteLength(filtered.content);
      if (filteredBytes > MAX_FILE_BYTES) throw new Error('Redacted file exceeds 1 MiB: ' + name);
      bytes += filteredBytes;
      redactedLines += filtered.redactedLines;
      files.push({ path: name, content: filtered.content, sha256: digest(filtered.content) });
      included.add(name);
      onProgress?.({ exportedFiles: files.length, redactedLines, coverageStatus: 'checking' });
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
  const isDirty = git('status', '--porcelain=v1', '--untracked-files=normal').length > 0;
  if (git('rev-parse', 'HEAD').trim() !== revision || git('branch', '--show-current').trim() !== worktreeBranch) {
    throw new Error('Git HEAD changed during export. Retry the export.');
  }
  const metadata = { createdAt: new Date().toISOString(), revision, branch: branch ?? (worktreeBranch || '(detached HEAD)'), isDirty };
  const snapshot = { version: 1, ...metadata, coverage, files };
  const report = { ...metadata, exportedFiles: files.length, redactedLines, skipped, coverage };
  if (coverage.unresolvedCoreDependencies.length) {
    coverage.status = 'incomplete';
    if (reportPath) await writeAtomic(reportPath, JSON.stringify(report, null, 2));
    throw Object.assign(new Error('Core source dependencies were not exported: ' + JSON.stringify(coverage.unresolvedCoreDependencies)), { report });
  }
  const serialized = JSON.stringify(validateSnapshot(snapshot));
  if (Buffer.byteLength(serialized) > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot exceeds serialized limit');
  await beforePublish?.(report);
  if (reportPath) await writeAtomic(reportPath, JSON.stringify(report, null, 2));
  await writeAtomic(output, serialized);
  return report;
}

export function exportSnapshotWithReport(root, output, options) {
  return exportSnapshot(root, output, { ...options, reportPath: path.join(path.dirname(output), 'report.json') });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.join(here, '.local', 'snapshot.json');
  try {
    const report = await exportSnapshotWithReport(path.resolve(here, '../..'), output);
    console.log(JSON.stringify({ exportedFiles: report.exportedFiles, redactedLines: report.redactedLines, skippedFiles: report.skipped.length,
      dependencyFiles: report.coverage.dependencyFiles.length, relatedTests: report.coverage.relatedTestFiles.length, snapshot: output }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
