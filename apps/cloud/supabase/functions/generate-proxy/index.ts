import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { ImageInput, MockScenario } from "../_shared/ark.ts";
import { requireUser } from "../_shared/auth.ts";
import { ensureDailyCredits, holdCredits } from "../_shared/billing.ts";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { assertBodySize, assertReferenceImages, corsHeaders } from "../_shared/limits.ts";
import { reserveManagedUsage } from "../_shared/usage.ts";
import { LAYER_SERVICES, validateLayerRequest, type LayerOptions } from "../_shared/layer-contract.ts";
import { validateVideoInput, videoService, type CloudVideoOptions, type VideoReference, type VideoInput } from "../_shared/video-contract.ts";

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
  /** 透明图层：映射 Ark `/images/generations` 的 `background: "transparent"`（仅图片）。 */
  transparent?: boolean;
  mock_scenario?: MockScenario;
  video_options?: CloudVideoOptions;
  reference_videos?: VideoReference[];
  layer_options?: LayerOptions;
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
  if (value.media !== "image" && value.media !== "video") {
    throw new ApiError("invalid_request", "不支持的生成媒体类型");
  }
  if (typeof value.prompt !== "string" || (!value.prompt.trim() && value.service !== "image_layer_decompose") || value.prompt.length > 20_000) {
    throw new ApiError("invalid_request", "prompt 不能为空且最多 20000 字符");
  }
  assertReferenceImages(value.reference_images ?? [], value.media === "video" ? 30 : 10);
  try { validateLayerRequest(value, String(value.service ?? "image_sd")); }
  catch (error) { throw new ApiError("invalid_request", error instanceof Error ? error.message : "分层参数无效"); }
  if (value.media === "video") {
    if (Deno.env.get("BOWERBIRD_CLOUD_MOCK") !== "false") throw new ApiError("not_configured", "视频服务尚未启用真实生成");
    try { validateVideoInput({ ...value, schema_version: 1, ratio: value.ratio ?? null, reference_images: value.reference_images ?? [], reference_videos: value.reference_videos ?? [] } as unknown as VideoInput); }
    catch { throw new ApiError("invalid_request", "视频参数或参考素材无效，请检查模式、时长和比例"); }
  } else if (value.video_options || (Array.isArray(value.reference_videos) && value.reference_videos.length)) {
    throw new ApiError("invalid_request", "图片生成不能携带视频参数");
  }
  if (value.transparent !== undefined && (typeof value.transparent !== "boolean" || value.media !== "image")) {
    throw new ApiError("invalid_request", "透明图层仅图片生成支持");
  }
  return value as unknown as GenerateRequest;
}

