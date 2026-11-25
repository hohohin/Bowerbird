import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ApiError, jsonResponse } from "./errors.ts";
import { FILE_SPEECH_BUCKET } from "./file-speech.ts";
import { libraryVisualVideoKey, parseLibraryVisualVideo } from "./library-visual.ts";
import { uploadedVisualMatches } from "./library-visual-edge.ts";
import { checkTextAcceptance, usageParameters } from "./text-job-upload.ts";

const service = "library_video_shot_analysis";
const enabled = () => Deno.env.get("LIBRARY_SHOT_ENABLED") === "true" && Deno.env.get("BOWERBIRD_CLOUD_MOCK") === "false";
const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const keyValid = (s: unknown): s is string => typeof s === "string" && /^library-shot:[a-zA-Z0-9:._-]{3,187}$/.test(s);
const uuid = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);

export async function quoteLibraryShots(admin: SupabaseClient, shots: unknown) {
  if (!Array.isArray(shots) || !shots.length || shots.length > 2000) {
    throw new ApiError("invalid_request", "请选择待分析镜头");
  }
  const seen = new Set<string>();
  for (const s of shots) {
    if (
      !s || !Number.isSafeInteger(s.start_ms) || s.start_ms < 0 || !positive(s.end_ms) ||
      s.end_ms <= s.start_ms || s.end_ms - s.start_ms > 60000 || seen.has(s.start_ms + "-" + s.end_ms)
    ) {
      throw new ApiError("invalid_request", "镜头区间无效或超过 60 秒");
    }
    seen.add(s.start_ms + "-" + s.end_ms);
  }
  const closed = { available: false, pricing_version: null, lines: [], total_milli: null };
  if (!enabled()) return closed;
  const { data, error } = await admin.from("service_costs").select("active,pricing_version,parameters").eq(
    "service",
    service,
  ).maybeSingle();
  if (error) throw new ApiError("internal_error", "镜头报价读取失败", true);
  const rates = data?.parameters;
  if (
    !data?.active || rates?.pricing_ready !== true || !positive(rates.short_milli) || rates.short_milli > 999 ||
    !positive(rates.long_milli) || rates.long_milli > 999 || !positive(data.pricing_version)
  ) return closed;
  const lines = shots.map(({ start_ms, end_ms }) => ({
    start_ms,
    end_ms,
    amount_milli: end_ms - start_ms <= 15000 ? rates.short_milli : rates.long_milli,
  }));
  return {
    available: true,
    pricing_version: data.pricing_version,
    lines,
    total_milli: lines.reduce((sum, s) => sum + s.amount_milli, 0),
  };
}

type Job = {
  id: string;
  status: string;
  expires_at: string;
  hold_id: string;
  pricing_version: number;
  amount_milli: number;
  result_text: string | null;
  error_code: string | null;
  safe_message: string | null;
  video: unknown;
};

function response(job: Job, cors: HeadersInit, uploadUrl?: string) {
  const expired = Date.parse(job.expires_at) <= Date.now();
  const status = expired && job.status === "succeeded" ? "failed" : job.status;
  return jsonResponse(
    {
      job_id: job.id,
      status,
      charge: {
        estimated_milli: job.amount_milli,
        actual_milli: job.status === "succeeded" ? job.amount_milli : null,
        refunded: job.status === "failed",
        transaction_id: job.hold_id,
        pricing_version: job.pricing_version,
      },
      ...(uploadUrl ? { upload_url: uploadUrl } : {}),
      ...(status === "succeeded" ? { result: JSON.parse(job.result_text!) } : {}),
      ...(["failed", "outcome_unknown"].includes(status)
        ? {
          error: {
            code: job.error_code ?? (expired ? "content_expired" : status),
            message: job.safe_message ?? (expired ? "镜头任务内容已过期" : "镜头分析未完成"),
          },
        }
        : {}),
    },
    ["succeeded", "failed", "outcome_unknown"].includes(status) ? 200 : 202,
    cors,
  );
}

