import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { assertBodySize, corsHeaders } from "../_shared/limits.ts";

const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

function secretKey(): string | undefined {
  const direct = Deno.env.get("SUPABASE_SECRET_KEY")?.trim();
  if (direct) return direct;
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS")?.trim();
  if (keys) {
    try {
      return (JSON.parse(keys) as Record<string, string>).default?.trim();
    } catch {
      return undefined;
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
}

function serviceAdmin(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = secretKey();
  if (!url || !serviceKey) throw new ApiError("not_configured", "服务密钥未配置");
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Provider-neutral webhook state machine.
//  - provider_signature is the raw provider signature. Mock verifies a constant-time match of
//    WEBHOOK_SECRET_MOCK; real superun/Paddle will verify the raw body before any field parse.
//  - order/event idempotency is enforced by unique provider_order_id / provider_event_id.

interface WebhookEvent {
  event: "order.paid" | "order.refunded";
  provider_order_id: string;
  provider_event_id: string;
}

function mockWebhookSecret(): string {
  const secret = Deno.env.get("SUPERUN_WEBHOOK_SECRET")?.trim();
  if (!secret) throw new ApiError("not_configured", "Mock 支付回调密钥未配置");
  return secret;
}

function parseEvent(rawBody: string): WebhookEvent {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new ApiError("invalid_request", "回调格式无效");
  }
  if (!value || typeof value !== "object") throw new ApiError("invalid_request", "回调格式无效");
  const event = value as Record<string, unknown>;
  if ((event.event !== "order.paid" && event.event !== "order.refunded") ||
    typeof event.provider_order_id !== "string" || !event.provider_order_id.trim() ||
    typeof event.provider_event_id !== "string" || !event.provider_event_id.trim()) {
    throw new ApiError("invalid_request", "回调字段无效");
  }
  return event as unknown as WebhookEvent;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

async function applyPaid(admin: SupabaseClient, event: WebhookEvent): Promise<void> {
  // Idempotent order lookup: upsert status to paid, then grant only on first transition.
  const existing = await admin
    .from("orders")
    .select("id,user_id,status,product,provider_event_id,created_at")
    .eq("provider", "mock")
    .eq("provider_order_id", event.provider_order_id)
    .maybeSingle();
  if (existing.error) throw new ApiError("internal_error", "订单读取失败", true);
  if (!existing.data) throw new ApiError("invalid_request", "未知订单");

  const product = existing.data.product as string;
  const sku: Record<string, { type: "subscription" | "credits"; tier?: string; period?: string; credits?: number }> = {
    pro_monthly: { type: "subscription", tier: "pro", period: "monthly" },
    pro_yearly: { type: "subscription", tier: "pro", period: "yearly" },
    studio_monthly: { type: "subscription", tier: "studio", period: "monthly" },
    studio_yearly: { type: "subscription", tier: "studio", period: "yearly" },
    credits_100: { type: "credits", credits: 100 },
    credits_500: { type: "credits", credits: 500 },
    credits_2000: { type: "credits", credits: 2000 },
  };
  const config = sku[product];
  if (!config) throw new ApiError("invalid_request", "未知商品");
  const userId = String(existing.data.user_id);

  // Duplicate paid event: no-op (already granted).
  if (existing.data.status === "paid") return;
  if (existing.data.status !== "pending") throw new ApiError("invalid_request", "订单状态不可支付");

  // Claim the globally unique provider event before granting anything. If the Function
  // stops after this update, the same event can resume because the order remains pending.
  const storedEventId = existing.data.provider_event_id as string | null;
  if (storedEventId && storedEventId !== event.provider_event_id) {
    throw new ApiError("invalid_request", "订单已由其他支付事件认领");
  }
  if (!storedEventId) {
    const { data: claimed, error: claimError } = await admin
      .from("orders")
      .update({ provider_event_id: event.provider_event_id, updated_at: new Date().toISOString() })
      .eq("id", existing.data.id)
      .eq("status", "pending")
      .is("provider_event_id", null)
      .select("id")
      .maybeSingle();
    if (claimError || !claimed) throw new ApiError("invalid_request", "支付事件重复或冲突");
  }

  if (config.type === "subscription") {
    // Use the server-created order timestamp so a replay cannot extend the subscription.
    const start = new Date(String(existing.data.created_at));
    const end = new Date(start);
    const months = config.period === "yearly" ? 12 : 1;
    end.setMonth(end.getMonth() + months);
    const { error } = await admin.from("subscriptions").upsert({
      user_id: userId,
      tier: config.tier,
      period: config.period,
      status: "active",
      provider: "mock",
      current_period_start: start.toISOString(),
      current_period_end: end.toISOString(),
    }, { onConflict: "user_id" });
    if (error) throw new ApiError("internal_error", "订阅开通失败", true);
  } else if (config.credits) {
    const { error } = await admin.rpc("grant_topup_credits", {
      p_user_id: userId,
      p_order_id: event.provider_order_id,
      p_amount: config.credits,
    });
    if (error) throw new ApiError("internal_error", "积分发放失败", true);
  }

  // Grants above are replay-safe. Persist the transition last so an interrupted webhook
  // can safely retry without losing the entitlement or issuing duplicate top-up credits.
  const { data: transitioned, error: orderError } = await admin
    .from("orders")
    .update({
      status: "paid",
      updated_at: new Date().toISOString(),
    })
    .eq("id", existing.data.id)
    .eq("status", "pending")
    .eq("provider_event_id", event.provider_event_id)
    .select("id")
    .maybeSingle();
  if (orderError) throw new ApiError("invalid_request", "支付事件重复或冲突");
  if (!transitioned) return;
}

async function applyRefunded(admin: SupabaseClient, event: WebhookEvent): Promise<void> {
  const { data, error } = await admin
    .from("orders")
    .select("id,user_id,status,product")
    .eq("provider", "mock")
    .eq("provider_order_id", event.provider_order_id)
    .maybeSingle();
  if (error) throw new ApiError("internal_error", "订单读取失败", true);
  if (!data || data.status !== "paid") return; // refund of non-paid is idempotent no-op

  if ((data.product as string).startsWith("pro_") || (data.product as string).startsWith("studio_")) {
    const { error: subError } = await admin
      .from("subscriptions")
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .eq("user_id", data.user_id);
    if (subError) throw new ApiError("internal_error", "订阅失效更新失败", true);
  }

  const { error: updateError } = await admin
    .from("orders")
    .update({
      status: "refunded",
      provider_event_id: event.provider_event_id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", data.id)
    .eq("status", "paid");
  if (updateError) throw new ApiError("invalid_request", "退款事件重复或冲突");
}

Deno.serve(async (request) => {
  const id = requestId(request);
  let cors: HeadersInit = {};
  try {
    cors = corsHeaders(request);
    if ((Deno.env.get("BOWERBIRD_PAYMENT_MOCK") ?? "true") !== "true") {
      throw new ApiError("not_configured", "真实支付尚未接入", false, 503);
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") throw new ApiError("invalid_request", "仅支持 POST", false, 405);
    assertBodySize(request);

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_WEBHOOK_BODY_BYTES) {
      throw new ApiError("payload_too_large", "回调内容过大");
    }
    const signature = request.headers.get("x-provider-signature") ?? "";
    if (!constantTimeEqual(signature, mockWebhookSecret())) {
      throw new ApiError("unauthorized", "回调签名无效", false, 401);
    }
    const event = parseEvent(rawBody);

    const admin = serviceAdmin();
    if (event.event === "order.paid") {
      await applyPaid(admin, event);
    } else if (event.event === "order.refunded") {
      await applyRefunded(admin, event);
    } else {
      throw new ApiError("invalid_request", "未知事件");
    }

    safeLog({ requestId: id, status: "ok", service: event.event });
    return jsonResponse({ ok: true }, 200, cors);
  } catch (error) {
    safeLog({ requestId: id, status: error instanceof ApiError ? error.code : "internal_error" });
    return errorResponse(error, id, cors);
  }
});
