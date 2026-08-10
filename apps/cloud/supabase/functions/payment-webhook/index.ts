import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { corsHeaders } from "../_shared/limits.ts";

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
const WEBHOOK_SECRET_MOCK = Deno.env.get("SUPERUN_WEBHOOK_SECRET") ?? "mock-secret";

interface WebhookEvent {
  event: "order.paid" | "order.refunded";
  provider_order_id: string;
  provider_event_id: string;
  product: string;
  user_id: string;
  signature: string;
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
    .select("id,status,product")
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

  // Duplicate paid event: no-op (already granted).
  if (existing.data.status === "paid") return;

  const { error: orderError } = await admin
    .from("orders")
    .update({ status: "paid", updated_at: new Date().toISOString() })
    .eq("provider_order_id", event.provider_order_id);
  if (orderError) throw new ApiError("internal_error", "订单更新失败", true);

  if (config.type === "subscription") {
    const now = new Date();
    const end = new Date(now);
    const months = config.period === "yearly" ? 12 : 1;
    end.setMonth(end.getMonth() + months);
    const { error } = await admin.from("subscriptions").upsert({
      user_id: event.user_id,
      tier: config.tier,
      period: config.period,
      status: "active",
      provider: "mock",
      current_period_start: now.toISOString(),
      current_period_end: end.toISOString(),
    }, { onConflict: "user_id" });
    if (error) throw new ApiError("internal_error", "订阅开通失败", true);
  } else if (config.credits) {
    const { error } = await admin.rpc("grant_topup_credits", {
      p_user_id: event.user_id,
      p_order_id: event.provider_order_id,
      p_amount: config.credits,
    });
    if (error) throw new ApiError("internal_error", "积分发放失败", true);
  }
}

async function applyRefunded(admin: SupabaseClient, event: WebhookEvent): Promise<void> {
  const { data, error } = await admin
    .from("orders")
    .select("id,status,product")
    .eq("provider_order_id", event.provider_order_id)
    .maybeSingle();
  if (error) throw new ApiError("internal_error", "订单读取失败", true);
  if (!data || data.status !== "paid") return; // refund of non-paid is idempotent no-op

  const { error: updateError } = await admin
    .from("orders")
    .update({ status: "refunded", updated_at: new Date().toISOString() })
    .eq("provider_order_id", event.provider_order_id);
  if (updateError) throw new ApiError("internal_error", "退款状态更新失败", true);

  if ((data.product as string).startsWith("pro_") || (data.product as string).startsWith("studio_")) {
    const { error: subError } = await admin
      .from("subscriptions")
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .eq("user_id", event.user_id);
    if (subError) throw new ApiError("internal_error", "订阅失效更新失败", true);
  }
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

    const rawBody = await request.text();
    const event = JSON.parse(rawBody) as WebhookEvent;
    const signature = request.headers.get("x-provider-signature") ?? "";
    if (!constantTimeEqual(signature, WEBHOOK_SECRET_MOCK)) {
      throw new ApiError("unauthorized", "回调签名无效", false, 401);
    }

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
