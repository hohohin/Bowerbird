import { execFileSync } from 'node:child_process';
import { localReferences, isCoreSource, relatedTests } from './dependencies.mjs';
import { constants } from 'node:fs';
import { lstat, realpath, open, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedFile, redact, digest, MAX_FILE_BYTES, MAX_SNAPSHOT_BYTES } from './core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
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
  const names = [...new Set([...git('ls-files', '-z', '--cached').split('\0').filter(Boolean), 'dev-doc/Bowerbird开发计划.md'])].sort();
  const untracked = git('ls-files', '-z', '--others', '--exclude-standard').split('\0').filter(Boolean);
  const allowedUntracked = new Set(untracked.filter(allowedFile));
  const seeds = new Set(names);
  const files = new Map();
  const skipped = [];
  let redactedLines = 0;
  let bytes = 0;
  const visited = new Set();
  const pending = [];
  const coverageCheck = { dependencyFiles: 0, relatedTests: 0, unresolvedReferences: 0 };
  const issues = [];
  const candidatesSeen = new Map();
  const checkCandidate = async name => {
    if (!candidatesSeen.has(name)) {
      const exists = await lstat(path.join(root, name)).then(stat => !stat.isDirectory(), error => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
        throw error;
      });
      candidatesSeen.set(name, exists);
    }
    return candidatesSeen.get(name);
  };
  const enqueue = (name, kind) => {
    if (visited.has(name)) return;
    visited.add(name);
    pending.push({ name, kind });
  };
  const scan = async () => {
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const { name, kind } = pending[cursor];
      if (!allowedFile(name)) { skipped.push({ path: name, reason: 'policy' }); continue; }
      let source;
      try { source = await readSource(root, name); }
      catch {
        skipped.push({ path: name, reason: 'unavailable, linked, binary or oversized' });
        continue;
      }
      const filtered = redact(source);
      bytes += Buffer.byteLength(filtered.content);
      redactedLines += filtered.redactedLines;
      files.set(name, { path: name, content: filtered.content, sha256: digest(filtered.content) });
      if (kind) coverageCheck[kind]++;
      if (bytes > MAX_SNAPSHOT_BYTES || files.size > 10000) throw new Error('Snapshot exceeds limit');
      for (const alternatives of localReferences(name, source)) {
        const eligible = alternatives.filter(allowedFile);
        if (!eligible.length) continue;
        let selected;
        for (const candidate of eligible) {
          if (await checkCandidate(candidate)) { selected = candidate; break; }
        }
        if (!selected) { coverageCheck.unresolvedReferences++; continue; }
        if (isCoreSource(name)) issues.push({ source: name, dependency: selected });
        if (seeds.has(selected) || allowedUntracked.has(selected)) enqueue(selected, 'dependencyFiles');
        else if (!isCoreSource(name)) coverageCheck.unresolvedReferences++;
      }
    }
    pending.length = 0;
  };
  for (const name of names) enqueue(name);
  await scan();
  for (const name of relatedTests(files.keys(), [...allowedUntracked])) enqueue(name, 'relatedTests');
  await scan();
  const uncovered = issues.filter(item => !files.has(item.dependency));
  if (uncovered.length) {
    const examples = uncovered.slice(0, 5).map(item => `${item.source} → ${item.dependency}`).join(', ');
    throw new Error(`Snapshot coverage check failed (${uncovered.length} references): ${examples}`);
  }
  if (!files.size) throw new Error('No eligible files');
  const snapshot = { version: 1, createdAt: new Date().toISOString(), revision: git('rev-parse', 'HEAD').trim(),
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), coverageCheck };
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized) > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot exceeds serialized limit');
  await mkdir(path.dirname(output), { recursive: true });
  // Never overwrite an existing symlink or write through it.
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 });
  await rename(temporary, output);
  const report = { createdAt: snapshot.createdAt, revision: snapshot.revision, exportedFiles: files.size, redactedLines, skipped, coverageCheck };
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.join(here, '.local', 'snapshot.json');
  const report = await exportSnapshot(path.resolve(here, '../..'), output);
  await writeFile(path.join(here, '.local', 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ exportedFiles: report.exportedFiles, redactedLines: report.redactedLines, skippedFiles: report.skipped.length, snapshot: output }));
}
