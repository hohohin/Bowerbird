import { settleSyncUnderstand } from "./settlement.ts";
import { acceptTextUpload, beginSyncUnderstand, checkTextAcceptance, enqueueTextUpload, inspectTextUpload, readableTextResult, storeTextManifest, usageParameters } from "../_shared/text-job-upload.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { createArkAdapter, type ImageInput, type MockScenario } from "../_shared/ark.ts";
import { requireUser } from "../_shared/auth.ts";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { assertReferenceImages, corsHeaders, readJsonBody, withTimeout } from "../_shared/limits.ts";
import { isReplication, replicationOperations, replicationService, replicationPriceAvailable, validateReplication } from "../_shared/replication.ts";
import { shortRewrite, standardTextFits } from "../_shared/bcoin-text.ts";
import { imageMetadata } from "../_shared/image-metadata.ts";
import { FILE_SPEECH_AUDIO_NAME, FILE_SPEECH_BUCKET, FILE_SPEECH_KEY_PREFIX, FILE_SPEECH_MAX_DURATION_MS, FILE_SPEECH_MIME, FILE_SPEECH_OPERATION, FILE_SPEECH_SERVICE, fileSpeechAudioKey, parseFileSpeechAudio } from "../_shared/file-speech.ts";
import { libraryShotAction } from "../_shared/library-shot-edge.ts";
import { LIBRARY_VISUAL_PREFIX } from "../_shared/library-visual.ts";
import { commitLibraryVisual, getLibraryVisual, libraryVisualCapabilities, prepareLibraryVisual } from "../_shared/library-visual-edge.ts";

// 双模式：UNDERSTAND_ASYNC=false（默认）保持旧的「单次 Edge 请求内同步调方舟」行为；
// true 时切换为生图 G0 同款异步任务模式（create/get 短请求 + VPS Worker 领取执行），
// 目的是摆脱 Edge 墙钟上限。观察期后旧同步路径按生图 135/140s 回退的同一策略移除。
const asyncMode = (Deno.env.get("UNDERSTAND_ASYNC") ?? "false") === "true";

interface UnderstandRequest {
  idempotency_key: string;
  operation: "caption" | "autoname" | "classify" | "video-analysis" | "text-rewrite" | "speech-transcription";
  audio?: unknown;
  video?: unknown;
  rewrite?: unknown;
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
  deleted_at: string | null;
  content_expires_at: string;
  error_code: string | null;
  safe_message: string | null;
  operation: string;
}

function validate(body: unknown): UnderstandRequest {
  if (!body || typeof body !== "object") throw new ApiError("invalid_request", "请求格式错误");
  const value = body as Record<string, unknown>;
  if (typeof value.idempotency_key !== "string" || !value.idempotency_key.trim()) {
    throw new ApiError("invalid_request", "缺少幂等键");
  }
  if (!["caption", "autoname", "classify", ...replicationOperations].includes(String(value.operation))) {
    throw new ApiError("invalid_request", "未知理解操作");
  }
  if (isReplication(value.operation)) {
    if ((value.idempotency_key as string).length > 200) throw new ApiError("invalid_request", "幂等键过长");
    try { validateReplication(value); } catch (error) { throw new ApiError("invalid_request", error instanceof Error ? error.message : "复刻输入无效"); }
    return value as unknown as UnderstandRequest;
  }
  if (value.image == null) {
    // 纯文本调用：无图时必须带非空 instruction（桌面维度数据命名恒满足）。
    if (typeof value.instruction !== "string" || !value.instruction.trim()) {
      throw new ApiError("invalid_request", "缺少图片或指令");
    }
  } else {
    assertReferenceImages([value.image], 1);
    const image = value.image as ImageInput;
    const metadata = imageMetadata(Uint8Array.from(atob(image.base64), c => c.charCodeAt(0)));
    if (!metadata || metadata.width > 1600 || metadata.height > 1600) throw new ApiError("invalid_request", "标准图片理解最长边为 1600 像素，请先缩小图片");
  }
  if (value.instruction !== undefined &&
    (typeof value.instruction !== "string" || value.instruction.length > 20_000)) {
    throw new ApiError("invalid_request", "instruction 最多 20000 字符");
  }
  if (!standardTextFits(value.instruction)) throw new ApiError("invalid_request", "标准理解限 8000 字节文字输入；长文本请使用单独预算的 Agent 任务");
  return value as unknown as UnderstandRequest;
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
  return await inspectTextUpload(admin, "understand_jobs", data as unknown as UnderstandJob);
}

