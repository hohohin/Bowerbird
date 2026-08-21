// Bowerbird Agent Runtime A1-T4: worker-side Run actions.
// Auth: high-entropy Worker Token (constant-time compare), never a user JWT,
// never service_role exposure to the VPS. Usage credits are computed here from
// versioned service_costs — worker-reported totals are never authoritative.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { corsHeaders } from "../_shared/limits.ts";

const BUCKET = "agent-temp";
const MAX_EVENTS_PER_BATCH = 100;
const MAX_USAGE_PER_BATCH = 100;
const CHECKPOINT_URL_SECONDS = 300;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new ApiError("not_configured", `${name} 未配置`, false, 503);
  return value;
}

function workerToken(): string {
  return requiredEnv("AGENT_WORKER_TOKEN");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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

function requireWorker(request: Request): { workerId: string; admin: SupabaseClient } {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1] ?? "";
  const expected = workerToken();
  if (!token || !timingSafeEqual(token, expected)) {
    throw new ApiError("unauthorized", "Worker 认证失败");
  }
  const workerId = request.headers.get("x-worker-id")?.trim() ?? "";
  if (!workerId || workerId.length > 120) throw new ApiError("unauthorized", "Worker id 无效");
  const admin = createClient(requiredEnv("SUPABASE_URL"), namedKey(
    "SUPABASE_SECRET_KEYS",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { workerId, admin };
}

interface RunRow {
  id: string;
  conversation_id: string;
  status: string;
  lease_id: string | null;
  lease_expires_at: string | null;
  request_object_key: string;
  skill_id: string;
  skill_version: string;
  input_manifest_hash: string;
  input_count: number;
  checkpoint_object_key: string | null;
  checkpoint_hash: string | null;
  snapshot_schema_version: number | null;
  approved_plan_hash: string | null;
  planned_tool_count: number | null;
  feedback_object_key: string | null;
  result_feedback_action: "accept" | "retry" | null;
  budget_credits: number;
  hold_id: string;
  pricing_version: number;
  user_id: string;
}

async function signOrNull(admin: SupabaseClient, objectKey: string): Promise<string | null> {
  try {
    const result = await admin.storage.from(BUCKET).createSignedUrl(objectKey, CHECKPOINT_URL_SECONDS);
    return result.error ? null : result.data?.signedUrl ?? null;
  } catch {
    return null;
  }
}

async function actionClaim(admin: SupabaseClient, workerId: string): Promise<Response> {
  const claimResult = await admin.rpc("claim_agent_run", { p_worker_id: workerId, p_lease_seconds: 60 });
  if (claimResult.error) throw new ApiError("internal_error", "claim RPC 失败", true);
  // PostgREST returns a scalar-typed function result directly, or an array when
  // the return type is a table row; normalise both.
  const raw = Array.isArray(claimResult.data) ? claimResult.data[0] : claimResult.data;
  const claimed = (raw ?? null) as RunRow | null;
  if (!claimed?.id) return jsonResponse({ run: null });
  const inputKey = claimed.request_object_key;
  const checkpointKey = claimed.checkpoint_object_key;
  const feedbackKey = claimed.feedback_object_key;
  // Signed URLs are best-effort here: a not-yet-uploaded input or a pruned
  // checkpoint must not break claiming; the worker re-requests when needed.
  const [inputUrl, checkpointUrl, feedbackUrl, artifactRows] = await Promise.all([
    signOrNull(admin, inputKey),
    checkpointKey ? signOrNull(admin, checkpointKey) : Promise.resolve(null),
    feedbackKey ? signOrNull(admin, feedbackKey) : Promise.resolve(null),
    admin.from("agent_artifacts")
      .select("id,conversation_id,role,step_id,parent_artifact_id,object_key,mime,bytes,sha256,user_visible")
      .eq("run_id", claimed.id)
      .is("deleted_at", null),
  ]);
  if (artifactRows.error) throw new ApiError("internal_error", "Run 产物读取失败", true);
  const artifactUrls = await Promise.all((artifactRows.data ?? []).map(async (artifact) => ({
    artifactId: artifact.id as string,
    conversationId: artifact.conversation_id as string,
    runId: claimed.id,
    role: artifact.role as string,
    stepId: artifact.step_id as string | null,
    parentArtifactId: artifact.parent_artifact_id as string | null,
    mime: artifact.mime as string,
    bytes: Number(artifact.bytes),
    sha256: artifact.sha256 as string,
    userVisible: artifact.user_visible !== false,
    url: await signOrNull(admin, artifact.object_key as string),
  })));
  return jsonResponse({
    run: {
      id: claimed.id,
      conversationId: claimed.conversation_id,
      skillId: claimed.skill_id,
      skillVersion: claimed.skill_version,
      inputManifestHash: claimed.input_manifest_hash,
      approvedPlanHash: claimed.approved_plan_hash,
      plannedToolCount: claimed.planned_tool_count,
      resultFeedbackAction: claimed.result_feedback_action,
      budgetCredits: claimed.budget_credits,
      pricingVersion: claimed.pricing_version,
      checkpointHash: claimed.checkpoint_hash,
      snapshotSchemaVersion: claimed.snapshot_schema_version,
    },
    lease: { leaseId: claimed.lease_id, expiresAt: null, leaseSeconds: 60 },
    inputUrl,
    checkpointUrl,
    feedbackUrl,
    artifactUrls,
  });
}

async function actionHeartbeat(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  if (!runId || !leaseId) throw new ApiError("invalid_request", "缺少 runId/leaseId");
  const heartbeatResult = await admin.rpc("heartbeat_agent_run", { p_run_id: runId, p_lease_id: leaseId, p_lease_seconds: 60 });
  if (heartbeatResult.error) {
    if (heartbeatResult.error.code === "55000") throw new ApiError("invalid_request", "租约已失效", false, 409);
    throw new ApiError("internal_error", "心跳 RPC 失败", true);
  }
  const raw = Array.isArray(heartbeatResult.data) ? heartbeatResult.data[0] : heartbeatResult.data;
  const result = (raw ?? {}) as { run_status?: string; cancel_requested?: boolean; lease_expires_at?: string };
  return jsonResponse({
    status: result.run_status ?? "unknown",
    cancelRequested: result.cancel_requested ?? false,
    leaseExpiresAt: result.lease_expires_at ?? null,
  });
}

async function actionEvents(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  const events = Array.isArray(body.events) ? body.events : [];
  if (!runId || !leaseId) throw new ApiError("invalid_request", "缺少 runId/leaseId");
  if (events.length === 0 || events.length > MAX_EVENTS_PER_BATCH) {
    throw new ApiError("invalid_request", `事件数量需在 1–${MAX_EVENTS_PER_BATCH} 之间`);
  }
  await assertLease(admin, runId, leaseId);

  const rows = events.map((raw) => {
    const e = raw as Record<string, unknown>;
    const seq = Number(e.seq);
    const type = typeof e.type === "string" ? e.type : "";
    if (!Number.isInteger(seq) || seq <= 0 || !type || type.length > 80) {
      throw new ApiError("invalid_request", "事件 seq/type 无效");
    }
    const progress = e.progress === undefined || e.progress === null ? null : Number(e.progress);
    if (progress !== null && (!Number.isInteger(progress) || progress < 0 || progress > 100)) {
      throw new ApiError("invalid_request", "progress 无效");
    }
    return {
      run_id: runId,
      seq,
      type,
      step: typeof e.step === "string" ? e.step.slice(0, 120) : null,
      progress,
      display_payload: (e.displayPayload ?? {}) as Record<string, unknown>,
      content_expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    };
  });
  // Idempotent by (run_id, seq): conflicting dupes fail, identical replays skip.
  const { error } = await admin.from("agent_events").upsert(rows, { onConflict: "run_id,seq", ignoreDuplicates: true });
  if (error) throw new ApiError("internal_error", "事件写入失败", true);
  return jsonResponse({ runId, accepted: rows.length });
}

async function assertLease(admin: SupabaseClient, runId: string, leaseId: string): Promise<RunRow> {
  const { data, error } = await admin.from("agent_runs").select("*").eq("id", runId).maybeSingle();
  if (error || !data) throw new ApiError("invalid_request", "Run 不存在", false, 404);
  const run = data as unknown as RunRow;
  if (run.lease_id !== leaseId || !leaseId || !run.lease_expires_at || Date.parse(run.lease_expires_at) <= Date.now()) {
    throw new ApiError("invalid_request", "租约已失效", false, 409);
  }
  return run;
}

interface UsageItem {
  callId: string;
  kind: "model_tokens" | "vision_call" | "image_generation";
  provider: "deepseek" | "ark";
  model: string;
  inputUnits: number;
  outputUnits: number;
  imageCount: number;
  resolution?: string;
  providerCostMicros?: number;
}

/** Server-side credit calculation. v1: text tokens per M, vision per call, image per piece. */
function creditsFor(item: UsageItem): number {
  if (item.kind === "model_tokens") {
    // DeepSeek-chat list-price derived ceiling: round up, min 1 credit.
    const approx = item.inputUnits / 500_000 + item.outputUnits / 100_000;
    return Math.max(1, Math.ceil(approx));
  }
  if (item.kind === "vision_call") return 1;
  return 5; // image_generation
}

/** Read aggregated usage credits for a run, tolerating scalar or array shapes. */
async function spentCredits(admin: SupabaseClient, runId: string): Promise<number> {
  const result = await admin.rpc("agent_run_spent_credits", { p_run_id: runId });
  if (result.error) throw new ApiError("internal_error", "usage 汇总失败", true);
  const raw = Array.isArray(result.data) ? result.data[0] : result.data;
  return Number((raw as { spent?: number } | null)?.spent ?? 0);
}

async function actionUsage(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  const items = Array.isArray(body.items) ? body.items : [];
  if (!runId || !leaseId) throw new ApiError("invalid_request", "缺少 runId/leaseId");
  if (items.length === 0 || items.length > MAX_USAGE_PER_BATCH) {
    throw new ApiError("invalid_request", `usage 数量需在 1–${MAX_USAGE_PER_BATCH} 之间`);
  }
  const run = await assertLease(admin, runId, leaseId);

  const rows = items.map((raw) => {
    const item = raw as UsageItem;
    if (typeof item.callId !== "string" || !item.callId || item.callId.length > 160) {
      throw new ApiError("invalid_request", "callId 无效");
    }
    if (!["model_tokens", "vision_call", "image_generation"].includes(item.kind)) {
      throw new ApiError("invalid_request", "usage kind 无效");
    }
    if (!["deepseek", "ark"].includes(item.provider)) throw new ApiError("invalid_request", "usage provider 无效");
    const credits = creditsFor(item);
    return {
      run_id: runId,
      call_id: item.callId,
      kind: item.kind,
      provider: item.provider,
      model: String(item.model ?? "unknown").slice(0, 120),
      input_units: Math.max(0, Number(item.inputUnits) || 0),
      output_units: Math.max(0, Number(item.outputUnits) || 0),
      image_count: Math.max(0, Number(item.imageCount) || 0),
      resolution: item.resolution ? String(item.resolution).slice(0, 40) : null,
      provider_cost_micros: item.providerCostMicros === undefined ? null : Math.max(0, Number(item.providerCostMicros) || 0),
      credits,
      pricing_version: run.pricing_version,
    };
  });

  const total = rows.reduce((sum, r) => sum + r.credits, 0);
  const spentSoFar = await spentCredits(admin, runId);
  if (spentSoFar + total > run.budget_credits) {
    throw new ApiError("insufficient_credits", "超出 Run 预算上限", false, 402);
  }

  const toolCallIds = new Set(rows.map((r) => r.call_id));
  const { data: calls } = await admin.from("agent_tool_calls").select("call_id").eq("run_id", runId).in("call_id", [...toolCallIds]);
  if ((calls ?? []).length !== toolCallIds.size) {
    throw new ApiError("invalid_request", "usage 引用了未登记的 tool call", false, 400);
  }

  const { error } = await admin.from("agent_usage_items").upsert(rows, { onConflict: "run_id,call_id", ignoreDuplicates: true });
  if (error) throw new ApiError("internal_error", "usage 写入失败", true);

  // Charge only rows that actually landed: replays of the same call_id add nothing.
  const { data: landed } = await admin.from("agent_usage_items").select("credits").eq("run_id", runId).in("call_id", rows.map((r) => r.call_id));
  const newCredits = Math.max(0, (landed ?? []).reduce((sum, r) => sum + r.credits, 0) - spentSoFar);
  return jsonResponse({ runId, accepted: rows.length, creditsCharged: newCredits, spentCredits: spentSoFar + newCredits });
}

async function actionToolCall(admin: SupabaseClient, body: Record<string, unknown>, phase: "prepare" | "submitted" | "complete"): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  const callId = typeof body.callId === "string" ? body.callId : "";
  if (!runId || !leaseId || !callId) throw new ApiError("invalid_request", "缺少 runId/leaseId/callId");
  await assertLease(admin, runId, leaseId);

  const { data: existingData, error: existingError } = await admin.from("agent_tool_calls")
    .select("call_id,phase,tool_name,args_hash,status,provider_request_id,result_object_key,result_hash,safe_error_code")
    .eq("run_id", runId).eq("call_id", callId).maybeSingle();
  if (existingError) throw new ApiError("internal_error", "tool call 读取失败", true);
  const existing = existingData as null | {
    call_id: string; phase: string; tool_name: string; args_hash: string; status: string;
    provider_request_id: string | null; result_object_key: string | null; result_hash: string | null;
    safe_error_code: string | null;
  };

  const responseFor = (row: NonNullable<typeof existing>, reused: boolean): Response => jsonResponse({
    callId: row.call_id,
    status: row.status,
    providerRequestId: row.provider_request_id,
    resultObjectKey: row.result_object_key,
    resultHash: row.result_hash,
    safeErrorCode: row.safe_error_code,
    reused,
  });

  if (phase === "prepare") {
    const row = {
      run_id: runId,
      call_id: callId,
      phase: String(body.phase ?? "unknown").slice(0, 80),
      tool_name: String(body.toolName ?? "unknown").slice(0, 80),
      args_hash: String(body.argsHash ?? ""),
      status: "prepared" as const,
    };
    if (!/^[0-9a-f]{64}$/.test(row.args_hash)) throw new ApiError("invalid_request", "args_hash 无效");
    if (existing) {
      if (existing.args_hash !== row.args_hash || existing.phase !== row.phase || existing.tool_name !== row.tool_name) {
        throw new ApiError("invalid_request", "call_id 与已登记参数冲突", false, 409);
      }
      return responseFor(existing, true);
    }
    const { data, error } = await admin.from("agent_tool_calls").insert(row)
      .select("call_id,phase,tool_name,args_hash,status,provider_request_id,result_object_key,result_hash,safe_error_code")
      .single();
    if (error || !data) throw new ApiError("internal_error", "tool call 登记失败", true);
    return responseFor(data as NonNullable<typeof existing>, false);
  }

  if (phase === "submitted") {
    if (!existing) throw new ApiError("invalid_request", "tool call 尚未 prepare", false, 409);
    if (existing.status !== "prepared") return responseFor(existing, true);
    const { data, error } = await admin.from("agent_tool_calls")
      .update({ status: "submitted", submitted_at: new Date().toISOString(), provider_request_id: body.providerRequestId ? String(body.providerRequestId).slice(0, 200) : null })
      .eq("run_id", runId).eq("call_id", callId).eq("status", "prepared")
      .select("call_id,phase,tool_name,args_hash,status,provider_request_id,result_object_key,result_hash,safe_error_code")
      .maybeSingle();
    if (error || !data) throw new ApiError("invalid_request", "tool call 状态已变化", false, 409);
    return responseFor(data as NonNullable<typeof existing>, false);
  }

  // complete
  const status = body.status === "failed" ? "failed" : body.status === "outcome_unknown" ? "outcome_unknown" : "succeeded";
  if (!existing) throw new ApiError("invalid_request", "tool call 尚未 prepare", false, 409);
  if (["succeeded", "failed"].includes(existing.status) ||
      (existing.status === "outcome_unknown" && status === "outcome_unknown")) {
    const suppliedHash = typeof body.resultHash === "string" ? body.resultHash : null;
    if (suppliedHash && existing.result_hash && suppliedHash !== existing.result_hash) {
      throw new ApiError("invalid_request", "tool call 完成结果冲突", false, 409);
    }
    return responseFor(existing, true);
  }
  const { data, error } = await admin.from("agent_tool_calls")
    .update({
      status,
      finished_at: new Date().toISOString(),
      result_object_key: body.resultObjectKey ? String(body.resultObjectKey).slice(0, 512) : null,
      result_hash: body.resultHash && /^[0-9a-f]{64}$/.test(String(body.resultHash)) ? String(body.resultHash) : null,
      safe_error_code: body.safeErrorCode ? String(body.safeErrorCode).slice(0, 80) : null,
    })
    .eq("run_id", runId).eq("call_id", callId).in("status", ["prepared", "submitted", "outcome_unknown"])
    .select("call_id,phase,tool_name,args_hash,status,provider_request_id,result_object_key,result_hash,safe_error_code")
    .maybeSingle();
  if (error || !data) throw new ApiError("invalid_request", "tool call 状态已变化", false, 409);
  return responseFor(data as NonNullable<typeof existing>, false);
}

/** Fire a lease-validated status transition; errors surface as ApiError. */
async function transitionRun(
  admin: SupabaseClient,
  params: {
    p_run_id: string; p_lease_id: string; p_to_status: string;
    p_current_step?: string | null; p_progress?: number | null;
    p_checkpoint_object_key?: string | null; p_checkpoint_hash?: string | null;
    p_snapshot_schema_version?: number | null;
  },
): Promise<RunRow> {
  const result = await admin.rpc("transition_agent_run", {
    p_current_step: null, p_progress: null, p_checkpoint_object_key: null,
    p_checkpoint_hash: null, p_snapshot_schema_version: null, ...params,
  });
  if (result.error) {
    if (result.error.code === "55000") throw new ApiError("invalid_request", "租约或状态已失效", false, 409);
    throw new ApiError("internal_error", "状态转换失败", true);
  }
  const raw = Array.isArray(result.data) ? result.data[0] : result.data;
  return raw as RunRow;
}

function checkpointFields(body: Record<string, unknown>): {
  runId: string; leaseId: string; checkpointHash: string; snapshotSchemaVersion: number; objectKey: string;
} {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  if (!runId || !leaseId) throw new ApiError("invalid_request", "缺少 runId/leaseId");
  if (typeof body.checkpointHash !== "string" || !/^[0-9a-f]{64}$/.test(body.checkpointHash)) {
    throw new ApiError("invalid_request", "checkpoint hash 无效");
  }
  const snapshotSchemaVersion = Number(body.snapshotSchemaVersion);
  if (!Number.isInteger(snapshotSchemaVersion) || snapshotSchemaVersion !== 1) {
    throw new ApiError("invalid_request", "snapshot schema version 无效");
  }
  return {
    runId,
    leaseId,
    checkpointHash: body.checkpointHash,
    snapshotSchemaVersion,
    objectKey: `runs/${runId}/checkpoints/${body.checkpointHash}.json`,
  };
}

async function actionCheckpointPrepare(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const fields = checkpointFields(body);
  await assertLease(admin, fields.runId, fields.leaseId);
  const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(fields.objectKey);
  if (error || !data) throw new ApiError("internal_error", "checkpoint 上传地址签发失败", true);
  return jsonResponse({ objectKey: fields.objectKey, uploadUrl: data.signedUrl, uploadToken: data.token });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function actionCheckpointCommit(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const fields = checkpointFields(body);
  await assertLease(admin, fields.runId, fields.leaseId);
  const { data, error } = await admin.storage.from(BUCKET).download(fields.objectKey);
  if (error || !data) throw new ApiError("invalid_request", "checkpoint 对象不存在", false, 409);
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > 1024 * 1024 || await sha256Hex(bytes) !== fields.checkpointHash) {
    throw new ApiError("invalid_request", "checkpoint 对象校验失败", false, 409);
  }
  const progress = body.progress === undefined ? null : Number(body.progress);
  if (progress !== null && (!Number.isInteger(progress) || progress < 0 || progress > 100)) {
    throw new ApiError("invalid_request", "progress 无效");
  }
  const result = await admin.rpc("commit_agent_checkpoint", {
    p_run_id: fields.runId,
    p_lease_id: fields.leaseId,
    p_object_key: fields.objectKey,
    p_checkpoint_hash: fields.checkpointHash,
    p_snapshot_schema_version: fields.snapshotSchemaVersion,
    p_current_step: body.step ? String(body.step).slice(0, 120) : null,
    p_progress: progress,
  });
  if (result.error) {
    if (result.error.code === "55000") throw new ApiError("invalid_request", "租约或状态已失效", false, 409);
    throw new ApiError("internal_error", "checkpoint 指针提交失败", true);
  }
  return jsonResponse({ runId: fields.runId, checkpointHash: fields.checkpointHash, committed: true });
}

async function actionCancel(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  if (!runId || !leaseId) throw new ApiError("invalid_request", "缺少 runId/leaseId");
  const run = await assertLease(admin, runId, leaseId);
  const { run: cancelled, actual } = await settleRun(admin, run, "cancelled");
  return jsonResponse({ runId, status: cancelled.status, actualCredits: actual });
}

async function actionApprovalRequest(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  const kind = body.kind === "controlled_image_edit_revision"
    ? "controlled_image_edit_revision"
    : body.kind === "controlled_image_edit_plan"
      ? "controlled_image_edit_plan"
      : "";
  const proposalHash = typeof body.proposalHash === "string" ? body.proposalHash : "";
  const proposal = body.proposal;
  const plannedToolCount = Number(body.plannedToolCount);
  const estimatedCredits = Number(body.estimatedAdditionalCredits ?? 0);
  if (!runId || !leaseId || !kind) throw new ApiError("invalid_request", "审批请求字段不完整");
  if (!/^[0-9a-f]{64}$/.test(proposalHash)) throw new ApiError("invalid_request", "proposal hash 无效");
  if (!Number.isInteger(plannedToolCount) || plannedToolCount < 1 || plannedToolCount > 8) {
    throw new ApiError("invalid_request", "计划工具数无效");
  }
  if (!Number.isInteger(estimatedCredits) || estimatedCredits < 0) {
    throw new ApiError("invalid_request", "计划积分无效");
  }
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
    throw new ApiError("invalid_request", "proposal 无效");
  }
  const run = await assertLease(admin, runId, leaseId);
  const encoded = new TextEncoder().encode(JSON.stringify(proposal));
  if (encoded.byteLength > 64 * 1024) throw new ApiError("invalid_request", "proposal 过大");
  const objectKey = `runs/${runId}/plans/${proposalHash}.json`;
  const { error: uploadError } = await admin.storage.from(BUCKET).upload(objectKey, encoded, {
    contentType: "application/json",
    upsert: false,
  });
  if (uploadError && !String(uploadError.message ?? "").toLowerCase().includes("already")) {
    throw new ApiError("internal_error", "计划保存失败", true);
  }
  const { data: pending, error: pendingError } = await admin.from("agent_approvals")
    .select("id,kind,proposal_hash,planned_tool_count,estimated_additional_credits")
    .eq("run_id", runId).eq("status", "pending").maybeSingle();
  if (pendingError) throw new ApiError("internal_error", "审批读取失败", true);
  if (pending && (pending.kind !== kind || pending.proposal_hash !== proposalHash ||
      pending.planned_tool_count !== plannedToolCount || pending.estimated_additional_credits !== estimatedCredits)) {
    throw new ApiError("invalid_request", "当前已有不同的待审批计划", false, 409);
  }
  let approval = pending as { id: string } | null;
  if (!approval) {
    const inserted = await admin.from("agent_approvals").insert({
      run_id: runId,
      kind,
      proposal_object_key: objectKey,
      proposal_hash: proposalHash,
      planned_tool_count: plannedToolCount,
      estimated_additional_credits: estimatedCredits,
      status: "pending",
      expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    }).select("id").single();
    if (inserted.error || !inserted.data) throw new ApiError("internal_error", "审批建立失败", true);
    approval = inserted.data as { id: string };
  }
  await transitionRun(admin, {
    p_run_id: runId,
    p_lease_id: leaseId,
    p_to_status: "awaiting_approval",
    p_current_step: kind,
  });
  return jsonResponse({
    conversationId: run.conversation_id,
    runId,
    approvalId: approval.id,
    proposalHash,
    status: "awaiting_approval",
  });
}

