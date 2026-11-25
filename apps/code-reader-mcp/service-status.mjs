import { execFile } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const geminiHost = '106.55.44.143';
const geminiForward = '127.0.0.1:48732:127.0.0.1:48731';

async function windowsProcesses(appDir) {
  const command = `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $exe = Get-Command tunnel-client -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $items = @(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe' OR Name='node.exe' OR Name='ssh.exe'" |
      Select-Object Name, ProcessId, ParentProcessId, CommandLine, ExecutablePath)
    $sshConnected = $null
    if ($items.Name -contains 'ssh.exe') {
      $sshConnected = @(Get-NetTCPConnection -State Established -RemoteAddress '106.55.44.143' -RemotePort 22 -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess)
    }
    ConvertTo-Json -InputObject @{ items = $items; tunnelExecutable = $exe.Source; sshConnected = $sshConnected } -Compress
  `;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: 6500, maxBuffer: 1024 * 1024,
  });
  const data = JSON.parse(stdout);
  data.tunnelExecutable ||= path.join(appDir, '.local/tunnel-client-v0.0.18/tunnel-client.exe');
  return data;
}

const readText = file => readFile(file, 'utf8').catch(() => '');
const known = (value, values) => values.includes(value) ? value : 'unknown';
const byCount = count => count > 1 ? 'multiple' : count === 1 ? 'running' : 'stopped';
const sameWindowsPath = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();

function inspectProcesses(data, appDir, tunnelId) {
  const processes = data.items.map(item => ({
    ...item, args: (item.CommandLine?.match(/(?:[^\s"]|"[^"]*")+/g) ?? []).map(arg => arg.replaceAll('"', '')),
  }));
  const profile = 'bowerbird-code-reader-' + tunnelId;
  const gpt = byCount(processes.filter(item => item.Name.toLowerCase() === 'tunnel-client.exe' &&
    sameWindowsPath(item.ExecutablePath, data.tunnelExecutable) && item.args[1]?.toLowerCase() === 'run' &&
    item.args.some((arg, index, args) => arg === '--profile=' + profile ||
      (arg === '--profile' && args[index + 1] === profile))).length);
  const nodeScript = (item, script) => item.Name.toLowerCase() === 'node.exe' &&
    item.args.slice(1).some(arg => sameWindowsPath(arg, path.join(appDir, script)));
  const launchers = processes.filter(item => nodeScript(item, 'run-gemini.mjs'));
  const launcher = byCount(launchers.length);
  if (launcher !== 'running') return { gpt, launcher, http: 'stopped', ssh: 'stopped' };
  const children = processes.filter(item => item.ParentProcessId === launchers[0].ProcessId);
  const http = byCount(children.filter(item => nodeScript(item, 'http-server.mjs')).length);
  const sshChildren = children.filter(item => item.Name.toLowerCase() === 'ssh.exe' &&
    item.args.includes('bowerbird-mcp@' + geminiHost) &&
    item.args.some((arg, index, args) => arg === '-R' && args[index + 1] === geminiForward));
  let ssh = byCount(sshChildren.length);
  if (ssh === 'running') {
    ssh = data.sshConnected?.includes(sshChildren[0].ProcessId) ? 'connected' : data.sshConnected ? 'connecting' : 'unknown';
  }
  return { gpt, launcher, http, ssh };
}

async function requestLocal(request, url) {
  return request(url, { signal: AbortSignal.timeout(1800), redirect: 'error' });
}

async function gptStatus(local, processState, request) {
  const status = { state: processState === 'stopped' ? 'stopped' : 'degraded', process: processState };
  if (processState !== 'running') return status;
  const base = (await readText(path.join(local, 'health.url'))).trim().replace(/\/$/, '');
  const port = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(base)?.[1];
  if (!port || Number(port) < 1 || Number(port) > 65535) return { ...status, reason: 'health_unavailable' };
  const getJson = async route => {
    const response = await requestLocal(request, base + route);
    if (response.ok) return response.json();
  };
  const [details, mcp] = await Promise.all([getJson('/health?details=true').catch(() => null), getJson('/health/mcp').catch(() => null)]);
  const control = details?.components?.['control-plane'];
  const failures = control?.details?.consecutive_failures;
  status.controlPlane = {
    status: known(control?.status, ['ok', 'degraded', 'disabled']),
    state: known(control?.state, ['polling', 'backoff', 'disabled']),
    reason: known(control?.reason_code, ['network_error', 'unauthorized', 'rate_limited', 'timeout']),
    consecutiveFailures: Number.isSafeInteger(failures) && failures >= 0 ? failures : null,
  };
  status.proxy = known(details?.components?.proxy?.state, ['healthy', 'unhealthy', 'disabled', 'direct']);
  status.discovery = mcp?.details?.tools_list?.ok === true ? 'discovered' : known(mcp?.state, ['discovered', 'not_observed', 'failed']);
  if (!details || !mcp) status.reason = 'health_unavailable';
  else if (status.controlPlane.status === 'ok' && status.controlPlane.state === 'polling' && failures === 0 &&
    status.proxy !== 'unhealthy' && status.discovery !== 'failed' &&
    (mcp?.details?.child_state ?? details?.components?.mcp?.details?.child_state) === 'running') status.state = 'healthy';
  return status;
}

async function snapshotEvent(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, 32768));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, size - buffer.length);
    for (const line of buffer.toString('utf8', 0, bytesRead).split(/\r?\n/).reverse()) {
      if (!line.startsWith('{')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.event === 'snapshot-loaded') return { event: 'snapshot-loaded' };
      if (entry?.event === 'snapshot-rejected') return {
        event: 'snapshot-rejected', reason: known(entry.reason, ['size_limit', 'invalid_snapshot', 'read_error']),
      };
    }
  } catch { /* A service may not have created a log yet. */ }
  finally { await handle?.close(); }
  return null;
}

