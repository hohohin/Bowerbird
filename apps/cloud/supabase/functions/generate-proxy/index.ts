import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { ImageInput, MockScenario } from "../_shared/ark.ts";
import { requireUser } from "../_shared/auth.ts";
import { ensureDailyCredits, holdCredits, rollbackCredits } from "../_shared/billing.ts";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { assertBodySize, assertReferenceImages, corsHeaders } from "../_shared/limits.ts";
import { reserveManagedUsage } from "../_shared/usage.ts";

const BUCKET = "generation-temp";
const CONTENT_TTL_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_URL_SECONDS = 300;

interface GenerateRequest {
  idempotency_key: string;
  media: "image" | "video";
  prompt: string;
  reference_images?: ImageInput[];
  ratio?: string;
  service?: string;
  mock_scenario?: MockScenario;
}

interface GenerationJob {
  id: string;
  user_id: string;
  status: string;
  progress: number;
  service: string;
  hold_id: string;
  estimated_credits: number;
  actual_credits: number | null;
  pricing_version: number;
  input_manifest_hash: string;
  request_object_key: string;
  output_object_key: string | null;
  output_mime: string | null;
  output_bytes: number | null;
  output_sha256: string | null;
  safe_message: string | null;
  error_code: string | null;
  content_expires_at: string;
}

function validate(body: unknown): GenerateRequest {
  if (!body || typeof body !== "object") throw new ApiError("invalid_request", "请求格式错误");
  const value = body as Record<string, unknown>;
  if (typeof value.idempotency_key !== "string" || !value.idempotency_key.trim() || value.idempotency_key.length > 200) {
    throw new ApiError("invalid_request", "缺少有效幂等键");
  }
  if (value.media !== "image") {
    throw new ApiError("invalid_request", "异步 Cloud 当前仅支持图片生成");
  }
  if (typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 20_000) {
    throw new ApiError("invalid_request", "prompt 不能为空且最多 20000 字符");
  }
  assertReferenceImages(value.reference_images ?? [], 10);
  return value as unknown as GenerateRequest;
}