type ArtifactFields = {
  runId: string;
  leaseId: string;
  callId: string;
  objectKey: string;
  role: string;
  sha256: string;
  mime: "image/png" | "image/jpeg" | "image/webp" | "application/json";
  bytes: number;
  stepId: string | null;
  parentArtifactId: string | null;
  userVisible: boolean;
};

function actualImageMime(bytes: Uint8Array): ArtifactFields["mime"] | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
      new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

function artifactFields(body: Record<string, unknown>): ArtifactFields {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  const callId = typeof body.sourceCallId === "string" ? body.sourceCallId : "";
  const role = typeof body.role === "string" ? body.role : "";
  const allowedRoles = new Set(["input", "control_reference", "stage_result", "final_result", "plan", "diagnostic"]);
  const sha256 = typeof body.sha256 === "string" ? body.sha256 : "";
  const mime = typeof body.mime === "string" ? body.mime : "";
  const bytes = Number(body.bytes);
  if (!runId || !leaseId || !/^[0-9a-f]{64}$/.test(callId)) throw new ApiError("invalid_request", "artifact 标识无效");
  if (!allowedRoles.has(role)) throw new ApiError("invalid_request", "artifact role 无效");
  const allowedMime = role === "diagnostic"
    ? mime === "application/json"
    : ["image/png", "image/jpeg", "image/webp"].includes(mime);
  const maxBytes = mime === "application/json" ? 64 * 1024 : MAX_ARTIFACT_BYTES;
  if (!/^[0-9a-f]{64}$/.test(sha256) || !allowedMime ||
      !Number.isInteger(bytes) || bytes <= 0 || bytes > maxBytes) {
    throw new ApiError("invalid_request", "artifact 元数据无效");
  }
  const suffix = mime === "application/json" ? "json" : mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
  return {
    runId,
    leaseId,
    callId,
    objectKey: `runs/${runId}/artifacts/${callId}.${suffix}`,
    role,
    sha256,
    mime: mime as ArtifactFields["mime"],
    bytes,
    stepId: typeof body.stepId === "string" ? body.stepId.slice(0, 120) : null,
    parentArtifactId: typeof body.parentArtifactId === "string" ? body.parentArtifactId : null,
    userVisible: mime === "application/json" ? false : body.userVisible !== false,
  };
}

