import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest, createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { digest, TOOLS } from '../core.mjs';
import { createHttpApp } from '../http-app.mjs';
import { validGoogleRedirect } from '../gemini-oauth.mjs';

const origin = 'https://mcp.example.invalid';
const redirect = 'https://oauth-redirect.googleusercontent.com/r/fixture-app';
const verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const adminPassword = 'fixture'.repeat(8);
const project = '# Fixture project\nTEST_LABEL';
const snapshot = { version: 1, createdAt: '2026-11-19T00:00:00.000Z', revision: 'fixture', files: [
  { path: 'PROJECT.md', content: project, sha256: digest(project) },
] };
const manual = { client_id: 'm'.repeat(43), client_secret: 's'.repeat(43), redirect_uri: redirect };

async function start(t, clients = [manual]) {
  const server = createHttpApp(snapshot, { origin, adminPassword, clients });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path, options = {}) => loopbackRequest(base, path, options);
}

function loopbackRequest(base, path, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = options.body?.toString();
    const headers = { Host: new URL(origin).host, ...options.headers };
    if (payload !== undefined) {
      headers['Content-Length'] = Buffer.byteLength(payload);
      if (options.body instanceof URLSearchParams) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const req = httpRequest(base + path, { method: options.method, headers }, async response => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString('utf8');
        const headers = new Map(Object.entries(response.headers).map(([name, value]) => [name, [].concat(value).join(', ')]));
        resolve({ status: response.statusCode, headers: { get: name => headers.get(name) ?? null },
          text: async () => text, json: async () => JSON.parse(text) });
      } catch (error) { reject(error); }
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const json = (request, url, value, headers = {}) => request(url, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
const form = (request, url, value, headers = {}) => request(url,
  { method: 'POST', headers, body: new URLSearchParams(value) });
const rpc = (request, accessToken, method, params = {}, session, id = 1) =>
  json(request, '/mcp', { jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }, {
    Authorization: 'Bearer ' + accessToken,
    Accept: 'application/json, text/event-stream',
    ...(session ? { 'Mcp-Session-Id': session, 'Mcp-Protocol-Version': '2025-11-25' } : {}),
  });

async function authorize(request, clientId = manual.client_id, uri = redirect) {
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: uri, response_type: 'code',
    code_challenge_method: 'S256', code_challenge: challenge, state: 'fixture-state', resource: origin + '/mcp' });
  const response = await request('/oauth/authorize?' + query);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  assert.match(response.headers.get('content-security-policy'), /form-action 'self' https:\/\/oauth-redirect\.googleusercontent\.com/);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly.*SameSite=Lax.*Secure/);
  const consent = /name="consent" value="([^"]+)"/.exec(await response.text())[1];
  return { fields: { password: adminPassword, consent }, headers: { Origin: origin, Cookie: cookie.split(';')[0] } };
}

async function code(request, clientId) {
  const { fields, headers } = await authorize(request, clientId);
  const response = await form(request, '/oauth/authorize', fields, headers);
  assert.equal(response.status, 302);
  const callback = new URL(response.headers.get('location'));
  assert.equal(callback.origin + callback.pathname, redirect);
  assert.equal(callback.searchParams.get('state'), 'fixture-state');
  return callback.searchParams.get('code');
}

const exchangeFields = (authCode, id = manual.client_id) => ({ grant_type: 'authorization_code',
  client_id: id, code: authCode, redirect_uri: redirect, code_verifier: verifier, resource: origin + '/mcp' });
const initialize = { protocolVersion: '2025-11-25', clientInfo: { name: 'fixture', version: '1' }, capabilities: {} };

