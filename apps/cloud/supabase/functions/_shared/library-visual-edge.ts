import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ApiError, jsonResponse } from "./errors.ts";
import { FILE_SPEECH_BUCKET as BUCKET } from "./file-speech.ts";
import { checkTextAcceptance, usageParameters } from "./text-job-upload.ts";
import {
  LIBRARY_VISUAL_MAX_SEGMENT_MS, LIBRARY_VISUAL_PREFIX, LIBRARY_VISUAL_SERVICE, LIBRARY_VISUAL_VIDEO_NAME,
  libraryVisualVideoKey, parseLibraryVisualVideo,
} from "./library-visual.ts";

type Parent = { credits: number; hold_id: string; pricing_version: number; expires_at: string; finished_status: string | null };
type Segment = { id: string; status: string; video: unknown; result_text: string | null; error_code: string | null; safe_message: string | null };

function enabled() { return Deno.env.get("LIBRARY_VISUAL_ENABLED") === "true"; }

async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function libraryVisualCapabilities(admin: SupabaseClient) {
  const unavailable = { available: false, credits_per_hour: null, pricing_version: null, max_segment_duration_ms: LIBRARY_VISUAL_MAX_SEGMENT_MS };
  if (!enabled()) return unavailable;
  const { data, error } = await admin.from("service_costs").select("active,unit_cost,pricing_version,parameters")
    .eq("service", LIBRARY_VISUAL_SERVICE).maybeSingle();
  if (error) throw new ApiError("internal_error", "画面分析报价读取失败", true);
  return data?.active && data.parameters?.pricing_ready === true && Number.isSafeInteger(data.unit_cost) && data.unit_cost > 0
    ? { ...unavailable, available: true, credits_per_hour: Number(data.unit_cost), pricing_version: Number(data.pricing_version) }
    : unavailable;
}

function response(segment: Segment, parent: Parent, cors: HeadersInit, uploadUrl?: string): Response {
  const common = { job_id: segment.id, charge: {
    estimated: parent.credits, actual: parent.finished_status === "succeeded" ? parent.credits : null,
    refunded: parent.finished_status === "failed",
    transaction_id: parent.hold_id, pricing_version: parent.pricing_version,
  } };
  if (Date.parse(parent.expires_at) <= Date.now()) {
    return jsonResponse({ ...common, status: "failed", error: { code: "content_expired", message: "画面分析结果已过期" } }, 200, cors);
  }
  if (segment.status === "succeeded") return jsonResponse({ ...common, status: segment.status, text: segment.result_text }, 200, cors);
  if (segment.status === "failed" || segment.status === "outcome_unknown") {
    return jsonResponse({ ...common, status: segment.status,
      error: { code: segment.error_code ?? segment.status, message: segment.safe_message ?? "画面分析未完成" },
    }, 200, cors);
  }
  return jsonResponse({ ...common, status: segment.status, ...(uploadUrl ? { upload_url: uploadUrl } : {}) }, 202, cors);
}

export async function libraryVisualLookup(admin: SupabaseClient, userId: string, field: "id" | "idempotency_key", value: string) {
  const { data, error } = await admin.from("library_visual_segments").select("*, parent:library_visual_jobs(*)").eq("user_id", userId).eq(field, value).maybeSingle();
  if (error) throw new ApiError("internal_error", "画面分析任务读取失败", true);
  return data as Segment & { parent: Parent } | null;
}