async function currentResponse(admin: SupabaseClient, job: Job, cors: HeadersInit) {
  if (Date.parse(job.expires_at) <= Date.now() && !["succeeded", "failed", "outcome_unknown"].includes(job.status)) {
    const { data, error } = await admin.rpc("control_library_shot", { p_action: "expire", p_segment_id: job.id });
    if (error || !data) throw new ApiError("internal_error", "镜头结算状态待核对", true);
    return response(data.segment as Job, cors);
  }
  return response(job, cors);
}

export async function libraryShotAction(
  admin: SupabaseClient,
  userId: string,
  raw: Record<string, unknown>,
  cors: HeadersInit,
) {
  if (raw.action === "library-shot-quote") return jsonResponse(await quoteLibraryShots(admin, raw.shots), 200, cors);
  if (raw.action === "library-shot-prepare") {
    if (
      !keyValid(raw.idempotency_key) || typeof raw.source_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(raw.source_sha256) ||
      !positive(raw.expected_milli) || raw.expected_milli > 999 || !positive(raw.pricing_version) ||
      raw.pricing_version > 2147483647
    ) throw new ApiError("invalid_request", "镜头身份或报价无效");
    let video;
    try {
      video = parseLibraryVisualVideo(raw.video, true);
    } catch {
      throw new ApiError("invalid_request", "镜头代理格式、大小或时长无效");
    }
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(video)));
    const { data, error } = await admin.rpc("begin_library_shot", {
      p_user_id: userId,
      p_key: raw.idempotency_key,
      p_source_sha256: raw.source_sha256,
      p_hash: Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, "0")).join(""),
      p_video: video,
      p_expected_milli: raw.expected_milli,
      p_pricing_version: raw.pricing_version,
      p_enabled: enabled(),
      ...usageParameters(),
    });
    if (error?.details === "stale_quote") {
      throw new ApiError("invalid_request", "镜头报价已变更，请重新确认", false, 409);
    }
    if (error?.details === "price_unavailable") throw new ApiError("not_configured", "镜头分析暂未开放", false, 503);
    checkTextAcceptance(error);
    if (!data) throw new ApiError("internal_error", "请按原任务查询镜头状态", true);
    const job = data as Job;
    if (job.status !== "uploading" || Date.parse(job.expires_at) <= Date.now()) {
      return await currentResponse(admin, job, cors);
    }
    const signed = await admin.storage.from(FILE_SPEECH_BUCKET).createSignedUploadUrl(libraryVisualVideoKey(job.id), {
      upsert: false,
    });
    if (!signed.data?.signedUrl || signed.error) throw new ApiError("internal_error", "镜头上传地址暂不可用", true);
    return response(job, cors, signed.data.signedUrl);
  }
  const byKey = raw.action === "get-by-key";
  if (!(byKey ? keyValid(raw.idempotency_key) : uuid(raw.job_id))) {
    throw new ApiError("invalid_request", "缺少有效的镜头任务身份");
  }
  const { data, error } = await admin.from("library_shot_jobs").select("*").eq("user_id", userId)
    .eq(byKey ? "idempotency_key" : "id", byKey ? raw.idempotency_key : raw.job_id).maybeSingle();
  if (error) throw new ApiError("internal_error", "镜头状态读取失败", true);
  if (!data) throw new ApiError("invalid_request", "未找到原镜头任务", false, 404);
  const job = data as Job;
  if (raw.action !== "library-shot-commit" || job.status !== "uploading" || Date.parse(job.expires_at) <= Date.now()) {
    return await currentResponse(admin, job, cors);
  }
  const matches = await uploadedVisualMatches(admin, job.id, parseLibraryVisualVideo(job.video, true));
  if (matches === null) return response(job, cors);
  const update = await admin.rpc("control_library_shot", {
    p_action: matches ? "commit" : "reject-upload",
    p_segment_id: job.id,
    p_user_id: userId,
  });
  if (update.error || !update.data) throw new ApiError("internal_error", "镜头任务提交状态待确认", true);
  return response(update.data.segment as Job, cors);
}
