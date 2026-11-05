import { ApiError } from "./errors.ts";

// Project-maintained Web Crypto implementation based on official APIv3 rules and
// WXPayUtility (Java): https://pay.wechatpay.cn/doc/v3/merchant/4014931831
// This is not an official WeChat Pay SDK.
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const hosts = ["https://api.mch.weixin.qq.com", "https://api2.mch.weixin.qq.com"];
export interface WechatPayConfig {
  mchid: string; appid: string; merchantSerial: string; privateKey: string;
  apiV3Key: string; publicKeyId: string; publicKey: string; notifyUrl: string; refundNotifyUrl?: string;
}
export function wechatPayConfig(env = (name: string) => Deno.env.get(name)): WechatPayConfig {
  const get = (key: string) => {
    const value = env(`WECHAT_PAY_${key}`)?.trim();
    if (!value) throw new ApiError("not_configured", "微信支付尚未配置完成", false, 503);
    return value;
  };
  const config = { mchid: get("MCH_ID"), appid: get("APP_ID"), merchantSerial: get("MERCHANT_SERIAL_NO"),
    privateKey: get("PRIVATE_KEY").replace(/\\n/g, "\n"), apiV3Key: get("API_V3_KEY"),
    publicKeyId: get("PUBLIC_KEY_ID"), publicKey: get("PUBLIC_KEY").replace(/\\n/g, "\n"), notifyUrl: get("NOTIFY_URL"),
    refundNotifyUrl: env("WECHAT_PAY_REFUND_NOTIFY_URL")?.trim() || get("NOTIFY_URL") };
  let urls: URL[];
  try { urls = [new URL(config.notifyUrl), new URL(config.refundNotifyUrl)]; } catch { throw new ApiError("not_configured", "微信支付通知地址配置无效"); }
  if (!/^\d{6,32}$/.test(config.mchid) || !/^wx[A-Za-z0-9]{16}$/.test(config.appid)
    || !/^[A-Fa-f0-9]{1,64}$/.test(config.merchantSerial) || !/^PUB_KEY_ID_\d+$/.test(config.publicKeyId)
    || encoder.encode(config.apiV3Key).length !== 32 || urls.some(url => url.protocol !== "https:" || url.search || url.hash || url.username || url.password)) {
    throw new ApiError("not_configured", "微信支付配置无效");
  }
  return config;
}
export function wechatCheckoutEnabled(env = (name: string) => Deno.env.get(name)): boolean {
  if (env("BOWERBIRD_PAYMENT_MOCK") !== "false" || env("BOWERBIRD_WECHAT_PAY_ENABLED") !== "true") return false;
  try { wechatPayConfig(env); return true; } catch { return false; }
}
function bytes64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("invalid base64");
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
function pemBytes(pem: string, kind: "PRIVATE KEY" | "PUBLIC KEY") {
  const match = pem.trim().match(new RegExp(`^-----BEGIN ${kind}-----\\s+([A-Za-z0-9+/=\\s]+)-----END ${kind}-----$`));
  if (!match) throw new Error("invalid PEM");
  return bytes64(match[1].replace(/\s/g, ""));
}
async function rsaKey(pem: string, privateKey: boolean) {
  try {
    const key = privateKey
      ? await crypto.subtle.importKey("pkcs8", pemBytes(pem, "PRIVATE KEY"), algorithm, false, ["sign"])
      : await crypto.subtle.importKey("spki", pemBytes(pem, "PUBLIC KEY"), algorithm, false, ["verify"]);
    if ((key.algorithm as RsaKeyAlgorithm).modulusLength !== 2048) throw new Error();
    return key;
  } catch { throw new ApiError("not_configured", "微信支付证书配置无效"); }
}
export async function wechatAuthorization(config: WechatPayConfig, method: string, path: string, body: string,
  now = Date.now(), nonce = crypto.randomUUID().replaceAll("-", "")): Promise<string> {
  const timestamp = String(Math.floor(now / 1000));
  const signature = await crypto.subtle.sign(algorithm, await rsaKey(config.privateKey, true),
    encoder.encode(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`));
  return `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchid}",nonce_str="${nonce}",signature="${btoa(String.fromCharCode(...new Uint8Array(signature)))}",timestamp="${timestamp}",serial_no="${config.merchantSerial}"`;
}
export async function verifyWechatSignature(config: WechatPayConfig, headers: Headers, raw: string, now = Date.now()): Promise<void> {
  const timestamp = headers.get("wechatpay-timestamp") ?? "";
  const nonce = headers.get("wechatpay-nonce") ?? "";
  const signature = headers.get("wechatpay-signature") ?? "";
  const type = headers.get("wechatpay-signature-type");
  if (!/^\d{10,12}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) >= 300 || !nonce || nonce.length > 128
    || headers.get("wechatpay-serial") !== config.publicKeyId || (type && type !== "WECHATPAY2-SHA256-RSA2048")) {
    throw new ApiError("unauthorized", "微信支付签名验证失败", false, 401);
  }
  let valid = false;
  try { valid = await crypto.subtle.verify(algorithm, await rsaKey(config.publicKey, false), bytes64(signature), encoder.encode(`${timestamp}\n${nonce}\n${raw}\n`)); }
  catch { /* Fail closed, including SIGNTEST traffic and malformed signatures. */ }
  if (!valid) throw new ApiError("unauthorized", "微信支付签名验证失败", false, 401);
}
export function jsonObject(raw: string): Record<string, unknown> {
  try { const value = JSON.parse(raw); if (value && typeof value === "object" && !Array.isArray(value)) return value; } catch { /* fixed message */ }
  throw new ApiError("invalid_request", "支付报文格式无效");
}
export async function readPaymentBody(request: Request, limit = 65536): Promise<string> {
  if (Number(request.headers.get("content-length")) > limit) throw new ApiError("payload_too_large", "支付请求内容过大");
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length;
      if (size > limit) { await reader.cancel(); throw new ApiError("payload_too_large", "支付请求内容过大"); } chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return decoder.decode(bytes);
  } finally { reader.releaseLock(); }
}
export async function decryptWechatNotification(config: WechatPayConfig, headers: Headers, raw: string, now = Date.now()) {
  await verifyWechatSignature(config, headers, raw, now);
  const notice = jsonObject(raw);
  const resource = notice.resource as Record<string, unknown> | undefined;
  if (typeof notice.id !== "string" || !notice.id || notice.id.length > 128 || notice.resource_type !== "encrypt-resource"
    || !resource || resource.algorithm !== "AEAD_AES_256_GCM" || typeof resource.nonce !== "string"
    || typeof resource.ciphertext !== "string" || (resource.associated_data !== undefined && typeof resource.associated_data !== "string")) {
    throw new ApiError("invalid_request", "支付通知格式无效");
  }
  let data: Record<string, unknown>;
  try {
    const key = await crypto.subtle.importKey("raw", encoder.encode(config.apiV3Key), "AES-GCM", false, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: encoder.encode(resource.nonce), tagLength: 128,
      additionalData: encoder.encode((resource.associated_data as string | undefined) ?? "") }, key, bytes64(resource.ciphertext));
    data = jsonObject(decoder.decode(decrypted));
  } catch { throw new ApiError("invalid_request", "支付通知解密失败"); }
  return { id: notice.id, eventType: notice.event_type, originalType: resource.original_type, data };
}
export class WechatApiError extends ApiError {
  constructor(readonly upstreamCode: string, readonly upstreamStatus: number) {
    super("upstream_failed", "微信支付暂未确认结果，请稍后查看原订单", true);
  }
}
export class WechatPayClient {
  constructor(readonly config: WechatPayConfig, private transport: typeof fetch = fetch, private now = () => Date.now()) {}
  async request(method: "GET" | "POST", path: string, value?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!path.startsWith("/v3/") || path.includes("\n") || path.includes("#")) throw new Error("invalid API path");
    const body = value ? JSON.stringify(value) : "";
    // Reads may fail over immediately. Writes return unknown and are recovered by
    // querying the original order before a later retry with the same parameters.
    for (let attempt = 0; attempt < (method === "GET" ? 2 : 1); attempt++) {
      try {
        const response = await this.transport(`${hosts[attempt]}${path}`, { method, redirect: "error",
          signal: AbortSignal.timeout(8000), headers: { "Authorization": await wechatAuthorization(this.config, method, path, body, this.now()),
            "Wechatpay-Serial": this.config.publicKeyId,
            "Accept": "application/json", "Content-Type": "application/json", "User-Agent": "Bowerbird-WechatPay/1" },
          ...(body ? { body } : {}) });
        const raw = await readPaymentBody(new Request("https://response.invalid", { method: "POST", body: response.body }), 1024 * 1024);
        const upstreamId = (response.headers.get("request-id") ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128);
        console.log(JSON.stringify({ service: "wechatpay", request_id: upstreamId, http_status: response.status, method }));
        if (!response.ok) {
          if (method === "GET" && attempt === 0 && response.status >= 500) continue;
          // Official API errors need not be signed. They never establish a paid,
          // refunded or closed state; they can only trigger same-order recovery.
          let code = "HTTP_ERROR";
          try { const candidate = jsonObject(raw).code; if (typeof candidate === "string" && /^[A-Z0-9_]{1,64}$/.test(candidate)) code = candidate; } catch { /* no raw logging */ }
          throw new WechatApiError(code, response.status);
        }
        await verifyWechatSignature(this.config, response.headers, raw, this.now());
        return raw ? jsonObject(raw) : {};
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (method === "GET" && attempt === 0) continue;
        throw new ApiError("upstream_timeout", "支付结果正在确认，请稍后查看原订单", true);
      }
    }
    throw new ApiError("upstream_timeout", "支付结果正在确认，请稍后查看原订单", true);
  }
  query(outTradeNo: string) { return this.request("GET", `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(this.config.mchid)}`); }
  close(outTradeNo: string) { return this.request("POST", `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`, { mchid: this.config.mchid }); }
  native(body: Record<string, unknown>) { return this.request("POST", "/v3/pay/transactions/native", body); }
  refund(body: Record<string, unknown>) { return this.request("POST", "/v3/refund/domestic/refunds", body); }
  queryRefund(outRefundNo: string) { return this.request("GET", `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`); }
}
