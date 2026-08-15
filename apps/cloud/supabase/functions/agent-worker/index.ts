// Bowerbird Agent Runtime A1-T4: worker-side Run actions.
// Auth: high-entropy Worker Token (constant-time compare), never a user JWT,
// never service_role exposure to the VPS. Usage credits are computed here from
// versioned service_costs — worker-reported totals are never authoritative.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { corsHeaders } from "../_shared/limits.ts";
import { confirmCredits, rollbackCredits } from "../_shared/billing.ts";

const BUCKET = "agent-temp";
const MAX_EVENTS_PER_BATCH = 100;
const MAX_USAGE_PER_BATCH = 100;
const CHECKPOINT_URL_SECONDS = 300;

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
  status: string;
  lease_id: string | null;
  request_object_key: string;
  skill_id: string;
  input_manifest_hash: string;
  checkpoint_object_key: string | null;
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
  if (!claimed) return jsonResponse({ run: null });
  const inputKey = `${claimed.id}/inputs/request.json`;
  const checkpointKey = claimed.checkpoint_object_key;
  // Signed URLs are best-effort here: a not-yet-uploaded input or a pruned
  // checkpoint must not break claiming; the worker re-requests when needed.
  const [inputUrl, checkpointUrl] = await Promise.all([
    signOrNull(admin, inputKey),
    checkpointKey ? signOrNull(admin, checkpointKey) : Promise.resolve(null),
  ]);
  return jsonResponse({
    run: {
      id: claimed.id,
      skillId: claimed.skill_id,
      inputManifestHash: claimed.input_manifest_hash,
      budgetCredits: claimed.budget_credits,
      pricingVersion: claimed.pricing_version,
    },
    lease: { leaseId: claimed.lease_id, expiresAt: null, leaseSeconds: 60 },
    inputUrl,
    checkpointUrl,
  });
}

async function actionHeartbeat(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  if (!runId || !leaseId) throw new ApiError("invalid_request", "缺少 runId/leaseId");
  const heartbeatResult = await admin.rpc("heartbeat_agent_run", { p_run_id: runId, p_lease_id: leaseId, p_lease_seconds: 60 });
  if (heartbeatResult.error) throw new ApiError("internal_error", "心跳 RPC 失败", true);
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
  if (run.lease_id !== leaseId || !leaseId) {
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
    const { error } = await admin.from("agent_tool_calls").upsert(row, { onConflict: "run_id,call_id", ignoreDuplicates: true });
    if (error) throw new ApiError("internal_error", "tool call 登记失败", true);
    return jsonResponse({ callId, status: "prepared" });
  }

  if (phase === "submitted") {
    const { error } = await admin.from("agent_tool_calls")
      .update({ status: "submitted", submitted_at: new Date().toISOString(), provider_request_id: body.providerRequestId ? String(body.providerRequestId).slice(0, 200) : null })
      .eq("run_id", runId).eq("call_id", callId).eq("status", "prepared");
    if (error) throw new ApiError("internal_error", "submitted 更新失败", true);
    return jsonResponse({ callId, status: "submitted" });
  }

  // complete
  const status = body.status === "failed" ? "failed" : body.status === "outcome_unknown" ? "outcome_unknown" : "succeeded";
  const { error } = await admin.from("agent_tool_calls")
    .update({
      status,
      finished_at: new Date().toISOString(),
      result_object_key: body.resultObjectKey ? String(body.resultObjectKey).slice(0, 512) : null,
      result_hash: body.resultHash && /^[0-9a-f]{64}$/.test(String(body.resultHash)) ? String(body.resultHash) : null,
      safe_error_code: body.safeErrorCode ? String(body.safeErrorCode).slice(0, 80) : null,
    })
    .eq("run_id", runId).eq("call_id", callId).in("status", ["prepared", "submitted"]);
  if (error) throw new ApiError("internal_error", "complete 更新失败", true);
  return jsonResponse({ callId, status });
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
  if (result.error) throw new ApiError("internal_error", "状态转换失败", true);
  const raw = Array.isArray(result.data) ? result.data[0] : result.data;
  return raw as RunRow;
}

async function actionCheckpoint(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  if (!runId || !leaseId) throw new ApiError("invalid_request", "缺少 runId/leaseId");
  if (typeof body.checkpointHash !== "string" || !/^[0-9a-f]{64}$/.test(body.checkpointHash)) {
    throw new ApiError("invalid_request", "checkpoint hash 无效");
  }
  const objectKey = `runs/${runId}/checkpoints/${body.checkpointHash.slice(0, 16)}.json`;
  await transitionRun(admin, {
    p_run_id: runId,
    p_lease_id: leaseId,
    p_to_status: "running",
    p_current_step: body.step ? String(body.step).slice(0, 120) : null,
    p_progress: body.progress === undefined ? null : Number(body.progress),
    p_checkpoint_object_key: objectKey,
    p_checkpoint_hash: body.checkpointHash,
    p_snapshot_schema_version: 1,
  });
  const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(objectKey);
  if (error || !data) throw new ApiError("internal_error", "checkpoint 上传地址签发失败", true);
  return jsonResponse({ checkpointUrl: data.signedUrl, checkpointToken: data.token });
}

async function settleRun(admin: SupabaseClient, run: RunRow, finalStatus: "succeeded" | "failed" | "cancelled"): Promise<number> {
  const spent = await spentCredits(admin, run.id);
  const actual = Math.min(spent, run.budget_credits);
  if (actual > 0) {
    await confirmCredits(admin, run.hold_id, actual);
  } else {
    await rollbackCredits(admin, run.hold_id, `agent run ${finalStatus} without usage`);
  }
  await admin.from("agent_runs").update({ actual_credits: actual }).eq("id", run.id);
  return actual;
}

async function actionFinish(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  if (!runId || !leaseId) throw new ApiError("invalid_request", "缺少 runId/leaseId");
  const run = await assertLease(admin, runId, leaseId);
  // The state machine requires exporting before succeeded from any active state.
  if (run.status !== "exporting") {
    await transitionRun(admin, {
      p_run_id: runId, p_lease_id: leaseId, p_to_status: "exporting", p_current_step: "export",
    });
  }
  const exporting = await transitionRun(admin, {
    p_run_id: runId, p_lease_id: leaseId, p_to_status: "succeeded",
    p_current_step: "done", p_progress: 100,
  });
  const actual = await settleRun(admin, exporting, "succeeded");
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
  await transitionRun(admin, {
    p_run_id: runId, p_lease_id: leaseId, p_to_status: "failed",
    p_current_step: safeCode,
  });
  const actual = await settleRun(admin, run, "failed");
  await admin.from("agent_runs").update({ error_code: safeCode, safe_message: safeMessage }).eq("id", runId);
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
      case "checkpoint":
        return await actionCheckpoint(admin, body);
      case "finish":
        return await actionFinish(admin, body);
      case "fail":
        return await actionFail(admin, body);
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
