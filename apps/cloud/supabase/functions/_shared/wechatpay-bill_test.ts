import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { compareWechatBill, downloadWechatBill, parseWechatTradeBill, yuanToMinor, type BillRow, type LocalPayment, type LocalRefund } from "./wechatpay-bill.ts";
import type { WechatPayConfig } from "./wechatpay.ts";

const columns = "公众账号ID,商户号,微信订单号,商户订单号,交易状态,货币种类,订单金额,商户退款单号,微信退款单号,申请退款金额,商品名称";
const csv = `${columns}\n\`wx0123456789abcdef,\`1900000001,\`txn1,\`order1,\`SUCCESS,\`CNY,\`39.00,\`0,\`0,\`0,\`"Pro, 月付"\n总交易单数,订单总金额\n\`1,\`39.00\n`;
const config = { mchid: "1900000001", appid: "wx0123456789abcdef" };
const payment: LocalPayment = { order_id: "local-order1", mchid: config.mchid, appid: config.appid, out_trade_no: "order1", transaction_id: "txn1",
  payment_state: "SUCCESS", success_time: "2026-11-03T00:00:00+08:00", orders: { amount_minor: 3900, currency: "CNY", status: "paid" } };

Deno.test("bill decimal yuan conversion is exact, bounded and rejects ambiguous amounts", () => {
  assertEquals(yuanToMinor("0.29"), 29); assertEquals(yuanToMinor("1234.1"), 123410);
  for (const value of ["-1", "1.001", "1e5", "NaN", "", "9007199254740992"]) assertThrows(() => yuanToMinor(value));
});
Deno.test("ALL bill reads quoted fields, backticks and original order total", () => {
  const rows = parseWechatTradeBill(csv);
  assertEquals(rows.length, 1); assertEquals(rows[0].total, 3900); assertEquals(rows[0].outTradeNo, "order1");
  assertThrows(() => parseWechatTradeBill(csv.replace("订单金额", "应结订单金额")));
  assertThrows(() => parseWechatTradeBill(csv.replace("总交易单数,订单总金额\n`1,`39.00\n", "")));
  assertThrows(() => parseWechatTradeBill(csv.replace('"Pro, 月付"', "Pro, 月付")));
});
Deno.test("daily comparison catches delivered mismatch, unknown orders and missing local payments", () => {
  const rows = parseWechatTradeBill(csv);
  assertEquals(compareWechatBill(rows, [payment], [], "2026-11-03", config).differences, []);
  assert(compareWechatBill(rows, [{ ...payment, orders: { ...payment.orders, amount_minor: 3800 } }], [], "2026-11-03", config).differences.some(item => item.type === "payment_details_mismatch"));
  assert(compareWechatBill(rows, [{ ...payment, payment_state: "NOTPAY", orders: { ...payment.orders, status: "pending" } }], [], "2026-11-03", config).differences.some(item => item.type === "payment_not_delivered"));
  assertEquals(compareWechatBill(rows, [], [], "2026-11-03", config).differences[0].type, "unknown_bill_order");
  assertEquals(compareWechatBill([], [payment], [], "2026-11-03", config).differences[0].type, "local_payment_missing_from_bill");
  assertEquals(compareWechatBill(rows, [payment], [], "2026-11-02", config).differences, []);
  assertEquals(compareWechatBill([], [{ ...payment, success_time: null }], [], "2026-11-03", config).differences[0].type, "payment_time_missing");
});
Deno.test("refund bills are acceptance evidence, never a final refund status or entitlement instruction", () => {
  const row: BillRow = { ...parseWechatTradeBill(csv)[0], state: "REFUND", outRefundNo: "refund1", refundId: "wx-refund1", refund: 3900 };
  const refund: LocalRefund = { order_id: payment.order_id, out_refund_no: "refund1", refund_id: "wx-refund1", amount_minor: 3900, state: "processing", create_time: "2026-11-03T08:00:00+08:00" };
  const oldPayment = { ...payment, success_time: "2026-11-01T08:00:00+08:00" };
  assertEquals(compareWechatBill([row], [oldPayment], [refund], "2026-11-03", config).differences, []);
  assertEquals(refund.state, "processing");
  assertEquals(compareWechatBill([row], [oldPayment], [], "2026-11-03", config).differences[0].type, "external_or_unknown_refund");
  assertEquals(compareWechatBill([row], [oldPayment], [{ ...refund, amount_minor: 3000 }], "2026-11-03", config).differences[0].type, "refund_details_mismatch");
  assertEquals(compareWechatBill([], [oldPayment], [refund], "2026-11-03", config).differences[0].type, "local_refund_missing_from_bill");
  assertEquals(compareWechatBill([], [oldPayment], [{ ...refund, create_time: null }], "2026-11-03", config).differences[0].type, "refund_time_missing");
});
Deno.test("bill download is restricted, signed, checksum verified and never follows redirects", async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
  const full = { ...config, privateKey: pem, merchantSerial: "ABCDEF" } as WechatPayConfig;
  const bytes = new TextEncoder().encode(csv);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
  const manifest = { download_url: "https://api.mch.weixin.qq.com/v3/billdownload/file?token=test", hash_type: "SHA1", hash_value: hash };
  let calls = 0;
  const transport = ((url: RequestInfo | URL, init?: RequestInit) => {
    calls++; assertEquals(String(url), manifest.download_url); assertEquals(init?.redirect, "error");
    assert(String((init?.headers as Record<string, string>).Authorization).startsWith("WECHATPAY2-SHA256-RSA2048 "));
    return Promise.resolve(new Response(bytes));
  }) as typeof fetch;
  assertEquals(await downloadWechatBill(full, manifest, transport), csv);
  for (const invalid of [
    { ...manifest, download_url: "https://other.invalid/v3/billdownload/file" },
    { ...manifest, download_url: "https://api.mch.weixin.qq.com/other" },
    { ...manifest, hash_type: "MD5" },
  ]) await assertRejects(() => downloadWechatBill(full, invalid, transport));
  assertEquals(calls, 1);
  await assertRejects(() => downloadWechatBill(full, { ...manifest, hash_value: "0".repeat(40) }, transport));
});
