import { requireUser } from "../_shared/auth.ts";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { assertBodySize, corsHeaders } from "../_shared/limits.ts";
import { wechatCheckoutEnabled } from "../_shared/wechatpay.ts";
import { handleWechatCheckout } from "../_shared/wechatpay-service.ts";

interface CheckoutRequest {
  product: string;
}

Deno.serve(async (request) => {
  const id = requestId(request);
  let cors: HeadersInit = {};
  let userId: string | undefined;
  try {
    cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!["GET", "POST"].includes(request.method)) throw new ApiError("invalid_request", "仅支持 GET 或 POST", false, 405);
    assertBodySize(request);
    const { user, admin } = await requireUser(request);
    userId = user.id;
    cors = { ...cors, "cache-control": "no-store" };
    if (request.method === "GET") return jsonResponse({ enabled: wechatCheckoutEnabled(), provider: "wechatpay", custom_max_yuan: 21474836 }, 200, cors);
    if ((Deno.env.get("BOWERBIRD_PAYMENT_MOCK") ?? "true") !== "true") {
      if (!wechatCheckoutEnabled()) throw new ApiError("not_configured", "微信支付暂未开放", false, 503);
      return jsonResponse(await handleWechatCheckout(request, { user, admin }), 201, cors);
    }
    const body = (await request.json()) as CheckoutRequest;
    const { data: sku, error: catalogError } = await admin.from("billing_products")
      .select("product,kind,amount_minor,credits,months,pricing_version,monthly_bonus_credits,bonus_valid_days")
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