async function actionArtifactPrepare(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const fields = artifactFields(body);
  await assertLease(admin, fields.runId, fields.leaseId);
  const { data: call } = await admin.from("agent_tool_calls").select("call_id,status")
    .eq("run_id", fields.runId).eq("call_id", fields.callId).maybeSingle();
  if (!call || !["submitted", "outcome_unknown", "succeeded"].includes(call.status as string)) {
    throw new ApiError("invalid_request", "artifact 未关联已提交的工具调用", false, 409);
  }
  const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(fields.objectKey);
  if (error || !data) throw new ApiError("internal_error", "artifact 上传地址签发失败", true);
  return jsonResponse({ objectKey: fields.objectKey, uploadUrl: data.signedUrl, uploadToken: data.token });
}

async function actionArtifact(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const fields = artifactFields(body);
  const { runId, leaseId, objectKey, role, sha256, mime, bytes } = fields;
  const run = await assertLease(admin, runId, leaseId);
  const { data: sourceCall } = await admin.from("agent_tool_calls").select("call_id,status")
    .eq("run_id", runId).eq("call_id", fields.callId).maybeSingle();
  if (!sourceCall || !["submitted", "outcome_unknown", "succeeded"].includes(sourceCall.status as string)) {
    throw new ApiError("invalid_request", "artifact 未关联已提交的工具调用", false, 409);
  }
  const object = await admin.storage.from(BUCKET).download(objectKey);
  if (object.error || !object.data) throw new ApiError("invalid_request", "artifact 对象不存在", false, 409);
  const objectBytes = new Uint8Array(await object.data.arrayBuffer());
  let contentValid = actualImageMime(objectBytes) === mime;
  if (mime === "application/json") {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(objectBytes));
      contentValid = !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
    } catch {
      contentValid = false;
    }
  }
  if (objectBytes.byteLength !== bytes || await sha256Hex(objectBytes) !== sha256 || !contentValid) {
    throw new ApiError("invalid_request", "artifact 对象校验失败", false, 409);
  }
  const parentArtifactId = fields.parentArtifactId;
  if (parentArtifactId) {
    const { data: parent } = await admin.from("agent_artifacts").select("id").eq("id", parentArtifactId).eq("run_id", runId).maybeSingle();
    if (!parent) throw new ApiError("invalid_request", "artifact parent 不属于当前 Run");
  }
  const { data: existing, error: existingError } = await admin.from("agent_artifacts")
    .select("id,conversation_id,role,step_id,parent_artifact_id,object_key,mime,bytes,sha256,user_visible")
    .eq("run_id", runId).eq("source_call_id", fields.callId).maybeSingle();
  if (existingError) throw new ApiError("internal_error", "artifact 幂等读取失败", true);
  if (existing) {
    if (existing.object_key !== objectKey || existing.role !== role || existing.step_id !== fields.stepId ||
        existing.parent_artifact_id !== parentArtifactId || existing.mime !== mime || Number(existing.bytes) !== bytes ||
        existing.sha256 !== sha256 || existing.user_visible !== fields.userVisible) {
      throw new ApiError("invalid_request", "artifact 重放元数据冲突", false, 409);
    }
    return jsonResponse({
      conversationId: run.conversation_id, runId, artifactId: existing.id, role,
      stepId: existing.step_id, parentArtifactId: existing.parent_artifact_id,
      mime: existing.mime, bytes: Number(existing.bytes), sha256: existing.sha256,
      userVisible: existing.user_visible !== false, objectKey, reused: true,
    });
  }
  if (role === "final_result") {
    const { count } = await admin.from("agent_artifacts")
      .select("id", { count: "exact", head: true })
      .eq("run_id", runId)
      .eq("role", "final_result");
    if ((count ?? 0) >= 1) {
      if (run.result_feedback_action !== "retry") {
        throw new ApiError("invalid_request", "最终产物只能有一个", false, 409);
      }
      const demoted = await admin.from("agent_artifacts")
        .update({ role: "stage_result" })
        .eq("run_id", runId)
        .eq("role", "final_result")
        .is("deleted_at", null);
      if (demoted.error) throw new ApiError("internal_error", "旧最终产物归档失败", true);
    }
  }
  const { data: artifact, error } = await admin.from("agent_artifacts").insert({
    run_id: runId,
    conversation_id: run.conversation_id,
    kind: typeof body.kind === "string" ? body.kind.slice(0, 80) : role,
    role,
    step_id: fields.stepId,
    object_key: objectKey,
    mime: mime.slice(0, 120),
    bytes,
    sha256,
    source_call_id: fields.callId,
    parent_artifact_id: parentArtifactId,
    user_visible: fields.userVisible,
    expires_at: new Date(Date.now() + (role === "final_result" ? 7 : 1) * 24 * 3600 * 1000).toISOString(),
  }).select("id").single();
  if (error || !artifact) throw new ApiError("internal_error", "artifact 登记失败", true);
  return jsonResponse({
    conversationId: run.conversation_id, runId, artifactId: artifact.id, role,
    stepId: fields.stepId, parentArtifactId, mime, bytes, sha256,
    userVisible: fields.userVisible, objectKey, reused: false,
  });
}