test('Gemini discovery, DCR, S256 consent, four read-only tools, refresh and revoke', async t => {
  const request = await start(t);
  const unauthenticated = await request('/mcp');
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
  assert.equal((await (await request('/.well-known/oauth-protected-resource/mcp')).json()).resource, origin + '/mcp');
  const metadata = await (await request('/.well-known/oauth-authorization-server')).json();
  assert.equal(metadata.registration_endpoint, origin + '/oauth/register');
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  const redirects = ['oauth-redirect', 'oauth-redirect-test', 'oauth-redirect-sandbox'].flatMap(host =>
    ['a', 'r'].map(part => `https://${host}.googleusercontent.com/${part}/fixture-app`));
  const registration = await json(request, '/oauth/register', { redirect_uris: redirects, token_endpoint_auth_method: 'none' });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  assert.deepEqual(client.redirect_uris, redirects);
  assert.equal(client.client_secret, undefined);
  const fields = exchangeFields(await code(request, client.client_id), client.client_id);
  const wrong = await form(request, '/oauth/token', { ...fields, resource: 'https://other.invalid/mcp' });
  assert.equal((await wrong.json()).error, 'invalid_target');
  const granted = await form(request, '/oauth/token', fields);
  assert.equal(granted.status, 200);
  const access = await granted.json();
  assert.equal((await form(request, '/oauth/token', fields)).status, 400, 'code is single-use');
  const initial = await rpc(request, access.access_token, 'initialize', initialize);
  assert.equal((await initial.json()).result.protocolVersion, '2025-11-25');
  const session = initial.headers.get('mcp-session-id');
  assert.ok(session);
  assert.equal((await rpc(request, access.access_token, 'tools/list')).status, 400);
  const premature = await rpc(request, access.access_token, 'tools/list', {}, session);
  assert.equal((await premature.json()).error.code, -32000);
  assert.equal((await rpc(request, access.access_token, 'notifications/initialized', {}, session, null)).status, 202);
  const listed = await rpc(request, access.access_token, 'tools/list', {}, session);
  assert.deepEqual((await listed.json()).result.tools, TOOLS);
  for (const [name, args, check] of [
    ['project_overview', {}, value => assert.equal(value.revision, 'fixture')],
    ['list_files', {}, value => assert.equal(value.files[0].path, 'PROJECT.md')],
    ['read_file', { path: 'PROJECT.md' }, value => assert.equal(value.sha256, digest(project))],
    ['search_code', { query: 'TEST_LABEL' }, value => assert.equal(value.results[0].line, 2)],
  ]) {
    const response = await rpc(request, access.access_token, 'tools/call', { name, arguments: args }, session);
    check(JSON.parse((await response.json()).result.content[0].text));
  }
  const invalid = await rpc(request, access.access_token, 'tools/call', { name: 'write_file' }, session);
  assert.equal((await invalid.json()).error.code, -32602);
  const traversal = await rpc(request, access.access_token, 'tools/call',
    { name: 'read_file', arguments: { path: '../outside' } }, session);
  assert.equal((await traversal.json()).result.isError, true);
  const refresh = { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: access.refresh_token };
  const updated = await (await form(request, '/oauth/token', refresh)).json();
  assert.ok(updated.access_token);
  assert.equal((await form(request, '/oauth/token', refresh)).status, 400);
  assert.equal((await rpc(request, updated.access_token, 'tools/list', {}, session)).status, 200);
  assert.equal((await form(request, '/oauth/revoke', { client_id: client.client_id, token: updated.refresh_token })).status, 200);
  assert.equal((await rpc(request, access.access_token, 'tools/list', {}, session)).status, 401);
  assert.equal((await rpc(request, updated.access_token, 'tools/list', {}, session)).status, 401);
});

test('manual clients retain exact redirect and require secret, PKCE and linked consent', async t => {
  const request = await start(t);
  assert.equal((await json(request, '/oauth/register', { redirect_uris: ['https://oauth-redirect.googleusercontent.com.evil.invalid/r/x'] })).status, 400);
  assert.equal(validGoogleRedirect('https://oauth-redirect.googleusercontent.com/r/x?wrong=x'), false);
  assert.equal((await request('/healthz', { headers: { Host: 'wrong.invalid' } })).status, 403);
  const { fields, headers } = await authorize(request);
  assert.equal((await form(request, '/oauth/authorize', fields, { ...headers, Origin: 'null' })).status, 403);
  assert.equal((await form(request, '/oauth/authorize', fields, { Origin: origin })).status, 403);
  assert.equal((await form(request, '/oauth/authorize', { ...fields, password: 'wrong' }, headers)).status, 403);
  const basic = 'Basic ' + Buffer.from(manual.client_id + ':' + manual.client_secret).toString('base64');
  const auth = { Authorization: basic };
  const pending = exchangeFields(await code(request));
  assert.equal((await form(request, '/oauth/token', pending)).status, 401);
  assert.equal((await form(request, '/oauth/token', { ...pending, code_verifier: 'x'.repeat(43) }, auth)).status, 400);
  assert.equal((await form(request, '/oauth/token', { ...pending, redirect_uri: redirect + '-different' }, auth)).status, 400);
  const tokenA = await (await form(request, '/oauth/token', pending, auth)).json();
  const tokenB = await (await form(request, '/oauth/token', {
    ...exchangeFields(await code(request)), client_secret: manual.client_secret,
  })).json();
  assert.ok(tokenA.access_token && tokenB.access_token);
  const initial = await rpc(request, tokenA.access_token, 'initialize', initialize);
  const session = initial.headers.get('mcp-session-id');
  assert.equal((await rpc(request, tokenB.access_token, 'tools/list', {}, session)).status, 404);
  const oversized = await json(request, '/mcp', { value: 'x'.repeat(65536) }, { Authorization: 'Bearer ' + tokenA.access_token });
  assert.equal(oversized.status, 413);
});

