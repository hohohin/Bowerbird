import { statSync, readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { once } from 'node:events';
import { validateSnapshot, MAX_SNAPSHOT_BYTES } from './core.mjs';
import { createMcpSession } from './protocol.mjs';

// Fail closed when someone bypasses the restricted launcher.
if (!process.permission || process.execArgv.some(arg => /^--(?:allow-fs-write|allow-child-process|allow-worker|allow-addons|allow-wasi|inspect)/.test(arg)) || process.permission.has('fs.write') || process.permission.has('child') ||
    process.permission.has('worker') || process.permission.has('addons')) {
  console.error('Start this server using run.mjs with its mandatory read-only permissions.');
  process.exit(1);
}
const snapshotUrl = new URL('./.local/snapshot.json', import.meta.url);
let snapshot;
try {
  if (statSync(snapshotUrl).size > MAX_SNAPSHOT_BYTES) throw new Error();
  snapshot = validateSnapshot(JSON.parse(readFileSync(snapshotUrl, 'utf8')));
} catch {
  console.error('Snapshot missing or invalid. Run node export.mjs locally before starting.');
  process.exit(1);
}

const dispatch = createMcpSession(snapshot);

const decoder = new StringDecoder('utf8');
let pending = '';
for await (const chunk of process.stdin) {
  pending += decoder.write(chunk);
  let end;
  while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    if (Buffer.byteLength(line) > 65536) { console.error('Request too large'); process.exit(1); }
    let response;
    try { response = dispatch(JSON.parse(line)); }
    catch { response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
    if (response && !process.stdout.write(JSON.stringify(response) + '\n')) await once(process.stdout, 'drain');
  }
  if (Buffer.byteLength(pending) > 65536) { console.error('Request too large'); process.exit(1); }
}
