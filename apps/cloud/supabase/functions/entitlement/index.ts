import { requireUser } from "../_shared/auth.ts";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { corsHeaders } from "../_shared/limits.ts";

interface Policy {
  can_use_byo: boolean;
  can_use_cloud: boolean;
  max_parallel_jobs: number;
  understand_daily_limit: number | null;
  can_use_priority_queue: boolean;
  can_hd_export: boolean;
}

function policyFor(tier: string): Policy {
  if (tier === "studio") {
    return {
      can_use_byo: true,
      can_use_cloud: true,
      max_parallel_jobs: 8,
      understand_daily_limit: null,
      can_use_priority_queue: true,
      can_hd_export: false,
    };
  }
  if (tier === "pro") {
    return {
      can_use_byo: true,
      can_use_cloud: true,
      max_parallel_jobs: 4,
      understand_daily_limit: null,
      can_use_priority_queue: false,
      can_hd_export: false,
    };
  }
  return {
    can_use_byo: false,
    can_use_cloud: true,
    max_parallel_jobs: 1,
    understand_daily_limit: 10,
    can_use_priority_queue: false,
    can_hd_export: false,
  };
}

Deno.serve(async (request) => {
  const id = requestId(request);
  let cors: HeadersInit = {};
  let userId: string | undefined;
  try {
    cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") throw new ApiError("invalid_request", "仅支持 GET", false, 405);

    const { user, admin } = await requireUser(request);
    userId = user.id;
    const [{ data: subscription, error: subError }, { data: credits, error: creditError }, { data: transactions, error: txError }] =
      await Promise.all([
        admin.from("subscriptions").select("tier,status,current_period_end,entitlement_version").eq("user_id", user.id).maybeSingle(),
        admin.from("user_credits").select("daily_balance,sub_balance,topup_balance").eq("user_id", user.id).maybeSingle(),
        admin.from("credit_transactions").select("kind,amount,service,created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(50),
      ]);
    if (subError || creditError || txError) throw new ApiError("internal_error", "权益状态读取失败", true);

    const active = subscription?.status === "active" &&
      (!subscription.current_period_end || Date.parse(subscription.current_period_end) > Date.now());
    const tier = active ? subscription?.tier ?? "free" : "free";
    const issuedAt = new Date();
    const refreshAfter = new Date(issuedAt.getTime() + 6 * 60 * 60 * 1000);
    const graceUntil = new Date(issuedAt.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Transport authenticity comes from HTTPS + verified JWT. P3 adds the client cache signature;
    // until then signature_version=0 explicitly means "do not trust offline".
    const body = {
      user_id: user.id,
      tier,
      balances: {
        daily: credits?.daily_balance ?? 0,
        sub: credits?.sub_balance ?? 0,
        topup: credits?.topup_balance ?? 0,
      },
      policy: policyFor(tier),
      recent_transactions: (transactions ?? []).map((tx) => ({
        kind: tx.kind,
        amount: tx.amount,
        service: tx.service,
        created_at: tx.created_at,
      })),
      issued_at: issuedAt.toISOString(),
      refresh_after: refreshAfter.toISOString(),
      grace_until: graceUntil.toISOString(),
      entitlement_version: subscription?.entitlement_version ?? 1,
      signature_version: 0,
      signature: null,
    };
    safeLog({ requestId: id, userId, status: "succeeded" });
    return jsonResponse(body, 200, cors);
  } catch (error) {
    safeLog({ requestId: id, userId, status: error instanceof ApiError ? error.code : "internal_error" });
    return errorResponse(error, id, cors);
  }
});
