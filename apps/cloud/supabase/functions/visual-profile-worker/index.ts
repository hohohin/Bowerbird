// V2 视觉设定提炼 · VPS Worker 控制面（AGENT-RUNTIME-PLAN §8.7 / §11 V2-T1）。
// 与 understand-worker 同一安全边界：Worker 只持专用 Worker Token 与签名输入 URL，
// 不持 Supabase secret。任务执行 = DeepSeek 分批文本抽取 + 确定性聚合（无图片参与）。

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { corsHeaders } from "../_shared/limits.ts";

const BUCKET = "generation-temp";
const LEASE_SECONDS = 120;
const SIGNED_URL_SECONDS = 300;
const MAX_RESULT_CHARS = 65_536;
let nextCleanupAt = 0;

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new ApiError("not_configured", `${name} 未配置`, false, 503);
  return value;
}

function namedKey(objectEnv: string, directEnv: string, legacyEnv: string): string {
  const direct = Deno.env.get(directEnv)?.trim();
  if (direct) return direct;
  const objectValue = Deno.env.get(objectEnv)?.trim();
  if (objectValue) {
    const value = (JSON.parse(objectValue) as Record<string, string>).default?.trim();
    if (value) return value;
  }
  return requiredEnv(legacyEnv);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function requireWorker(request: Request): { workerId: string; admin: SupabaseClient } {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const expected = requiredEnv("VISUAL_PROFILE_WORKER_TOKEN");
  if (!token || !timingSafeEqual(token, expected)) throw new ApiError("unauthorized", "Worker 认证失败");
  const workerId = request.headers.get("x-worker-id")?.trim() ?? "";
  if (!workerId || workerId.length > 120) throw new ApiError("unauthorized", "Worker id 无效");
  const admin = createClient(requiredEnv("SUPABASE_URL"), namedKey(
    "SUPABASE_SECRET_KEYS",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ), { auth: { persistSession: false, autoRefreshToken: false } });
  return { workerId, admin };
}

interface JobRow {
  id: string;
  status: string;
  lease_id: string | null;
  request_object_key: string;
  input_manifest_hash: string;
  attempt_count: number;
  upstream_submitted_at: string | null;
}

function scalar<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

async function assertLease(admin: SupabaseClient, jobId: string, leaseId: string): Promise<JobRow> {
  const { data, error } = await admin.from("visual_profile_jobs").select("*").eq("id", jobId).maybeSingle();
  if (error || !data) throw new ApiError("invalid_request", "提炼任务不存在", false, 404);
  const job = data as unknown as JobRow;
  if (!leaseId || job.lease_id !== leaseId || !["leased", "running", "cancel_requested"].includes(job.status)) {
    throw new ApiError("invalid_request", "提炼任务租约已失效", false, 409);
  }
  return job;
}

async function maybeCleanupExpired(admin: SupabaseClient): Promise<void> {
  const now = Date.now();
  if (now < nextCleanupAt) return;
  nextCleanupAt = now + 10 * 60 * 1000;
  const { data, error } = await admin.from("visual_profile_jobs")
    .select("id,request_object_key")
    .lt("content_expires_at", new Date(now).toISOString())
    .is("deleted_at", null)
    .limit(100);
  if (error) throw new ApiError("internal_error", "过期提炼任务查询失败", true);
  for (const raw of data ?? []) {
    const row = raw as { id: string; request_object_key: string };
    const removed = await admin.storage.from(BUCKET).remove([row.request_object_key]);
    if (removed.error) continue;
    // 输入对象删除后同步清空结果：draft 只做短时投递，长期权威在桌面本地。
    await admin.from("visual_profile_jobs").update({
      deleted_at: new Date(now).toISOString(),
      result_text: null,
    })
      .eq("id", row.id).is("deleted_at", null);
  }
}

async function actionClaim(admin: SupabaseClient, workerId: string): Promise<Response> {
  await maybeCleanupExpired(admin);
  const reconciled = await admin.rpc("reconcile_stale_visual_profile_jobs", { p_limit: 100 });
  if (reconciled.error) throw new ApiError("internal_error", "失联提炼任务对账失败", true);
  const result = await admin.rpc("claim_visual_profile_job", {
    p_worker_id: workerId,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (result.error) throw new ApiError("internal_error", "提炼任务认领失败", true);
  const job = scalar(result.data) as JobRow | null;
  // PostgREST serializes a NULL composite return as an all-null object, not JSON null.
  if (!job?.id) return jsonResponse({ job: null });
  const signed = await admin.storage.from(BUCKET).createSignedUrl(job.request_object_key, SIGNED_URL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) {
    throw new ApiError("internal_error", "提炼输入下载地址签发失败", true);
  }
  return jsonResponse({
    job: {
      id: job.id,
      inputManifestHash: job.input_manifest_hash,
      attempt: job.attempt_count,
    },
    lease: { leaseId: job.lease_id, leaseSeconds: LEASE_SECONDS },
    inputUrl: signed.data.signedUrl,
  });
}

async function actionHeartbeat(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  if (!jobId || !leaseId) throw new ApiError("invalid_request", "缺少 jobId/leaseId");
  const result = await admin.rpc("heartbeat_visual_profile_job", {
    p_job_id: jobId,
    p_lease_id: leaseId,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (result.error) throw new ApiError("invalid_request", "提炼任务租约已失效", false, 409);
  const row = scalar(result.data) as { job_status?: string; cancel_requested?: boolean; lease_expires_at?: string } | null;
  return jsonResponse({
    status: row?.job_status ?? "unknown",
    cancelRequested: row?.cancel_requested ?? false,
    leaseExpiresAt: row?.lease_expires_at ?? null,
  });
}

async function actionSubmitted(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  if (!jobId || !leaseId) throw new ApiError("invalid_request", "缺少 jobId/leaseId");
  const result = await admin.rpc("mark_visual_profile_job_submitted", {
    p_job_id: jobId,
    p_lease_id: leaseId,
  });
  if (result.error) throw new ApiError("invalid_request", "无法登记模型请求提交", false, 409);
  const job = scalar(result.data) as JobRow;
  return jsonResponse({ jobId, status: job.status, submittedAt: job.upstream_submitted_at });
}

async function actionComplete(
  admin: SupabaseClient,
  body: Record<string, unknown>,
  status: "succeeded" | "failed" | "outcome_unknown",
): Promise<Response> {
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  if (!jobId || !leaseId) throw new ApiError("invalid_request", "缺少 jobId/leaseId");
  await assertLease(admin, jobId, leaseId);
  const resultText = typeof body.resultText === "string" ? body.resultText : null;
  if (status === "succeeded") {
    if (!resultText?.trim() || resultText.length > MAX_RESULT_CHARS) {
      throw new ApiError("invalid_request", "提炼结果无效");
    }
    try {
      JSON.parse(resultText);
    } catch {
      throw new ApiError("invalid_request", "提炼结果不是有效 JSON");
    }
  }
  const result = await admin.rpc("complete_visual_profile_job", {
    p_job_id: jobId,
    p_lease_id: leaseId,
    p_status: status,
    p_result_text: resultText,
    p_error_code: typeof body.safeErrorCode === "string" ? body.safeErrorCode.slice(0, 80) : null,
    p_safe_message: typeof body.safeMessage === "string" ? body.safeMessage.slice(0, 500) : null,
  });
  if (result.error) throw new ApiError("internal_error", "提炼任务结算失败", true);
  const job = scalar(result.data) as { status: string; actual_credits?: number | null };
  return jsonResponse({ jobId, status: job.status, actualCredits: job.actual_credits ?? null });
}

Deno.serve(async (request) => {
  const id = requestId(request);
  let cors: HeadersInit = {};
  const started = Date.now();
  try {
    cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") throw new ApiError("invalid_request", "仅支持 POST", false, 405);
    const { workerId, admin } = requireWorker(request);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";
    let response: Response;
    if (action === "claim") response = await actionClaim(admin, workerId);
    else if (action === "heartbeat") response = await actionHeartbeat(admin, body);
    else if (action === "submitted") response = await actionSubmitted(admin, body);
    else if (action === "finish") response = await actionComplete(admin, body, "succeeded");
    else if (action === "fail") response = await actionComplete(admin, body, "failed");
    else if (action === "outcome_unknown") response = await actionComplete(admin, body, "outcome_unknown");
    else throw new ApiError("invalid_request", "未知 action");
    safeLog({ requestId: id, service: `visual-profile-worker:${action}`, status: String(response.status), elapsedMs: Date.now() - started });
    return response;
  } catch (error) {
    safeLog({ requestId: id, service: "visual-profile-worker", status: error instanceof ApiError ? error.code : "error", elapsedMs: Date.now() - started });
    return errorResponse(error, id, cors);
  }
});