async function geminiStatus(local, processes, request, interfaces) {
  const dir = path.join(local, 'gemini');
  const [configText, interfaceText, snapshot] = await Promise.all([
    readText(path.join(dir, 'config.json')),
    readText(path.join(dir, 'ssh-interface.txt')),
    snapshotEvent(path.join(dir, 'run.err.log')),
  ]);
  let port = 48731;
  let config = configText ? 'invalid' : 'default';
  try {
    const value = JSON.parse(configText)?.port;
    if (Number.isInteger(value) && value > 0 && value <= 65535) { port = value; config = 'configured'; }
  } catch { /* The default port applies if the config cannot be read. */ }
  const name = interfaceText.trim();
  const http = processes.http === 'running'
    ? await requestLocal(request, 'http://127.0.0.1:' + port + '/healthz').then(res => res.status === 204 ? 'healthy' : 'unhealthy', () => 'unhealthy')
    : processes.http;
  const { launcher, ssh } = processes;
  const state = launcher === 'stopped' ? 'stopped' : launcher === 'running' && http === 'healthy' && ssh === 'connected'
    ? 'healthy' : 'degraded';
  return { state, process: launcher, http, ssh, config, interface: name && Object.hasOwn(interfaces(), name) ? name : null,
    interfaceUnavailable: Boolean(name) && !Object.hasOwn(interfaces(), name), snapshot };
}

export async function readServiceStatus(appDir, tunnelId, {
  listProcesses = windowsProcesses, request = fetch, interfaces = networkInterfaces,
} = {}) {
  let processes;
  try { processes = inspectProcesses(await listProcesses(appDir), appDir, tunnelId); }
  catch {
    return { gpt: { state: 'degraded', process: 'unknown' }, gemini: { state: 'degraded', process: 'unknown' } };
  }
  const local = path.join(appDir, '.local');
  const [gpt, gemini] = await Promise.all([
    gptStatus(local, processes.gpt, request), geminiStatus(local, processes, request, interfaces),
  ]);
  return { gpt, gemini };
}

export function combinedServiceState({ gpt, gemini }, starting = false) {
  const states = [gpt.state, gemini.state];
  if (states.every(state => state === 'healthy')) return 'healthy';
  if (starting) return 'starting';
  if (states.includes('stopped')) return 'stopped';
  return 'degraded';
}
