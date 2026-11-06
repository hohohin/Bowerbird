import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = path => readFileSync(resolve(root, path), 'utf8');
const contract = JSON.parse(read('website/cloud-routes.json'));
function sources(dir) {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? sources(path) : path.endsWith('.rs') ? [path] : [];
  });
}
const files = sources('apps/desktop/src-tauri/src').filter(path => !/(?:_tests|\/tests)\b/.test(path));
const production = path => read(path).replace(/#\[cfg\(test\)\]\s*mod \w+\s*\{[\s\S]*?^\}/gm, '');

test('every desktop Cloud function call is registered; no business code reads the raw upstream', () => {
  const used = new Set();
  for (const file of files) {
    if (file.endsWith('/cloud/config.rs')) continue;
    const source = production(file);
    for (const [, name] of source.matchAll(/(?<!account_)\.endpoint\("([^"]+)"\)/g)) {
      used.add(name);
      assert.ok(contract.functions.includes(name), `unregistered Cloud function ${name}: ${file}`);
    }
    assert.doesNotMatch(source, /\.supabase_url\b|\/rest\/v1\/|https:\/\/[^\s"']+\.supabase\.co/, `direct Cloud URL bypass in ${file}`);
  }
  assert.deepEqual([...used].sort(), [...contract.functions].sort());
});

test('desktop and gateway consume the same contract and Agent transfers cannot bypass mapping', () => {
  assert.match(read('apps/desktop/src-tauri/src/cloud/config.rs'), /include_str!\("\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/website\/cloud-routes.json"\)/);
  assert.match(read('website/cloud-proxy.mjs'), /new URL\('\.\/cloud-routes.json', import.meta.url\)/);
  const agent = production('apps/desktop/src-tauri/src/commands/cloud_agent.rs');
  const upload = agent.slice(agent.indexOf('async fn upload_signed('), agent.indexOf('fn validate_html_layout_options('));
  const download = agent.slice(agent.indexOf('async fn download_artifact('), agent.indexOf('async fn download_artifact(') + 6000);
  assert.match(upload, /agent_transfer_url\(url, true\)/);
  assert.match(download, /agent_transfer_url\(url, false\)/);
  assert.equal((agent.match(/\.put\(/g) || []).length, 1, 'Agent uploads must use the one mapped helper');
});