async function actionArtifactGet(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  const callId = typeof body.callId === "string" ? body.callId : "";
  if (!runId || !leaseId || !/^[0-9a-f]{64}$/.test(callId)) throw new ApiError("invalid_request", "artifact 查询字段无效");
  await assertLease(admin, runId, leaseId);
  const { data: artifact, error } = await admin.from("agent_artifacts")
    .select("id,conversation_id,role,step_id,parent_artifact_id,object_key,mime,bytes,sha256,user_visible")
    .eq("run_id", runId).eq("source_call_id", callId).maybeSingle();
  if (error) throw new ApiError("internal_error", "artifact 查询失败", true);
  if (!artifact) throw new ApiError("invalid_request", "artifact 尚未登记", false, 409);
  const url = await signOrNull(admin, artifact.object_key as string);
  if (!url) throw new ApiError("invalid_request", "artifact 对象不可用", false, 409);
  return jsonResponse({
    artifactId: artifact.id,
    conversationId: artifact.conversation_id,
    runId,
    role: artifact.role,
    stepId: artifact.step_id,
    parentArtifactId: artifact.parent_artifact_id,
    mime: artifact.mime,
    bytes: Number(artifact.bytes),
    sha256: artifact.sha256,
    userVisible: artifact.user_visible !== false,
    objectKey: artifact.object_key,
    url,
  });
}

