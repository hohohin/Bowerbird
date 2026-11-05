import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { decryptWechatNotification, readPaymentBody, verifyWechatSignature, wechatAuthorization, WechatApiError, WechatPayClient, type WechatPayConfig } from "./wechatpay.ts";

const enc = new TextEncoder();
const alg = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
const pair = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
const base64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const config: WechatPayConfig = { mchid: "1900000001", appid: "wx1234567890abcdef", merchantSerial: "AABBCCDD",
  privateKey: `-----BEGIN PRIVATE KEY-----\n${base64(await crypto.subtle.exportKey("pkcs8", pair.privateKey))}\n-----END PRIVATE KEY-----`,
  publicKey: `-----BEGIN PUBLIC KEY-----\n${base64(await crypto.subtle.exportKey("spki", pair.publicKey))}\n-----END PUBLIC KEY-----`,
  publicKeyId: "PUB_KEY_ID_1234", apiV3Key: "12345678901234567890123456789012", notifyUrl: "https://example.invalid/pay/notify" };
const now = 1800000000000;
async function signed(raw: string, timestamp = String(now / 1000)) {
  return new Headers({ "Wechatpay-Timestamp": timestamp, "Wechatpay-Nonce": "fixture-nonce", "Wechatpay-Serial": config.publicKeyId,
    "Wechatpay-Signature": base64(await crypto.subtle.sign(alg, pair.privateKey, enc.encode(`${timestamp}\nfixture-nonce\n${raw}\n`))) });
}
Deno.test("request signature covers exact method, query and original UTF-8 body", async () => {
  const raw = '{"description":"测试商品","amount":{"total":500}}';
  const path = "/v3/pay/transactions/native?fixture=a%20b";
  const auth = await wechatAuthorization(config, "POST", path, raw, now, "fixed-nonce");
  const signature = Uint8Array.from(atob(auth.match(/signature="([^"]+)"/)![1]), (c) => c.charCodeAt(0));
  assert(await crypto.subtle.verify(alg, pair.publicKey, signature, enc.encode(`POST\n${path}\n1800000000\nfixed-nonce\n${raw}\n`)));
  assertEquals(await crypto.subtle.verify(alg, pair.publicKey, signature, enc.encode(`POST\n${path}\n1800000000\nfixed-nonce\n${raw}`)), false);
  assert(auth.includes('serial_no="AABBCCDD"'));
});
Deno.test("signed response and empty 204 validate; whitespace tampering fails", async () => {
  for (const raw of ['{"code_url":"weixin://wxpay/test"}', ""]) await verifyWechatSignature(config, await signed(raw), raw, now);
  await assertRejects(() => verifyWechatSignature(config, new Headers(), "", now));
  const raw = '{"ok":true}';
  await assertRejects(async () => verifyWechatSignature(config, await signed(raw), `${raw} `, now));
});
Deno.test("unknown public key, algorithm, timestamp and SIGNTEST all fail closed", async () => {
  for (const [key, value] of [["Wechatpay-Serial", "PUB_KEY_ID_other"], ["Wechatpay-Signature-Type", "unknown"], ["Wechatpay-Signature", "WECHATPAY/SIGNTEST/probe"], ["Wechatpay-Timestamp", "not-a-number"]]) {
    const headers = await signed("{}"); headers.set(key, value);
    await assertRejects(() => verifyWechatSignature(config, headers, "{}", now));
  }
  await assertRejects(async () => verifyWechatSignature(config, await signed("{}", String(now / 1000 - 300)), "{}", now));
  await assertRejects(async () => verifyWechatSignature(config, await signed("{}", String(now / 1000 + 300)), "{}", now));
});
Deno.test("notification decrypts AES-GCM with empty optional associated data; tamper fails", async () => {
  const key = await crypto.subtle.importKey("raw", enc.encode(config.apiV3Key), "AES-GCM", false, ["encrypt"]);
  const ciphertext = base64(await crypto.subtle.encrypt({ name: "AES-GCM", iv: enc.encode("fixture12345"), additionalData: new Uint8Array(), tagLength: 128 }, key, enc.encode('{"trade_state":"SUCCESS","amount":{"total":500}}')));
  const value = { id: "notice-1", event_type: "TRANSACTION.SUCCESS", resource_type: "encrypt-resource", resource: { algorithm: "AEAD_AES_256_GCM", nonce: "fixture12345", original_type: "transaction", ciphertext } };
  const raw = JSON.stringify(value);
  assertEquals((await decryptWechatNotification(config, await signed(raw), raw, now)).data.trade_state, "SUCCESS");
  value.resource.ciphertext = `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;
  const broken = JSON.stringify(value);
  await assertRejects(async () => decryptWechatNotification(config, await signed(broken), broken, now));
});
Deno.test("body limit applies even without Content-Length", async () => {
  await assertRejects(() => readPaymentBody(new Request("https://example.invalid", { method: "POST", body: "123456" }), 5));
});
Deno.test("GET transport outage fails over to official backup with same query", async () => {
  const urls: string[] = [];
  const transport = (async (input: string | URL | Request) => { urls.push(String(input)); if (urls.length === 1) throw new TypeError("offline"); const raw = '{"trade_state":"NOTPAY"}'; return new Response(raw, { headers: await signed(raw) }); }) as typeof fetch;
  const client = new WechatPayClient(config, transport, () => now);
  assertEquals((await client.query("abc123")).trade_state, "NOTPAY");
  assertEquals(urls, ["https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/abc123?mchid=1900000001", "https://api2.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/abc123?mchid=1900000001"]);
});
Deno.test("POST uncertain result is never automatically resubmitted", async () => {
  let count = 0;
  const client = new WechatPayClient(config, (async () => { count++; throw new TypeError("offline"); }) as typeof fetch, () => now);
  await assertRejects(() => client.native({ out_trade_no: "fixed" })); assertEquals(count, 1);
});
Deno.test("all API calls explicitly request public-key response signing", async () => {
  const headers: Headers[] = [];
  const client = new WechatPayClient(config, (async (_input: string | URL | Request, init?: RequestInit) => {
    headers.push(new Headers(init?.headers)); const raw = "{}";
    return new Response(raw, { headers: await signed(raw) });
  }) as typeof fetch, () => now);
  await client.query("fixed"); await client.native({ out_trade_no: "fixed" });
  assertEquals(headers.map(value => value.get("Wechatpay-Serial")), [config.publicKeyId, config.publicKeyId]);
});
Deno.test("invalid signed 2xx response cannot return business data or trigger failover", async () => {
  let count = 0;
  const client = new WechatPayClient(config, (async () => { count++; return new Response('{"trade_state":"SUCCESS"}'); }) as typeof fetch, () => now);
  await assertRejects(() => client.query("fixed")); assertEquals(count, 1);
});
Deno.test("unsigned API errors are errors only, with sanitized code and no provider message", async () => {
  const client = new WechatPayClient(config, (async () => new Response('{"code":"ORDER_NOT_EXIST","message":"secret detail"}', { status: 404 })) as typeof fetch, () => now);
  const error = await assertRejects(() => client.query("fixed"), WechatApiError);
  assertEquals(error.upstreamCode, "ORDER_NOT_EXIST"); assertEquals(error.message.includes("secret detail"), false);
});