function serviceFor(body: GenerateRequest): "image_sd" | "image_hd" {
  const service = body.service ?? "image_sd";
  if (service !== "image_sd" && service !== "image_hd") {
    throw new ApiError("invalid_request", "service 与生成媒体类型不匹配");
  }
  return service;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function ownJob(admin: SupabaseClient, userId: string, jobId: string): Promise<GenerationJob> {
  const { data, error } = await admin.from("generation_jobs").select("*")
    .eq("id", jobId).eq("user_id", userId).maybeSingle();
  if (error) throw new ApiError("internal_error", "读取云任务失败", true);
  if (!data) throw new ApiError("invalid_request", "云任务不存在", false, 404);
  return data as unknown as GenerationJob;
}

async function jobResponse(admin: SupabaseClient, job: GenerationJob, cors: HeadersInit): Promise<Response> {
  const common = {
    status: job.status,
    job_id: job.id,
    remote_task_id: job.id,
    progress: job.progress,
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
    if (!job.output_object_key || !job.output_mime || !job.output_bytes || !job.output_sha256) {
      throw new ApiError("internal_error", "云任务产物元数据不完整", true);
    }
    const { data, error } = await admin.storage.from(BUCKET)
      .createSignedUrl(job.output_object_key, DOWNLOAD_URL_SECONDS);
    if (error || !data?.signedUrl) throw new ApiError("internal_error", "云图片下载地址签发失败", true);
    return jsonResponse({
      ...common,
      artifact: {
        url: data.signedUrl,
        mime: job.output_mime,
        bytes: job.output_bytes,
        sha256: job.output_sha256,
        expires_in: DOWNLOAD_URL_SECONDS,
      },
    }, 200, cors);
  }
  return jsonResponse({
    ...common,
    error: {
      code: job.error_code ?? job.status,
      message: job.safe_message ?? (job.status === "cancelled" ? "任务已取消" : "云生成未完成"),
    },
  }, 200, cors);
}

async function actionGet(
  admin: SupabaseClient,
  userId: string,
  jobId: string,
  cors: HeadersInit,
): Promise<Response> {
  if (!jobId) throw new ApiError("invalid_request", "缺少 job_id");
  return await jobResponse(admin, await ownJob(admin, userId, jobId), cors);
}

async function actionCancel(
  admin: SupabaseClient,
  userId: string,
  jobId: string,
  cors: HeadersInit,
): Promise<Response> {
  if (!jobId) throw new ApiError("invalid_request", "缺少 job_id");
  const result = await admin.rpc("cancel_generation_job", { p_job_id: jobId, p_user_id: userId });
  if (result.error) throw new ApiError("invalid_request", "云任务不存在或无法取消", false, 404);
  const raw = Array.isArray(result.data) ? result.data[0] : result.data;
  return await jobResponse(admin, raw as GenerationJob, cors);
}

async function actionReceived(admin: SupabaseClient, userId: string, jobId: string, cors: HeadersInit): Promise<Response> {
  const job = await ownJob(admin, userId, jobId);
  if (job.status !== "succeeded") throw new ApiError("invalid_request", "云任务尚未成功");
  const { error } = await admin.from("generation_jobs").update({ downloaded_at: new Date().toISOString() })
    .eq("id", jobId).eq("user_id", userId).is("downloaded_at", null);
  if (error) throw new ApiError("internal_error", "确认云图片接收失败", true);
  return jsonResponse({ status: "received", job_id: jobId }, 200, cors);
}

async function createJob(
  admin: SupabaseClient,
  userId: string,
  body: GenerateRequest,
  cors: HeadersInit,
): Promise<Response> {
  await ensureDailyCredits(admin, userId);
  const service = serviceFor(body);
  const held = await holdCredits(admin, userId, body.idempotency_key, service);
  const requestPayload = JSON.stringify({
    schema_version: 1,
    media: "image",
    prompt: body.prompt,
    reference_images: body.reference_images ?? [],
    ratio: body.ratio ?? null,
    mock_scenario: body.mock_scenario ?? null,
  });
  const manifestHash = await sha256Hex(requestPayload);

  const existingResult = await admin.from("generation_jobs").select("*")
    .eq("hold_id", held.holdId).maybeSingle();
  if (existingResult.error) throw new ApiError("internal_error", "读取幂等云任务失败", true);
  let job = existingResult.data as unknown as GenerationJob | null;
  if (job && job.input_manifest_hash !== manifestHash) {
    throw new ApiError("invalid_request", "幂等键已用于不同的生成内容", false, 409);
  }
  if (job && job.status !== "uploading") return await jobResponse(admin, job, cors);

  if (!job) {
    const jobId = crypto.randomUUID();
    const requestObjectKey = `jobs/${jobId}/inputs/request.json`;
    const { data, error } = await admin.from("generation_jobs").insert({
      id: jobId,
      user_id: userId,
      idempotency_key: body.idempotency_key,
      service,
      status: "uploading",
      request_object_key: requestObjectKey,
      input_manifest_hash: manifestHash,
      input_count: body.reference_images?.length ?? 0,
      hold_id: held.holdId,
      estimated_credits: held.estimated,
      pricing_version: held.pricingVersion,
      content_expires_at: new Date(Date.now() + CONTENT_TTL_MS).toISOString(),
    }).select("*").single();
    if (error || !data) throw new ApiError("internal_error", "创建云任务失败", true);
    job = data as unknown as GenerationJob;
  }

  try {
    // Replays are allowed only while the durable job is still in `uploading`.
    await reserveManagedUsage(admin, userId, held.holdId, held.estimated, true);
    const upload = await admin.storage.from(BUCKET).upload(job.request_object_key, requestPayload, {
      contentType: "application/json",
      upsert: true,
    });
    if (upload.error) throw new ApiError("internal_error", "暂存云生成输入失败", true);
    const { data, error } = await admin.from("generation_jobs").update({
      status: "queued",
      progress: 1,
      queued_at: new Date().toISOString(),
    }).eq("id", job.id).eq("status", "uploading").select("*").single();
    if (error || !data) throw new ApiError("internal_error", "云任务入队失败", true);
    job = data as unknown as GenerationJob;
  } catch (error) {
    try {
      await rollbackCredits(admin, held.holdId, error instanceof ApiError ? error.code : "queue_failed");
      await admin.from("generation_jobs").update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error_code: "queue_failed",
        safe_message: "云任务入队失败，请重试",
      }).eq("id", job.id).eq("status", "uploading");
    } catch {
      // Stale-hold reconciliation remains the final safety net.
    }
    throw error;
  }
  return await jobResponse(admin, job, cors);
}

Deno.serve(async (request) => {
  const id = requestId(request);
  let cors: HeadersInit = {};
  const started = performance.now();
  let userId: string | undefined;
  try {
    cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") throw new ApiError("invalid_request", "仅支持 POST", false, 405);
    assertBodySize(request);
    const { user, admin } = await requireUser(request);
    userId = user.id;
    const raw = await request.json() as Record<string, unknown>;
    const action = typeof raw.action === "string" ? raw.action : "";
    const jobId = typeof raw.job_id === "string"
      ? raw.job_id
      : typeof raw.remote_task_id === "string" ? raw.remote_task_id : "";

    let response: Response;
    if (action === "get" || (!action && jobId)) response = await actionGet(admin, user.id, jobId, cors);
    else if (action === "cancel") response = await actionCancel(admin, user.id, jobId, cors);
    else if (action === "artifact_received") response = await actionReceived(admin, user.id, jobId, cors);
    else if (action) throw new ApiError("invalid_request", "未知 action");
    else response = await createJob(admin, user.id, validate(raw), cors);

    safeLog({ requestId: id, userId, service: "generate-proxy", status: response.status, elapsedMs: performance.now() - started });
    return response;
  } catch (error) {
    safeLog({ requestId: id, userId, service: "generate-proxy", status: error instanceof ApiError ? error.code : "internal_error", elapsedMs: performance.now() - started });
    return errorResponse(error, id, cors);
  }
});
