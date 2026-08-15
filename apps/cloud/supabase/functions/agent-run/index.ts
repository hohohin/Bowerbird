// Bowerbird Agent Runtime A1-T3: user-side Run control actions.
// Bearer JWT + publishable key (requireUser); all writes go through the service
// client so RLS own-row SELECT stays the only direct user privilege.

import { requireUser } from "../_shared/auth.ts";
import { ensureDailyCredits, holdCredits } from "../_shared/billing.ts";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { corsHeaders } from "../_shared/limits.ts";

const BUCKET = "agent-temp";
const ALLOWED_SKILLS = new Set(["smart-refinement"]);
const MAX_INPUTS = 8;
const MAX_GOAL_CHARS = 4000;
const SIGNED_URL_SECONDS = 300;

interface CreateInput {
  skillId: string;
  goal: string;
  inputCount: number;
  inputManifestHash: string;
  ratio?: string;
}

interface OwnRun {
  id: string;
  status: string;
  skill_id: string;
}

function sha256Pattern(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

async function billingAccountId(admin: ReturnType<typeof requireUser> extends Promise<infer T> ? T["admin"] : never, authUserId: string): Promise<string> {
  const { data, error } = await admin.from("billing_accounts").select("id").eq("auth_user_id", authUserId).maybeSingle();
  if (error || !data) throw new ApiError("internal_error", "账号计费身份读取失败", true);
  return data.id as string;
}

async function loadOwnRun(admin: Parameters<typeof billingAccountId>[0], runId: string, authUserId: string): Promise<OwnRun> {
  const { data, error } = await admin.from("agent_runs")
    .select("id,status,skill_id,user_id,billing:billing_accounts!agent_runs_user_id_fkey(auth_user_id)")
    .eq("id", runId)
    .maybeSingle();
  if (error || !data) throw new ApiError("invalid_request", "Run 不存在", false, 404);
  const row = data as OwnRun & { user_id: string; billing: { auth_user_id: string } | null };
  if (!row.billing || row.billing.auth_user_id !== authUserId) {
    // Do not leak other users' run existence.
    throw new ApiError("invalid_request", "Run 不存在", false, 404);
  }
  return { id: row.id, status: row.status, skill_id: row.skill_id };
}

function serviceBudget(service: string): { budget: number; pricingVersion: number } {
  if (service === "smart-refinement") return { budget: 15, pricingVersion: 1 };
  throw new ApiError("invalid_request", "不支持的 Skill", false);
}

async function actionCreate(admin: Parameters<typeof billingAccountId>[0], user: { id: string }, body: Record<string, unknown>, requestIdValue: string): Promise<Response> {
  const skillId = typeof body.skillId === "string" ? body.skillId : "";
  if (!ALLOWED_SKILLS.has(skillId)) throw new ApiError("invalid_request", "不支持的 Skill");
  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  if (!goal || goal.length > MAX_GOAL_CHARS) throw new ApiError("invalid_request", "目标文本长度需在 1–4000 字之间");
  const inputCount = Number(body.inputCount);
  if (!Number.isInteger(inputCount) || inputCount < 1 || inputCount > MAX_INPUTS) {
    throw new ApiError("invalid_request", `输入图数量需在 1–${MAX_INPUTS} 张之间`);
  }
  if (!sha256Pattern(body.inputManifestHash)) throw new ApiError("invalid_request", "输入清单哈希格式无效");
  if (body.ratio !== undefined && (typeof body.ratio !== "string" || body.ratio.length > 16)) {
    throw new ApiError("invalid_request", "ratio 无效");
  }

  const { budget, pricingVersion } = serviceBudget(skillId);
  const accountId = await billingAccountId(admin, user.id);
  await ensureDailyCredits(admin, accountId);

  const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.length >= 8
    ? body.idempotencyKey.slice(0, 128)
    : `agent-run-${user.id.slice(0, 8)}-${requestIdValue}`;
  const hold = await holdCredits(admin, accountId, idempotencyKey, skillId === "smart-refinement" ? "agent_smart_refinement" : skillId);

  // Idempotent create: if a run row already references this hold, return it.
  const { data: existing } = await admin.from("agent_runs").select("id,status").eq("hold_id", hold.holdId).maybeSingle();
  if (existing) {
    return jsonResponse({ runId: (existing as OwnRun).id, holdId: hold.holdId, reused: true });
  }

  const runId = crypto.randomUUID();
  const requestKey = `runs/${runId}/request.json`;
  const { error: insertError } = await admin.from("agent_runs").insert({
    id: runId,
    user_id: accountId,
    skill_id: skillId,
    skill_version: "0.1.0-m0",
    kernel_version: "0.1.0",
    status: "uploading",
    input_count: inputCount,
    input_manifest_hash: body.inputManifestHash as string,
    request_object_key: requestKey,
    budget_credits: budget,
    hold_id: hold.holdId,
    pricing_version: pricingVersion,
    content_expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  });
  if (insertError) throw new ApiError("internal_error", "Run 创建失败", true);

  const upload = await admin.storage.from(BUCKET)
    .createSignedUploadUrl(`${runId}/inputs/request.json`);
  if (upload.error) throw new ApiError("internal_error", "上传地址签发失败", true);

  safeLog({
    requestId: requestIdValue,
    userId: user.id,
    service: "agent-run:create",
    status: "ok",
    credits: budget,
  });
  return jsonResponse({
    runId,
    holdId: hold.holdId,
    uploadUrl: upload.data.signedUrl,
    uploadToken: upload.data.token,
    budgetCredits: budget,
    pricingVersion,
  });
}

async function actionEnqueue(admin: Parameters<typeof billingAccountId>[0], user: { id: string }, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  if (!runId) throw new ApiError("invalid_request", "缺少 runId");
  await loadOwnRun(admin, runId, user.id);
  const { data: run, error } = await admin.from("agent_runs")
    .select("status,input_count,input_manifest_hash")
    .eq("id", runId)
    .maybeSingle();
  if (error || !run) throw new ApiError("invalid_request", "Run 不存在", false, 404);
  const row = run as { status: string; input_count: number };
  if (row.status !== "uploading") throw new ApiError("invalid_request", "Run 状态不允许入队");

  const { error: updateError } = await admin.from("agent_runs")
    .update({ status: "queued", queued_at: new Date().toISOString() })
    .eq("id", runId)
    .eq("status", "uploading");
  if (updateError) throw new ApiError("internal_error", "入队失败", true);
  return jsonResponse({ runId, status: "queued" });
}

async function actionGet(admin: Parameters<typeof billingAccountId>[0], user: { id: string }, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  if (!runId) throw new ApiError("invalid_request", "缺少 runId");
  await loadOwnRun(admin, runId, user.id);
  const [{ data: run }, { data: events }, { data: approvals }] = await Promise.all([
    admin.from("agent_runs").select(
      "id,status,current_step,progress,skill_id,skill_version,budget_credits,actual_credits,created_at,queued_at,started_at,finished_at,content_expires_at,error_code,safe_message",
    ).eq("id", runId).maybeSingle(),
    admin.from("agent_events").select("seq,type,step,progress,created_at").eq("run_id", runId).order("seq", { ascending: false }).limit(50),
    admin.from("agent_approvals").select("id,kind,status,requested_at,expires_at,estimated_additional_credits").eq("run_id", runId).order("requested_at", { ascending: false }).limit(10),
  ]);
  return jsonResponse({
    run,
    events: events ?? [],
    approvals: approvals ?? [],
  });
}

async function actionDecideApproval(admin: Parameters<typeof billingAccountId>[0], user: { id: string }, body: Record<string, unknown>, approve: boolean): Promise<Response> {
  const approvalId = typeof body.approvalId === "string" ? body.approvalId : "";
  if (!approvalId) throw new ApiError("invalid_request", "缺少 approvalId");
  const { data: approval, error } = await admin.from("agent_approvals")
    .select("id,run_id,status,expires_at,kind,run:agent_runs!agent_approvals_run_id_fkey(id,user_id,billing:billing_accounts!agent_runs_user_id_fkey(auth_user_id))")
    .eq("id", approvalId)
    .maybeSingle();
  if (error || !approval) throw new ApiError("invalid_request", "审批不存在", false, 404);
  const row = approval as {
    id: string; run_id: string; status: string; expires_at: string;
    run: { id: string; billing: { auth_user_id: string } | null } | null;
  };
  if (!row.run?.billing || row.run.billing.auth_user_id !== user.id) {
    throw new ApiError("invalid_request", "审批不存在", false, 404);
  }
  if (row.status !== "pending") throw new ApiError("invalid_request", "审批已被处理");
  if (Date.parse(row.expires_at) <= Date.now()) {
    await admin.from("agent_approvals").update({ status: "expired", decided_at: new Date().toISOString() }).eq("id", approvalId);
    throw new ApiError("invalid_request", "审批已过期，请重新提交计划");
  }

  const { error: decideError } = await admin.from("agent_approvals")
    .update({ status: approve ? "approved" : "rejected", decided_at: new Date().toISOString() })
    .eq("id", approvalId)
    .eq("status", "pending");
  if (decideError) throw new ApiError("internal_error", "审批决策失败", true);

  // Approval releases the pause; the run re-queues for a fresh lease.
  await admin.from("agent_runs")
    .update({ status: "queued" })
    .eq("id", row.run_id)
    .eq("status", "awaiting_approval");
  // Rejection ends the run at the next worker reconciliation; mark cancel intent now.
  if (!approve) {
    await admin.from("agent_runs")
      .update({ cancel_requested_at: new Date().toISOString() })
      .eq("id", row.run_id)
      .in("status", ["queued", "awaiting_approval"]);
  }
  return jsonResponse({ approvalId, status: approve ? "approved" : "rejected" });
}

async function actionCancel(admin: Parameters<typeof billingAccountId>[0], user: { id: string }, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  if (!runId) throw new ApiError("invalid_request", "缺少 runId");
  const own = await loadOwnRun(admin, runId, user.id);
  if (["succeeded", "failed", "cancelled"].includes(own.status)) {
    return jsonResponse({ runId, status: own.status, alreadyFinal: true });
  }
  if (own.status === "uploading" || own.status === "queued") {
    // Not started: cancel directly; hold rollback happens at settle time.
    const { error } = await admin.from("agent_runs")
      .update({ status: "cancelled", finished_at: new Date().toISOString() })
      .eq("id", runId)
      .in("status", ["uploading", "queued"]);
    if (error) throw new ApiError("internal_error", "取消失败", true);
    return jsonResponse({ runId, status: "cancelled" });
  }
  const { error } = await admin.from("agent_runs")
    .update({ cancel_requested_at: new Date().toISOString() })
    .eq("id", runId);
  if (error) throw new ApiError("internal_error", "取消请求失败", true);
  return jsonResponse({ runId, status: "cancel_requested" });
}

async function actionArtifactUrl(admin: Parameters<typeof billingAccountId>[0], user: { id: string }, body: Record<string, unknown>): Promise<Response> {
  const artifactId = typeof body.artifactId === "string" ? body.artifactId : "";
  if (!artifactId) throw new ApiError("invalid_request", "缺少 artifactId");
  const { data: artifact, error } = await admin.from("agent_artifacts")
    .select("id,object_key,deleted_at,expires_at,run:agent_runs!agent_artifacts_run_id_fkey(billing:billing_accounts!agent_runs_user_id_fkey(auth_user_id))")
    .eq("id", artifactId)
    .maybeSingle();
  if (error || !artifact) throw new ApiError("invalid_request", "产物不存在", false, 404);
  const row = artifact as { object_key: string; deleted_at: string | null; expires_at: string; run: { billing: { auth_user_id: string } | null } | null };
  if (!row.run?.billing || row.run.billing.auth_user_id !== user.id) {
    throw new ApiError("invalid_request", "产物不存在", false, 404);
  }
  if (row.deleted_at || Date.parse(row.expires_at) <= Date.now()) {
    throw new ApiError("invalid_request", "产物已过期", false, 410);
  }
  const { data: signed, error: signError } = await admin.storage.from(BUCKET)
    .createSignedUrl(row.object_key, SIGNED_URL_SECONDS, { download: true });
  if (signError || !signed) throw new ApiError("internal_error", "下载地址签发失败", true);
  return jsonResponse({ artifactId, url: signed.signedUrl, expiresInSeconds: SIGNED_URL_SECONDS });
}

async function actionArtifactReceived(admin: Parameters<typeof billingAccountId>[0], user: { id: string }, body: Record<string, unknown>): Promise<Response> {
  const artifactId = typeof body.artifactId === "string" ? body.artifactId : "";
  if (!artifactId) throw new ApiError("invalid_request", "缺少 artifactId");
  const { data: artifact, error } = await admin.from("agent_artifacts")
    .select("id,run:agent_runs!agent_artifacts_run_id_fkey(billing:billing_accounts!agent_runs_user_id_fkey(auth_user_id))")
    .eq("id", artifactId)
    .maybeSingle();
  if (error || !artifact) throw new ApiError("invalid_request", "产物不存在", false, 404);
  const row = artifact as { id: string; run: { billing: { auth_user_id: string } | null } | null };
  if (!row.run?.billing || row.run.billing.auth_user_id !== user.id) {
    throw new ApiError("invalid_request", "产物不存在", false, 404);
  }
  const { error: updateError } = await admin.from("agent_artifacts")
    .update({ downloaded_at: new Date().toISOString() })
    .eq("id", artifactId);
  if (updateError) throw new ApiError("internal_error", "确认失败", true);
  return jsonResponse({ artifactId, received: true });
}

Deno.serve(async (request) => {
  const id = requestId(request);
  let cors: HeadersInit = {};
  let userId: string | undefined;
  const started = Date.now();
  try {
    cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") throw new ApiError("invalid_request", "仅支持 POST", false, 405);

    const { user, admin } = await requireUser(request);
    userId = user.id;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";

    switch (action) {
      case "create":
        return await actionCreate(admin, user, body, id);
      case "enqueue":
        return await actionEnqueue(admin, user, body);
      case "get":
        return await actionGet(admin, user, body);
      case "approve":
        return await actionDecideApproval(admin, user, body, true);
      case "reject":
        return await actionDecideApproval(admin, user, body, false);
      case "cancel":
        return await actionCancel(admin, user, body);
      case "artifact_url":
        return await actionArtifactUrl(admin, user, body);
      case "artifact_received":
        return await actionArtifactReceived(admin, user, body);
      default:
        throw new ApiError("invalid_request", "未知 action");
    }
  } catch (error) {
    safeLog({
      requestId: id,
      userId,
      service: "agent-run",
      status: error instanceof ApiError ? error.code : "error",
      elapsedMs: Date.now() - started,
    });
    return errorResponse(error, id, cors);
  }
});
