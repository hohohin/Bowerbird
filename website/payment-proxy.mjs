// This gateway transports bytes only. payment-webhook authenticates the WeChat
// signature, decrypts the resource and durably records it before acknowledging.
const ROUTES = new Set(["/api/pay/wechat/notify", "/api/pay/wechat/refund-notify"]);
const SIGNATURE_HEADERS = ["wechatpay-timestamp", "wechatpay-nonce", "wechatpay-signature", "wechatpay-serial", "wechatpay-signature-type"];
const MAX_BODY = 65_536;

function fail(status) { return Object.assign(new Error("Payment notification gateway failed"), { status }); }

async function readLimited(stream, maxBytes, signal) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    if (signal.aborted) throw fail(504);
    size += chunk.length;
    if (size > maxBytes) throw fail(413);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createPaymentProxy({ upstream = process.env.SUPABASE_URL, fetchImpl = fetch, timeoutMs = 4_000 } = {}) {
  return async (request, response) => {
    const controller = new AbortController();
    const stopUpload = () => { if (!request.readableEnded) request.destroy(); };
    let timer;
    try {
      if (!ROUTES.has(request.url)) throw fail(404);
      if (request.method !== "POST") throw fail(405);
      if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) throw fail(415);
      if (Number(request.headers["content-length"]) > MAX_BODY) throw fail(413);
      if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") throw fail(415);
      const base = new URL(upstream);
      if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw fail(503);
      const headers = { "Content-Type": "application/json" };
      for (const key of SIGNATURE_HEADERS) {
        const value = request.headers[key];
        if (typeof value === "string" && value.length <= 4_096 && value.trim()) headers[key] = value;
        else if (key !== "wechatpay-signature-type") throw fail(400);
      }
      // No user token, privileged API key, mock signature or caller-selected
      // destination is accepted here. Missing/invalid signatures never hit Mock.
      timer = setTimeout(() => controller.abort(), timeoutMs);
      controller.signal.addEventListener("abort", stopUpload, { once: true });
      const body = await readLimited(request, MAX_BODY, controller.signal);
      const target = new URL("/functions/v1/payment-webhook?forceFunctionRegion=ap-northeast-1", base);
      const result = await fetchImpl(target, { method: "POST", headers, body, redirect: "manual", signal: controller.signal });
      // Only the Edge function's completed acknowledgement counts as accepted.
      // Do not read/relay error bodies: these may contain internal diagnostics.
      await result.body?.cancel();
      if (result.status !== 200 && result.status !== 204) throw fail(result.status >= 400 && result.status < 500 ? result.status : 502);
      response.writeHead(204, { "Cache-Control": "no-store" });
      response.end();
    } catch (error) {
      if (response.destroyed) return;
      const status = controller.signal.aborted ? 504 : error.status || 502;
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ code: "FAIL", message: "通知未确认，请重试" }));
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", stopUpload);
      controller.abort();
    }
  };
}
