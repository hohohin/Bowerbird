import { execFileSync } from 'node:child_process';
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
  const files = [];
  const skipped = [];
  let redactedLines = 0;
  let bytes = 0;
  for (const name of names) {
    if (!allowedFile(name)) { skipped.push({ path: name, reason: 'policy' }); continue; }
    try {
      const filtered = redact(await readSource(root, name));
      bytes += Buffer.byteLength(filtered.content);
      redactedLines += filtered.redactedLines;
      files.push({ path: name, content: filtered.content, sha256: digest(filtered.content) });
    } catch { skipped.push({ path: name, reason: 'unavailable, linked, binary or oversized' }); }
    if (bytes > MAX_SNAPSHOT_BYTES || files.length > 10000) throw new Error('Snapshot exceeds limit');
  }
  if (!files.length) throw new Error('No eligible files');
  const snapshot = { version: 1, createdAt: new Date().toISOString(), revision: git('rev-parse', 'HEAD').trim(), files };
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized) > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot exceeds serialized limit');
  await mkdir(path.dirname(output), { recursive: true });
  // Never overwrite an existing symlink or write through it.
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 });
  await rename(temporary, output);
  const report = { createdAt: snapshot.createdAt, revision: snapshot.revision, exportedFiles: files.length, redactedLines, skipped };
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.join(here, '.local', 'snapshot.json');
  const report = await exportSnapshot(path.resolve(here, '../..'), output);
  await writeFile(path.join(here, '.local', 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ exportedFiles: report.exportedFiles, redactedLines: report.redactedLines, skippedFiles: report.skipped.length, snapshot: output }));
}
