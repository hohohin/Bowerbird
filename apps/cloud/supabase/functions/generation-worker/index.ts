// Restricted VPS worker control plane for durable Cloud image generation.
// The VPS receives only a dedicated Worker Token and signed object URLs; it
// never receives a Supabase secret/service-role key.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { corsHeaders } from "../_shared/limits.ts";

const BUCKET = "generation-temp";
const LEASE_SECONDS = 90;
const SIGNED_URL_SECONDS = 300;
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
  const expected = requiredEnv("GENERATION_WORKER_TOKEN");
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
  service: "image_sd" | "image_hd";
  lease_id: string | null;
  request_object_key: string;
  input_manifest_hash: string;
  input_count: number;
  attempt_count: number;
  upstream_submitted_at: string | null;
}

function scalar<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

async function assertLease(admin: SupabaseClient, jobId: string, leaseId: string): Promise<JobRow> {
  const { data, error } = await admin.from("generation_jobs").select("*").eq("id", jobId).maybeSingle();
  if (error || !data) throw new ApiError("invalid_request", "云任务不存在", false, 404);
  const job = data as unknown as JobRow;
  if (!leaseId || job.lease_id !== leaseId || !["leased", "running", "cancel_requested"].includes(job.status)) {
    throw new ApiError("invalid_request", "生成租约已失效", false, 409);
  }
  return job;
}

