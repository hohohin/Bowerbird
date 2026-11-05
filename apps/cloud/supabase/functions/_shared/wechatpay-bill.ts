import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ApiError } from "./errors.ts";
import { WechatPayClient, wechatAuthorization, type WechatPayConfig } from "./wechatpay.ts";

// Official ALL bill fields/decimal yuan and download checksum contract:
// https://pay.wechatpay.cn/doc/v3/merchant/4013071246
// https://pay.wechatpay.cn/doc/v3/merchant/4013071238
export interface BillRow {
  mchid: string; appid: string; outTradeNo: string; transactionId: string;
  state: string; currency: string; total: number; outRefundNo: string; refundId: string; refund: number;
}
export function yuanToMinor(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error("invalid bill amount");
  const [whole, decimals = ""] = value.split(".");
  const result = BigInt(whole) * 100n + BigInt(decimals.padEnd(2, "0"));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("bill amount overflow");
  return Number(result);
}

export function parseWechatTradeBill(text: string): BillRow[] {
  const records: string[][] = []; let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else if (quoted || field === "" || field === "`") quoted = !quoted;
      else field += char;
    } else if (!quoted && (char === "," || char === "\n")) {
      row.push(field.replace(/\r$/, "").replace(/^`/, "")); field = "";
      if (char === "\n") { records.push(row); row = []; }
    } else field += char;
  }
  if (quoted) throw new Error("unterminated bill field");
  if (field || row.length) { row.push(field.replace(/\r$/, "").replace(/^`/, "")); records.push(row); }
  const header = records.shift()?.map(value => value.replace(/^\uFEFF/, ""));
  const required = ["公众账号ID", "商户号", "微信订单号", "商户订单号", "交易状态", "货币种类", "订单金额", "商户退款单号", "微信退款单号", "申请退款金额"];
  if (!header || required.some(name => header.filter(value => value === name).length !== 1)) throw new Error("unsupported bill columns");
  const result: BillRow[] = [];
  let summary = false;
  for (const cells of records) {
    if (cells.length === 1 && !cells[0]) continue;
    if (cells[0] === "总交易单数") { summary = true; break; }
    if (cells.length !== header.length) throw new Error("ambiguous bill row");
    const get = (name: string) => cells[header.indexOf(name)];
    const state = get("交易状态");
    if (!["SUCCESS", "REFUND", "REVOKED"].includes(state)) throw new Error("unknown bill state");
    result.push({ mchid: get("商户号"), appid: get("公众账号ID"), outTradeNo: get("商户订单号"), transactionId: get("微信订单号"),
      state, currency: get("货币种类"), total: yuanToMinor(get("订单金额")), outRefundNo: get("商户退款单号"), refundId: get("微信退款单号"),
      refund: state === "SUCCESS" ? 0 : yuanToMinor(get("申请退款金额")) });
  }
  if (!summary) throw new Error("missing bill summary");
  return result;
}

export interface LocalPayment { order_id: string; mchid: string; appid: string; out_trade_no: string; transaction_id: string | null;
  payment_state: string; success_time: string | null; orders: { amount_minor: number; currency: string; status: string } }
export interface LocalRefund { order_id: string; out_refund_no: string; refund_id: string | null; amount_minor: number; state: string; create_time: string | null }
export interface BillDifference { type: string; out_trade_no?: string; out_refund_no?: string; order_id?: string }
const chinaDay = (time: string | null) => time ? new Date(Date.parse(time) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) : null;