function jobResponse(job: UnderstandJob, cors: HeadersInit, uploadUrl?: string): Response {
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
    return jsonResponse(uploadUrl ? { ...common, upload_url: uploadUrl } : common, 202, cors);
  }
  if (job.status === "succeeded") {
    const text = readableTextResult(job);
    if (!text) {
      return jsonResponse({
        ...common,
        error: { code: "content_expired", message: "理解结果已过期" },
      }, 200, cors);
    }
    return jsonResponse({ ...common, text }, 200, cors);
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
  const replication = isReplication(body.operation);
  const requestPayload = JSON.stringify({
    schema_version: 1, operation: body.operation, image: body.image ?? null,
    instruction: body.instruction ?? null, mock_scenario: body.mock_scenario ?? null,
    ...(replication ? { video: body.video ?? null, rewrite: body.rewrite ?? null } : {}),
    ...(body.operation === "speech-transcription" ? { audio: body.audio } : {}),
  });
  const manifestHash = await sha256Hex(requestPayload);
  const job = await acceptTextUpload<UnderstandJob>(admin, "understand_jobs", {
    userId, key: body.idempotency_key, operation: body.operation,
    service: shortRewrite(body) ? "replication_text_rewrite_short" : replication ? replicationService(body.operation) : "caption",
    cards: null, payload: requestPayload, manifestHash,
  });
  return jobResponse(job, cors);
}

async function replicationCapabilities(admin: SupabaseClient) {
  const prices = await admin.from("service_costs").select("service,unit_cost,active,parameters").in("service", replicationOperations.map(replicationService));
  if (prices.error) throw new ApiError("internal_error", "读取复刻价格失败", true);
  return replicationOperations.map(operation => {
    const row = prices.data?.find(item => item.service === replicationService(operation));
    const available = replicationPriceAvailable(row);
    return { operation, available, credits: available ? Number(row!.unit_cost) : null };
  });
}

// true = an individually authorized pilot, false = public, null = recover only.
function fileSpeechPilotMode(userId: string): boolean | null {
  const pilotUserId = Deno.env.get("FILE_SPEECH_PILOT_USER_ID")?.trim();
  if (pilotUserId) return pilotUserId === userId ? true : null;
  return Deno.env.get("FILE_SPEECH_ENABLED") === "true" ? false : null;
}

async function fileSpeechCapabilities(admin: SupabaseClient, userId: string) {
  const result = { available: false, credits: null as number | null, max_duration_ms: FILE_SPEECH_MAX_DURATION_MS };
  const pilot = fileSpeechPilotMode(userId);
  if (pilot === null) return result;
  const { data, error } = await admin.from("service_costs").select("active,unit_cost,parameters")
    .eq("service", FILE_SPEECH_SERVICE).maybeSingle();
  if (error) throw new ApiError("internal_error", "读取视频转录报价失败", true);
  if (data && replicationPriceAvailable(data) && Number.isSafeInteger(data.unit_cost) &&
      (data.parameters?.pilot_only === true) === pilot) {
    result.available = true;
    result.credits = Number(data.unit_cost);
  }
  return result;
}

