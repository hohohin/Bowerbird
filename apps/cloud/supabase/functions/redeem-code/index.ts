import { requireUser } from "../_shared/auth.ts";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { corsHeaders } from "../_shared/limits.ts";
import { assertRedemptionResult, readRedemptionBody, redemptionCodeHash } from "../_shared/redemption.ts";

Deno.serve(async (request) => {
  const id = requestId(request);
  let cors: HeadersInit = {};
  let userId: string | undefined;
  try {
    cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") throw new ApiError("invalid_request", "仅支持 POST", false, 405);
    const { user, admin } = await requireUser(request);
    userId = user.id;
    const body = await readRedemptionBody(request);
    const codeHash = await redemptionCodeHash(body.code);
    // Identity and grant contents are server-owned, regardless of extra client fields.
    const { data, error } = await admin.rpc("redeem_pro_code", { p_user_id: user.id, p_code_hash: codeHash });
    if (error) throw new ApiError("internal_error", "兑换服务暂时不可用，请使用同一码重试", true);
    assertRedemptionResult(data);
    safeLog({ requestId: id, userId, status: "succeeded" });
    return jsonResponse(data, 200, cors);
  } catch (error) {
    safeLog({ requestId: id, userId, status: error instanceof ApiError ? error.code : "internal_error" });
    return errorResponse(error, id, cors);
  }
});