export function compareWechatBill(rows: BillRow[], payments: LocalPayment[], refunds: LocalRefund[], date: string, config: Pick<WechatPayConfig, "mchid" | "appid">) {
  const differences: BillDifference[] = [], seenPayments = new Set<string>(), seenRefunds = new Set<string>();
  const byOrder = new Map(payments.map(row => [row.out_trade_no, row]));
  const byRefund = new Map(refunds.map(row => [row.out_refund_no, row]));
  let paymentCount = 0, refundCount = 0;
  for (const row of rows) {
    // One merchant may serve other apps. Its other apps do not belong to this ledger.
    if (row.mchid !== config.mchid) { differences.push({ type: "merchant_mismatch" }); continue; }
    if (row.appid !== config.appid) continue;
    const local = byOrder.get(row.outTradeNo);
    const issue = (type: string) => differences.push({ type, out_trade_no: row.outTradeNo, ...(local ? { order_id: local.order_id } : {}) });
    if (!local) { issue("unknown_bill_order"); continue; }
    if (local.mchid !== row.mchid || local.appid !== row.appid || local.transaction_id !== row.transactionId
      || local.orders.amount_minor !== row.total || row.currency !== "CNY" || local.orders.currency !== row.currency) issue("payment_details_mismatch");
    if (row.state === "SUCCESS") {
      paymentCount++;
      if (seenPayments.has(row.outTradeNo)) issue("duplicate_bill_payment");
      seenPayments.add(row.outTradeNo);
      if (local.payment_state !== "SUCCESS" || !["paid", "refunded"].includes(local.orders.status)) issue("payment_not_delivered");
    } else if (row.state === "REFUND") {
      refundCount++;
      const refund = byRefund.get(row.outRefundNo);
      if (seenRefunds.has(row.outRefundNo)) issue("duplicate_bill_refund");
      seenRefunds.add(row.outRefundNo);
      if (!refund) issue("external_or_unknown_refund");
      else if (refund.order_id !== local.order_id || refund.refund_id !== row.refundId || refund.amount_minor !== row.refund) issue("refund_details_mismatch");
      // Bills record refund acceptance, not its latest final state. Never finalize
      // money/entitlements from this row; the verified refund query does that.
    } else issue("unexpected_revoked_payment");
  }
  for (const payment of payments) if (payment.mchid === config.mchid && payment.appid === config.appid && payment.payment_state === "SUCCESS") {
    if (!payment.success_time) differences.push({ type: "payment_time_missing", order_id: payment.order_id, out_trade_no: payment.out_trade_no });
    else if (chinaDay(payment.success_time) === date && !seenPayments.has(payment.out_trade_no)) differences.push({ type: "local_payment_missing_from_bill", order_id: payment.order_id, out_trade_no: payment.out_trade_no });
  }
  for (const refund of refunds) if (refund.refund_id) {
    if (!refund.create_time) differences.push({ type: "refund_time_missing", order_id: refund.order_id, out_refund_no: refund.out_refund_no });
    else if (chinaDay(refund.create_time) === date && !seenRefunds.has(refund.out_refund_no)) differences.push({ type: "local_refund_missing_from_bill", order_id: refund.order_id, out_refund_no: refund.out_refund_no });
  }
  return { payment_count: paymentCount, refund_count: refundCount, differences };
}

