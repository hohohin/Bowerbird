import { requireUser } from "../_shared/auth.ts";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { assertBodySize, corsHeaders } from "../_shared/limits.ts";

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
    const { data: sku, error: catalogError } = await admin.from("billing_products")
      .select("product,kind,amount_minor,credits,months,pricing_version")
      .eq("product", body.product).eq("active", true).maybeSingle();
    if (catalogError) throw new ApiError("internal_error", "价格目录暂不可用", true);
    if (!sku) throw new ApiError("invalid_request", "未知商品");

    const providerOrderId = `mock-${crypto.randomUUID()}`;
    const amountMinor = sku.amount_minor; // Mock does not collect money, but records the real quoted price.
    const { error } = await admin.from("orders").insert({
      user_id: user.id,
      provider: "mock",
      provider_order_id: providerOrderId,
      product: sku.product,
      amount_minor: amountMinor,
      currency: "CNY",
      status: "pending",
      product_snapshot: sku,
    });
    if (error) throw new ApiError("internal_error", "订单创建失败", true);

    safeLog({ requestId: id, userId, service: "checkout", status: "created" });
    // Mock checkout: return an order id; a real provider would redirect to its hosted checkout.
    return jsonResponse({ order_id: providerOrderId, provider: "mock", amount_minor: amountMinor, currency: "CNY", product: sku }, 201, cors);
  } catch (error) {
    safeLog({ requestId: id, userId, status: error instanceof ApiError ? error.code : "internal_error" });
    return errorResponse(error, id, cors);
  }
});