// service 校验是数据驱动的：形状必须是 image_*（防止把 video_*/caption 等高价服务当生图扣费），
// 且必须是 service_costs 中 active 的行（0018 起新档位只加数据、不改代码）。
async function serviceFor(admin: SupabaseClient, body: GenerateRequest): Promise<string> {
  const service = body.service ?? (body.media === "video" && body.video_options ? videoService(body.video_options.video_resolution) : "image_sd");
  if (body.media === "video" ? service !== videoService(body.video_options!.video_resolution) : !/^image_[a-z0-9_]{1,40}$/.test(service)) {
    throw new ApiError("invalid_request", "service 与生成媒体类型不匹配");
  }
  const { data } = await admin.from("service_costs").select("service,unit_cost,parameters").eq("service", service)
    .eq("active", true).maybeSingle();
  if (!data) {
    throw new ApiError("invalid_request", LAYER_SERVICES.includes(service as typeof LAYER_SERVICES[number]) ? "分层服务尚未开放，请等待积分定价与服务启用" : "service 与生成媒体类型不匹配");
  }
  if (LAYER_SERVICES.includes(service as typeof LAYER_SERVICES[number]) && (Number(data.unit_cost) <= 0 || data.parameters?.pricing_ready !== true)) throw new ApiError("not_configured", "分层服务价格尚未确认");
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
  const settlementPending = job.status === "outcome_unknown" && job.error_code === "video_usage_exceeds_reservation";
  if (job.status === "succeeded" || settlementPending) {
    if (Date.parse(job.content_expires_at) <= Date.now()) return jsonResponse({ ...common, status: "artifact_expired", error: { code: "artifact_expired", message: "视频产物已超过保留期限；用量和结算记录仍保留" } }, 200, cors);
    if (!job.output_object_key || !job.output_mime || !job.output_bytes || !job.output_sha256) {
      throw new ApiError("internal_error", "云任务产物元数据不完整", true);
    }
    const { data, error } = await admin.storage.from(BUCKET)
      .createSignedUrl(job.output_object_key, DOWNLOAD_URL_SECONDS);
    if (error || !data?.signedUrl) throw new ApiError("internal_error", "云图片下载地址签发失败", true);
    return jsonResponse({
      ...common,
      ...(settlementPending ? { status: "settlement_pending" } : {}),
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
  if (job.status !== "succeeded" && !(job.status === "outcome_unknown" && job.error_code === "video_usage_exceeds_reservation")) throw new ApiError("invalid_request", "云任务尚未成功");
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
  const service = await serviceFor(admin, body);
  let held;
  if (body.media === "video") {
    const result = await admin.rpc("credit_hold_video", { p_user_id: userId, p_idempotency_key: body.idempotency_key, p_service: service, p_duration: body.video_options!.duration, p_has_video: Boolean(body.reference_videos?.length) });
    const row = result.data?.[0];
    if (result.error || !row) throw new ApiError("invalid_request", "视频积分预授权失败：请检查积分和服务配置");
    held = { holdId: String(row.hold_id), estimated: Number(row.estimated_amount), pricingVersion: Number(row.pricing_version) };
  } else held = await holdCredits(admin, userId, body.idempotency_key, service);
  const existingResult = await admin.from("generation_jobs").select("*").eq("hold_id", held.holdId).maybeSingle();
  if (existingResult.error) throw new ApiError("internal_error", "读取幂等云任务失败", true);
  let job = existingResult.data as unknown as GenerationJob | null;
  // The hold is unique per user/key: concurrent creates compile identical paths/manifests.
  const jobId = job?.id ?? held.holdId;
  const videoReferences = (body.reference_videos ?? []).map((reference, index) => ({
    object_key: `jobs/${jobId}/inputs/video-${index}.${reference.mime === "video/quicktime" ? "mov" : "mp4"}`,
    bytes: reference.bytes, mime: reference.mime ?? "video/mp4",
  }));
  const requestPayload = JSON.stringify({
    schema_version: 1,
    media: body.media,
    prompt: body.prompt,
    reference_images: body.reference_images ?? [],
    ratio: body.ratio ?? null,
    mock_scenario: body.mock_scenario ?? null,
    ...(body.media === "video" ? { video_options: body.video_options, reference_videos: videoReferences } : {}),
    ...(body.media === "image" ? { transparent: body.transparent === true } : {}),
    ...(body.layer_options ? { layer_options: body.layer_options } : {}),
  });
  const manifestHash = await sha256Hex(requestPayload);

  if (job && job.input_manifest_hash !== manifestHash) {
    throw new ApiError("invalid_request", "幂等键已用于不同的生成内容", false, 409);
  }
  if (job && job.status !== "uploading") return await jobResponse(admin, job, cors);
  if (job && Date.parse(job.content_expires_at) <= Date.now()) throw new ApiError("invalid_request", "上传已过期，请取消原任务后重新开始");

  if (!job) {
    const requestObjectKey = `jobs/${jobId}/inputs/request.json`;
    const { data, error } = await admin.from("generation_jobs").insert({
      id: jobId,
      user_id: userId,
      idempotency_key: body.idempotency_key,
      service,
      status: "uploading",
      request_object_key: requestObjectKey,
      input_manifest_hash: manifestHash,
      input_count: (body.reference_images?.length ?? 0) + videoReferences.length,
      hold_id: held.holdId,
      estimated_credits: held.estimated,
      pricing_version: held.pricingVersion,
      content_expires_at: new Date(Date.now() + CONTENT_TTL_MS).toISOString(),
    }).select("*").single();
    if (error || !data) {
      job = await ownJob(admin, userId, jobId);
      if (job.input_manifest_hash !== manifestHash) throw new ApiError("invalid_request", "幂等键已用于不同的生成内容", false, 409);
      if (job.status !== "uploading") return await jobResponse(admin, job, cors);
    } else job = data as unknown as GenerationJob;
  }

  try {
    // Replays are allowed only while the durable job is still in `uploading`.
    let providerCostMicros: number | undefined;
    if (body.media === "video") {
      const snapshot = await admin.from("credit_holds").select("video_pricing_snapshot").eq("id", held.holdId).eq("user_id", userId).single();
      const price = snapshot.data?.video_pricing_snapshot;
      providerCostMicros = Math.ceil(Number(price?.max_tokens) * Number(price?.provider_cny_per_million));
      if (snapshot.error || !Number.isSafeInteger(providerCostMicros) || providerCostMicros <= 0) throw new ApiError("not_configured", "视频成本快照无效");
    }
    await reserveManagedUsage(admin, userId, held.holdId, held.estimated, true, providerCostMicros);
    const upload = await admin.storage.from(BUCKET).upload(job.request_object_key, requestPayload, {
      contentType: "application/json",
      upsert: true,
    });
    if (upload.error) throw new ApiError("internal_error", "暂存云生成输入失败", true);
    const missingUploads = [];
    for (const [index, reference] of videoReferences.entries()) {
      const listed = await admin.storage.from(BUCKET).list(`jobs/${job.id}/inputs`, { search: `video-${index}.`, limit: 10 });
      if (listed.error) throw new ApiError("internal_error", "读取视频上传状态失败", true);
      const existing = listed.data?.find(file => reference.object_key.endsWith(`/${file.name}`));
      if (existing && Number(existing.metadata?.size) !== reference.bytes) throw new ApiError("invalid_request", "参考视频大小与声明不符");
      if (!existing) {
        const signed = await admin.storage.from(BUCKET).createSignedUploadUrl(reference.object_key, { upsert: false });
        if (signed.error || !signed.data) throw new ApiError("internal_error", "签发参考视频上传地址失败", true);
        missingUploads.push({ index, object_key: reference.object_key, upload_url: signed.data.signedUrl });
      }
    }
    if (missingUploads.length) return jsonResponse({ status: "uploading", remote_task_id: job.id, reference_uploads: missingUploads }, 202, cors);
    const { data, error } = await admin.rpc("enqueue_generation_job", { p_job_id: job.id, p_user_id: userId });
    if (error || !data) throw new ApiError("internal_error", "云任务入队失败", true);
    job = data as unknown as GenerationJob;
  } catch (error) {
    try {
      await admin.rpc("fail_uploading_generation_job", { p_job_id: job.id, p_user_id: userId });
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
    if (action === "layer_quote") {
      const prices = await admin.from("service_costs").select("service,unit_cost,active,parameters").in("service", [...LAYER_SERVICES]);
      if (prices.error) throw new ApiError("internal_error", "分层价格读取失败", true);
      response = jsonResponse({ status: "quoted", services: LAYER_SERVICES.map(service => {
        const row = prices.data?.find(row => row.service === service);
        const available = !!row?.active && row.parameters?.pricing_ready === true && Number(row.unit_cost) > 0;
        return { service, available, credits: available ? row!.unit_cost : null };
      }) }, 200, cors);
    }
    else if (action === "get" || (!action && jobId)) response = await actionGet(admin, user.id, jobId, cors);
    else if (action === "get_by_key") {
      if (typeof raw.idempotency_key !== "string" || !raw.idempotency_key) throw new ApiError("invalid_request", "缺少幂等键");
      const found = await admin.from("generation_jobs").select("*").eq("user_id", user.id).eq("idempotency_key", raw.idempotency_key).maybeSingle();
      if (found.error) throw new ApiError("internal_error", "读取原任务失败", true);
      response = found.data ? await jobResponse(admin, found.data as GenerationJob, cors) : jsonResponse({ status: "not_found" }, 404, cors);
    }
    else if (action === "abandon_video_upload") {
      const job = await ownJob(admin, user.id, jobId);
      if (!job.service.startsWith("video_seedance25_")) throw new ApiError("invalid_request", "仅支持结束未完成的视频上传");
      const result = await admin.rpc("fail_uploading_generation_job", { p_job_id: jobId, p_user_id: user.id });
      if (result.error) throw new ApiError("internal_error", "结束视频上传失败", true);
      response = await actionGet(admin, user.id, jobId, cors);
    }
    else if (action === "cancel") response = await actionCancel(admin, user.id, jobId, cors);
    else if (action === "artifact_received") response = await actionReceived(admin, user.id, jobId, cors);
    else if (action) throw new ApiError("invalid_request", "未知 action");
    else response = await createJob(admin, user.id, validate(raw), cors);

    safeLog({ requestId: id, userId, service: "generate-proxy", status: String(response.status), elapsedMs: performance.now() - started });
    return response;
  } catch (error) {
    safeLog({ requestId: id, userId, service: "generate-proxy", status: error instanceof ApiError ? error.code : "internal_error", elapsedMs: performance.now() - started });
    return errorResponse(error, id, cors);
  }
});