export async function downloadWechatBill(config: WechatPayConfig, manifest: Record<string, unknown>, transport: typeof fetch = fetch): Promise<string> {
  const url = new URL(String(manifest.download_url));
  if (url.protocol !== "https:" || !["api.mch.weixin.qq.com", "api2.mch.weixin.qq.com"].includes(url.hostname) || url.port || url.username || url.password
    || url.pathname !== "/v3/billdownload/file" || url.hash || manifest.hash_type !== "SHA1" || !/^[a-fA-F0-9]{40}$/.test(String(manifest.hash_value))) {
    throw new ApiError("upstream_failed", "微信账单下载信息无效");
  }
  const response = await transport(url, { redirect: "error", signal: AbortSignal.timeout(20_000), headers: {
    Authorization: await wechatAuthorization(config, "GET", `${url.pathname}${url.search}`, ""),
    "Wechatpay-Serial": config.publicKeyId,
  } });
  if (!response.ok || !response.body) throw new ApiError("upstream_failed", "微信账单下载失败");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length;
      if (size > 32 * 1024 * 1024) { await reader.cancel(); throw new ApiError("payload_too_large", "微信账单超出处理大小"); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
  if (hash !== String(manifest.hash_value).toLowerCase()) throw new ApiError("upstream_failed", "微信账单完整性校验失败");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function reconcileWechatBill(admin: SupabaseClient, config: WechatPayConfig, billDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(billDate) || !Number.isFinite(Date.parse(`${billDate}T00:00:00+08:00`))
    || chinaDay(`${billDate}T00:00:00+08:00`) !== billDate || billDate >= chinaDay(new Date().toISOString())!) throw new ApiError("invalid_request", "账单日期必须是有效的历史日期");
  const manifest = await new WechatPayClient(config).request("GET", `/v3/bill/tradebill?bill_date=${billDate}&bill_type=ALL`);
  const rows = parseWechatTradeBill(await downloadWechatBill(config, manifest));
  const relevant = rows.filter(row => row.mchid === config.mchid && row.appid === config.appid);
  const start = new Date(`${billDate}T00:00:00+08:00`).toISOString(), end = new Date(Date.parse(start) + 86_400_000).toISOString();
  const paymentSelect = "order_id,mchid,appid,out_trade_no,transaction_id,payment_state,success_time,orders!inner(amount_minor,currency,status)";
  const refundSelect = "order_id,out_refund_no,refund_id,amount_minor,state,create_time,wechatpay_payments!inner(mchid,appid)";
  const payments = new Map<string, LocalPayment>(), refunds = new Map<string, LocalRefund>();
  // Paginate daily records; do not silently accept PostgREST's 1000-row truncation.
  for (let offset = 0;; offset += 500) {
    const { data, error } = await admin.from("wechatpay_payments").select(paymentSelect).eq("mchid", config.mchid).eq("appid", config.appid)
      .gte("success_time", start).lt("success_time", end).order("order_id").range(offset, offset + 499);
    if (error) throw new ApiError("internal_error", "本地支付账单读取失败", true);
    for (const row of (data ?? []) as unknown as LocalPayment[]) payments.set(row.out_trade_no, row);
    if ((data ?? []).length < 500) break;
  }
  for (let offset = 0;; offset += 500) {
    const { data, error } = await admin.from("wechatpay_refunds").select(refundSelect).eq("wechatpay_payments.mchid", config.mchid).eq("wechatpay_payments.appid", config.appid)
      .gte("create_time", start).lt("create_time", end).order("id").range(offset, offset + 499);
    if (error) throw new ApiError("internal_error", "本地退款账单读取失败", true);
    for (const row of (data ?? []) as unknown as LocalRefund[]) refunds.set(row.out_refund_no, row);
    if ((data ?? []).length < 500) break;
  }
  // A missing official time must remain visible even when the bill also omits
  // the record. Otherwise neither query would load it and falsely report matched.
  for (let offset = 0;; offset += 500) {
    const { data, error } = await admin.from("wechatpay_payments").select(paymentSelect).eq("mchid", config.mchid).eq("appid", config.appid)
      .eq("payment_state", "SUCCESS").is("success_time", null).order("order_id").range(offset, offset + 499);
    if (error) throw new ApiError("internal_error", "待核对支付记录读取失败", true);
    for (const row of (data ?? []) as unknown as LocalPayment[]) payments.set(row.out_trade_no, row);
    if ((data ?? []).length < 500) break;
  }
  for (let offset = 0;; offset += 500) {
    const { data, error } = await admin.from("wechatpay_refunds").select(refundSelect).eq("wechatpay_payments.mchid", config.mchid).eq("wechatpay_payments.appid", config.appid)
      .not("refund_id", "is", null).is("create_time", null).order("id").range(offset, offset + 499);
    if (error) throw new ApiError("internal_error", "待核对退款记录读取失败", true);
    for (const row of (data ?? []) as unknown as LocalRefund[]) refunds.set(row.out_refund_no, row);
    if ((data ?? []).length < 500) break;
  }
  const orderIds = [...new Set(relevant.map(row => row.outTradeNo))];
  const refundIds = [...new Set(relevant.filter(row => row.state === "REFUND").map(row => row.outRefundNo))];
  for (const ids of [orderIds, refundIds]) if (ids.some(id => !/^[a-zA-Z0-9_-]{1,64}$/.test(id))) throw new ApiError("upstream_failed", "微信账单订单标识无效");
  for (let i = 0; i < orderIds.length; i += 100) {
    const { data, error } = await admin.from("wechatpay_payments").select(paymentSelect).in("out_trade_no", orderIds.slice(i, i + 100));
    if (error) throw new ApiError("internal_error", "本地支付账单读取失败", true);
    for (const row of (data ?? []) as unknown as LocalPayment[]) payments.set(row.out_trade_no, row);
  }
  for (let i = 0; i < refundIds.length; i += 100) {
    const { data, error } = await admin.from("wechatpay_refunds").select(refundSelect).in("out_refund_no", refundIds.slice(i, i + 100));
    if (error) throw new ApiError("internal_error", "本地退款账单读取失败", true);
    for (const row of (data ?? []) as unknown as LocalRefund[]) refunds.set(row.out_refund_no, row);
  }
  const report = compareWechatBill(rows, [...payments.values()], [...refunds.values()], billDate, config);
  const status = report.differences.length ? "differences" : "matched";
  const { error } = await admin.from("wechatpay_bill_audits").upsert({ bill_date: billDate, mchid: config.mchid, appid: config.appid,
    hash_value: manifest.hash_value, status, report, checked_at: new Date().toISOString() });
  if (error) throw new ApiError("internal_error", "账单核对记录保存失败", true);
  return { bill_date: billDate, status, payment_count: report.payment_count, refund_count: report.refund_count, difference_count: report.differences.length };
}
