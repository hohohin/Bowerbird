import { requireUser } from "../_shared/auth.ts";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { assertBodySize, corsHeaders } from "../_shared/limits.ts";

// Server-owned SKU catalog. The client may only submit a product id; price, currency and the
// resulting entitlement/credits are derived here, never trusted from the request body.
const SKU: Record<string, { product: string; type: "subscription" | "credits"; tier?: "pro" | "studio"; period?: "monthly" | "yearly"; credits?: number }> = {
  pro_monthly: { product: "pro_monthly", type: "subscription", tier: "pro", period: "monthly" },
  pro_yearly: { product: "pro_yearly", type: "subscription", tier: "pro", period: "yearly" },
  studio_monthly: { product: "studio_monthly", type: "subscription", tier: "studio", period: "monthly" },
  studio_yearly: { product: "studio_yearly", type: "subscription", tier: "studio", period: "yearly" },
  credits_100: { product: "credits_100", type: "credits", credits: 100 },
  credits_500: { product: "credits_500", type: "credits", credits: 500 },
  credits_2000: { product: "credits_2000", type: "credits", credits: 2000 },
};

interface CheckoutRequest {
  product: string;
}

Deno.serve(async (request) => {
  const id = requestId(request);
  let cors: HeadersInit = {};
  let userId: string | undefined;
  try {
    cors = corsHeaders(request);
    if ((Deno.env.get("BOWERBIRD_PAYMENT_MOCK") ?? "true") !== "true") {
      throw new ApiError("not_configured", "真实支付尚未接入，购买入口未开放", false, 503);
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") throw new ApiError("invalid_request", "仅支持 POST", false, 405);
    assertBodySize(request);
    const { user, admin } = await requireUser(request);
    userId = user.id;
    const body = (await request.json()) as CheckoutRequest;
    const sku = SKU[body.product];
    if (!sku) throw new ApiError("invalid_request", "未知商品");

    const providerOrderId = `mock-${crypto.randomUUID()}`;
    const amountMinor = sku.type === "subscription" ? 0 : sku.credits; // Mock 阶段不真实收款
    const { error } = await admin.from("orders").insert({
      user_id: user.id,
      provider: "mock",
      provider_order_id: providerOrderId,
      product: sku.product,
      amount_minor: amountMinor,
      currency: "CNY",
      status: "pending",
    });
    if (error) throw new ApiError("internal_error", "订单创建失败", true);

    safeLog({ requestId: id, userId, service: "checkout", status: "created" });
    // Mock checkout: return an order id; a real provider would redirect to its hosted checkout.
    return jsonResponse({ order_id: providerOrderId, provider: "mock" }, 201, cors);
  } catch (error) {
    safeLog({ requestId: id, userId, status: error instanceof ApiError ? error.code : "internal_error" });
    return errorResponse(error, id, cors);
  }
});
