import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm, copyFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { allowedFile, safePath, redact, digest, validateSnapshot, callTool, TOOLS } from '../core.mjs';
import { readSource, exportSnapshot } from '../export.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const makeFile = (name, content) => ({ path: name, content, sha256: digest(content) });
const sample = () => ({ version: 1, createdAt: '2026-10-24T00:00:00Z', revision: 'fixture', files: [
  makeFile('PROJECT.md', 'Bowerbird\nLocal-first\n项目'),
  makeFile('apps/desktop/src/demo.ts', 'export const code = 1;\n// Bowerbird\n// 中文测试'),
] });

async function temporary(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bowerbird-code-reader-test-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), dir);
    assert.ok(relative.startsWith('bowerbird-code-reader-test-') && !relative.includes(path.sep));
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('path policy rejects escapes, secrets, generated data and binary files', () => {
  for (const value of ['../PROJECT.md', '/etc/passwd', 'C:/secret', 'a\\b', 'a/../b', 'a//b', '%2e%2e/x', 'a.ts:secret', 'a\0b', 'a./b']) assert.equal(safePath(value), false, value);
  for (const value of ['.env.tos', 'apps/cloud/.env', '.git/config', 'apps/cloud/secrets.json', 'apps/desktop/target/src.rs', 'apps/desktop/.tmp/foo.ts', 'apps/a/x.db', 'apps/a/auth.json', 'apps/a/key.pem', 'assets/a.jpg']) assert.equal(allowedFile(value), false, value);
  assert.equal(allowedFile('apps/desktop/src-tauri/src/commands/projects.rs'), true);
});

test('credential filtering preserves line numbers and removes private key blocks', () => {
  const token = 'sk-' + 'a'.repeat(30);
  const source = ['safe', `const api_key = "${token}";`, '-----BEGIN PRIVATE KEY-----', 'private material', '-----END PRIVATE KEY-----', 'safe again'].join('\n');
  const result = redact(source);
  assert.equal(result.redactedLines, 4);
  assert.equal(result.content.split('\n').length, 6);
  assert.ok(!result.content.includes(token) && !result.content.includes('private material'));
  assert.equal(redact('API_KEY=abcdefghijklmnop\nAuthorization: Bearer abcdefghijklmnop').redactedLines, 2);
});

test('snapshot rejects corrupted, duplicated and forbidden files', () => {
  assert.doesNotThrow(() => validateSnapshot(sample()));
  for (const file of [makeFile('../secret', 'x'), makeFile('apps/a/.env', 'x'), { ...makeFile('PROJECT.md', 'x'), sha256: 'wrong' }]) {
    assert.throws(() => validateSnapshot({ ...sample(), files: [file] }));
  }
  assert.throws(() => validateSnapshot({ ...sample(), files: [sample().files[0], sample().files[0]] }));
});

test('read, search, pagination and strict argument validation', () => {
  const data = sample();
  assert.equal(callTool(data, 'project_overview').fileCount, 2);
  assert.equal(callTool(data, 'list_files', { limit: 1 }).nextOffset, 1);
  assert.equal(callTool(data, 'read_file', { path: 'PROJECT.md', startLine: 2, limit: 1 }).lines[0].text, 'Local-first');
  assert.equal(callTool(data, 'search_code', { query: 'BOWERBIRD', limit: 1 }).nextOffset, 1);
  assert.equal(callTool(data, 'search_code', { query: 'BOWERBIRD', offset: 1 }).results.length, 1);
  assert.equal(callTool(data, 'search_code', { query: '中文' }).results[0].line, 3);
  assert.deepEqual(callTool(data, 'search_code', { query: '(a+)+$' }).results, []);
  for (const args of [{ path: '../.env' }, { path: 'PROJECT.md', limit: 201 }, { path: 'PROJECT.md', startLine: 0 }, { path: 'PROJECT.md', command: 'del' }, { path: 'missing.ts' }]) assert.throws(() => callTool(data, 'read_file', args));
  assert.throws(() => callTool(data, 'write_file', { path: 'PROJECT.md', content: 'changed' }));
  assert.throws(() => callTool(data, 'search_code', { query: '' }));
  assert.throws(() => callTool(data, 'list_files', { constructor: 1 }));
  assert.throws(() => callTool(data, 'list_files', { prefix: '/' }));
  assert.ok(TOOLS.every(t => t.annotations.readOnlyHint && !t.annotations.destructiveHint));
});

test('responses remain bounded for very long source lines', () => {
  const data = { ...sample(), files: [makeFile('PROJECT.md', 'x'.repeat(900000))] };
  const result = callTool(data, 'read_file', { path: 'PROJECT.md' });
  assert.ok(JSON.stringify(result).length < 13000);
  assert.ok(result.lines[0].text.endsWith('[LINE TRUNCATED]'));
});

