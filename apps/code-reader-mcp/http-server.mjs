import { readFileSync } from 'node:fs';
import { createMcpHttpServer, validateConfig } from './http-app.mjs';
import { createSnapshotReader } from './snapshot-store.mjs';

let oauthRequestId = 0;
const oauthRequests = new Map();
if (process.send) process.on('message', message => oauthRequests.get(message?.id)?.(message));
function oauthFile(type, data) {
  if (oauthRequests.size >= 16) return Promise.reject(new Error('Too many OAuth state requests'));
  const id = ++oauthRequestId;
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => finish(new Error('OAuth state request timed out')), 10_000);
    function finish(error, value) {
      clearTimeout(deadline);
      oauthRequests.delete(id);
      if (error) reject(error);
      else resolve(value);
    }
    oauthRequests.set(id, message => finish(message.error ? new Error('OAuth state unavailable') : null, message.data));
    process.send({ id, type, data }, error => { if (error) finish(error); });
  });
}

if (!process.permission || process.execArgv.some(arg => /^--(?:allow-fs-write|allow-child-process|allow-worker|allow-addons|allow-wasi|inspect)/.test(arg)) ||
    process.permission.has('fs.write') || process.permission.has('child') || process.permission.has('worker') || process.permission.has('addons')) {
  console.error('Start using run-gemini.mjs with mandatory read-only permissions.');
  process.exit(1);
}
try {
  const config = validateConfig(JSON.parse(readFileSync(new URL('./.local/gemini/config.json', import.meta.url), 'utf8')));
  const file = new URL('./.local/snapshot.json', import.meta.url);
  const readSnapshot = createSnapshotReader(file, event => console.error(JSON.stringify(event)));
  readSnapshot();
  if (process.send) process.on('disconnect', () => process.exit(1));
  const oauth = process.send ? {
    stored: await oauthFile('oauth-load'),
    save: data => oauthFile('oauth-save', data),
    rejected: () => console.error('Gemini saved OAuth state did not match this configuration. Reauthorization required.'),
  } : undefined;
  const server = createMcpHttpServer(readSnapshot, config, Date.now, oauth);
  server.on('oauth-state-save-failed', () => console.error('Gemini could not save OAuth state.'));
  // Bounded connection diagnostics. Never log URLs with queries, headers or bodies.
  let diagnostics = 100;
  server.on('oauth-registration-error', reason => {
    if (diagnostics-- > 0) console.error(JSON.stringify({ event: 'gemini-registration-rejected', reason }));
  });
  const routes = ['/mcp', '/healthz', '/oauth/register', '/oauth/authorize', '/oauth/authorize/continue', '/oauth/token', '/oauth/revoke',
    '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'];
  server.on('request', (request, response) => {
    response.once('finish', () => {
      if (diagnostics-- <= 0) return;
      const pathname = request.url.split('?')[0];
      console.error(JSON.stringify({ event: 'gemini-http',
        method: ['GET', 'POST', 'HEAD', 'DELETE', 'OPTIONS'].includes(request.method) ? request.method : 'OTHER',
        route: routes.includes(pathname) ? pathname : 'OTHER', status: response.statusCode }));
    });
  });
  server.listen(config.port, '127.0.0.1', () => console.log('Gemini MCP listening on loopback. Port ' + server.address().port));
  server.on('error', () => { console.error('Gemini MCP listener unavailable.'); process.exit(1); });
} catch {
  console.error('Gemini configuration or snapshot missing or invalid. Run setup-gemini.mjs and export.mjs.');
  process.exit(1);
}
