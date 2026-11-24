import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

test('Gemini setup and deployment use separate Mac settings while preserving Windows defaults', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bb-gemini-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const local = path.join(root, '.local/gemini');
  const file = path.join(local, 'config.json');
  const read = name => readFileSync(path.join(local, name), 'utf8');
  for (const name of ['setup-gemini.mjs', 'http-app.mjs', 'core.mjs', 'gemini-config-mode.mjs', 'prepare-gemini-deploy.mjs', 'deploy']) {
    cpSync(new URL('../' + name, import.meta.url), path.join(root, name), { recursive: true });
  }
  mkdirSync(local, { recursive: true });
  for (const [name, data] of Object.entries({
    id_ed25519: 'fixture-only',
    'id_ed25519.pub': 'ssh-ed25519 AAAAAA== fixture\n',
    known_hosts: 'fixture-only',
  })) writeFileSync(path.join(local, name), data);
  const run = (script, ...flags) => spawnSync(process.execPath, [path.join(root, script), ...flags], { encoding: 'utf8' });
  const setup = (...flags) => run('setup-gemini.mjs', ...flags);
  const bundle = () => run('prepare-gemini-deploy.mjs');
  const windows = 'https://mcp.bowerbird.cn';
  const mac = 'https://mcp-mac.bowerbird.cn';
  for (const flags of [['--origin', 'https://evil.example'], ['--remote-port', '0'], ['--remote-port', '0x1234'],
    ['--ssh-user', '-option'], ['--ssh-user', 'with space'], ['--origin', mac, '--origin', windows]]) {
    assert.notEqual(setup(...flags).status, 0, flags.join(' '));
    assert.equal(existsSync(file), false);
  }
  const defaults = setup();
  assert.equal(defaults.status, 0, defaults.stderr);
  const original = JSON.parse(read('config.json'));
  assert.equal(original.origin, windows);
  assert.equal(original.port, 48731);
  assert.equal(original.remotePort, undefined);
  assert.equal(original.sshUser, undefined);
  const winBundle = bundle();
  assert.equal(winBundle.status, 0, winBundle.stderr);
  const oldSite = read('deployment/mcp.bowerbird.cn.nginx.conf');
  assert.match(oldSite, /server_name mcp\.bowerbird\.cn;/);
  assert.notEqual(setup('--origin', mac).status, 0);
  assert.deepEqual(JSON.parse(read('config.json')), original);
  rmSync(file);

  const flags = ['--origin', mac, '--remote-port', '48734', '--ssh-user', 'bowerbird-mcp-mac'];
  const macSetup = setup(...flags);
  assert.equal(macSetup.status, 0, macSetup.stderr);
  const configured = JSON.parse(read('config.json'));
  assert.equal(configured.origin, mac);
  assert.equal(configured.remotePort, 48734);
  assert.equal(configured.sshUser, 'bowerbird-mcp-mac');
  if (process.platform !== 'win32') for (const name of ['config.json', 'id_ed25519', 'known_hosts']) {
    chmodSync(path.join(local, name), 0o644);
  }
  const callback = setup('--redirect-uri', 'https://oauth-redirect.googleusercontent.com/r/mac-fixture');
  assert.equal(callback.status, 0, callback.stderr);
  assert.equal(JSON.parse(read('config.json')).adminPassword, configured.adminPassword);
  if (process.platform !== 'win32') for (const name of ['config.json', 'id_ed25519', 'known_hosts']) {
    assert.equal(statSync(path.join(local, name)).mode & 0o777, 0o600);
  }
  const macBundle = bundle();
  assert.equal(macBundle.status, 0, macBundle.stderr);
  const entries = readdirSync(path.join(local, 'deployment-mac'));
  assert.deepEqual(entries.sort(), ['90-bowerbird-mcp-mac.conf', 'SHA256SUMS', 'activate.sh', 'bootstrap.nginx.conf',
    'bowerbird-mcp-mac-proxy.conf', 'mcp-mac.bowerbird.cn.nginx.conf', 'rollback.sh', 'tunnel.pub']);
  const checksums = read('deployment-mac/SHA256SUMS').trim().split('\n');
  assert.equal(checksums.length, entries.length - 1);
  for (const line of checksums) {
    const [hash, name] = line.split('  ');
    const content = read('deployment-mac/' + name);
    assert.equal(createHash('sha256').update(content).digest('hex'), hash);
    assert.doesNotMatch(content, /mcp\.bowerbird\.cn|48732|4173|bowerbird-mcp(?!-mac)/);
  }
  const ssh = read('deployment-mac/90-bowerbird-mcp-mac.conf');
  assert.match(ssh, /Match User bowerbird-mcp-mac\b/);
  assert.match(ssh, /AllowTcpForwarding remote\n\s*AllowStreamLocalForwarding no/);
  assert.match(ssh, /PermitListen 127\.0\.0\.1:48734/);
  assert.match(ssh, /MaxSessions 0/);
  assert.match(read('deployment-mac/bowerbird-mcp-mac-proxy.conf'), /proxy_pass http:\/\/127\.0\.0\.1:48734/);
  assert.equal(read('deployment/mcp.bowerbird.cn.nginx.conf'), oldSite);
});
