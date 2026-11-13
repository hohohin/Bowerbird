import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const dist = resolve(desktop, process.argv[2] ?? 'dist');
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
}
const artifacts = files(dist).filter(f => /\.(js|html|css|map|json|md|txt)$/i.test(f));
assert(artifacts.some(f => f.endsWith('.js')), 'Build the desktop frontend before running this check.');
const skills = ['h3-video-prompt', 'text-editor'];
const lines = skills.flatMap(id => {
  const body = readFileSync(join(desktop, '../agent-worker/src/skills/text', id, 'SKILL.md'), 'utf8');
  return body.split(/\r?\n/).map((text, i) => ({ text: text.trim(), id, line: i + 1 })).filter(p => p.text.length >= 24);
});
assert(skills.every(id => lines.some(p => p.id === id)));
for (const file of artifacts) {
  const content = readFileSync(file, 'utf8').replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  for (const p of lines) assert(!content.includes(p.text), `${relative(dist, file)} contains ${p.id} line ${p.line}`);
}
const config = JSON.parse(readFileSync(join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'));
assert(!Object.keys(config.bundle.resources).some(p => /agent-worker|text-skills|dsh-chat/.test(p)), 'Check native resources');
for (const rust of files(join(desktop, 'src-tauri/src')).filter(f => f.endsWith('.rs'))) {
  assert(!/include_(?:str|bytes)!\s*\(\s*["'][^"']*(?:agent-worker\/src\/skills\/text|(?:text-editor|h3-video-prompt)\/SKILL\.md)/.test(readFileSync(rust, 'utf8')), relative(desktop, rust));
}
console.log(`Checked ${artifacts.length} frontend files and native resource declarations; no matches for ${lines.length} skill passages.`);