async function prepareFileSpeech(admin: SupabaseClient, userId: string, raw: Record<string, unknown>, cors: HeadersInit) {
  const key = raw.idempotency_key;
  const credits = raw.expected_credits;
  if (typeof key !== "string" || !key.startsWith(FILE_SPEECH_KEY_PREFIX) || key.length > 200 ||
      typeof credits !== "number" || !Number.isSafeInteger(credits) || credits <= 0) {
    throw new ApiError("invalid_request", "视频转录需要有效的任务编号和已确认报价");
  }
  let audio;
  try {
    audio = parseFileSpeechAudio(raw.audio);
  } catch {
    throw new ApiError("invalid_request", "音轨格式、大小或时长不符合转录要求");
  }
  const manifest = JSON.stringify({ schema_version: 1, operation: FILE_SPEECH_OPERATION, audio });
  const { data, error } = await admin.rpc("begin_file_speech_upload", {
    p_user_id: userId, p_key: key, p_hash: await sha256Hex(manifest), p_expected_credits: credits,
    p_source_duration_ms: audio.source_duration_ms, p_pilot: fileSpeechPilotMode(userId),
    ...usageParameters(),
  });
  if (error?.details === "stale_quote") throw new ApiError("invalid_request", "视频转录价格已变化，请重新核对报价", false, 409);
  if (error?.details === "file_speech_closed") throw new ApiError("not_configured", "整段转录暂未开放", false, 503);
  if (error?.details === "file_speech_pilot_used") throw new ApiError("invalid_request", "本次试转录名额已使用。已提交的任务可在原视频预览中恢复。", false, 409);
  if (error?.details === "price_unavailable") throw new ApiError("not_configured", "视频转录暂无可用报价");
  checkTextAcceptance(error);
  if (!data) throw new ApiError("internal_error", "视频转录任务状态未知，请按原任务恢复", true);
  const job = data as UnderstandJob;
  if (job.status !== "uploading") return jobResponse(job, cors);
  await storeTextManifest(admin, job.request_object_key, manifest);
  const { data: signed, error: signError } = await admin.storage.from(FILE_SPEECH_BUCKET)
    .createSignedUploadUrl(fileSpeechAudioKey(job.id), { upsert: false });
  if (signError || !signed?.signedUrl) throw new ApiError("internal_error", "音轨上传地址签发失败，请按原任务恢复", true);
  return jobResponse(job, cors, signed.signedUrl);
}

async function commitFileSpeech(admin: SupabaseClient, userId: string, jobId: unknown, cors: HeadersInit) {
  if (typeof jobId !== "string" || !jobId) throw new ApiError("invalid_request", "缺少转录任务编号");
  const job = await ownJob(admin, userId, jobId);
  if (job.operation !== FILE_SPEECH_OPERATION) throw new ApiError("invalid_request", "任务类型不匹配");
  if (job.status !== "uploading") return jobResponse(job, cors);
  const bucket = admin.storage.from(FILE_SPEECH_BUCKET);
  const audioKey = fileSpeechAudioKey(job.id);
  const [stored, list] = await Promise.all([
    bucket.download(job.request_object_key),
    bucket.list(audioKey.slice(0, audioKey.lastIndexOf("/")), { search: FILE_SPEECH_AUDIO_NAME, limit: 10 }),
  ]);
  if (stored.error || !stored.data || list.error) throw new ApiError("internal_error", "音轨上传状态未确认，请按原任务恢复", true);
  const manifest = await stored.data.text();
  if (await sha256Hex(manifest) !== job.input_manifest_hash) throw new ApiError("internal_error", "转录输入校验失败");
  const expected = parseFileSpeechAudio(JSON.parse(manifest).audio);
  const uploaded = list.data?.find(file => file.name === FILE_SPEECH_AUDIO_NAME);
  if (!uploaded) return jobResponse(job, cors);
  if (Number(uploaded.metadata?.size) !== expected.bytes || uploaded.metadata?.mimetype !== FILE_SPEECH_MIME) {
    throw new ApiError("invalid_request", "上传的音轨大小或格式与原任务不一致");
  }
  return jobResponse(await enqueueTextUpload(admin, "understand_jobs", job), cors);
}

