import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const redirectHosts = new Set([
  'oauth-redirect.googleusercontent.com',
  'oauth-redirect-sandbox.googleusercontent.com',
  'oauth-redirect-test.googleusercontent.com',
]);
export const token = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest();
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(digest(a), digest(b));
const scope = 'code:read';
const accessSeconds = 3600;
const verifierPattern = /^[A-Za-z0-9._~-]{43,128}$/;

export function validGoogleRedirect(value) {
  if (typeof value !== 'string' || value.length > 1024) return false;
  try {
    const url = new URL(value);
    return value === url.href && url.protocol === 'https:' && !url.username && !url.password
      && !url.port && !url.hash && !url.search && redirectHosts.has(url.hostname)
      && /^\/[ra]\/[A-Za-z0-9._~-]+$/.test(url.pathname);
  } catch { return false; }
}

export function createOAuth({ origin, adminPassword, clients: configured = [] }, now = Date.now) {
  if (typeof adminPassword !== 'string' || adminPassword.length < 32 || adminPassword.length > 256) {
    throw new Error('A generated admin password is required');
  }
  const resource = origin + '/mcp';
  const manual = new Map();
  for (const client of configured) {
    if (!client || typeof client.client_id !== 'string' || !verifierPattern.test(client.client_id)
      || typeof client.client_secret !== 'string' || !verifierPattern.test(client.client_secret)
      || !validGoogleRedirect(client.redirect_uri) || manual.has(client.client_id)) {
      throw new Error('Invalid configured OAuth client');
    }
    manual.set(client.client_id, { ...client, redirects: [client.redirect_uri], method: 'manual' });
  }
  const registrations = new Map();
  const consents = new Map();
  const grants = new Map();
  const access = new Map();
  const refresh = new Map();
  const stores = [consents, grants, access, refresh, registrations];
  let failures = 0;
  let cooldown = 0;

  function sweep() {
    const at = now();
    for (const store of stores) for (const [id, entry] of store) if (entry.expires <= at) store.delete(id);
  }
  const metadata = {
    issuer: origin,
    authorization_endpoint: origin + '/oauth/authorize',
    token_endpoint: origin + '/oauth/token',
    registration_endpoint: origin + '/oauth/register',
    revocation_endpoint: origin + '/oauth/revoke',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    scopes_supported: [scope],
  };
  function register(body) {
    const redirects = body?.redirect_uris;
    const method = body?.token_endpoint_auth_method ?? 'client_secret_basic';
    if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 16
      || !redirects.every(validGoogleRedirect)) return { error: 'invalid_redirect_uri' };
    for (const [key, supported, required] of [
      ['grant_types', metadata.grant_types_supported, 'authorization_code'],
      ['response_types', metadata.response_types_supported, 'code'],
    ]) {
      const list = body[key];
      if (list !== undefined && (!Array.isArray(list) || !list.includes(required) || !list.every(item => supported.includes(item)))) {
        return { error: 'invalid_client_metadata' };
      }
    }
    if (!metadata.token_endpoint_auth_methods_supported.includes(method)
      || (body.scope !== undefined && body.scope !== scope)) return { error: 'invalid_client_metadata' };
    if (registrations.size >= 128) return { error: 'temporarily_unavailable' };
    const client_id = token();
    const client_secret = method === 'none' ? undefined : token();
    registrations.set(client_id, { client_id, client_secret, redirects, method, expires: now() + 7 * 86400_000 });
    return { client_id, client_secret, client_id_issued_at: Math.floor(now() / 1000),
      ...(client_secret ? { client_secret_expires_at: Math.floor(registrations.get(client_id).expires / 1000) } : {}),
      redirect_uris: redirects, token_endpoint_auth_method: method,
      grant_types: metadata.grant_types_supported, response_types: ['code'], scope };
  }

  const getClient = id => manual.get(id) ?? registrations.get(id);
  const resourceMatches = value => value == null || value === resource;

  function authorize(params) {
    const id = params.get('client_id');
    const redirect = params.get('redirect_uri');
    const challenge = params.get('code_challenge');
    const state = params.get('state');
    const client = getClient(id);
    if (!client?.redirects.includes(redirect) || params.get('response_type') !== 'code'
      || params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge ?? '')
      || (state?.length ?? 0) > 1024 || !resourceMatches(params.get('resource'))
      || ![null, '', scope].includes(params.get('scope'))) return { error: 'invalid_request' };
    if (consents.size >= 64) return { error: 'temporarily_unavailable' };
    const key = token();
    consents.set(key, { id, redirect, challenge, state, expires: now() + 300_000 });
    return { key, callbackOrigin: new URL(redirect).origin };
  }

  function consent(key, cookie, password) {
    const request = consents.get(key);
    if (!request || !equal(key, cookie)) return { error: 'forbidden' };
    consents.delete(key);
    if (now() < cooldown) return { error: 'rate_limited' };
    if (!equal(adminPassword, password)) {
      if (++failures >= 5) { cooldown = now() + 60_000; failures = 0; }
      return { error: 'forbidden' };
    }
    failures = 0;
    if (grants.size >= 64) return { error: 'temporarily_unavailable' };
    const code = token();
    grants.set(code, { ...request, expires: now() + 60_000 });
    const callback = new URL(request.redirect);
    callback.searchParams.set('code', code);
    if (request.state !== null) callback.searchParams.set('state', request.state);
    return { location: callback.href };
  }

  function authenticateClient(params, authorization) {
    let id = params.get('client_id');
    let secret = params.get('client_secret');
    let method = secret == null ? 'none' : 'client_secret_post';
    if (authorization != null) {
      if (secret != null || !/^Basic [A-Za-z0-9+/]+=*$/i.test(authorization)) return null;
      try {
        const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        if (separator < 0) return null;
        const basicId = decodeURIComponent(decoded.slice(0, separator).replaceAll('+', ' '));
        if (id !== null && id !== basicId) return null;
        id = basicId;
        secret = decodeURIComponent(decoded.slice(separator + 1).replaceAll('+', ' '));
        method = 'client_secret_basic';
      } catch { return null; }
    }
    const client = getClient(id);
    return client && (client.method === method || (client.method === 'manual' && method !== 'none'))
      && (method === 'none' || equal(client.client_secret, secret)) ? client : null;
  }

  function issue(id, family) {
    const access_token = token();
    const refresh_token = token();
    access.set(access_token, { id, family, expires: now() + accessSeconds * 1000 });
    refresh.set(refresh_token, { id, family, expires: now() + 86400_000 });
    return { access_token, refresh_token, token_type: 'Bearer', expires_in: accessSeconds, scope };
  }

  function exchange(params, authorization) {
    const client = authenticateClient(params, authorization);
    if (!client) return { error: 'invalid_client' };
    if (!resourceMatches(params.get('resource'))) return { error: 'invalid_target' };
    if (access.size >= 256 || refresh.size >= 128) return { error: 'temporarily_unavailable' };
    const grant = params.get('grant_type');
    if (grant === 'authorization_code') {
      const key = params.get('code');
      const record = grants.get(key);
      const verifier = params.get('code_verifier');
      if (!record || record.id !== client.client_id || record.redirect !== params.get('redirect_uri')
        || !verifierPattern.test(verifier ?? '') || !equal(record.challenge, digest(verifier).toString('base64url'))) {
        return { error: 'invalid_grant' };
      }
      grants.delete(key);
      return issue(record.id, token());
    }
    if (grant === 'refresh_token') {
      const key = params.get('refresh_token');
      const record = refresh.get(key);
      if (!record || record.id !== client.client_id) return { error: 'invalid_grant' };
      if (![null, '', scope].includes(params.get('scope'))) return { error: 'invalid_scope' };
      refresh.delete(key);
      return issue(record.id, record.family);
    }
    return { error: 'unsupported_grant_type' };
  }

  function revoke(params, authorization) {
    const client = authenticateClient(params, authorization);
    if (!client) return { error: 'invalid_client' };
    const key = params.get('token');
    const record = access.get(key) ?? refresh.get(key);
    if (record?.id === client.client_id) {
      for (const store of [access, refresh]) {
        for (const [value, entry] of store) if (entry.family === record.family) store.delete(value);
      }
    }
    return {};
  }

  return { metadata, resource, sweep, register, authorize, consent, exchange, revoke,
    bearer: header => access.get(/^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header ?? '')?.[1]) };
}
