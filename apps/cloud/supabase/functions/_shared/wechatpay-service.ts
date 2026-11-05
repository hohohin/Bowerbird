import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { AuthContext } from "./auth.ts";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "./errors.ts";
import { corsHeaders } from "./limits.ts";
import { adminUuid, assertCodeAdmin } from "./pro-code-admin.ts";
import { decryptWechatNotification, jsonObject, readPaymentBody, WechatApiError, WechatPayClient, wechatPayConfig } from "./wechatpay.ts";

export interface PaymentBundle {
  order: { id: string; user_id: string; product: string; amount_minor: number; currency: string; status: string;
    product_snapshot: { credits: number; months: number; kind: string } };
  payment: { mchid: string; appid: string; out_trade_no: string; code_url: string | null; time_expire: string; payment_state: string; transaction_id: string | null; native_request: Record<string, unknown> };
  refund?: { id: string; out_refund_no: string; state: string; amount_minor: number; created_at?: string; request_payload: Record<string, unknown> };
}
export function paymentServiceAdmin(): SupabaseClient {
  let key = Deno.env.get("SUPABASE_SECRET_KEY")?.trim() || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!key) { try { key = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default; } catch { /* fail below */ } }
  const url = Deno.env.get("SUPABASE_URL");
  if (!key || !url) throw new ApiError("not_configured", "支付服务尚未配置");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
