import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMcpHttpServer, googleRedirect } from '../http-app.mjs';
import { createSnapshotReader } from '../snapshot-store.mjs';
import { digest } from '../core.mjs';

const origin = 'https://mcp.bowerbird.cn';
const resource = origin + '/mcp';
const password = 'p'.repeat(43);
const config = { origin, port: 48731, adminPassword: password };
const snapshot = { version: 1, createdAt: '2026-11-15T00:00:00Z', revision: 'fixture',
  files: [{ path: 'PROJECT.md', content: 'safe project', sha256: digest('safe project') }] };
const callback = 'https://oauth-redirect.googleusercontent.com/r/fixture';
const verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');

async function fixture(t, overrides = {}, source = snapshot) {
  let time = Date.now();
  const server = createMcpHttpServer(source, { ...config, ...overrides }, () => time);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  async function request(route, { method = 'GET', data, form, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path: route, method,
        headers: { Host: 'mcp.bowerbird.cn', Accept: 'application/json, text/event-stream',
          ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(form === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }), ...headers } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks),
          { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])) })));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(data === undefined ? form === undefined ? undefined : new URLSearchParams(form).toString() : JSON.stringify(data));
    });
  }
  async function register() {
    const response = await request('/oauth/register', { method: 'POST', data: { redirect_uris: [callback], token_endpoint_auth_method: 'none' } });
    assert.equal(response.status, 201);
    return (await response.json()).client_id;
  }
  async function approval(clientId, overrides = {}) {
    const query = { client_id: clientId, redirect_uri: callback, response_type: 'code', resource,
      scope: 'code:read', state: 'opaque-state', code_challenge_method: 'S256', code_challenge: challenge, ...overrides };
    const response = await request('/oauth/authorize?' + new URLSearchParams(query));
    return { response, html: await response.text(), query };
  }
  async function code(clientId) {
    const { response, html } = await approval(clientId);
    assert.equal(response.status, 200);
    const nonce = /name="nonce" value="([^"]+)"/.exec(html)[1];
    const result = await request('/oauth/authorize', { method: 'POST', form: { nonce, password },
      headers: { Origin: origin, Cookie: response.headers.get('set-cookie').split(';')[0] } });
    assert.equal(result.status, 302);
    const redirect = new URL(result.headers.get('location'));
    assert.equal(redirect.origin + redirect.pathname, callback);
    assert.equal(redirect.searchParams.get('state'), 'opaque-state');
    return redirect.searchParams.get('code');
  }
  async function tokens(clientId, authCode, overrides = {}, headers = {}) {
    return request('/oauth/token', { method: 'POST', headers, form: { client_id: clientId, code: authCode,
      grant_type: 'authorization_code', redirect_uri: callback, code_verifier: verifier, resource, ...overrides } });
  }
  async function rpc(token, method, params = {}) {
    return request('/mcp', { method: 'POST', data: { jsonrpc: '2.0', id: 1, method, params },
      headers: { Authorization: 'Bearer ' + token } });
  }
  return { request, register, approval, code, tokens, rpc, advance: ms => { time += ms; } };
}

