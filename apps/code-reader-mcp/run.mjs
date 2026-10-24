import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Do not pass the tunnel's runtime key, NODE_OPTIONS, or other user secrets to the MCP child.
const env = {};
for (const key of ['SystemRoot', 'WINDIR', 'LANG']) if (process.env[key]) env[key] = process.env[key];
const child = spawn(process.execPath, [
  '--permission', '--disable-proto=throw',
  ...['server.mjs', 'core.mjs', 'package.json', '.local/snapshot.json'].map(p => `--allow-fs-read=${path.join(here, p)}`),
  path.join(here, 'server.mjs'),
], { stdio: 'inherit', cwd: here, env, windowsHide: true });
child.on('error', () => { console.error('Unable to start restricted MCP process. Node >=24.10 required.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
