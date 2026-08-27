// V2 视觉设定云端提炼 · 用户侧控制面（AGENT-RUNTIME-PLAN §8.7 / §11 V2-T1）。
// create：校验 FeaturePolicy + 反推卡结构（白名单字段消毒，杜绝图片/路径/URL 进入云端），
// 幂等 hold 2 积分 → 暂存私有 bucket → 入队；get：轮询任务状态与 draft JSON 结果。
// 长耗时模型分批在 VPS Worker 执行（visual-profile-worker），Edge 保持短请求。

import { requireUser } from "../_shared/auth.ts";
import { ensureDailyCredits, holdCredits, rollbackCredits } from "../_shared/billing.ts";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { activeTier, policyForUser } from "../_shared/feature-policy.ts";
import { corsHeaders } from "../_shared/limits.ts";
import { reserveManagedUsage } from "../_shared/usage.ts";

const BUCKET = "generation-temp";
const CONTENT_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_CARDS = 5;
const MAX_CARDS = 500;

interface SanitizedCard {
  assetId: string;
  captionId: string;
  captionHash: string;
  sections: Array<{ title: string; body: string }>;
  dimensions: Record<string, string>;
  textFallback?: string;
  parseStatus: string;
  sourceClass: string;
}

interface VisualProfileJob {
  id: string;
  user_id: string;
  status: string;
  request_object_key: string;
  input_manifest_hash: string;
  hold_id: string;
  estimated_credits: number;
  actual_credits: number | null;
  pricing_version: number;
  card_count: number;
  result_text: string | null;
  deleted_at: string | null;
  error_code: string | null;
  safe_message: string | null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cleanString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** 白名单深选：只保留契约已知字段；任何图片字节、路径、URL、未知字段都进不了云端。 */
function sanitizeCards(raw: unknown): SanitizedCard[] {
  if (!Array.isArray(raw) || raw.length < MIN_CARDS || raw.length > MAX_CARDS) {
    throw new ApiError("invalid_request", `反推卡数量需在 ${MIN_CARDS}–${MAX_CARDS} 之间`);
  }
  return raw.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ApiError("invalid_request", "反推卡结构无效");
    }
    const card = item as Record<string, unknown>;
    const assetId = cleanString(card.assetId, 80);
    const captionId = cleanString(card.captionId, 80);
    const captionHash = cleanString(card.captionHash, 64);
    if (!assetId || !captionId || !/^[0-9a-f]{64}$/.test(captionHash)) {
      throw new ApiError("invalid_request", "反推卡标识无效");
    }
    const sections = (Array.isArray(card.sections) ? card.sections : []).slice(0, 32).map((section) => {
      if (!section || typeof section !== "object" || Array.isArray(section)) {
        throw new ApiError("invalid_request", "反推卡 section 无效");
      }
      const value = section as Record<string, unknown>;
      return { title: cleanString(value.title, 120), body: cleanString(value.body, 4000) };
    }).filter((section) => section.title && section.body);
    const dimensions: Record<string, string> = {};
    if (card.dimensions && typeof card.dimensions === "object" && !Array.isArray(card.dimensions)) {
      for (const [key, value] of Object.entries(card.dimensions as Record<string, unknown>)) {
        const cleanKey = cleanString(key, 40);
        const cleanValue = cleanString(value, 1000);
        if (cleanKey && cleanValue) dimensions[cleanKey] = cleanValue;
      }
    }
    const textFallback = cleanString(card.textFallback, 8000) || undefined;
    return {
      assetId,
      captionId,
      captionHash,
      sections,
      dimensions,
      textFallback,
      parseStatus: cleanString(card.parseStatus, 40) || "unknown",
      sourceClass: ["imported", "generated_confirmed", "generated_other"].includes(String(card.sourceClass))
        ? String(card.sourceClass)
        : "imported",
    };
  });
}

async function ownJob(admin: Parameters<typeof ensureDailyCredits>[0], userId: string, jobId: string): Promise<VisualProfileJob> {
  const { data, error } = await admin.from("visual_profile_jobs").select("*")
    .eq("id", jobId).eq("user_id", userId).maybeSingle();
  if (error) throw new ApiError("internal_error", "读取视觉设定任务失败", true);
  if (!data) throw new ApiError("invalid_request", "视觉设定任务不存在", false, 404);
  return data as unknown as VisualProfileJob;
}

function jobResponse(job: VisualProfileJob, cors: HeadersInit): Response {
  const common = {
    status: job.status,
    job_id: job.id,
    card_count: job.card_count,
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
    if (!job.result_text || job.deleted_at) {
      return jsonResponse({ ...common, error: { code: "content_expired", message: "提炼结果已过期" } }, 200, cors);
    }
    return jsonResponse({ ...common, draft: JSON.parse(job.result_text) }, 200, cors);
  }
  return jsonResponse({
    ...common,
    error: {
      code: job.error_code ?? job.status,
      message: job.safe_message ?? (job.status === "cancelled" ? "提炼任务已取消" : "云端提炼未完成"),
    },
  }, 200, cors);
}

