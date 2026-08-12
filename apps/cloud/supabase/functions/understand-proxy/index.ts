import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { createArkAdapter, type ImageInput, type MockScenario } from "../_shared/ark.ts";
import { requireUser } from "../_shared/auth.ts";
import {
  confirmCredits,
  ensureDailyCredits,
  holdCredits,
  rollbackCredits,
} from "../_shared/billing.ts";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { assertBodySize, assertReferenceImages, corsHeaders, withTimeout } from "../_shared/limits.ts";
import { reserveManagedUsage } from "../_shared/usage.ts";

interface UnderstandRequest {
  idempotency_key: string;
  operation: "caption" | "autoname" | "classify";
  image: ImageInput;
  instruction?: string;
  mock_scenario?: MockScenario;
}

function validate(body: unknown): UnderstandRequest {
  if (!body || typeof body !== "object") throw new ApiError("invalid_request", "请求格式错误");
  const value = body as Record<string, unknown>;
  if (typeof value.idempotency_key !== "string" || !value.idempotency_key.trim()) {
    throw new ApiError("invalid_request", "缺少幂等键");
  }
  if (!["caption", "autoname", "classify"].includes(String(value.operation))) {
    throw new ApiError("invalid_request", "未知理解操作");
  }
  assertReferenceImages([value.image], 1);
  if (value.instruction !== undefined &&
    (typeof value.instruction !== "string" || value.instruction.length > 20_000)) {
    throw new ApiError("invalid_request", "instruction 最多 20000 字符");
  }
  return value as unknown as UnderstandRequest;
}

async function tierFor(admin: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await admin.from("subscriptions").select("tier,status,current_period_end")
    .eq("user_id", userId).maybeSingle();
  if (error) throw new ApiError("internal_error", "订阅状态读取失败", true);
  if (!data || data.status !== "active" ||
    (data.current_period_end && Date.parse(data.current_period_end) <= Date.now())) return "free";
  return data.tier;
}

Deno.serve(async (request) => {
  const id = requestId(request);
  let cors: HeadersInit = {};
  let adminClient: SupabaseClient | undefined;
  let userId: string | undefined;
  let holdId: string | undefined;
  let quotaConsumed = false;
  const started = performance.now();
  try {
    cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") throw new ApiError("invalid_request", "仅支持 POST", false, 405);
    assertBodySize(request);

    const { user, admin } = await requireUser(request);
    userId = user.id;
    adminClient = admin;
    const body = validate(await request.json());
    await ensureDailyCredits(admin, user.id);
    const tier = await tierFor(admin, user.id);
    if (tier === "free") {
      const limit = Number.parseInt(Deno.env.get("FREE_CAPTION_DAILY_LIMIT") ?? "10", 10);
      const { error } = await admin.rpc("consume_understand_quota", {
        p_user_id: user.id,
        p_limit: limit,
      });
      if (error?.details === "understand_daily_limit" || error?.message?.includes("daily understand")) {
        throw new ApiError("rate_limited", "今日反推次数已用完");
      }
      if (error) throw new ApiError("internal_error", "理解次数计数失败", true);
      quotaConsumed = true;
    }

    const held = await holdCredits(admin, user.id, body.idempotency_key, "caption");
    holdId = held.holdId;
    await reserveManagedUsage(admin, user.id, holdId, held.estimated);
    const result = await withTimeout(createArkAdapter().understand({
      operation: body.operation,
      image: body.image,
      instruction: body.instruction,
      scenario: body.mock_scenario,
    }), 120_000);
    const confirmed = await confirmCredits(admin, holdId, result.actualCost);
    safeLog({ requestId: id, userId, service: "caption", status: "succeeded", elapsedMs: performance.now() - started, credits: result.actualCost });
    return jsonResponse({
      status: "succeeded",
      text: result.text,
      sections: result.sections,
      categories: result.categories,
      charge: {
        estimated: held.estimated,
        actual: result.actualCost,
        transaction_id: confirmed.transactionId,
        pricing_version: held.pricingVersion,
      },
      balance: confirmed.balance,
    }, 200, cors);
  } catch (error) {
    if (holdId && adminClient) {
      try {
        await rollbackCredits(adminClient, holdId, error instanceof ApiError ? error.code : "internal_error");
      } catch { /* stale reconciliation is the fallback */ }
    }
    if (quotaConsumed && adminClient && userId) {
      try {
        await adminClient.rpc("undo_understand_quota", { p_user_id: userId });
      } catch { /* daily counter is a coarse fair-use control */ }
    }
    safeLog({ requestId: id, userId, service: "caption", status: error instanceof ApiError ? error.code : "internal_error", elapsedMs: performance.now() - started });
    return errorResponse(error, id, cors);
  }
});