async function actionAwaitResultFeedback(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  if (!runId || !leaseId) throw new ApiError("invalid_request", "缺少 runId/leaseId");
  await assertLease(admin, runId, leaseId);
  const { count, error } = await admin.from("agent_artifacts")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .eq("role", "final_result");
  if (error) throw new ApiError("internal_error", "最终产物校验失败", true);
  if (count !== 1) throw new ApiError("invalid_request", "等待反馈前必须恰有一个最终产物", false, 409);
  const transitioned = await transitionRun(admin, {
    p_run_id: runId,
    p_lease_id: leaseId,
    p_to_status: "awaiting_result_feedback",
    p_current_step: "awaiting_result_feedback",
    p_progress: 90,
  });
  return jsonResponse({ runId, conversationId: transitioned.conversation_id, status: transitioned.status });
}

async function settleRun(
  admin: SupabaseClient,
  run: RunRow,
  finalStatus: "succeeded" | "failed" | "cancelled",
  error?: { code: string; message: string },
): Promise<{ run: RunRow & { actual_credits: number }; actual: number }> {
  const result = await admin.rpc("settle_agent_run", {
    p_run_id: run.id,
    p_lease_id: run.lease_id,
    p_final_status: finalStatus,
    p_error_code: error?.code ?? null,
    p_safe_message: error?.message ?? null,
  });
  if (result.error) {
    if (result.error.code === "55000") throw new ApiError("invalid_request", "Run 无法完成结算", false, 409);
    throw new ApiError("internal_error", "Run 结算失败", true);
  }
  const raw = Array.isArray(result.data) ? result.data[0] : result.data;
  const settled = raw as RunRow & { actual_credits: number };
  if (!settled?.id || !Number.isInteger(Number(settled.actual_credits))) {
    throw new ApiError("internal_error", "Run 结算返回无效", true);
  }
  return { run: settled, actual: Number(settled.actual_credits) };
}

