import { statSync, readFileSync } from 'node:fs';
import { MAX_SNAPSHOT_BYTES } from './core.mjs';
import { createHttpApp } from './http-app.mjs';

const blocked = /^--(?:allow-fs-write|allow-child-process|allow-worker|allow-addons|allow-wasi|inspect)/;
if (!process.permission || process.execArgv.some(arg => blocked.test(arg))
  || ['fs.write', 'child', 'worker', 'addons'].some(permission => process.permission.has(permission))) {
  console.error('Start Gemini MCP through run-gemini.mjs with the mandatory permissions.');
  process.exit(1);
}

function readJson(relative, maxSize) {
  const url = new URL(relative, import.meta.url);
  if (statSync(url).size > maxSize) throw new Error('Input exceeds limit');
  return JSON.parse(readFileSync(url, 'utf8'));
}

try {
  const snapshot = readJson('./.local/snapshot.json', MAX_SNAPSHOT_BYTES);
  const config = readJson('./.local/gemini/config.json', 64 * 1024);
  const port = config.port ?? 48731;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
  const server = createHttpApp(snapshot, config);
  server.maxConnections = 64;
  server.on('error', () => { console.error('Unable to listen on the configured loopback port.'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Gemini MCP listening on 127.0.0.1:${port}`));
} catch {
  console.error('Unable to load the fixed snapshot or Gemini configuration.');
  process.exitCode = 1;
}