test('atomic snapshot updates preserve access and refresh tokens, retain valid data on failure, and recover', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bb-mcp-reload-'));
  t.after(async () => {
    assert.equal(path.dirname(dir), os.tmpdir());
    await rm(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, 'snapshot.json');
  await writeFile(file, JSON.stringify(snapshot));
  const events = [];
  const reader = createSnapshotReader(file, event => events.push(event));
  const f = await fixture(t, {}, reader);
  const id = await f.register();
  const token = await (await f.tokens(id, await f.code(id))).json();
  async function read(tokenValue = token.access_token) {
    const result = await (await f.rpc(tokenValue, 'tools/call', { name: 'read_file', arguments: { path: 'PROJECT.md' } })).json();
    assert.ok(!result.error && !result.result.isError);
    return JSON.parse(result.result.content[0].text);
  }
  async function replace(value) {
    await writeFile(file + '.tmp', value);
    await rename(file + '.tmp', file);
  }
  const first = await read();
  const content = 'updated project';
  await replace(JSON.stringify({ ...snapshot, createdAt: '2026-11-19T00:00:00Z',
    files: [{ path: 'PROJECT.md', content, sha256: digest(content) }] }));
  const second = await read();
  assert.notDeepEqual(second, first);
  assert.match(JSON.stringify(second), /updated project/);
  const refreshed = await f.request('/oauth/token', { method: 'POST', form: {
    client_id: id, grant_type: 'refresh_token', refresh_token: token.refresh_token, resource } });
  assert.equal(refreshed.status, 200);
  assert.deepEqual(await read((await refreshed.json()).access_token), second);
  await replace('{truncated');
  assert.deepEqual(await read(), second);
  await replace(JSON.stringify({ ...snapshot, files: [{ ...snapshot.files[0], sha256: 'bad' }] }));
  assert.deepEqual(await read(), second);
  await rm(file);
  assert.deepEqual(await read(), second);
  await replace(JSON.stringify(snapshot));
  assert.deepEqual(await read(), first);
  assert.ok(events.some(event => event.event === 'snapshot-rejected'));
  assert.equal(events.filter(event => event.event === 'snapshot-loaded').length, 3);
});

test('public metadata, authentication and Host/Origin boundaries', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/healthz')).status, 204);
  const metadata = await (await f.request('/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(metadata.response_types_supported, ['code']);
  assert.equal((await (await f.request('/.well-known/oauth-protected-resource/mcp')).json()).resource, resource);
  const denied = await f.request('/mcp');
  assert.equal(denied.status, 401);
  assert.ok(denied.headers.get('www-authenticate').includes('oauth-protected-resource'));
  assert.equal((await f.request('/mcp?access_token=anything')).status, 401);
  assert.equal((await f.request('/healthz', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await f.request('/healthz', { headers: { Origin: 'https://evil.example' } })).status, 403);
  for (const uri of ['http://oauth-redirect.googleusercontent.com/r/x', 'https://evil.example/r/x', callback + '?next=evil', callback + '/more', callback.replace('.com', '.com.evil.example')]) {
    assert.equal(googleRedirect(uri), false, uri);
    assert.equal((await f.request('/oauth/register', { method: 'POST', data: { redirect_uris: [uri] } })).status, 400);
  }
  assert.equal(googleRedirect(callback), true);
});

test('OAuth consent requires password, cookie, same-origin POST and exact registered redirect', async t => {
  const f = await fixture(t);
  const clientId = await f.register();
  for (const overrides of [{ redirect_uri: callback + '-other' }, { resource: 'https://evil.example/mcp' },
    { code_challenge_method: 'plain' }, { scope: 'write' }, { response_type: 'token' }]) {
    assert.equal((await f.approval(clientId, overrides)).response.status, 400);
  }
  const { response, html } = await f.approval(clientId);
  assert.ok(!html.includes(password));
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  const nonce = /name="nonce" value="([^"]+)"/.exec(html)[1];
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /Secure; HttpOnly; SameSite=Lax/);
  for (const options of [
    { form: { nonce, password }, headers: { Origin: origin } },
    { form: { nonce, password: 'incorrect' }, headers: { Origin: origin, Cookie: cookie.split(';')[0] } },
    { form: { nonce, password }, headers: { Origin: 'https://evil.example', Cookie: cookie.split(';')[0] } },
    { form: { nonce, password }, headers: { Origin: 'null', Cookie: cookie.split(';')[0] } },
    { form: { nonce, password }, headers: { Cookie: cookie.split(';')[0] } },
  ]) assert.equal((await f.request('/oauth/authorize', { method: 'POST', ...options })).status, 403);
  f.advance(601_000);
  assert.equal((await f.request('/oauth/authorize', { method: 'POST', form: { nonce, password },
    headers: { Origin: origin, Cookie: cookie.split(';')[0] } })).status, 403);
});

test('stale client IDs identify registration mismatch without bypassing OAuth', async t => {
  const f = await fixture(t);
  const failed = await f.approval('expired-client');
  assert.equal(failed.response.status, 400);
  assert.deepEqual(JSON.parse(failed.html), { error: 'invalid_request', error_description: 'unknown_client' });
  const response = await f.request('/oauth/authorize?' + new URLSearchParams(failed.query), { headers: { Accept: 'text/html' } });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /oauthClient.clientId/);
  assert.equal((await f.request('/mcp')).status, 401);
});

test('browser approvals coexist, allow password retry, and duplicate submits reuse one code', async t => {
  const f = await fixture(t);
  const id = await f.register();
  const first = await f.approval(id);
  const second = await f.approval(id);
  const nonce = /name="nonce" value="([^"]+)"/.exec(first.html)[1];
  const cookies = [first, second].map(page => page.response.headers.get('set-cookie').split(';')[0]);
  const headers = { Accept: 'text/html', Origin: origin, Cookie: cookies.join('; ') };
  const post = password => f.request('/oauth/authorize', { method: 'POST', headers, form: { nonce, password } });
  const wrong = await post('wrong');
  assert.equal(wrong.status, 403);
  assert.match(await wrong.text(), /授权密码不匹配/);
  const accepted = await post(password);
  assert.equal(accepted.status, 303);
  const location = accepted.headers.get('location');
  const duplicate = await post(password);
  assert.equal(duplicate.status, 303);
  assert.equal(duplicate.headers.get('location'), location);
  assert.equal((await f.request(location, { headers: { ...headers, Cookie: cookies[1] } })).status, 403);
  const receipt = () => f.request(location, { headers });
  const firstBody = await (await receipt()).text();
  const code = /[?&]code=([\w-]+)/.exec(firstBody)[1];
  assert.equal(await (await receipt()).text(), firstBody);
  assert.equal((await f.tokens(id, code)).status, 200);
  assert.equal((await receipt()).status, 403);
  assert.equal((await f.tokens(id, code)).status, 400);
});

