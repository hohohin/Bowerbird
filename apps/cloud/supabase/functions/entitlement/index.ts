import { requireUser } from "../_shared/auth.ts";
import { ensureDailyCredits } from "../_shared/billing.ts";
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
    await ensureDailyCredits(admin, user.id);
    const [
      { data: subscription, error: subError },
      { data: credits, error: creditError },
      { data: transactions, error: txError },
      { data: imageServices, error: svcError },
      { data: promptConfigs, error: promptError },
    ] = await Promise.all([
      admin.from("subscriptions").select("tier,status,current_period_end,entitlement_version").eq("user_id", user.id).maybeSingle(),
      admin.from("user_credits").select("daily_balance,sub_balance,topup_balance").eq("user_id", user.id).maybeSingle(),
      admin.from("credit_transactions").select("kind,amount,service,created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(50),
      // 桌面端动态生图档位：active 且带 label 的 image_* 服务（label/sort 由 0018 起存 parameters）。
      admin.from("service_costs").select("service,unit_cost,parameters").eq("active", true).like("service", "image%"),
      // 远程 prompt 配置（0020）：enabled 行随权益快照下发，桌面 agent 指令云端热改无需发版。
      admin.from("prompt_configs").select("key,value,version").eq("enabled", true),
    ]);
    if (subError || creditError || txError || svcError || promptError) {
      throw new ApiError("internal_error", "权益状态读取失败", true);
    }

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
      generation_services: (imageServices ?? [])
        .filter((row) => typeof row.parameters?.label === "string" && row.parameters.label.trim())
        .sort((a, b) => (a.parameters?.sort ?? 999) - (b.parameters?.sort ?? 999))
        .map((row) => ({ service: row.service, label: row.parameters.label, credits: row.unit_cost })),
      prompt_configs: (promptConfigs ?? []).map((row) => ({ key: row.key, value: row.value, version: row.version })),
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
