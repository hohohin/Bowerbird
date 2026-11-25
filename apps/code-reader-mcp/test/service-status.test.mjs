import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { combinedServiceState, readServiceStatus } from '../service-status.mjs';

const forbidden = ['adminPassword', 'oauthClient', 'MCP_UPDATE_KEY', 'access_token', 'private-value'];

test('the widget combines both service states and shows startup while launching', () => {
  const state = (gpt, gemini, starting) => combinedServiceState({ gpt: { state: gpt }, gemini: { state: gemini } }, starting);
  assert.equal(state('healthy', 'healthy'), 'healthy');
  assert.equal(state('healthy', 'degraded'), 'degraded');
  assert.equal(state('degraded', 'degraded'), 'degraded');
  assert.equal(state('stopped', 'degraded'), 'stopped');
  assert.equal(state('healthy', 'stopped'), 'stopped');
  assert.equal(state('stopped', 'stopped'), 'stopped');
  assert.equal(state('stopped', 'healthy', true), 'starting');
  assert.equal(state('healthy', 'healthy', true), 'healthy');
});
const tunnelExecutable = 'C:\\fixture\\tunnel-client.exe';
const tunnel = (pid, profile = 'bowerbird-code-reader-tunnel_fixture', command = 'run', executablePath = tunnelExecutable) => ({
  Name: 'tunnel-client.exe', ProcessId: pid, ExecutablePath: executablePath,
  CommandLine: '"' + executablePath + '" ' + command + ' --profile "' + profile + '" --key=private-value',
});

async function fixture(t, withFiles = true) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'bb-status-'));
  assert.equal(path.relative(os.tmpdir(), parent), path.basename(parent));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const app = path.join(parent, 'MCP app');
  const local = path.join(app, '.local');
  const gemini = path.join(local, 'gemini');
  await mkdir(gemini, { recursive: true });
  if (withFiles) {
    await writeFile(path.join(local, 'health.url'), 'http://127.0.0.1:30123');
    await writeFile(path.join(gemini, 'config.json'), JSON.stringify({ port: 48731, adminPassword: 'private-value', oauthClient: {} }));
    await writeFile(path.join(gemini, 'ssh-interface.txt'), 'Fixture WLAN');
    await writeFile(path.join(gemini, 'run.err.log'), [
      '{"event":"snapshot-loaded","fileCount":17}',
      '{"event":"snapshot-rejected","reason":"read_error","access_token":"private-value"}',
      'an unrelated raw log with secret private-value',
    ].join('\n'));
  }
  const responses = new Map([
    ['http://127.0.0.1:30123/health?details=true', { components: {
      'control-plane': { status: 'ok', state: 'polling', details: { consecutive_failures: 0 } },
      proxy: { status: 'ok', state: 'healthy' }, mcp: { details: { child_state: 'running' } },
    } }],
    ['http://127.0.0.1:30123/health/mcp', { status: 'ok', state: 'discovered', details: { tools_list: { ok: true } }, MCP_UPDATE_KEY: 'private-value' }],
    ['http://127.0.0.1:48731/healthz', 204],
  ]);
  const processes = [
    tunnel(11),
    { Name: 'node.exe', ProcessId: 21, CommandLine: 'node "' + path.join(app, 'run-gemini.mjs') + '"' },
    { Name: 'node.exe', ProcessId: 22, ParentProcessId: 21, CommandLine: 'node --permission "' + path.join(app, 'http-server.mjs') + '"' },
    { Name: 'ssh.exe', ProcessId: 23, ParentProcessId: 21,
      CommandLine: 'ssh -R 127.0.0.1:48732:127.0.0.1:48731 bowerbird-mcp@106.55.44.143' },
  ];
  const requested = [];
  async function read(items = processes) {
    return readServiceStatus(app, 'tunnel_fixture', {
      listProcesses: async () => ({ tunnelExecutable, items, sshConnected: [23] }),
      interfaces: () => ({ 'Fixture WLAN': [] }),
      request: async url => {
        requested.push(String(url));
        const result = responses.get(String(url));
        if (typeof result === 'number') return new Response(null, { status: result });
        assert.ok(result, 'Unexpected request: ' + url);
        return Response.json(result);
      },
    });
  }
  return { read, responses, requested, processes, local };
}

test('status separates stopped services from unrelated executables and profiles', async t => {
  const f = await fixture(t);
  const status = await f.read([tunnel(10, 'bowerbird-code-reader-tunnel_fixture_other'),
    tunnel(20, undefined, 'doctor'), tunnel(30, undefined, 'run', 'C:\\elsewhere\\tunnel-client.exe')]);
  assert.equal(status.gpt.state, 'stopped');
  assert.equal(status.gemini.state, 'stopped');
  assert.deepEqual(f.requested, []);
});

test('GPT reports network_error even while its process and local MCP discovery are healthy', async t => {
  const f = await fixture(t);
  const health = f.responses.get('http://127.0.0.1:30123/health?details=true');
  health.components['control-plane'] = { status: 'degraded', state: 'backoff', reason_code: 'network_error',
    details: { consecutive_failures: 35 } };
  health.components.proxy = { status: 'degraded', state: 'unhealthy', access_token: 'private-value' };
  const { gpt } = await f.read();
  assert.equal(gpt.state, 'degraded');
  assert.deepEqual(gpt.controlPlane, { status: 'degraded', state: 'backoff', reason: 'network_error', consecutiveFailures: 35 });
  assert.equal(gpt.proxy, 'unhealthy');
  assert.equal(gpt.discovery, 'discovered');
});

test('both services can be healthy and output only known diagnostics', async t => {
  const f = await fixture(t);
  const result = await f.read();
  assert.equal(result.gpt.state, 'healthy');
  assert.equal(result.gemini.state, 'healthy');
  assert.equal(result.gemini.http, 'healthy');
  assert.equal(result.gemini.ssh, 'connected');
  assert.equal(result.gemini.interface, 'Fixture WLAN');
  assert.deepEqual(result.gemini.snapshot, { event: 'snapshot-rejected', reason: 'read_error' });
  for (const value of forbidden) assert.ok(!JSON.stringify(result).includes(value));
});

test('missing configuration uses the Gemini default and untrusted health URLs are ignored', async t => {
  const f = await fixture(t, false);
  await writeFile(path.join(f.local, 'health.url'), 'http://remote.invalid:7890/secret');
  const result = await f.read();
  assert.equal(result.gpt.state, 'degraded');
  assert.equal(result.gpt.reason, 'health_unavailable');
  assert.equal(result.gemini.state, 'healthy');
  assert.equal(result.gemini.config, 'default');
  assert.deepEqual(f.requested, ['http://127.0.0.1:48731/healthz']);
});

test('duplicate GPT tunnels and missing Gemini SSH are reported separately', async t => {
  const f = await fixture(t);
  const result = await f.read([...f.processes.filter(p => p.Name !== 'ssh.exe'), tunnel(33)]);
  assert.equal(result.gpt.process, 'multiple');
  assert.equal(result.gpt.state, 'degraded');
  assert.equal(result.gemini.state, 'degraded');
  assert.equal(result.gemini.ssh, 'stopped');
});