test('PKCE, single-use code, expiry, client/resource binding and refresh revocation', async t => {
  const f = await fixture(t);
  const clientId = await f.register();
  const otherClient = await f.register();
  const authCode = await f.code(clientId);
  for (const overrides of [{ code_verifier: 'x'.repeat(43) }, { client_id: otherClient },
    { resource: 'https://evil.example/mcp' }, { redirect_uri: callback + '-other' }]) {
    assert.equal((await f.tokens(clientId, authCode, overrides)).status, 400);
  }
  const response = await f.tokens(clientId, authCode);
  assert.equal(response.status, 200);
  const token = await response.json();
  assert.equal((await f.tokens(clientId, authCode)).status, 400);
  assert.equal((await f.rpc(token.access_token, 'ping')).status, 200);
  f.advance(3601_000);
  assert.equal((await f.rpc(token.access_token, 'ping')).status, 401);
  const form = { client_id: clientId, grant_type: 'refresh_token', refresh_token: token.refresh_token, resource };
  assert.equal((await f.request('/oauth/token', { method: 'POST', form: { ...form, client_id: otherClient } })).status, 400);
  const renewed = await (await f.request('/oauth/token', { method: 'POST', form })).json();
  assert.equal(renewed.refresh_token, token.refresh_token);
  assert.equal((await f.rpc(renewed.access_token, 'ping')).status, 200);
  assert.equal((await f.request('/oauth/revoke', { method: 'POST', form: { client_id: clientId, token: token.refresh_token } })).status, 200);
  assert.equal((await f.rpc(renewed.access_token, 'ping')).status, 401);
  assert.equal((await f.request('/oauth/token', { method: 'POST', form })).status, 400);
  const expiredCode = await f.code(clientId);
  f.advance(121_000);
  assert.equal((await f.tokens(clientId, expiredCode)).status, 400);
});

