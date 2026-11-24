import { createServer } from 'node:http';
import { createMcpSession, isObject, legacyVersions } from './protocol.mjs';
import { createOAuth, token } from './gemini-oauth.mjs';
import { validateSnapshot } from './core.mjs';

const REQUEST_LIMIT = 65536;
const SESSION_TTL = 60 * 60 * 1000;
const MODERN_VERSION = '2026-07-28';

export function publicOrigin(value) {
  const origin = new URL(value);
  const local = origin.protocol === 'http:' && origin.hostname === '127.0.0.1';
  if (value !== origin.origin || (!local && origin.protocol !== 'https:')) throw new Error('Invalid public origin');
  return origin;
}

const reply = (res, status, body, headers = {}) => {
  const html = typeof body === 'string';
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...(body === undefined ? {} : { 'Content-Type': html ? 'text/html; charset=utf-8' : 'application/json' }),
    ...headers,
  });
  res.end(body === undefined ? undefined : html ? body : JSON.stringify(body));
};
const problem = (status, message) => Object.assign(new Error(message), { status });
async function body(req, mode) {
  const type = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (type !== mode) throw problem(415, 'unsupported_media_type');
  if (Number(req.headers['content-length']) > REQUEST_LIMIT) throw problem(413, 'request_too_large');
  const chunks = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > REQUEST_LIMIT) throw problem(413, 'request_too_large');
    chunks.push(chunk);
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw problem(400, 'invalid_request'); }
  if (mode === 'application/json') {
    try { return JSON.parse(text); }
    catch { throw problem(400, 'invalid_json'); }
  }
  const fields = new URLSearchParams(text);
  if (new Set(fields.keys()).size !== [...fields.keys()].length) throw problem(400, 'invalid_request');
  return fields;
}

export function createHttpApp(snapshot, config) {
  validateSnapshot(snapshot);
  const site = publicOrigin(config.origin);
  const oauth = createOAuth(config);
  const protectedResource = { resource: oauth.resource, authorization_servers: [site.origin],
    scopes_supported: oauth.metadata.scopes_supported, bearer_methods_supported: ['header'] };
  const resourceMetadata = site.origin + '/.well-known/oauth-protected-resource/mcp';
  const sessions = new Map();
  const cookieName = site.protocol === 'https:' ? '__Host-bowerbird-consent' : 'bowerbird-consent';
  const cookie = (value, age) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${site.protocol === 'https:' ? '; Secure' : ''}`;
  const json = 'application/json';
  const form = 'application/x-www-form-urlencoded';

  async function mcp(req, res) {
    const authority = oauth.bearer(req.headers.authorization);
    if (!authority) return reply(res, 401, { error: 'unauthorized' },
      { 'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadata}"` });
    const sessionId = req.headers['mcp-session-id'];
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && session?.family !== authority.family) return reply(res, 404, { error: 'session_not_found' });
    if (req.method === 'DELETE' && session) {
      sessions.delete(sessionId);
      return reply(res, 204);
    }
    if (req.method !== 'POST') return reply(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST, DELETE' });

    const version = req.headers['mcp-protocol-version'];
    if (version && (![...legacyVersions, MODERN_VERSION].includes(version) || (session && session.version !== version))) {
      return reply(res, 400, { error: 'invalid_protocol_version' });
    }
    const message = await body(req, json);
    const dispatch = session?.dispatch ?? createMcpSession(snapshot);
    const modern = message?.params?._meta?.['io.modelcontextprotocol/protocolVersion'] !== undefined;
    if (!session && !modern && message?.method !== 'initialize' && isObject(message) && message.method !== 'server/discover') {
      return reply(res, 400, { error: 'session_required' });
    }
    const result = dispatch(message);
    if (result === null) return reply(res, 202);
    if (!session && !modern && message?.method === 'initialize' && result.result) {
      if (sessions.size >= 128) return reply(res, 503, { error: 'temporarily_unavailable' });
      const id = token();
      sessions.set(id, { dispatch, family: authority.family, version: result.result.protocolVersion, expires: Date.now() + SESSION_TTL });
      return reply(res, 200, result, { 'Mcp-Session-Id': id });
    }
    return reply(res, 200, result);
  }

  async function route(req, res) {
    // The reverse proxy must pass the canonical Host. Forwarded headers are ignored.
    if (req.headers.host !== site.host || !req.url?.startsWith('/') || req.url.startsWith('//')
      || req.url.startsWith('/\\') || (req.headers.origin && req.headers.origin !== site.origin)) {
      return reply(res, 403, { error: 'forbidden' });
    }
    const url = new URL(req.url, site);
    oauth.sweep();
    for (const [id, session] of sessions) if (session.expires <= Date.now()) sessions.delete(id);
    if (url.pathname === '/mcp') return mcp(req, res);
    if (req.method === 'GET') {
      switch (url.pathname) {
        case '/healthz': return reply(res, 200, { status: 'ok' });
        case '/.well-known/oauth-protected-resource':
        case '/.well-known/oauth-protected-resource/mcp': return reply(res, 200, protectedResource);
        case '/.well-known/oauth-authorization-server': return reply(res, 200, oauth.metadata);
        case '/oauth/authorize': {
          const request = oauth.authorize(url.searchParams);
          if (request.error) return reply(res, 400, request);
          return reply(res, 200, `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><title>Bowerbird 代码访问授权</title>
<h1>Bowerbird 代码访问授权</h1>
<p>授权 Gemini 读取本机已导出并审核的只读代码快照。</p>
<form action="/oauth/authorize" method="post">
<input type="hidden" name="consent" value="${request.key}">
<label>访问密码 <input type="password" name="password" required maxlength="256" autocomplete="current-password"></label>
<button type="submit">授权</button></form></html>`, {
            'Referrer-Policy': 'same-origin',
            'Content-Security-Policy': `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' ${request.callbackOrigin}`,
            'Set-Cookie': cookie(request.key, 300),
          });
        }
      }
    }
    if (req.method === 'POST') {
      switch (url.pathname) {
        case '/oauth/authorize': {
          if (req.headers.origin !== site.origin) return reply(res, 403, { error: 'forbidden' });
          const params = await body(req, form);
          const state = req.headers.cookie?.split(';').map(part => part.trim())
            .find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
          const result = oauth.consent(params.get('consent'), state, params.get('password'));
          if (result.error) return reply(res, result.error === 'rate_limited' ? 429 : 403, result);
          return reply(res, 302, undefined, { Location: result.location, 'Set-Cookie': cookie('', 0) });
        }
        case '/oauth/register': {
          const result = oauth.register(await body(req, json));
          return reply(res, result.error ? (result.error === 'temporarily_unavailable' ? 503 : 400) : 201, result);
        }
        case '/oauth/token':
        case '/oauth/revoke': {
          const params = await body(req, form);
          const method = url.pathname === '/oauth/token' ? oauth.exchange : oauth.revoke;
          const result = method(params, req.headers.authorization);
          return reply(res, result.error === 'invalid_client' ? 401 : result.error ? 400 : 200, result);
        }
      }
    }
    return reply(res, 404, { error: 'not_found' });
  }

  return createServer({ requestTimeout: 10_000, headersTimeout: 5_000, connectionsCheckingInterval: 1000,
    maxHeaderSize: 8192 }, (req, res) => {
    route(req, res).catch(error => {
      if (res.destroyed || res.headersSent) return;
      if (error.status === 413) res.once('finish', () => req.destroy());
      reply(res, error.status ?? 500, { error: error.status ? error.message : 'internal_error' },
        error.status === 413 ? { Connection: 'close' } : {});
    });
  });
}