async function actionCreate(
  admin: Parameters<typeof ensureDailyCredits>[0],
  user: { id: string; app_metadata?: unknown },
  body: Record<string, unknown>,
  cors: HeadersInit,
): Promise<Response> {
  const { data: subscription, error: subError } = await admin.from("subscriptions")
    .select("tier,status,current_period_end").eq("user_id", user.id).maybeSingle();
  if (subError) throw new ApiError("internal_error", "订阅状态读取失败", true);
  const policy = policyForUser(activeTier(subscription), user);
  if (!policy.can_use_visual_profiles) {
    throw new ApiError("upgrade_required", "当前权益不支持视觉设定提炼", false, 403);
  }

  const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.length >= 8
    ? body.idempotencyKey.slice(0, 200)
    : "";
  if (!idempotencyKey) throw new ApiError("invalid_request", "缺少幂等键");
  const cards = sanitizeCards(body.cards);
  const payload = JSON.stringify({ schema_version: 1, cards });
  if (payload.length > 2 * 1024 * 1024) throw new ApiError("invalid_request", "反推快照过大");
  const manifestHash = await sha256Hex(payload);

  await ensureDailyCredits(admin, user.id);
  let holdId: string | undefined;
  let jobId: string | undefined;
  try {
    const held = await holdCredits(admin, user.id, idempotencyKey, "visual_profile_extract");
    holdId = held.holdId;
    const existing = await admin.from("visual_profile_jobs").select("*")
      .eq("hold_id", held.holdId).maybeSingle();
    if (existing.error) throw new ApiError("internal_error", "读取幂等提炼任务失败", true);
    let job = existing.data as unknown as VisualProfileJob | null;
    if (job && job.input_manifest_hash !== manifestHash) {
      throw new ApiError("invalid_request", "幂等键已用于不同的提炼内容", false, 409);
    }
    if (job && job.status !== "uploading") return jobResponse(job, cors);
    if (job) jobId = job.id;

    if (!job) {
      jobId = crypto.randomUUID();
      const inserted = await admin.from("visual_profile_jobs").insert({
        id: jobId,
        user_id: user.id,
        idempotency_key: idempotencyKey,
        status: "uploading",
        request_object_key: `visual-profile/${jobId}/inputs/request.json`,
        input_manifest_hash: manifestHash,
        card_count: cards.length,
        hold_id: held.holdId,
        estimated_credits: held.estimated,
        pricing_version: held.pricingVersion,
        content_expires_at: new Date(Date.now() + CONTENT_TTL_MS).toISOString(),
      }).select("*").single();
      if (inserted.error || !inserted.data) throw new ApiError("internal_error", "创建提炼任务失败", true);
      job = inserted.data as unknown as VisualProfileJob;
      jobId = job.id;
    }

    // 云端成本预留 + 入队（与 understand 同款：桌面不参与上传，payload 由 Edge 暂存）。
    await reserveManagedUsage(admin, user.id, held.holdId, held.estimated, true);
    const upload = await admin.storage.from(BUCKET).upload(job.request_object_key, payload, {
      contentType: "application/json",
      upsert: true,
    });
    if (upload.error) throw new ApiError("internal_error", "暂存提炼输入失败", true);
    const queued = await admin.from("visual_profile_jobs").update({
      status: "queued",
      queued_at: new Date().toISOString(),
    }).eq("id", job.id).eq("status", "uploading").select("*").single();
    if (queued.error || !queued.data) throw new ApiError("internal_error", "提炼任务入队失败", true);
    return jobResponse(queued.data as unknown as VisualProfileJob, cors);
  } catch (error) {
    try {
      if (holdId) await rollbackCredits(admin, holdId, error instanceof ApiError ? error.code : "queue_failed");
      if (jobId) await admin.from("visual_profile_jobs").update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error_code: "queue_failed",
        safe_message: "提炼任务入队失败，请重试",
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
  const started = Date.now();
  let userId: string | undefined;
  try {
    cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") throw new ApiError("invalid_request", "仅支持 POST", false, 405);
    const { user, admin } = await requireUser(request);
    userId = user.id;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";
    if (action === "get" || (!action && typeof body.job_id === "string")) {
      const jobId = typeof body.job_id === "string" ? body.job_id : "";
      if (!jobId) throw new ApiError("invalid_request", "缺少 job_id");
      return jobResponse(await ownJob(admin, user.id, jobId), cors);
    }
    if (action && action !== "create") throw new ApiError("invalid_request", "未知 action");
    return await actionCreate(admin, user, body, cors);
  } catch (error) {
    safeLog({
      requestId: id,
      userId,
      service: "visual-profile",
      status: error instanceof ApiError ? error.code : "error",
      elapsedMs: Date.now() - started,
    });
    return errorResponse(error, id, cors);
  }
});
