import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const useSsh = process.argv[2] === '--ssh';
if (process.argv.length !== (useSsh ? 3 : 2)) throw new Error('Usage: node run-gemini.mjs [--ssh]');
let ssh;
if (useSsh) {
  const config = JSON.parse(readFileSync(path.join(here, '.local/gemini/config.json'), 'utf8'));
  const { host, user, identityFile, knownHosts } = config.ssh ?? {};
  const port = config.port ?? 48731;
  const remotePort = config.ssh?.remotePort ?? 48732;
  if (!/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(host ?? '') || !/^[a-z_][a-z0-9_-]{0,30}$/i.test(user ?? '')
    || ![identityFile, knownHosts].every(file => typeof file === 'string' && path.isAbsolute(file) && !/[\r\n%]/.test(file))
    || ![port, remotePort].every(value => Number.isInteger(value) && value >= 1024 && value <= 65535)) {
    throw new Error('Configure an explicit SSH account, host, identity, known_hosts and loopback ports.');
  }
  ssh = ['-F', 'none', '-N', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3', '-o', `UserKnownHostsFile=${knownHosts}`, '-i', identityFile,
    '-R', `127.0.0.1:${remotePort}:127.0.0.1:${port}`, '-l', user, host];
}

const env = {};
for (const key of ['SystemRoot', 'WINDIR', 'LANG']) if (process.env[key]) env[key] = process.env[key];
const allowed = ['gemini-server.mjs', 'http-app.mjs', 'gemini-oauth.mjs', 'core.mjs', 'protocol.mjs',
  'package.json', '.local/snapshot.json', '.local/gemini/config.json'];
const server = spawn(process.execPath, ['--permission', '--disable-proto=throw',
  ...allowed.map(file => `--allow-fs-read=${path.join(here, file)}`), path.join(here, 'gemini-server.mjs')],
{ stdio: ['ignore', 'pipe', 'inherit'], cwd: here, env, windowsHide: true });

let forwarding;
let retry;
let stopping = false;
function connect() {
  if (!ssh || stopping || forwarding) return;
  const process = spawn('ssh', ssh, { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
  forwarding = process;
  process.on('error', () => console.error('Unable to start SSH forwarding.'));
  process.on('close', () => {
    forwarding = undefined;
    if (!stopping) {
      console.error('SSH forwarding closed. Reconnecting in 5 seconds.');
      retry = setTimeout(connect, 5000);
    }
  });
}
server.stdout.on('data', chunk => { process.stdout.write(chunk); connect(); });
function stop() {
  stopping = true;
  clearTimeout(retry);
  forwarding?.kill();
  if (server.exitCode === null && server.signalCode === null) server.kill();
}
server.on('error', () => { console.error('Unable to start restricted Gemini MCP.'); process.exitCode = 1; stop(); });
server.on('exit', code => { process.exitCode = stopping ? 0 : (code ?? 1); stop(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
