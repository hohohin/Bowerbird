import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { usesLocalConfig } from './gemini-config-mode.mjs';

if (process.argv[2] === '--ssh' || usesLocalConfig()) {
  await import('./run-local-gemini.mjs');
} else {
  if (process.argv.length !== 2) throw new Error('Usage: node run-gemini.mjs');
  const { attachOAuthStateFile } = await import('./oauth-state-file.mjs');
  const { validateConfig, GEMINI_REMOTE_PORT, GEMINI_SSH_USER } = await import('./http-app.mjs');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const local = path.join(here, '.local/gemini');
  const config = validateConfig(JSON.parse(readFileSync(path.join(local, 'config.json'), 'utf8')));
  const { remotePort = GEMINI_REMOTE_PORT, sshUser = GEMINI_SSH_USER } = config;
  const pidFile = path.join(local, 'run.pid');
  const pid = String(process.pid);
  writeFileSync(pidFile, pid, { mode: 0o600 });
  process.on('exit', () => {
    try {
      if (readFileSync(pidFile, 'utf8') === pid) rmSync(pidFile);
    } catch { /* The PID file is advisory. */ }
  });
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'LANG']) if (process.env[key]) env[key] = process.env[key];
  const server = spawn(process.execPath, ['--permission', '--disable-proto=throw',
    ...['http-server.mjs', 'http-app.mjs', 'snapshot-store.mjs', 'core.mjs', 'package.json', '.local/snapshot.json', '.local/gemini/config.json'].map(file => `--allow-fs-read=${path.join(here, file)}`),
    path.join(here, 'http-server.mjs')], { cwd: here, env, stdio: ['ignore', 'pipe', 'inherit', 'ipc'], windowsHide: true });
  try {
    attachOAuthStateFile(server, local);
  } catch {
    console.error('Gemini OAuth state directory could not be secured.');
    server.kill();
    process.exit(1);
  }
  let tunnel;
  let reconnect;
  let stopping = false;
  let localPort;
  function stop(code) {
    if (stopping) return;
    stopping = true;
    clearTimeout(startup);
    clearTimeout(reconnect);
    tunnel?.kill();
    server.kill();
    process.exitCode = code;
  }
  const startup = setTimeout(() => { console.error('Gemini MCP startup timed out.'); stop(1); }, 10_000);
  function connect() {
    if (stopping) return;
    tunnel = spawn('ssh', ['-N', '-T', '-i', path.join(local, 'id_ed25519'),
      '-o', 'UserKnownHostsFile=' + path.join(local, 'known_hosts'), '-o', 'StrictHostKeyChecking=yes',
      '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
      '-R', `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`, `${sshUser}@106.55.44.143`],
    { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    tunnel.on('error', () => console.error('SSH connection could not start.'));
    tunnel.on('close', () => {
      tunnel = undefined;
      if (stopping) return;
      console.error('Gemini SSH tunnel disconnected. Retrying in 5 seconds; local authorization remains active.');
      reconnect = setTimeout(connect, 5000);
    });
  }
  let output = '';
  server.stdout.on('data', data => {
    if (localPort !== undefined) return;
    output += data;
    const ready = /Gemini MCP listening on loopback\. Port (\d+)\r?\n/.exec(output);
    if (!ready) return;
    localPort = Number(ready[1]);
    clearTimeout(startup);
    output = '';
    connect();
    console.log('Gemini MCP started. Waiting for SSH connection; verify public discovery before using.');
  });
  server.on('error', () => { console.error('Gemini MCP process unavailable.'); stop(1); });
  server.on('exit', () => stop(1));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));
}