export async function paymentRpc<T>(admin: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw new ApiError(error.code === "42501" ? "unauthorized" : "internal_error", "订单处理未完成，请稍后查看原订单", true);
  return data as T;
}
export function publicPayment(bundle: PaymentBundle, refundState?: string) {
  const o = bundle.order, p = bundle.payment;
  const status = o.status === "refunded" ? "refunded" : ["reserved", "processing", "abnormal"].includes(refundState ?? "") ? "refunding"
    : o.status === "paid" ? "paid" : o.status === "canceled" ? "closed" : "pending";
  return { order_id: o.id, provider: "wechatpay", product: o.product, amount_minor: o.amount_minor, currency: o.currency,
    status, code_url: status === "pending" && Date.parse(p.time_expire) > Date.now() ? p.code_url : null,
    expires_at: p.time_expire, credits: o.product_snapshot.credits, months: o.product_snapshot.months };
}
function assertMerchant(bundle: PaymentBundle, client: WechatPayClient) {
  if (bundle.payment.mchid !== client.config.mchid || bundle.payment.appid !== client.config.appid) throw new ApiError("not_configured", "订单收款配置不匹配，请联系管理员");
}
async function applyTransaction(admin: SupabaseClient, value: Record<string, unknown>, eventId?: string) {
  if (value.trade_type !== undefined && value.trade_type !== "NATIVE") throw new ApiError("invalid_request", "支付类型与订单不符");
  return await paymentRpc<{ accepted: boolean; status: string }>(admin, "apply_wechatpay_transaction", {
    // Each signed query is a fresh observation; later responses may add official
    // timestamps without changing state. SQL owns entitlement idempotency.
    p_event_id: eventId ?? `query:${crypto.randomUUID()}`,
    p_transaction: value,
  });
}
export async function reconcileWechatOrder(admin: SupabaseClient, bundle: PaymentBundle, client: WechatPayClient): Promise<void> {
  assertMerchant(bundle, client);
  if (bundle.order.status !== "pending") return;
  const p = bundle.payment;
  let state: Record<string, unknown> | null = null;
  try { state = await client.query(p.out_trade_no); }
  catch (error) { if (!(error instanceof WechatApiError && error.upstreamCode === "ORDER_NOT_EXIST")) throw error; }
  if (state) {
    if (state.out_trade_no !== p.out_trade_no || state.mchid !== p.mchid || state.appid !== p.appid) throw new ApiError("upstream_failed", "支付查询结果与原订单不符");
    // Query amount is optional before successful payment. Never invent a paid
    // amount, nor overwrite a supplied mismatch. Source: 4012791880.
    if (state.trade_state !== "SUCCESS") state = { ...state, amount: { total: bundle.order.amount_minor,
      currency: bundle.order.currency, ...(state.amount as Record<string, unknown> ?? {}) } };
    const result = await applyTransaction(admin, state);
    if (!result.accepted) throw new ApiError("internal_error", "支付信息需要核对，请联系管理员");
    if (state.trade_state !== "NOTPAY") return;
  }
  if (Date.parse(p.time_expire) <= Date.now()) {
    // Even ORDER_NOT_EXIST does not count as a confirmed close. A later query or
    // signed close response is required; never infer payment failure from a clock.
    if (!state) throw new ApiError("upstream_failed", "到期订单仍待确认，请联系管理员核对", true);
    await client.close(p.out_trade_no);
    const closed = await applyTransaction(admin, { ...state, trade_state: "CLOSED" }, `close:${crypto.randomUUID()}`);
    if (!closed.accepted) throw new ApiError("internal_error", "支付信息需要核对，请联系管理员");
    return;
  }
  if (!p.code_url) {
    const o = bundle.order;
    if (!p.native_request || p.native_request.out_trade_no !== p.out_trade_no) throw new ApiError("internal_error", "订单请求快照缺失，请联系管理员");
    const result = await client.native(p.native_request);
    if (typeof result.code_url !== "string" || !result.code_url.startsWith("weixin://wxpay/") || result.code_url.length > 2048) throw new ApiError("upstream_failed", "支付二维码暂不可用，请稍后查看原订单", true);
    await paymentRpc(admin, "update_wechatpay_checkout", { p_order_id: o.id, p_code_url: result.code_url });
  }
}
async function refreshClaimedOrder(admin: SupabaseClient, orderId: string, client: WechatPayClient) {
  const claimed = await paymentRpc<PaymentBundle | null>(admin, "claim_wechatpay_order", { p_order_id: orderId });
  if (!claimed) return;
  try { await reconcileWechatOrder(admin, claimed, client); }
  catch (error) { safeLog({ requestId: orderId, service: "wechatpay-recovery", status: error instanceof WechatApiError ? error.upstreamCode : error instanceof ApiError ? error.code : "internal_error" }); }
  finally { await paymentRpc(admin, "release_wechatpay_reconciliation", { p_order_id: orderId }); }
}
async function ownerOrder(admin: SupabaseClient, userId: string, orderId?: string): Promise<PaymentBundle | null> {
  let query = admin.from("orders").select("id").eq("provider", "wechatpay").eq("user_id", userId);
  if (orderId) query = query.eq("id", orderId); else query = query.eq("status", "pending").order("created_at", { ascending: false }).limit(1);
  const { data, error } = await query.maybeSingle();
  if (error) throw new ApiError("internal_error", "订单查询暂不可用", true);
  if (!data) { if (orderId) throw new ApiError("invalid_request", "未找到此账号的订单", false, 404); return null; }
  return paymentRpc<PaymentBundle>(admin, "wechatpay_order_json", { p_order_id: data.id });
}
async function orderResponse(admin: SupabaseClient, bundle: PaymentBundle) {
  const { data, error } = await admin.from("wechatpay_refunds").select("state").eq("order_id", bundle.order.id).neq("state", "closed").maybeSingle();
  if (error) throw new ApiError("internal_error", "订单状态暂不可用", true);
  return { order: publicPayment(bundle, data?.state) };
}
export async function handleWechatCheckout(request: Request, context: AuthContext, client = new WechatPayClient(wechatPayConfig())) {
  const body = jsonObject(await readPaymentBody(request, 4096));
  if (typeof body.product !== "string" || !/^[a-z0-9_]{1,48}$/.test(body.product)
    || typeof body.idempotency_key !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(body.idempotency_key)
    || (body.custom_amount_yuan !== undefined && (!Number.isInteger(body.custom_amount_yuan) || Number(body.custom_amount_yuan) < 1 || Number(body.custom_amount_yuan) > 21474836))) {
    throw new ApiError("invalid_request", "请选择商品或填写有效的整数充值金额");
  }
  const bundle = await paymentRpc<PaymentBundle>(context.admin, "create_wechatpay_order", { p_user_id: context.user.id,
    p_request_key: body.idempotency_key, p_product: body.product, p_custom_yuan: body.custom_amount_yuan ?? null,
    p_mchid: client.config.mchid, p_appid: client.config.appid, p_notify_url: client.config.notifyUrl });
  await refreshClaimedOrder(context.admin, bundle.order.id, client);
  const refreshed = await ownerOrder(context.admin, context.user.id, bundle.order.id);
  return orderResponse(context.admin, refreshed!);
}
export async function handleCheckoutStatus(request: Request, authenticate: (r: Request) => Promise<AuthContext>) {
  const id = requestId(request); let headers: HeadersInit = { "cache-control": "no-store" };
  try {
    headers = { ...headers, ...corsHeaders(request) };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") throw new ApiError("invalid_request", "仅支持 POST", false, 405);
    const { user, admin } = await authenticate(request);
    const body = jsonObject(await readPaymentBody(request, 4096));
    const bundle = await ownerOrder(admin, user.id, body.order_id === undefined ? undefined : adminUuid(body.order_id));
    if (!bundle) return jsonResponse({ order: null }, 200, headers);
    // Recovery remains available when new sales are disabled.
    await refreshClaimedOrder(admin, bundle.order.id, new WechatPayClient(wechatPayConfig()));
    return jsonResponse(await orderResponse(admin, (await ownerOrder(admin, user.id, bundle.order.id))!), 200, headers);
  } catch (error) { return errorResponse(error, id, headers); }
}
export async function handleWechatNotification(request: Request, admin: SupabaseClient, client = new WechatPayClient(wechatPayConfig())) {
  const id = requestId(request);
  try {
    if (request.method !== "POST") throw new ApiError("invalid_request", "仅支持 POST", false, 405);
    const notice = await decryptWechatNotification(client.config, request.headers, await readPaymentBody(request));
    if (notice.eventType === "TRANSACTION.SUCCESS" && notice.originalType === "transaction") {
      if (notice.data.trade_state !== "SUCCESS" || notice.data.trade_type !== "NATIVE"
        || notice.data.mchid !== client.config.mchid || notice.data.appid !== client.config.appid) throw new ApiError("invalid_request", "支付通知状态不符");
      await applyTransaction(admin, notice.data, notice.id);
    } else if (["REFUND.SUCCESS", "REFUND.CLOSED", "REFUND.ABNORMAL"].includes(String(notice.eventType)) && notice.originalType === "refund") {
      if (notice.eventType !== `REFUND.${notice.data.refund_status}` || notice.data.mchid !== client.config.mchid) throw new ApiError("invalid_request", "退款通知状态不符");
      await paymentRpc(admin, "apply_wechatpay_refund", { p_event_id: notice.id, p_refund: notice.data, p_mchid: notice.data.mchid });
    } else throw new ApiError("invalid_request", "不支持的支付通知");
    // The RPC has durably stored the verified event even if business application
    // needs reconciliation. No detached in-memory work follows the acknowledgement.
    return new Response(null, { status: 204 });
  } catch (error) { safeLog({ requestId: id, service: "wechatpay-notify", status: error instanceof ApiError ? error.code : "internal_error" }); return errorResponse(error, id); }
}
export async function reconcileWechatRefund(admin: SupabaseClient, bundle: PaymentBundle, client: WechatPayClient) {
  assertMerchant(bundle, client);
  const refund = bundle.refund!;
  let result: Record<string, unknown>;
  try { result = await client.queryRefund(refund.out_refund_no); }
  catch (error) {
    const absent = error instanceof WechatApiError && error.upstreamCode === "RESOURCE_NOT_EXISTS";
    const unknown = error instanceof WechatApiError ? error.upstreamStatus >= 500 : error instanceof ApiError && error.code === "upstream_timeout";
    // Official refund recovery permits an original-number retry after a minute
    // of unknown status. Signature failures never qualify for that retry.
    const oldUnknown = unknown && refund.created_at !== undefined && Date.parse(refund.created_at) <= Date.now() - 60000;
    if ((!absent && !oldUnknown) || refund.state !== "reserved") throw error;
    if (!refund.request_payload || refund.request_payload.out_refund_no !== refund.out_refund_no) throw new ApiError("internal_error", "退款请求快照缺失，请联系管理员");
    result = await client.refund(refund.request_payload);
  }
  if (result.out_refund_no !== refund.out_refund_no || result.out_trade_no !== bundle.payment.out_trade_no
    || result.transaction_id !== bundle.payment.transaction_id) throw new ApiError("upstream_failed", "退款查询结果与原订单不符");
  const applied = await paymentRpc<{ accepted: boolean }>(admin, "apply_wechatpay_refund", {
    p_event_id: `refund-query:${crypto.randomUUID()}`, p_refund: result, p_mchid: client.config.mchid });
  if (!applied.accepted) throw new ApiError("internal_error", "退款信息需要核对，请联系管理员");
}
export async function handlePaymentAdmin(request: Request, authenticate: (r: Request) => Promise<AuthContext>) {
  const id = requestId(request); let headers: HeadersInit = { "cache-control": "no-store" };
  try {
    headers = { ...headers, ...corsHeaders(request) };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") throw new ApiError("invalid_request", "仅支持 POST", false, 405);
    const { user, admin } = await authenticate(request); assertCodeAdmin(user);
    const body = jsonObject(await readPaymentBody(request, 4096));
    if (body.action !== "refund" || typeof body.idempotency_key !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(body.idempotency_key)) throw new ApiError("invalid_request", "退款请求无效");
    // Validate config before reserving any balance. Only explicit admin action
    // creates a refund; the background worker merely resumes an existing one.
    const config = wechatPayConfig();
    const orderId = adminUuid(body.order_id);
    const original = await paymentRpc<PaymentBundle | null>(admin, "wechatpay_order_json", { p_order_id: orderId });
    if (!original) throw new ApiError("invalid_request", "订单不存在");
    assertMerchant(original, new WechatPayClient(config));
    const bundle = await paymentRpc<PaymentBundle>(admin, "prepare_wechatpay_refund", { p_actor: user.id, p_order_id: orderId,
      p_request_key: body.idempotency_key, p_notify_url: config.refundNotifyUrl ?? config.notifyUrl });
    return jsonResponse({ refund_id: bundle.refund!.id, status: bundle.refund!.state, order_id: bundle.order.id }, 202, headers);
  } catch (error) { return errorResponse(error, id, headers); }
}
export function assertPaymentWorker(request: Request) {
  const expected = Deno.env.get("WECHAT_PAY_RECONCILE_TOKEN") ?? "";
  const actual = request.headers.get("authorization") ?? "";
  const left = new TextEncoder().encode(`Bearer ${expected}`), right = new TextEncoder().encode(actual);
  let diff = left.length ^ right.length;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ (right[i] ?? 0);
  if (expected.length < 32 || diff !== 0) throw new ApiError("unauthorized", "未授权的支付维护请求");
}
export async function handlePaymentReconcile(request: Request) {
  const id = requestId(request);
  try {
    if (request.method !== "POST") throw new ApiError("invalid_request", "仅支持 POST", false, 405);
    assertPaymentWorker(request);
    const admin = paymentServiceAdmin(), client = new WechatPayClient(wechatPayConfig());
    const body = jsonObject((await readPaymentBody(request, 4096)) || "{}");
    if (body.bill_date !== undefined) {
      if (typeof body.bill_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.bill_date)
        || !Number.isFinite(Date.parse(`${body.bill_date}T00:00:00Z`)) || new Date(`${body.bill_date}T00:00:00Z`).toISOString().slice(0, 10) !== body.bill_date) throw new ApiError("invalid_request", "账单日期无效");
      const { reconcileWechatBill } = await import("./wechatpay-bill.ts");
      return jsonResponse(await reconcileWechatBill(admin, client.config, body.bill_date), 200, { "cache-control": "no-store" });
    }
    const batch = await paymentRpc<{ orders: PaymentBundle[]; refunds: PaymentBundle[]; events: Array<{ event_id: string; kind: string; payload: Record<string, unknown>; mchid: string }> }>(admin, "claim_wechatpay_reconciliation", { p_limit: 5 });
    let processed = 0, failed = 0;
    const run = async (operation: () => Promise<unknown>) => { try {
      const result = await operation();
      if (result && typeof result === "object" && "accepted" in result && !result.accepted) throw new ApiError("internal_error", "支付事件需要人工核对");
      processed++;
    } catch (error) { failed++; safeLog({ requestId: id, service: "wechatpay-reconcile", status: error instanceof WechatApiError ? error.upstreamCode : error instanceof ApiError ? error.code : "internal_error" }); } };
    for (const event of batch.events) await run(() => event.kind === "transaction" ? applyTransaction(admin, event.payload, event.event_id)
      : paymentRpc(admin, "apply_wechatpay_refund", { p_event_id: event.event_id, p_refund: event.payload, p_mchid: event.mchid }));
    await Promise.all(batch.orders.map((bundle) => run(() => reconcileWechatOrder(admin, bundle, client))));
    await Promise.all(batch.refunds.map((bundle) => run(() => reconcileWechatRefund(admin, bundle, client))));
    return jsonResponse({ processed, failed }, 200, { "cache-control": "no-store" });
  } catch (error) { return errorResponse(error, id); }
}
