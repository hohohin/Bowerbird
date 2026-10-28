import { isIP } from "node:net";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const PREFIX = "/api/cloud";
const PRIVATE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const JSON_LIMIT = 20 * 1024 * 1024;
const UPLOAD_LIMIT = 200 * 1024 * 1024;
const DOWNLOAD_LIMIT = 500 * 1024 * 1024;
const fail = status => Object.assign(new Error("Cloud gateway request failed"), { status });

async function readLimited(stream, limit) {
  const chunks = []; let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > limit) throw fail(502);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function readRequest(request, limit, signal) {
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0;
    const finish = (error) => {
      request.off("data", data); request.off("end", end); request.off("error", errorHandler);
      signal.removeEventListener("abort", abort);
      if (error) { request.pause(); reject(error); } else resolve(Buffer.concat(chunks));
    };
    const data = chunk => { bytes += chunk.length; if (bytes > limit) finish(fail(413)); else chunks.push(chunk); };
    const end = () => finish();
    const errorHandler = () => finish(fail(400));
    const abort = () => finish(fail(504));
    request.on("data", data); request.once("end", end); request.once("error", errorHandler);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

// Exact routes on one configured upstream. Signed storage tokens remain the
// authority for transfers; user Bearer remains the authority for generation.
// No service key, retries, redirects, payload logging or persistent file cache.
export function createCloudProxy({
  upstream = process.env.SUPABASE_URL,
  publicKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY,
  trustProxy = process.env.BOWERBIRD_TRUST_PROXY === "1",
  fetchImpl = fetch, timeoutMs = 180_000,
} = {}) {
  const buckets = new Map(); let active = 0; let sweptAt = 0;
  return async (request, response) => {
    const controller = new AbortController();
    let timer, admitted = false;
    const disconnected = () => { if (!response.writableEnded) controller.abort(); };
    request.on("aborted", disconnected); response.on("close", disconnected);
    try {
      const rawPath = request.url.split("?", 1)[0];
      if (!rawPath.startsWith(`${PREFIX}/`) || request.url.length > 8192) throw fail(404);
      const path = rawPath.slice(PREFIX.length);
      const control = request.method === "POST" && path === "/functions/v1/generate-proxy";
      const upload = request.method === "PUT" && /^\/storage\/v1\/object\/upload\/sign\/generation-temp\/jobs\/[a-f0-9-]{36}\/inputs\/video-\d+\.(mp4|mov)$/.test(path);
      const download = request.method === "GET" && /^\/storage\/v1\/object\/sign\/generation-temp\/jobs\/[a-f0-9-]{36}\/outputs\/result\.(png|jpg|webp|mp4|json)$/.test(path);
      if (!control && !upload && !download) throw fail(404);
      const url = new URL(request.url, "http://localhost");
      for (const key of url.searchParams.keys()) {
        if (!(control ? ["forceFunctionRegion"] : ["token"]).includes(key) || url.searchParams.getAll(key).length !== 1) throw fail(400);
      }
      if (!control && !url.searchParams.get("token")) throw fail(401);
      const headers = {};
      if (control) {
        const bearer = request.headers.authorization;
        if (typeof bearer !== "string" || !/^Bearer [^\s]{1,8192}$/.test(bearer)) throw fail(401);
        headers.Authorization = bearer; headers.apikey = publicKey;
      }
      const now = Date.now();
      if (now - sweptAt > 60_000) {
        for (const [key, bucket] of buckets) if (bucket.until <= now) buckets.delete(key);
        sweptAt = now;
      }
      const peer = request.socket.remoteAddress, realIp = request.headers["x-real-ip"];
      const ip = trustProxy && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer) && typeof realIp === "string" && isIP(realIp) ? realIp : peer;
      let bucket = buckets.get(ip);
      if (!bucket || bucket.until <= now) {
        if (!bucket && buckets.size >= 10_000) throw fail(429);
        bucket = { count: 0, until: now + 60_000 }; buckets.set(ip, bucket);
      }
      if (++bucket.count > 300 || active >= 8) throw fail(429);
      active++; admitted = true;
      const base = new URL(upstream);
      if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash || !publicKey) throw fail(503);
      const target = new URL(path, base); target.search = url.search;
      if (control) target.searchParams.set("forceFunctionRegion", "ap-northeast-1");
      timer = setTimeout(() => controller.abort(), timeoutMs);
      let body;
      if (control) {
        if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) throw fail(415);
        if (Number(request.headers["content-length"]) > JSON_LIMIT) throw fail(413);
        body = await readRequest(request, JSON_LIMIT, controller.signal);
        let parsed;
        try { parsed = JSON.parse(body.toString("utf8")); } catch { throw fail(400); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw fail(400);
        headers["Content-Type"] = "application/json";
      } else if (upload) {
        const mime = request.headers["content-type"];
        if (!["video/mp4", "video/quicktime"].includes(mime)) throw fail(415);
        const length = Number(request.headers["content-length"]);
        if (!Number.isSafeInteger(length) || length <= 0 || length > UPLOAD_LIMIT) throw fail(413);
        headers["Content-Type"] = mime; headers["Content-Length"] = String(length);
        body = (async function* () {
          let bytes = 0;
          for await (const chunk of request) {
            bytes += chunk.length; if (bytes > length) throw fail(413);
            yield chunk;
          }
          if (bytes !== length) throw fail(400);
        })();
      }
      const result = await fetchImpl(target, { method: request.method, headers, body,
        ...(upload ? { duplex: "half" } : {}), redirect: "manual", signal: controller.signal });
      if (result.status >= 300 && result.status < 400) { await result.body?.cancel(); throw fail(502); }
      if (download && result.ok) {
        const mime = result.headers.get("content-type")?.split(";", 1)[0];
        if (!["image/png", "image/jpeg", "image/webp", "video/mp4", "application/json", "application/octet-stream"].includes(mime) || !result.body) { await result.body?.cancel(); throw fail(502); }
        const length = result.headers.get("content-length");
        if (length && (!/^\d+$/.test(length) || Number(length) > DOWNLOAD_LIMIT)) { await result.body.cancel(); throw fail(502); }
        response.writeHead(result.status, { ...PRIVATE, "Content-Type": mime, ...(length ? { "Content-Length": length } : {}) });
        let bytes = 0;
        await pipeline(Readable.fromWeb(result.body), new Transform({ transform(chunk, _, done) {
          bytes += chunk.length; done(bytes > DOWNLOAD_LIMIT ? fail(502) : null, chunk);
        } }), response, { signal: controller.signal });
      } else {
        if (!/^application\/json(?:;|$)/i.test(result.headers.get("content-type") || "")) { await result.body?.cancel(); throw fail(502); }
        const payload = result.body ? await readLimited(result.body, 1_048_576) : Buffer.alloc(0);
        try { JSON.parse(payload.toString("utf8")); } catch { throw fail(502); }
        const retry = result.headers.get("retry-after");
        response.writeHead(result.status, { ...PRIVATE, "Content-Type": "application/json; charset=utf-8", "Content-Length": payload.length,
          ...(retry && /^\d{1,6}$/.test(retry) ? { "Retry-After": retry } : {}) });
        response.end(payload);
      }
    } catch (error) {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      const status = controller.signal.aborted ? 504 : Number(error.status) || 502;
      response.writeHead(status, { ...PRIVATE, "Connection": "close", "Content-Type": "application/json; charset=utf-8", ...(status === 429 ? { "Retry-After": "60" } : {}) });
      response.end(JSON.stringify({ error: { code: `cloud_gateway_${status}`, message: status === 401 ? "请先登录或重新获取原任务文件链接" : status === 413 ? "请求内容超过大小限制，请减少参考素材" : "云服务连接暂时中断，请稍后查看原任务状态，勿重复提交" } }));
    } finally {
      clearTimeout(timer); controller.abort(); if (admitted) active--;
      request.off("aborted", disconnected); response.off("close", disconnected);
    }
  };
}