test('export reads tracked current edits, excludes untracked secrets and leaves source unchanged', async t => {
  const dir = await temporary(t);
  const root = path.join(dir, 'repo');
  await mkdir(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', windowsHide: true });
  git('init');
  await writeFile(path.join(root, 'PROJECT.md'), 'old');
  git('add', 'PROJECT.md');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  await writeFile(path.join(root, 'PROJECT.md'), 'current edit');
  await writeFile(path.join(root, '.env'), 'password=private');
  const status = git('status', '--porcelain').toString();
  const out = path.join(dir, 'snapshot.json');
  const report = await exportSnapshot(root, out);
  const snapshot = validateSnapshot(JSON.parse(await readFile(out, 'utf8')));
  assert.equal(report.exportedFiles, 1);
  assert.equal(snapshot.files[0].content, 'current edit');
  assert.equal(git('status', '--porcelain').toString(), status);
  assert.equal(await readFile(path.join(root, '.env'), 'utf8'), 'password=private');
});

test('export rejects junction traversal, hardlinks, binary and oversize files', async t => {
  const dir = await temporary(t);
  const root = path.join(dir, 'repo');
  const outside = path.join(dir, 'outside');
  await mkdir(path.join(root, 'apps'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, 'private.ts'), 'sentinel');
  await symlink(outside, path.join(root, 'apps', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readSource(root, 'apps/escape/private.ts'));
  await link(path.join(outside, 'private.ts'), path.join(root, 'apps', 'hard.ts'));
  await assert.rejects(readSource(root, 'apps/hard.ts'));
  await writeFile(path.join(root, 'apps', 'binary.ts'), Buffer.from([1, 0, 2]));
  await assert.rejects(readSource(root, 'apps/binary.ts'));
  await writeFile(path.join(root, 'apps', 'large.ts'), 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(readSource(root, 'apps/large.ts'));
});

async function fixtureServer(t) {
  const dir = await temporary(t);
  for (const name of ['run.mjs', 'server.mjs', 'core.mjs', 'package.json']) await copyFile(path.join(here, name), path.join(dir, name));
  await mkdir(path.join(dir, '.local'));
  await writeFile(path.join(dir, '.local', 'snapshot.json'), JSON.stringify(sample()));
  return dir;
}

async function converse(dir, input) {
  const child = spawn(process.execPath, [path.join(dir, 'run.mjs')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  return done;
}
const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params });
const init = rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
const ready = rpc(undefined, 'notifications/initialized');

test('real restricted stdio process negotiates MCP and rejects writes/escapes', async t => {
  const dir = await fixtureServer(t);
  const result = await converse(dir, [init, ready, rpc(2, 'tools/list'), rpc(3, 'tools/call', { name: 'read_file', arguments: { path: 'PROJECT.md' } }), rpc(4, 'tools/call', { name: 'write_file', arguments: {} }), rpc(5, 'tools/call', { name: 'read_file', arguments: { path: '../.env' } }), rpc(6, 'exec', { command: 'whoami' }), 'not json', rpc(7, 'ping')].join('\n') + '\n');
  assert.equal(result.code, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(messages.length, 8);
  assert.equal(messages[0].result.protocolVersion, '2025-06-18');
  assert.equal(messages[1].result.tools.length, 4);
  assert.ok(messages[2].result.content[0].text.includes('Bowerbird'));
  assert.equal(messages[3].error.code, -32602);
  assert.equal(messages[4].result.isError, true);
  assert.equal(messages[5].error.code, -32601);
  assert.equal(messages[6].error.code, -32700);
  assert.deepEqual(messages[7].result, {});
});

test('protocol requires initialization, rejects oversized input and refuses unrestricted startup', async t => {
  const dir = await fixtureServer(t);
  const early = await converse(dir, rpc(1, 'tools/list') + '\n');
  assert.equal(JSON.parse(early.stdout).error.code, -32000);
  const oversized = await converse(dir, 'x'.repeat(70000));
  assert.notEqual(oversized.code, 0);
  assert.throws(() => execFileSync(process.execPath, [path.join(dir, 'server.mjs')], { stdio: 'pipe' }));
});

test('Node runtime denies file writes, out-of-snapshot reads and child execution', async t => {
  const dir = await temporary(t);
  const target = path.join(dir, 'sentinel.txt');
  await writeFile(target, 'unchanged');
  const probe = `const fs=require('node:fs'); const cp=require('node:child_process'); const p=process.argv[1]; const codes=[]; for(const fn of [()=>fs.writeFileSync(p,'bad'),()=>fs.readFileSync(p),()=>cp.spawnSync(process.execPath,['-v'])]) {try {fn();codes.push('ALLOWED')}catch(e){codes.push(e.code)}} console.log(JSON.stringify(codes));`;
  const output = execFileSync(process.execPath, ['--permission', '-e', probe, target], { encoding: 'utf8', windowsHide: true });
  assert.deepEqual(JSON.parse(output), ['ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED']);
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
});
