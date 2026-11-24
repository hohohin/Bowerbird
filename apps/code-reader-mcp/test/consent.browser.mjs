// Optional browser regression: uses the workspace renderer's Playwright and installed Chrome.
// Requests are routed to this fixture; browser DNS is disabled to prevent external traffic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { createMcpHttpServer } from '../http-app.mjs';
import { digest } from '../core.mjs';

test('native browser consent retains same-origin POST and secure cookie while null Origin stays denied', async t => {
  const origin = 'https://mcp.bowerbird.cn';
  const password = 'p'.repeat(43);
  const clientId = 'c'.repeat(43);
  const callback = 'https://oauth-redirect.googleusercontent.com/r/browser-fixture';
  const server = createMcpHttpServer({ version: 1, createdAt: '2026-11-16T00:00:00Z', revision: 'fixture',
    files: [{ path: 'PROJECT.md', content: 'fixture', sha256: digest('fixture') }] }, {
    origin, port: 0, adminPassword: password,
    oauthClient: { clientId, clientSecret: 's'.repeat(43), redirectUri: callback },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
  t.after(() => browser.close());
  for (const legacyPolicy of [false, true]) {
    const context = await browser.newContext();
    t.after(() => context.close());
    await context.route('**/*', async route => {
      const incoming = route.request();
      const url = new URL(incoming.url());
      if (url.origin !== origin) return route.fulfill({ status: 200, contentType: 'text/plain', body: 'fixture callback' });
      const headers = { ...await incoming.allHeaders(), host: 'mcp.bowerbird.cn' };
      const forwarded = await new Promise((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: server.address().port,
          path: url.pathname + url.search, method: incoming.method(), headers }, response => {
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end(incoming.postDataBuffer());
      });
      const responseHeaders = Object.fromEntries(Object.entries(forwarded.headers)
        .map(([key, value]) => [key, Array.isArray(value) ? value.join('\n') : String(value)]));
      delete responseHeaders['transfer-encoding'];
      if (legacyPolicy && incoming.method() === 'GET' && url.pathname === '/oauth/authorize') responseHeaders['referrer-policy'] = 'no-referrer';
      await route.fulfill({ ...forwarded, headers: responseHeaders });
    });
    const page = await context.newPage();
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: 'code',
      resource: origin + '/mcp', code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'), state: 'browser-fixture' });
    assert.equal((await page.goto(origin + '/oauth/authorize?' + query)).status(), 200);
    await page.locator('input[name=password]').fill(password);
    const posted = page.waitForResponse(response => response.request().method() === 'POST');
    const redirected = legacyPolicy ? null : page.waitForRequest(request => request.url().startsWith(callback + '?'));
    await page.getByRole('button', { name: '授权只读访问' }).click({ noWaitAfter: true });
    const result = await posted;
    const submitted = await result.request().allHeaders();
    assert.equal(submitted.origin, legacyPolicy ? 'null' : origin);
    if (legacyPolicy) {
      assert.equal(result.status(), 403);
      assert.deepEqual(await result.json(), { error: 'forbidden' });
    } else {
      assert.match(submitted.cookie, /bb_mcp_approval_/);
      assert.equal(result.status(), 303);
      assert.match((await result.allHeaders()).location, /^\/oauth\/authorize\/continue\?nonce=/);
      const destination = new URL((await redirected).url());
      assert.equal(destination.origin + destination.pathname, callback);
      assert.equal(destination.searchParams.get('state'), 'browser-fixture');
      assert.ok(destination.searchParams.get('code'));
    }
  }
});
