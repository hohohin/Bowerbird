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
import { assertReferenceImages, corsHeaders, withTimeout } from "../_shared/limits.ts";
import { reserveManagedUsage } from "../_shared/usage.ts";

// 双模式：UNDERSTAND_ASYNC=false（默认）保持旧的「单次 Edge 请求内同步调方舟」行为；
// true 时切换为生图 G0 同款异步任务模式（create/get 短请求 + VPS Worker 领取执行），
// 目的是摆脱 Edge 墙钟上限。观察期后旧同步路径按生图 135/140s 回退的同一策略移除。
const BUCKET = "generation-temp";
const CONTENT_TTL_MS = 24 * 60 * 60 * 1000;
const asyncMode = (Deno.env.get("UNDERSTAND_ASYNC") ?? "false") === "true";

interface UnderstandRequest {
  idempotency_key: string;
  operation: "caption" | "autoname" | "classify";
  /** null = 纯文本调用（生成图维度数据命名），图片不上云；caption/classify 必带一张图。 */
  image: ImageInput | null;
  instruction?: string;
  mock_scenario?: MockScenario;
}

interface UnderstandJob {
  id: string;
  user_id: string;
  status: string;
  request_object_key: string;
  input_manifest_hash: string;
  hold_id: string;
  estimated_credits: number;
  actual_credits: number | null;
  pricing_version: number;
  result_text: string | null;
  error_code: string | null;
  safe_message: string | null;
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
  if (value.image == null) {
    // 纯文本调用：无图时必须带非空 instruction（桌面维度数据命名恒满足）。
    if (typeof value.instruction !== "string" || !value.instruction.trim()) {
      throw new ApiError("invalid_request", "缺少图片或指令");
    }
  } else {
    assertReferenceImages([value.image], 1);
  }
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

async function consumeFreeQuota(admin: SupabaseClient, userId: string): Promise<void> {
  const limit = Number.parseInt(Deno.env.get("FREE_CAPTION_DAILY_LIMIT") ?? "10", 10);
  const { error } = await admin.rpc("consume_understand_quota", {
    p_user_id: userId,
    p_limit: limit,
  });
  if (error?.details === "understand_daily_limit" || error?.message?.includes("daily understand")) {
    throw new ApiError("rate_limited", "今日反推次数已用完");
  }
  if (error) throw new ApiError("internal_error", "理解次数计数失败", true);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function ownJob(admin: SupabaseClient, userId: string, jobId: string): Promise<UnderstandJob> {
  const { data, error } = await admin.from("understand_jobs").select("*")
    .eq("id", jobId).eq("user_id", userId).maybeSingle();
  if (error) throw new ApiError("internal_error", "读取云理解任务失败", true);
  if (!data) throw new ApiError("invalid_request", "云理解任务不存在", false, 404);
  return data as unknown as UnderstandJob;
}

function jobResponse(job: UnderstandJob, cors: HeadersInit): Response {
  const common = {
    status: job.status,
    job_id: job.id,
    charge: {
      estimated: job.estimated_credits,
      actual: job.actual_credits,
      transaction_id: job.hold_id,
      pricing_version: job.pricing_version,
    },
  };
  if (["uploading", "queued", "leased", "running", "cancel_requested"].includes(job.status)) {
    return jsonResponse(common, 202, cors);
  }
  if (job.status === "succeeded") {
    if (!job.result_text) {
      return jsonResponse({
        ...common,
        error: { code: "content_expired", message: "理解结果已过期" },
      }, 200, cors);
    }
    return jsonResponse({ ...common, text: job.result_text }, 200, cors);
  }
  return jsonResponse({
    ...common,
    error: {
      code: job.error_code ?? job.status,
      message: job.safe_message ??
        (job.status === "cancelled" ? "云任务已取消" : "云理解未完成"),
    },
  }, 200, cors);
}

async function createJob(
  admin: SupabaseClient,
  userId: string,
  body: UnderstandRequest,
  cors: HeadersInit,
): Promise<Response> {
  await ensureDailyCredits(admin, userId);
  const tier = await tierFor(admin, userId);
  let quotaConsumed = false;
  let holdId: string | undefined;
  let jobId: string | undefined;
  try {
    if (tier === "free") {
      await consumeFreeQuota(admin, userId);
      quotaConsumed = true;
    }
    const held = await holdCredits(admin, userId, body.idempotency_key, "caption");
    holdId = held.holdId;
    const requestPayload = JSON.stringify({
      schema_version: 1,
      operation: body.operation,
      image: body.image,
      instruction: body.instruction ?? null,
      mock_scenario: body.mock_scenario ?? null,
    });
    const manifestHash = await sha256Hex(requestPayload);

    const existingResult = await admin.from("understand_jobs").select("*")
      .eq("hold_id", held.holdId).maybeSingle();
    if (existingResult.error) throw new ApiError("internal_error", "读取幂等云理解任务失败", true);
    let job = existingResult.data as unknown as UnderstandJob | null;
    if (job && job.input_manifest_hash !== manifestHash) {
      throw new ApiError("invalid_request", "幂等键已用于不同的理解内容", false, 409);
    }
    if (job && job.status !== "uploading") return jobResponse(job, cors);
    if (job) jobId = job.id;

    if (!job) {
      jobId = crypto.randomUUID();
      const requestObjectKey = `understand/${jobId}/inputs/request.json`;
      const { data, error } = await admin.from("understand_jobs").insert({
        id: jobId,
        user_id: userId,
        idempotency_key: body.idempotency_key,
        operation: body.operation,
        status: "uploading",
        quota_consumed: quotaConsumed,
        request_object_key: requestObjectKey,
        input_manifest_hash: manifestHash,
        hold_id: held.holdId,
        estimated_credits: held.estimated,
        pricing_version: held.pricingVersion,
        content_expires_at: new Date(Date.now() + CONTENT_TTL_MS).toISOString(),
      }).select("*").single();
      if (error || !data) throw new ApiError("internal_error", "创建云理解任务失败", true);
      job = data as unknown as UnderstandJob;
      jobId = job.id;
    }

    // Replays are allowed only while the durable job is still in `uploading`.
    await reserveManagedUsage(admin, userId, held.holdId, held.estimated, true);
    const upload = await admin.storage.from(BUCKET).upload(job.request_object_key, requestPayload, {
      contentType: "application/json",
      upsert: true,
    });
    if (upload.error) throw new ApiError("internal_error", "暂存云理解输入失败", true);
    const { data, error } = await admin.from("understand_jobs").update({
      status: "queued",
      queued_at: new Date().toISOString(),
    }).eq("id", job.id).eq("status", "uploading").select("*").single();
    if (error || !data) throw new ApiError("internal_error", "云理解任务入队失败", true);
    job = data as unknown as UnderstandJob;
    return jobResponse(job, cors);
  } catch (error) {
    try {
      if (holdId) await rollbackCredits(admin, holdId, error instanceof ApiError ? error.code : "queue_failed");
      if (quotaConsumed) await admin.rpc("undo_understand_quota", { p_user_id: userId });
      if (jobId) await admin.from("understand_jobs").update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error_code: "queue_failed",
        safe_message: "云理解任务入队失败，请重试",
      }).eq("id", jobId).eq("status", "uploading");
    } catch {
      // Stale-hold reconciliation remains the final safety net.
    }
    throw error;
  }
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
    const { user, admin } = await requireUser(request);
    userId = user.id;
    adminClient = admin;
    const raw = await request.json() as Record<string, unknown>;

    if (asyncMode) {
      const action = typeof raw.action === "string" ? raw.action : "";
      const jobId = typeof raw.job_id === "string" ? raw.job_id : "";
      let response: Response;
      if (action === "get" || (!action && jobId)) {
        if (!jobId) throw new ApiError("invalid_request", "缺少 job_id");
        response = jobResponse(await ownJob(admin, user.id, jobId), cors);
      } else if (action && action !== "create") {
        throw new ApiError("invalid_request", "未知 action");
      } else {
        response = await createJob(admin, user.id, validate(raw), cors);
      }
      safeLog({ requestId: id, userId, service: "understand-proxy", status: response.status, elapsedMs: performance.now() - started });
      return response;
    }

    // —— 旧同步路径（UNDERSTAND_ASYNC=false）：行为与改造前完全一致 ——
    const body = validate(raw);
    await ensureDailyCredits(admin, user.id);
    const tier = await tierFor(admin, user.id);
    if (tier === "free") {
      await consumeFreeQuota(admin, user.id);
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
