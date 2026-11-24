import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { digest } from '../core.mjs';

test('Gemini preserves grants across SSH drops and launcher restarts, including durable revocation', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bb-reconnect-'));
  t.after(async () => {
    assert.equal(path.dirname(dir), os.tmpdir());
    await rm(dir, { recursive: true, force: true });
  });
  for (const file of ['run-gemini.mjs', 'gemini-config-mode.mjs', 'oauth-state-file.mjs', 'http-server.mjs', 'http-app.mjs', 'snapshot-store.mjs', 'core.mjs', 'package.json']) {
    await copyFile(new URL('../' + file, import.meta.url), path.join(dir, file));
  }
  await mkdir(path.join(dir, '.local/gemini'), { recursive: true });
  await writeFile(path.join(dir, '.local/gemini/config.json'), JSON.stringify({ origin: 'https://mcp.bowerbird.cn', port: 0, adminPassword: 'p'.repeat(43) }));
  await writeFile(path.join(dir, '.local/snapshot.json'), JSON.stringify({ version: 1, createdAt: 'fixture', revision: 'fixture',
    files: [{ path: 'PROJECT.md', content: 'safe', sha256: digest('safe') }] }));
  // Replace only SSH with a simulated failing connection. HTTP remains a real restricted subprocess.
  const preload = path.join(dir, 'fixture-preload.mjs');
  await writeFile(preload, `
    import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    import {EventEmitter} from 'node:events';
    const realSpawn=cp.spawn; let attempts=0;
    cp.spawn=(command,args,options)=>{
      if(command==='ssh'){
        const child=new EventEmitter();
        child.kill=()=>{child.emit('close',0);return true;};
        console.log('TEST_SSH_ATTEMPT '+(++attempts));
        if(attempts===1)setTimeout(()=>child.emit('close',1),200);
        return child;
      }
      const child=realSpawn(command,args,options);
      console.log('TEST_HTTP_PID '+child.pid);
      child.stdout.on('data',data=>{const port=/Port (\\d+)/.exec(String(data));if(port)console.log('TEST_PORT '+port[1]);});
      return child;
    };
    syncBuiltinESMExports();
  `);
  async function start() {
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, path.join(dir, 'run-gemini.mjs')],
      { stdio: 'pipe', windowsHide: true });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors += data; });
    async function stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      const pid = /TEST_HTTP_PID (\d+)/.exec(output)?.[1];
      if (pid) {
        try { process.kill(Number(pid)); } catch { child.kill(); }
      } else child.kill();
      await exited;
    }
    t.after(stop);
    async function until(pattern) {
      const deadline = Date.now() + 9000;
      while (!pattern.test(output + errors)) {
        if (child.exitCode !== null || Date.now() > deadline) throw new Error('Launcher failed: ' + errors);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    await until(/TEST_PORT \d+/);
    const base = 'http://127.0.0.1:' + /TEST_PORT (\d+)/.exec(output)[1];
    return { request: (route, options) => fetch(base + route, { redirect: 'manual', ...options }),
      until, stop, errors: () => errors };
  }
  let launcher = await start();
  const registration = await launcher.request('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://oauth-redirect.googleusercontent.com/r/fixture'], token_endpoint_auth_method: 'client_secret_post' }) });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  await launcher.until(/Retrying in 5 seconds/);
  assert.equal((await launcher.request('/healthz')).status, 204);
  await launcher.until(/TEST_SSH_ATTEMPT 2/);
  const origin = 'https://mcp.bowerbird.cn';
  const resource = origin + '/mcp', verifier = 'v'.repeat(43);
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code',
    resource, scope: 'code:read', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
  const page = await launcher.request('/oauth/authorize?' + query);
  assert.equal(page.status, 200);
  const nonce = /name="nonce" value="([^"]+)"/.exec(await page.text())[1];
  const consent = await launcher.request('/oauth/authorize', { method: 'POST',
    headers: { Origin: origin, Cookie: page.headers.get('set-cookie').split(';')[0] },
    body: new URLSearchParams({ nonce, password: 'p'.repeat(43) }) });
  assert.equal(consent.status, 302);
  const code = new URL(consent.headers.get('location')).searchParams.get('code');
  const post = (route, parameters) => launcher.request(route, { method: 'POST',
    body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, resource, ...parameters }) });
  const exchanged = await post('/oauth/token', { grant_type: 'authorization_code', code,
    redirect_uri: client.redirect_uris[0], code_verifier: verifier });
  assert.equal(exchanged.status, 200);
  const tokens = await exchanged.json();
  const statePath = path.join(dir, '.local/gemini/oauth/state.json');
  const saved = await readFile(statePath, 'utf8');
  for (const secret of [client.client_secret, tokens.access_token, tokens.refresh_token, code, nonce, 'p'.repeat(43)]) {
    assert.ok(!saved.includes(secret) && !launcher.errors().includes(secret));
  }
  const rpc = accessToken => launcher.request('/mcp', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + accessToken },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
  await launcher.stop();
  launcher = await start();
  assert.equal((await rpc(tokens.access_token)).status, 200);
  const refresh = () => post('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  const refreshed = await refresh();
  assert.equal(refreshed.status, 200);
  const renewed = await refreshed.json();
  assert.equal(renewed.refresh_token, tokens.refresh_token);
  assert.equal((await rpc(renewed.access_token)).status, 200);
  assert.equal((await post('/oauth/revoke', { token: renewed.access_token })).status, 200);
  await launcher.stop();
  launcher = await start();
  assert.equal((await rpc(tokens.access_token)).status, 401);
  assert.equal((await rpc(renewed.access_token)).status, 401);
  assert.equal((await refresh()).status, 400);
  await launcher.stop();
  await writeFile(statePath, JSON.stringify({ ...JSON.parse(saved), mac: 'corrupted' }));
  launcher = await start();
  assert.equal((await rpc(tokens.access_token)).status, 401);
  assert.match(launcher.errors(), /saved OAuth state did not match/);
  await launcher.stop();
});
