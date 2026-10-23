import { isIP } from "node:net";

const PREFIX = "/api/account";
const REGION = "ap-northeast-1";
const ROUTES = new Map([
  ["GET /functions/v1/wechat-login", ["state", "forceFunctionRegion"]],
  ["POST /functions/v1/wechat-login", ["forceFunctionRegion"]],
  ["GET /functions/v1/entitlement", ["forceFunctionRegion"]],
  ["POST /functions/v1/redeem-code", ["forceFunctionRegion"]],
  ["POST /functions/v1/comfy-download", ["forceFunctionRegion"]],
  ["POST /auth/v1/otp", ["redirect_to"]],
  ["POST /auth/v1/token", ["grant_type"]],
  ["GET /auth/v1/verify", ["token", "type", "redirect_to"]],
]);
const PRIVATE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function fail(status) {
  return Object.assign(new Error("Account gateway request failed"), { status });
}

function allowedCallback(value) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && (
      (url.protocol === "bowerbird:" && url.hostname === "auth" && !url.port && url.pathname === "/callback")
      || url.origin === "https://bowerbird.cn"
      // Existing Supabase Site URL; retained for development email links only.
      || url.origin === "http://localhost:3000"
    );
  } catch { return false; }
}

async function readLimited(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw fail(413);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Fixed upstream + exact route/method allowlist. No privileged key, cookie,
// automatic retry, upstream redirect following, or request/token logging.
export function createAccountProxy({
  upstream = process.env.SUPABASE_URL,
  publicKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY,
  trustProxy = process.env.BOWERBIRD_TRUST_PROXY === "1",
  fetchImpl = fetch,
  timeoutMs = 20_000,
} = {}) {
  const buckets = new Map();
  let sweptAt = 0;
  return async (request, response) => {
    let timer;
    const controller = new AbortController();
    try {
      const rawPath = request.url.split("?", 1)[0];
      const path = rawPath.slice(PREFIX.length);
      const allowed = rawPath.startsWith(`${PREFIX}/`) && ROUTES.get(`${request.method} ${path}`);
      if (!allowed || request.url.length > 8192) throw fail(404);
      const url = new URL(request.url, "http://localhost");
      for (const key of url.searchParams.keys()) {
        if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw fail(400);
      }
      if (path === "/auth/v1/token" && !["pkce", "refresh_token"].includes(url.searchParams.get("grant_type"))) throw fail(400);
      if (url.searchParams.has("redirect_to") && !allowedCallback(url.searchParams.get("redirect_to"))) throw fail(400);
      if (path === "/auth/v1/verify" && (!url.searchParams.get("token") || !["signup", "magiclink"].includes(url.searchParams.get("type")))) throw fail(400);

      const now = Date.now();
      if (now - sweptAt > 60_000) {
        for (const [key, bucket] of buckets) if (bucket.until <= now) buckets.delete(key);
        sweptAt = now;
      }
      const peer = request.socket.remoteAddress;
      const realIp = request.headers["x-real-ip"];
      const ip = trustProxy && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer) && typeof realIp === "string" && isIP(realIp) ? realIp : peer;
      const otp = path === "/auth/v1/otp";
      const key = `${ip}:${otp ? "email" : "account"}`;
      let bucket = buckets.get(key);
      if (!bucket || bucket.until <= now) {
        if (!bucket && buckets.size >= 10_000) throw fail(429);
        bucket = { count: 0, until: now + (otp ? 600_000 : 60_000) };
        buckets.set(key, bucket);
      }
      if (++bucket.count > (otp ? 5 : 120)) throw fail(429);

      const base = new URL(upstream);
      if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash || !publicKey) throw fail(503);
      const target = new URL(path, base);
      target.search = url.search;
      if (path.startsWith("/functions/")) target.searchParams.set("forceFunctionRegion", REGION);
      const headers = { apikey: publicKey, "Content-Type": "application/json" };
      if (["/functions/v1/entitlement", "/functions/v1/redeem-code", "/functions/v1/comfy-download"].includes(path)) {
        const bearer = request.headers.authorization;
        if (typeof bearer !== "string" || !/^Bearer [^\s]{1,8192}$/.test(bearer)) throw fail(401);
        headers.Authorization = bearer;
      }
      let body;
      if (request.method === "POST") {
        if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) throw fail(415);
        if (Number(request.headers["content-length"]) > 65_536) throw fail(413);
        body = await readLimited(request, 65_536);
        let parsed;
        try { parsed = JSON.parse(body.toString("utf8")); } catch { throw fail(400); }
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw fail(400);
        if (otp && (typeof parsed.email !== "string" || parsed.phone)) throw fail(400);
      }
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const result = await fetchImpl(target, { method: request.method, headers, body, redirect: "manual", signal: controller.signal });
      if (result.status >= 300 && result.status < 400) {
        const location = result.headers.get("location");
        await result.body?.cancel();
        if (path !== "/auth/v1/verify" || !allowedCallback(location)) throw fail(502);
        response.writeHead(result.status, { ...PRIVATE_HEADERS, Location: location });
        return response.end();
      }
      if (path === "/auth/v1/verify" || result.status >= 500) {
        await result.body?.cancel();
        throw fail(502);
      }
      let payload;
      try { payload = result.body ? await readLimited(result.body, 1_048_576) : Buffer.alloc(0); }
      catch (error) { throw error.status === 413 ? fail(502) : error; }
      if (payload.length && !/^application\/json(?:;|$)/i.test(result.headers.get("content-type") || "")) throw fail(502);
      const outgoing = { ...PRIVATE_HEADERS, "Content-Type": "application/json; charset=utf-8", "Content-Length": payload.length };
      const retry = result.headers.get("retry-after");
      if (retry && /^\d{1,6}$/.test(retry)) outgoing["Retry-After"] = retry;
      response.writeHead(result.status, outgoing);
      response.end(payload);
    } catch (error) {
      const status = controller.signal.aborted ? 504 : Number(error.status) || 502;
      const payload = JSON.stringify({ error: { code: `account_gateway_${status}`, message: status === 429 ? "操作过于频繁，请稍后重试" : status === 401 ? "请先登录" : "账号服务暂时不可用，请稍后重试" } });
      response.writeHead(status, { ...PRIVATE_HEADERS, "Content-Type": "application/json; charset=utf-8", ...(status === 429 ? { "Retry-After": "60" } : {}) });
      response.end(payload);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}