test('Streamable HTTP handles concurrent read-only requests and bounded input', async t => {
  const f = await fixture(t);
  const clientId = await f.register();
  const token = await (await f.tokens(clientId, await f.code(clientId))).json();
  const initialized = await (await f.rpc(token.access_token, 'initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })).json();
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  const headers = { Authorization: 'Bearer ' + token.access_token };
  assert.equal((await f.request('/mcp', { method: 'POST', headers,
    data: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status, 202);
  assert.equal((await f.request('/mcp', { headers })).status, 405);
  assert.equal((await f.request('/mcp', { method: 'DELETE', headers })).status, 405);
  assert.equal((await f.request('/mcp', { method: 'POST', data: {}, headers: { ...headers, Accept: 'text/plain' } })).status, 406);
  assert.equal((await f.request('/mcp', { method: 'POST', data: {}, headers: { ...headers, 'MCP-Protocol-Version': 'unsupported' } })).status, 400);
  assert.equal((await f.request('/mcp', { method: 'POST', data: ['batch'], headers })).status, 400);
  assert.equal((await f.request('/mcp', { method: 'POST', data: { value: 'x'.repeat(65536) }, headers })).status, 413);
  const results = await Promise.all(['project_overview', 'list_files', 'read_file', 'search_code'].map(name =>
    f.rpc(token.access_token, 'tools/call', { name, arguments: name === 'read_file' ? { path: 'PROJECT.md' } : name === 'search_code' ? { query: 'safe' } : {} }).then(response => response.json())));
  assert.ok(results.every(result => !result.error && !result.result.isError));
  const listed = await (await f.rpc(token.access_token, 'tools/list')).json();
  assert.equal(listed.result.tools.length, 4);
  for (const method of ['write_file', 'exec', 'refresh']) assert.equal((await (await f.rpc(token.access_token, method)).json()).error.code, -32601);
  assert.equal((await (await f.rpc(token.access_token, 'tools/call', { name: 'read_file', arguments: { path: '../.env.tunnel' } })).json()).result.isError, true);
});

test('confidential registrations authenticate token requests with their declared method', async t => {
  const f = await fixture(t);
  for (const method of ['client_secret_post', 'client_secret_basic']) {
    const registration = await (await f.request('/oauth/register', { method: 'POST',
      data: { redirect_uris: [callback], token_endpoint_auth_method: method } })).json();
    assert.equal(registration.token_endpoint_auth_method, method);
    const code = await f.code(registration.client_id);
    assert.equal((await f.tokens(registration.client_id, code)).status, 400);
    assert.equal((await f.tokens(registration.client_id, code, { client_secret: 'wrong' })).status, 400);
    const headers = method === 'client_secret_basic'
      ? { Authorization: 'Basic ' + Buffer.from(registration.client_id + ':' + registration.client_secret).toString('base64') } : {};
    const params = method === 'client_secret_post' ? { client_secret: registration.client_secret } : {};
    assert.equal((await f.tokens(registration.client_id, code, params, headers)).status, 200);
  }
});

test('pre-registered credentials survive server recreation and require secret, PKCE and exact callback', async t => {
  const oauthClient = { clientId: 'c'.repeat(43), clientSecret: 's'.repeat(43), redirectUri: callback };
  for (const method of ['client_secret_post', 'client_secret_basic']) {
    const f = await fixture(t, { oauthClient });
    f.advance(31 * 86400_000);
    const { clientId, clientSecret } = oauthClient;
    assert.equal((await f.approval(clientId, { redirect_uri: callback + '-other' })).response.status, 400);
    const code = await f.code(clientId);
    assert.equal((await f.tokens(clientId, code)).status, 400);
    assert.equal((await f.tokens(clientId, code, { client_secret: 'wrong' })).status, 400);
    const headers = method === 'client_secret_basic' ? { Authorization: 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64') } : {};
    const params = method === 'client_secret_post' ? { client_secret: clientSecret } : {};
    assert.equal((await f.tokens(clientId, code, { ...params, code_verifier: 'wrong' }, headers)).status, 400);
    const result = await f.tokens(clientId, code, params, headers);
    assert.equal(result.status, 200);
    assert.equal((await f.rpc((await result.json()).access_token, 'tools/list')).status, 200);
  }
  assert.throws(() => createMcpHttpServer(snapshot, { ...config, oauthClient: { ...oauthClient, redirectUri: 'https://evil.example/r/x' } }));
});

test('DCR accepts all six official callback families and reports safe rejection reasons', async t => {
  const f = await fixture(t);
  const redirectUris = ['oauth-redirect', 'oauth-redirect-sandbox', 'oauth-redirect-test']
    .flatMap(host => ['r', 'a'].map(prefix => `https://${host}.googleusercontent.com/${prefix}/fixture`));
  const registration = await f.request('/oauth/register', { method: 'POST', data: { redirect_uris: redirectUris } });
  assert.equal(registration.status, 201);
  assert.deepEqual((await registration.json()).redirect_uris, redirectUris);
  const denied = await f.request('/oauth/register', { method: 'POST', data: { redirect_uris: ['https://evil.example/r/secret'] } });
  assert.equal(denied.status, 400);
  assert.deepEqual(await denied.json(), { error: 'invalid_client_metadata', error_description: 'invalid_redirect_uri' });
});

test('HTTP entrypoint rejects unrestricted execution and starts with read-only permissions', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bb-mcp-http-'));
  t.after(async () => {
    assert.equal(path.dirname(dir), os.tmpdir());
    await rm(dir, { recursive: true, force: true });
  });
  for (const file of ['http-server.mjs', 'http-app.mjs', 'snapshot-store.mjs', 'core.mjs', 'package.json']) await copyFile(new URL('../' + file, import.meta.url), path.join(dir, file));
  await mkdir(path.join(dir, '.local/gemini'), { recursive: true });
  await writeFile(path.join(dir, '.local/gemini/config.json'), JSON.stringify({ ...config, port: 0 }));
  await writeFile(path.join(dir, '.local/snapshot.json'), JSON.stringify(snapshot));
  const unsafe = spawn(process.execPath, [path.join(dir, 'http-server.mjs')], { stdio: 'pipe', windowsHide: true });
  assert.equal((await once(unsafe, 'exit'))[0], 1);
  const child = spawn(process.execPath, ['--permission', '--disable-proto=throw',
    ...['http-server.mjs', 'http-app.mjs', 'snapshot-store.mjs', 'core.mjs', 'package.json', '.local/snapshot.json', '.local/gemini/config.json'].map(file => '--allow-fs-read=' + path.join(dir, file)),
    path.join(dir, 'http-server.mjs')], { stdio: 'pipe', windowsHide: true });
  t.after(() => child.kill());
  const started = await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('Restricted listener failed'); })]);
  assert.match(String(started[0]), /listening on loopback/);
  const port = /Port (\d+)/.exec(String(started[0]))[1];
  const health = await fetch('http://127.0.0.1:' + port + '/healthz');
  assert.equal(health.status, 204);
  child.kill();
  await once(child, 'exit');
});