Deno.serve(async (request) => {
  const id = requestId(request);
  let cors: HeadersInit = {};
  let userId: string | undefined;
  const started = performance.now();
  try {
    cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") throw new ApiError("invalid_request", "仅支持 POST", false, 405);
    const { user, admin } = await requireUser(request);
    userId = user.id;
    const raw = await readJsonBody(request, 50 * 1024 * 1024);
    if (raw.action === "replication-capabilities") return jsonResponse({ services: await replicationCapabilities(admin) }, 200, cors);
    if (["library-shot-quote","library-shot-prepare","library-shot-commit","library-shot-get"].includes(String(raw.action)) ||
        (raw.action === "get-by-key" && typeof raw.idempotency_key === "string" && raw.idempotency_key.startsWith("library-shot:"))) {
      return await libraryShotAction(admin,user.id,raw,cors);
    }
    if (raw.action === "library-visual-capabilities") return jsonResponse(await libraryVisualCapabilities(admin), 200, cors);
    if (raw.action === "library-visual-prepare") return await prepareLibraryVisual(admin, user.id, raw, cors);
    if (raw.action === "library-visual-commit") return await commitLibraryVisual(admin, user.id, raw.job_id, cors);
    if (raw.action === "library-visual-get") {
      if (typeof raw.job_id !== "string") throw new ApiError("invalid_request", "缺少画面分析任务编号");
      return await getLibraryVisual(admin, user.id, "id", raw.job_id, cors);
    }
    if (raw.action === "file-speech-capabilities") return jsonResponse(await fileSpeechCapabilities(admin, user.id), 200, cors);
    if (raw.action === "file-speech-prepare") return await prepareFileSpeech(admin, user.id, raw, cors);
    if (raw.action === "file-speech-commit") return await commitFileSpeech(admin, user.id, raw.job_id, cors);
    if (raw.action === "get-by-key") {
      if (typeof raw.idempotency_key === "string" && raw.idempotency_key.startsWith(LIBRARY_VISUAL_PREFIX) && raw.idempotency_key.length <= 200) {
        return await getLibraryVisual(admin, user.id, "idempotency_key", raw.idempotency_key, cors);
      }
      if (typeof raw.idempotency_key !== "string" || raw.idempotency_key.length > 200 ||
          !["replication:", FILE_SPEECH_KEY_PREFIX].some(prefix => (raw.idempotency_key as string).startsWith(prefix))) {
        throw new ApiError("invalid_request", "原任务编号无效");
      }
      const result = await admin.from("understand_jobs").select("*").eq("user_id", user.id).eq("idempotency_key", raw.idempotency_key).maybeSingle();
      if (result.error) throw new ApiError("internal_error", "查回原任务失败", true);
      if (!result.data) throw new ApiError("invalid_request", "尚未找到原 Cloud 任务，请稍后重查", false, 404);
      return jobResponse(await inspectTextUpload(admin, "understand_jobs", result.data as UnderstandJob), cors);
    }

    // Server-owned brand prompts are resolved exclusively on the VPS worker.
    if (asyncMode || isReplication(raw.operation) || raw.instruction === "bowerbird:brand-visual-observation:v2" || raw.action === "get" || typeof raw.job_id === "string") {
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
      safeLog({ requestId: id, userId, service: "understand-proxy", status: String(response.status), elapsedMs: performance.now() - started });
      return response;
    }

    // 兼容同步响应格式；已尝试提交但结果未知的任务保留原预授权。
    const body = validate(raw);
    const held = await beginSyncUnderstand(admin, user.id, body.idempotency_key);
    const { result, confirmed } = await settleSyncUnderstand(admin, held.holdId, () => withTimeout(createArkAdapter().understand({
      operation: body.operation as "caption" | "autoname" | "classify",
      image: body.image,
      instruction: body.instruction,
      scenario: body.mock_scenario,
    }), 120_000));
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
    safeLog({ requestId: id, userId, service: "caption", status: error instanceof ApiError ? error.code : "internal_error", elapsedMs: performance.now() - started });
    return errorResponse(error, id, cors);
  }
});