test('modern discovery and tools work independently of legacy HTTP sessions', async t => {
  const request = await start(t);
  const access = await (await form(request, '/oauth/token', {
    ...exchangeFields(await code(request)), client_secret: manual.client_secret,
  })).json();
  const _meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
  const discover = await rpc(request, access.access_token, 'server/discover', { _meta });
  assert.equal(discover.headers.get('mcp-session-id'), null);
  assert.deepEqual((await discover.json()).result.supportedVersions, ['2026-07-28']);
  const listed = await rpc(request, access.access_token, 'tools/list', { _meta });
  const value = (await listed.json()).result;
  assert.equal(value.resultType, 'complete');
  assert.deepEqual(value.tools, TOOLS);
});

test('restricted launcher keeps the HTTP port and authorization during SSH retries', {
  skip: process.platform === 'win32' ? 'POSIX fake SSH executable' : false, timeout: 12000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bb-mcp-launcher-'));
  let child;
  try {
    await mkdir(path.join(root, '.local'));
    const names = ['gemini-server.mjs', 'http-app.mjs', 'gemini-oauth.mjs', 'core.mjs', 'protocol.mjs',
      'package.json', 'run-gemini.mjs', 'setup-gemini.mjs'];
    for (const name of names) await copyFile(new URL('../' + name, import.meta.url), path.join(root, name));
    const setup = (...args) => execFileSync(process.execPath, [path.join(root, 'setup-gemini.mjs'), ...args], { stdio: 'pipe' });
    setup('--origin', origin);
    setup('--redirect-uri', redirect);
    const fixture = createServer().listen(0, '127.0.0.1');
    await once(fixture, 'listening');
    const port = fixture.address().port;
    await new Promise(resolve => fixture.close(resolve));
    const configFile = path.join(root, '.local/gemini/config.json');
    const stored = JSON.parse(await readFile(configFile, 'utf8'));
    assert.equal(stored.clients.length, 1);
    assert.equal(stored.clients[0].redirect_uri, redirect);
    const fields = { ...stored, port, adminPassword, ssh: {
      host: 'fixture.invalid', user: 'fixture', identityFile: path.join(root, 'identity'),
      knownHosts: path.join(root, 'known-hosts'),
    } };
    await writeFile(configFile, JSON.stringify(fields));
    await writeFile(path.join(root, '.local/snapshot.json'), JSON.stringify(snapshot));
    await writeFile(path.join(root, 'ssh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    assert.throws(() => execFileSync(process.execPath, [path.join(root, 'gemini-server.mjs')], { stdio: 'pipe' }));
    child = spawn(process.execPath, [path.join(root, 'run-gemini.mjs'), '--ssh'], {
      env: { PATH: root }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let retries = 0;
    child.stderr.on('data', chunk => { retries += (String(chunk).match(/Reconnecting in 5 seconds/g) ?? []).length; });
    const deadline = Date.now() + 8000;
    async function waitForRetries(count) {
      while (retries < count && Date.now() < deadline && child.exitCode === null) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      assert.ok(retries >= count, 'SSH should retry without exiting');
    }
    await waitForRetries(1);
    const request = (url, options) => loopbackRequest('http://127.0.0.1:' + port, url, options);
    const manualClient = stored.clients[0];
    const access = await (await form(request, '/oauth/token', {
      ...exchangeFields(await code(request, manualClient.client_id), manualClient.client_id),
      client_secret: manualClient.client_secret,
    })).json();
    assert.ok(access.access_token);
    await waitForRetries(2);
    const result = await rpc(request, access.access_token, 'initialize', initialize);
    assert.equal((await result.json()).result.protocolVersion, initialize.protocolVersion);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
