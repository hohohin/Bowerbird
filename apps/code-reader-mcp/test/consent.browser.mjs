import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { createHttpApp } from '../http-app.mjs';
import { digest } from '../core.mjs';

const redirect = 'https://oauth-redirect.googleusercontent.com/r/test-app';
const adminPassword = 'fixture'.repeat(8);
const client = { client_id: 'c'.repeat(43), client_secret: 's'.repeat(43), redirect_uri: redirect };
const content = '# Synthetic fixture';
const dir = await mkdtemp(path.join(tmpdir(), 'bb-mcp-chrome-'));
let proxy, server, browser;
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-keyout', 'key.pem', '-out', 'cert.pem'], { cwd: dir, stdio: 'ignore' });
  let seenOrigin;
  let useOldPolicy = false;
  proxy = createServer({ key: await readFile(path.join(dir, 'key.pem')), cert: await readFile(path.join(dir, 'cert.pem')) },
    (incoming, response) => {
      if (incoming.method === 'POST') seenOrigin = incoming.headers.origin;
      const outgoing = request({ host: '127.0.0.1', port: server.address().port, path: incoming.url,
        method: incoming.method, headers: incoming.headers }, upstream => {
        if (useOldPolicy && incoming.method === 'GET') upstream.headers['referrer-policy'] = 'no-referrer';
        response.writeHead(upstream.statusCode, upstream.headers);
        upstream.pipe(response);
      });
      outgoing.on('error', () => { response.writeHead(502); response.end(); });
      incoming.pipe(outgoing);
    });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const origin = `https://127.0.0.1:${proxy.address().port}`;
  server = createHttpApp({ version: 1, createdAt: '2026-11-19T00:00:00Z', revision: 'fixture',
    files: [{ path: 'PROJECT.md', content, sha256: digest(content) }] }, { origin, adminPassword, clients: [client] });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.context().route('https://oauth-redirect.googleusercontent.com/**', route =>
    route.fulfill({ status: 200, body: 'Synthetic Google callback' }));
  const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code',
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url') });
  const authorize = origin + '/oauth/authorize?' + params;
  const submit = async () => {
    await page.goto(authorize);
    await page.getByLabel('访问密码').fill(adminPassword);
    const [response] = await Promise.all([
      page.waitForResponse(response => response.request().method() === 'POST' && response.url() === origin + '/oauth/authorize'),
      page.getByRole('button', { name: '授权' }).click({ noWaitAfter: true }),
    ]);
    return response.status();
  };
  const [callback, approved] = await Promise.all([
    page.waitForRequest(request => request.url().startsWith(redirect + '?')), submit(),
  ]);
  assert.equal(approved, 302);
  assert.equal(seenOrigin, origin);
  assert.ok(new URL(callback.url()).searchParams.get('code'));
  useOldPolicy = true;
  assert.equal(await submit(), 403);
  assert.equal(seenOrigin, 'null');
  console.log('PASS: Chrome native consent preserves Origin and the exact callback; old no-referrer policy reproduces 403.');
} finally {
  await browser?.close();
  for (const listener of [proxy, server]) if (listener) {
    listener.closeAllConnections();
    await new Promise(resolve => listener.close(resolve));
  }
  await rm(dir, { force: true, recursive: true });
}