async function actionFinish(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  if (!runId || !leaseId) throw new ApiError("invalid_request", "缺少 runId/leaseId");
  const run = await assertLease(admin, runId, leaseId);
  // Exporting is non-terminal and keeps the lease. The settlement RPC then
  // confirms billing and exposes succeeded atomically.
  const active = run.status === "leased" ? await transitionRun(admin, {
    p_run_id: runId, p_lease_id: leaseId, p_to_status: "running", p_current_step: "resume_finish",
  }) : run;
  const exporting = active.status === "exporting" ? active : await transitionRun(admin, {
    p_run_id: runId, p_lease_id: leaseId, p_to_status: "exporting", p_current_step: "export",
  });
  const { actual } = await settleRun(admin, exporting, "succeeded");
  safeLog({ requestId: requestIdFromBody(body), service: "agent-worker:finish", status: "ok", credits: actual });
  return jsonResponse({ runId, status: "succeeded", actualCredits: actual });
}

function requestIdFromBody(_body: Record<string, unknown>): string {
  return crypto.randomUUID();
}

async function actionFail(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  if (!runId || !leaseId) throw new ApiError("invalid_request", "缺少 runId/leaseId");
  const run = await assertLease(admin, runId, leaseId);
  const safeCode = body.safeErrorCode ? String(body.safeErrorCode).slice(0, 80) : "worker_error";
  const safeMessage = body.safeMessage ? String(body.safeMessage).slice(0, 500) : "Run 执行失败";
  const { actual } = await settleRun(admin, run, "failed", { code: safeCode, message: safeMessage });
  return jsonResponse({ runId, status: "failed", actualCredits: actual });
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

    switch (action) {
      case "claim":
        return await actionClaim(admin, workerId);
      case "heartbeat":
        return await actionHeartbeat(admin, body);
      case "events":
        return await actionEvents(admin, body);
      case "usage":
        return await actionUsage(admin, body);
      case "tool_prepare":
        return await actionToolCall(admin, body, "prepare");
      case "tool_submitted":
        return await actionToolCall(admin, body, "submitted");
      case "tool_complete":
        return await actionToolCall(admin, body, "complete");
      case "checkpoint_prepare":
        return await actionCheckpointPrepare(admin, body);
      case "checkpoint_commit":
        return await actionCheckpointCommit(admin, body);
      case "approval_request":
        return await actionApprovalRequest(admin, body);
      case "artifact_prepare":
        return await actionArtifactPrepare(admin, body);
      case "artifact":
        return await actionArtifact(admin, body);
      case "artifact_get":
        return await actionArtifactGet(admin, body);
      case "await_result_feedback":
        return await actionAwaitResultFeedback(admin, body);
      case "finish":
        return await actionFinish(admin, body);
      case "fail":
        return await actionFail(admin, body);
      case "cancel":
        return await actionCancel(admin, body);
      default:
        throw new ApiError("invalid_request", "未知 action");
    }
  } catch (error) {
    safeLog({
      requestId: id,
      service: "agent-worker",
      status: error instanceof ApiError ? error.code : "error",
      elapsedMs: Date.now() - started,
    });
    return errorResponse(error, id, cors);
  }
});
