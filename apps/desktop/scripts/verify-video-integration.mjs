// Read-only drift guard for the reviewed integration patch. Does not stage, apply or commit files.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [manifestPath, directory, mode = 'before'] = process.argv.slice(2);
if (!manifestPath || !directory || !['before', 'api', 'after'].includes(mode)) throw new Error('usage: verify-video-integration.mjs MANIFEST TARGET_DIRECTORY [before|api|after]');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.supersededBy) throw new Error(`superseded_manifest_use_${manifest.supersededBy}`);
const root = path.resolve(directory);
const mismatches = [];
for (const file of manifest.integrationFiles) {
  if (path.isAbsolute(file.path) || file.path.split(/[\\/]/).some(part => part === '..' || part === '.git')) throw new Error('invalid_manifest_path');
  const target = path.resolve(root, file.path);
  if (!target.startsWith(root + path.sep)) throw new Error('path_outside_target');
  const actual = fs.existsSync(target)
    ? createHash('sha256').update(fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n')).digest('hex')
    : null;
  const expected = mode === 'before' ? file.savedSha256 : mode === 'api' ? file.apiSha256 : file.mergedSha256;
  if (actual !== expected) mismatches.push(file.path);
}
console.log(JSON.stringify({ mode, checked: manifest.integrationFiles.length, matches: mismatches.length === 0, mismatches }, null, 2));
if (mismatches.length) process.exitCode = 1;