async function actionClaim(admin: SupabaseClient, workerId: string): Promise<Response> {
  await maybeCleanupExpired(admin);
  const reconciled = await admin.rpc("reconcile_stale_generation_jobs", { p_limit: 100 });
  if (reconciled.error) throw new ApiError("internal_error", "失联任务对账失败", true);
  const result = await admin.rpc("claim_generation_job", {
    p_worker_id: workerId,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (result.error) throw new ApiError("internal_error", "生成任务认领失败", true);
  const job = scalar(result.data) as JobRow | null;
  // PostgREST serializes a NULL composite return as an all-null object, not JSON null.
  if (!job?.id) return jsonResponse({ job: null });
  const signed = await admin.storage.from(BUCKET).createSignedUrl(job.request_object_key, SIGNED_URL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) {
    throw new ApiError("internal_error", "生成输入下载地址签发失败", true);
  }
  return jsonResponse({
    job: {
      id: job.id,
      service: job.service,
      inputManifestHash: job.input_manifest_hash,
      inputCount: job.input_count,
      attempt: job.attempt_count,
    },
    lease: { leaseId: job.lease_id, leaseSeconds: LEASE_SECONDS },
    inputUrl: signed.data.signedUrl,
  });
}

async function maybeCleanupExpired(admin: SupabaseClient): Promise<void> {
  const now = Date.now();
  if (now < nextCleanupAt) return;
  nextCleanupAt = now + 10 * 60 * 1000;
  const { data, error } = await admin.from("generation_jobs")
    .select("id,request_object_key,output_object_key")
    .lt("content_expires_at", new Date(now).toISOString())
    .is("deleted_at", null)
    .limit(100);
  if (error) throw new ApiError("internal_error", "过期云任务查询失败", true);
  for (const raw of data ?? []) {
    const row = raw as { id: string; request_object_key: string; output_object_key: string | null };
    const keys = [row.request_object_key, row.output_object_key].filter((key): key is string => Boolean(key));
    const removed = keys.length ? await admin.storage.from(BUCKET).remove(keys) : { error: null };
    if (removed.error) continue;
    await admin.from("generation_jobs").update({ deleted_at: new Date().toISOString() })
      .eq("id", row.id).is("deleted_at", null);
  }
}

async function actionHeartbeat(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  if (!jobId || !leaseId) throw new ApiError("invalid_request", "缺少 jobId/leaseId");
  const result = await admin.rpc("heartbeat_generation_job", {
    p_job_id: jobId,
    p_lease_id: leaseId,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (result.error) throw new ApiError("invalid_request", "生成租约已失效", false, 409);
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
  const result = await admin.rpc("mark_generation_job_submitted", {
    p_job_id: jobId,
    p_lease_id: leaseId,
    p_provider_request_id: typeof body.providerRequestId === "string" ? body.providerRequestId.slice(0, 200) : null,
  });
  if (result.error) throw new ApiError("invalid_request", "无法登记方舟请求提交", false, 409);
  const job = scalar(result.data) as JobRow;
  return jsonResponse({ jobId, status: job.status, submittedAt: job.upstream_submitted_at });
}

function outputExtension(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/png") return "png";
  throw new ApiError("invalid_request", "不支持的图片 MIME");
}

async function actionOutputUpload(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  const mime = typeof body.mime === "string" ? body.mime : "";
  await assertLease(admin, jobId, leaseId);
  const objectKey = `jobs/${jobId}/outputs/result.${outputExtension(mime)}`;
  const result = await admin.storage.from(BUCKET).createSignedUploadUrl(objectKey, { upsert: true });
  if (result.error || !result.data) throw new ApiError("internal_error", "产物上传地址签发失败", true);
  return jsonResponse({ objectKey, uploadUrl: result.data.signedUrl, uploadToken: result.data.token });
}

async function assertUploadedObject(admin: SupabaseClient, objectKey: string, expectedBytes: number): Promise<void> {
  const slash = objectKey.lastIndexOf("/");
  const folder = objectKey.slice(0, slash);
  const filename = objectKey.slice(slash + 1);
  const result = await admin.storage.from(BUCKET).list(folder, { search: filename, limit: 10 });
  if (result.error) throw new ApiError("internal_error", "校验云图片产物失败", true);
  const object = result.data?.find((item) => item.name === filename);
  const size = Number(object?.metadata?.size ?? -1);
  if (!object || size !== expectedBytes) throw new ApiError("invalid_request", "云图片产物不存在或大小不匹配");
}

async function actionComplete(
  admin: SupabaseClient,
  body: Record<string, unknown>,
  status: "succeeded" | "failed" | "outcome_unknown" | "cancelled",
): Promise<Response> {
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  if (!jobId || !leaseId) throw new ApiError("invalid_request", "缺少 jobId/leaseId");
  await assertLease(admin, jobId, leaseId);
  const objectKey = typeof body.objectKey === "string" ? body.objectKey : null;
  const mime = typeof body.mime === "string" ? body.mime : null;
  const bytes = Number(body.bytes ?? 0);
  const sha256 = typeof body.sha256 === "string" ? body.sha256 : null;
  if (status === "succeeded") {
    if (!objectKey || !objectKey.startsWith(`jobs/${jobId}/outputs/`) || !Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new ApiError("invalid_request", "产物元数据无效");
    }
    await assertUploadedObject(admin, objectKey, bytes);
  }
  const result = await admin.rpc("complete_generation_job", {
    p_job_id: jobId,
    p_lease_id: leaseId,
    p_status: status,
    p_output_object_key: objectKey,
    p_output_mime: mime,
    p_output_bytes: status === "succeeded" ? bytes : null,
    p_output_sha256: sha256,
    p_error_code: typeof body.safeErrorCode === "string" ? body.safeErrorCode.slice(0, 80) : null,
    p_safe_message: typeof body.safeMessage === "string" ? body.safeMessage.slice(0, 500) : null,
  });
  if (result.error) throw new ApiError("internal_error", "云任务结算失败", true);
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
    else if (action === "output_upload") response = await actionOutputUpload(admin, body);
    else if (action === "finish") response = await actionComplete(admin, body, "succeeded");
    else if (action === "fail") response = await actionComplete(admin, body, "failed");
    else if (action === "outcome_unknown") response = await actionComplete(admin, body, "outcome_unknown");
    else if (action === "cancelled") response = await actionComplete(admin, body, "cancelled");
    else throw new ApiError("invalid_request", "未知 action");
    safeLog({ requestId: id, service: `generation-worker:${action}`, status: response.status, elapsedMs: Date.now() - started });
    return response;
  } catch (error) {
    safeLog({ requestId: id, service: "generation-worker", status: error instanceof ApiError ? error.code : "error", elapsedMs: Date.now() - started });
    return errorResponse(error, id, cors);
  }
});