export async function prepareLibraryVisual(admin: SupabaseClient, userId: string, raw: Record<string, unknown>, cors: HeadersInit) {
  const key = (value: unknown): value is string => typeof value === "string" && value.startsWith(LIBRARY_VISUAL_PREFIX) && value.length >= 16 && value.length <= 200;
  if (!key(raw.parent_key) || !key(raw.idempotency_key) || raw.parent_key === raw.idempotency_key ||
      typeof raw.expected_credits !== "number" || !Number.isSafeInteger(raw.expected_credits) ||
      raw.expected_credits < 1 || raw.expected_credits > 2147483647 ||
      typeof raw.pricing_version !== "number" || !Number.isSafeInteger(raw.pricing_version) ||
      raw.pricing_version < 1 || raw.pricing_version > 2147483647) {
    throw new ApiError("invalid_request", "画面分析需要有效任务编号及已确认报价");
  }
  let video;
  try { video = parseLibraryVisualVideo(raw.video); }
  catch { throw new ApiError("invalid_request", "画面代理格式、大小或时长不符合要求"); }
  const { data, error } = await admin.rpc("begin_library_visual_segment", {
    p_user_id: userId, p_parent_key: raw.parent_key, p_segment_key: raw.idempotency_key, p_video: video,
    p_hash: await sha256(new TextEncoder().encode(JSON.stringify(video))),
    p_expected_credits: raw.expected_credits, p_pricing_version: raw.pricing_version, p_admission_enabled: enabled(),
    ...usageParameters(),
  });
  if (error?.details === "stale_quote") throw new ApiError("invalid_request", "画面分析报价已变化", false, 409);
  if (["library_visual_closed", "price_unavailable"].includes(error?.details ?? "")) {
    throw new ApiError("not_configured", "素材库画面分析暂未开放", false, 503);
  }
  checkTextAcceptance(error);
  if (!data) throw new ApiError("internal_error", "画面分析任务状态未知，请按原任务恢复", true);
  const { segment, parent } = data as { segment: Segment; parent: Parent };
  if (segment.status !== "uploading" || Date.parse(parent.expires_at) <= Date.now()) return response(segment, parent, cors);
  const signed = await admin.storage.from(BUCKET).createSignedUploadUrl(libraryVisualVideoKey(segment.id), { upsert: false });
  if (signed.error || !signed.data?.signedUrl) throw new ApiError("internal_error", "画面代理上传地址签发失败", true);
  return response(segment, parent, cors, signed.data.signedUrl);
}

export async function getLibraryVisual(admin: SupabaseClient, userId: string, field: "id" | "idempotency_key", value: string, cors: HeadersInit) {
  if (field === "id" && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) {
    throw new ApiError("invalid_request", "画面分析任务编号无效");
  }
  const segment = await libraryVisualLookup(admin, userId, field, value);
  if (!segment) throw new ApiError("invalid_request", "未找到原画面分析任务", false, 404);
  return response(segment, segment.parent, cors);
}

export async function commitLibraryVisual(admin: SupabaseClient, userId: string, jobId: unknown, cors: HeadersInit) {
  if (typeof jobId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(jobId)) {
    throw new ApiError("invalid_request", "缺少画面分析任务编号");
  }
  const segment = await libraryVisualLookup(admin, userId, "id", jobId);
  if (!segment) throw new ApiError("invalid_request", "未找到原画面分析任务", false, 404);
  if (segment.status !== "uploading" || Date.parse(segment.parent.expires_at) <= Date.now()) return response(segment, segment.parent, cors);
  const expected = parseLibraryVisualVideo(segment.video);
  const key = libraryVisualVideoKey(jobId);
  const bucket = admin.storage.from(BUCKET);
  const stored = await bucket.list(key.slice(0, key.lastIndexOf("/")), { search: LIBRARY_VISUAL_VIDEO_NAME, limit: 10 });
  if (stored.error) throw new ApiError("internal_error", "画面代理上传状态未确认", true);
  const uploaded = stored.data?.find(object => object.name === LIBRARY_VISUAL_VIDEO_NAME);
  if (!uploaded) return response(segment, segment.parent, cors);
  let matches = Number(uploaded.metadata?.size) === expected.bytes && uploaded.metadata?.mimetype === expected.mime;
  if (matches) {
    const body = await bucket.download(key);
    if (body.error || !body.data) throw new ApiError("internal_error", "画面代理校验暂不可用，请按原任务恢复", true);
    matches = body.data.size === expected.bytes && await sha256(new Uint8Array(await body.data.arrayBuffer())) === expected.sha256;
  }
  const { data, error } = await admin.rpc("control_library_visual_segment", {
    p_action: matches ? "commit" : "reject-upload", p_user_id: userId, p_segment_id: jobId,
  });
  if (error || !data) throw new ApiError("internal_error", "画面分析入队失败，请按原任务恢复", true);
  const accepted = data as { segment: Segment; parent: Parent };
  return response(accepted.segment, accepted.parent, cors);
}
