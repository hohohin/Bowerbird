// Bowerbird Agent Runtime A1-T3: user-side Run control actions.
// Bearer JWT + publishable key (requireUser); all writes go through the service
// client so RLS own-row SELECT stays the only direct user privilege.

import { requireUser } from "../_shared/auth.ts";
import type { AuthContext } from "../_shared/auth.ts";
import { ensureDailyCredits, holdCredits } from "../_shared/billing.ts";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { corsHeaders } from "../_shared/limits.ts";

const BUCKET = "agent-temp";
const ALLOWED_SKILLS = new Set(["smart-refinement", "bowerbird-controlled-image-edit"]);
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
  conversation_id: string;
  status: string;
  skill_id: string;
}

function sha256Pattern(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function controlledInputObjectKey(runId: string, ordinal: number): string {
  return `runs/${runId}/inputs/reference-${ordinal}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function actualImageMime(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
      new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

type ControlledReference = {
  referenceId: string;
  ordinal: number;
  mime: "image/png" | "image/jpeg" | "image/webp";
  bytes: number;
  sha256: string;
};

function parseControlledManifest(value: unknown, expectedCount: number): ControlledReference[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("invalid_request", "受控编辑输入清单无效");
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== 1 || typeof manifest.intentPrompt !== "string" ||
      !manifest.intentPrompt.trim() || manifest.intentPrompt.length > MAX_GOAL_CHARS || !Array.isArray(manifest.references)) {
    throw new ApiError("invalid_request", "受控编辑输入清单无效");
  }
  if (manifest.references.length !== expectedCount) throw new ApiError("invalid_request", "参考图数量与 Run 不一致");
  const ordinals = new Set<number>();
  const ids = new Set<string>();
  return manifest.references.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError("invalid_request", "参考图元数据无效");
    const item = raw as Record<string, unknown>;
    const referenceId = typeof item.referenceId === "string" ? item.referenceId : "";
    const ordinal = Number(item.ordinal);
    const mime = item.mime;
    const bytes = Number(item.bytes);
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(referenceId) || ids.has(referenceId) ||
        !Number.isInteger(ordinal) || ordinal < 1 || ordinal > expectedCount || ordinals.has(ordinal) ||
        !["image/png", "image/jpeg", "image/webp"].includes(String(mime)) ||
        !Number.isInteger(bytes) || bytes <= 0 || bytes > 20 * 1024 * 1024 || !sha256Pattern(item.sha256)) {
      throw new ApiError("invalid_request", "参考图元数据无效");
    }
    ids.add(referenceId);
    ordinals.add(ordinal);
    return { referenceId, ordinal, mime, bytes, sha256: item.sha256 } as ControlledReference;
  }).sort((a, b) => a.ordinal - b.ordinal);
}

async function billingAccountId(admin: AuthContext["admin"], authUserId: string): Promise<string> {
  const { data, error } = await admin.from("billing_accounts").select("id").eq("auth_user_id", authUserId).maybeSingle();
  if (error || !data) throw new ApiError("internal_error", "账号计费身份读取失败", true);
  return data.id as string;
}

async function loadOwnRun(admin: Parameters<typeof billingAccountId>[0], runId: string, authUserId: string): Promise<OwnRun> {
  const { data, error } = await admin.from("agent_runs")
    .select("id,conversation_id,status,skill_id,user_id,billing:billing_accounts!agent_runs_user_id_fkey(auth_user_id)")
    .eq("id", runId)
    .maybeSingle();
  if (error || !data) throw new ApiError("invalid_request", "Run 不存在", false, 404);
  const row = data as unknown as OwnRun & { user_id: string; billing: { auth_user_id: string } | null };
  if (!row.billing || row.billing.auth_user_id !== authUserId) {
    // Do not leak other users' run existence.
    throw new ApiError("invalid_request", "Run 不存在", false, 404);
  }
  return { id: row.id, conversation_id: row.conversation_id, status: row.status, skill_id: row.skill_id };
}

function serviceBudget(service: string): { budget: number; pricingVersion: number } {
  if (service === "smart-refinement") return { budget: 15, pricingVersion: 1 };
  if (service === "bowerbird-controlled-image-edit") return { budget: 48, pricingVersion: 1 };
  throw new ApiError("invalid_request", "不支持的 Skill", false);
}

async function actionCreate(admin: Parameters<typeof billingAccountId>[0], user: { id: string }, body: Record<string, unknown>, requestIdValue: string): Promise<Response> {
  const skillId = typeof body.skillId === "string" ? body.skillId : "";
  if (!ALLOWED_SKILLS.has(skillId)) throw new ApiError("invalid_request", "不支持的 Skill");
  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  if (!goal || goal.length > MAX_GOAL_CHARS) throw new ApiError("invalid_request", "目标文本长度需在 1–4000 字之间");
  const inputCount = Number(body.inputCount);
  const minInputs = skillId === "bowerbird-controlled-image-edit" ? 0 : 1;
  if (!Number.isInteger(inputCount) || inputCount < minInputs || inputCount > MAX_INPUTS) {
    throw new ApiError("invalid_request", `输入图数量需在 ${minInputs}–${MAX_INPUTS} 张之间`);
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
  const billingService = skillId === "smart-refinement"
    ? "agent_smart_refinement"
    : "agent_controlled_image_edit";
  const hold = await holdCredits(admin, accountId, idempotencyKey, billingService);

  // Idempotent create: if a run row already references this hold, return it.
  const { data: existing } = await admin.from("agent_runs")
    .select("id,conversation_id,status,skill_id,input_count,request_object_key,budget_credits,pricing_version")
    .eq("hold_id", hold.holdId).maybeSingle();
  if (existing) {
    const row = existing as OwnRun & {
      skill_id: string; input_count: number; request_object_key: string; budget_credits: number; pricing_version: number;
    };
    const requestUpload = row.status === "uploading"
      ? await admin.storage.from(BUCKET).createSignedUploadUrl(row.request_object_key)
      : null;
    if (requestUpload?.error || row.status === "uploading" && !requestUpload?.data) {
      throw new ApiError("internal_error", "上传地址重新签发失败", true);
    }
    const inputUploads = row.status === "uploading" && row.skill_id === "bowerbird-controlled-image-edit"
      ? await Promise.all(Array.from({ length: row.input_count }, async (_, index) => {
        const ordinal = index + 1;
        const objectKey = controlledInputObjectKey(row.id, ordinal);
        const signed = await admin.storage.from(BUCKET).createSignedUploadUrl(objectKey);
        if (signed.error || !signed.data) throw new ApiError("internal_error", "参考图上传地址重新签发失败", true);
        return { ordinal, objectKey, uploadUrl: signed.data.signedUrl, uploadToken: signed.data.token };
      }))
      : [];
    return jsonResponse({
      conversationId: row.conversation_id,
      runId: row.id,
      holdId: hold.holdId,
      uploadUrl: requestUpload?.data?.signedUrl ?? null,
      uploadToken: requestUpload?.data?.token ?? null,
      inputUploads,
      budgetCredits: row.budget_credits,
      pricingVersion: row.pricing_version,
      reused: true,
    });
  }

  const runId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const requestKey = skillId === "bowerbird-controlled-image-edit"
    ? `runs/${runId}/inputs/request.json`
    : `${runId}/inputs/request.json`;
  const { error: insertError } = await admin.from("agent_runs").insert({
    id: runId,
    conversation_id: conversationId,
    user_id: accountId,
    skill_id: skillId,
    skill_version: skillId === "bowerbird-controlled-image-edit" ? "0.1.1" : "0.1.0-m0",
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

  const upload = await admin.storage.from(BUCKET).createSignedUploadUrl(requestKey);
  if (upload.error) throw new ApiError("internal_error", "上传地址签发失败", true);

  const inputUploads = skillId === "bowerbird-controlled-image-edit"
    ? await Promise.all(Array.from({ length: inputCount }, async (_, index) => {
      const ordinal = index + 1;
      const objectKey = controlledInputObjectKey(runId, ordinal);
      const signed = await admin.storage.from(BUCKET).createSignedUploadUrl(objectKey);
      if (signed.error || !signed.data) throw new ApiError("internal_error", "参考图上传地址签发失败", true);
      return { ordinal, objectKey, uploadUrl: signed.data.signedUrl, uploadToken: signed.data.token };
    }))
    : [];

  safeLog({
    requestId: requestIdValue,
    userId: user.id,
    service: "agent-run:create",
    status: "ok",
    credits: budget,
  });
  return jsonResponse({
    conversationId,
    runId,
    holdId: hold.holdId,
    uploadUrl: upload.data.signedUrl,
    uploadToken: upload.data.token,
    inputUploads,
    budgetCredits: budget,
    pricingVersion,
  });
}

async function actionEnqueue(admin: Parameters<typeof billingAccountId>[0], user: { id: string }, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  if (!runId) throw new ApiError("invalid_request", "缺少 runId");
  await loadOwnRun(admin, runId, user.id);
  const { data: run, error } = await admin.from("agent_runs")
    .select("id,conversation_id,status,skill_id,input_count,input_manifest_hash,request_object_key,content_expires_at")
    .eq("id", runId)
    .maybeSingle();
  if (error || !run) throw new ApiError("invalid_request", "Run 不存在", false, 404);
  const row = run as {
    id: string; conversation_id: string; status: string; skill_id: string; input_count: number;
    input_manifest_hash: string; request_object_key: string; content_expires_at: string;
  };
  if (row.status !== "uploading") throw new ApiError("invalid_request", "Run 状态不允许入队");

  if (row.skill_id === "bowerbird-controlled-image-edit") {
    const downloaded = await admin.storage.from(BUCKET).download(row.request_object_key);
    if (downloaded.error || !downloaded.data) throw new ApiError("invalid_request", "输入清单尚未上传");
    const requestBytes = new Uint8Array(await downloaded.data.arrayBuffer());
    if (!requestBytes.byteLength || requestBytes.byteLength > 64 * 1024 ||
        await sha256Hex(requestBytes) !== row.input_manifest_hash) {
      throw new ApiError("invalid_request", "输入清单校验失败");
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(new TextDecoder().decode(requestBytes));
    } catch {
      throw new ApiError("invalid_request", "输入清单不是有效 JSON");
    }
    const references = parseControlledManifest(manifest, row.input_count);
    const artifacts = [];
    for (const reference of references) {
      const objectKey = controlledInputObjectKey(runId, reference.ordinal);
      const object = await admin.storage.from(BUCKET).download(objectKey);
      if (object.error || !object.data) throw new ApiError("invalid_request", `第 ${reference.ordinal} 张参考图尚未上传`);
      const bytes = new Uint8Array(await object.data.arrayBuffer());
      if (bytes.byteLength !== reference.bytes || await sha256Hex(bytes) !== reference.sha256 ||
          actualImageMime(bytes) !== reference.mime) {
        throw new ApiError("invalid_request", `第 ${reference.ordinal} 张参考图校验失败`);
      }
      artifacts.push({
        run_id: runId,
        conversation_id: row.conversation_id,
        kind: "input",
        role: "input",
        step_id: reference.referenceId,
        object_key: objectKey,
        mime: reference.mime,
        bytes: reference.bytes,
        sha256: reference.sha256,
        user_visible: true,
        expires_at: row.content_expires_at,
      });
    }
    if (artifacts.length) {
      const inserted = await admin.from("agent_artifacts").upsert(artifacts, {
        onConflict: "run_id,object_key",
        ignoreDuplicates: true,
      });
      if (inserted.error) throw new ApiError("internal_error", "输入产物登记失败", true);
    }
  }

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
      "id,conversation_id,status,current_step,progress,skill_id,skill_version,approved_plan_hash,planned_tool_count,budget_credits,actual_credits,result_feedback_action,created_at,queued_at,started_at,finished_at,content_expires_at,error_code,safe_message",
    ).eq("id", runId).maybeSingle(),
    admin.from("agent_events").select("seq,type,step,progress,display_payload,created_at").eq("run_id", runId).order("seq", { ascending: true }).limit(100),
    admin.from("agent_approvals").select("id,kind,status,proposal_object_key,proposal_hash,planned_tool_count,requested_at,expires_at,estimated_additional_credits").eq("run_id", runId).order("requested_at", { ascending: false }).limit(10),
  ]);
  const { data: artifacts } = await admin.from("agent_artifacts")
    .select("id,conversation_id,kind,role,step_id,parent_artifact_id,mime,bytes,sha256,user_visible,expires_at,downloaded_at")
    .eq("run_id", runId)
    .eq("user_visible", true)
    .order("expires_at", { ascending: true });
  const approvalsWithProposal = await Promise.all((approvals ?? []).map(async (approval) => {
    const { proposal_object_key: proposalObjectKey, ...safeApproval } = approval;
    if (!proposalObjectKey) return safeApproval;
    const object = await admin.storage.from(BUCKET).download(proposalObjectKey as string);
    if (object.error || !object.data) throw new ApiError("internal_error", "审批计划读取失败", true);
    const bytes = new Uint8Array(await object.data.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > 64 * 1024) throw new ApiError("internal_error", "审批计划对象无效", true);
    let proposal: unknown;
    try { proposal = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new ApiError("internal_error", "审批计划对象无效", true); }
    return { ...safeApproval, proposal };
  }));
  return jsonResponse({
    conversationId: (run as { conversation_id?: string } | null)?.conversation_id ?? null,
    run,
    events: events ?? [],
    approvals: approvalsWithProposal,
    artifacts: artifacts ?? [],
  });
}

async function actionDecideApproval(admin: Parameters<typeof billingAccountId>[0], user: { id: string }, body: Record<string, unknown>, approve: boolean): Promise<Response> {
  const approvalId = typeof body.approvalId === "string" ? body.approvalId : "";
  if (!approvalId) throw new ApiError("invalid_request", "缺少 approvalId");
  const { data: approval, error } = await admin.from("agent_approvals")
    .select("id,run_id,status,expires_at,kind,proposal_hash,planned_tool_count,run:agent_runs!agent_approvals_run_id_fkey(id,user_id,billing:billing_accounts!agent_runs_user_id_fkey(auth_user_id))")
    .eq("id", approvalId)
    .maybeSingle();
  if (error || !approval) throw new ApiError("invalid_request", "审批不存在", false, 404);
  const row = approval as unknown as {
    id: string; run_id: string; status: string; expires_at: string; proposal_hash: string; planned_tool_count: number | null;
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
  if (approve) {
    await admin.from("agent_runs")
      .update({
        status: "queued",
        queued_at: new Date().toISOString(),
        approved_plan_hash: row.proposal_hash,
        planned_tool_count: row.planned_tool_count,
      })
      .eq("id", row.run_id)
      .eq("status", "awaiting_approval");
  }
  // A paused approval has no Worker lease. Settle durable usage and the hold in
  // the same database transaction before exposing the terminal state.
  if (!approve) {
    const { error: cancelError } = await admin.rpc("cancel_unleased_agent_run", { p_run_id: row.run_id });
    if (cancelError) throw new ApiError("internal_error", "拒绝计划后的结算失败", true);
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
  if (["uploading", "queued", "awaiting_approval", "awaiting_result_feedback"].includes(own.status)) {
    const { data, error } = await admin.rpc("cancel_unleased_agent_run", { p_run_id: runId });
    if (error) throw new ApiError("internal_error", "取消结算失败", true);
    const settled = Array.isArray(data) ? data[0] : data;
    return jsonResponse({
      runId,
      status: "cancelled",
      actualCredits: Number((settled as { actual_credits?: number } | null)?.actual_credits ?? 0),
    });
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
    .select("id,object_key,role,mime,user_visible,deleted_at,expires_at,run:agent_runs!agent_artifacts_run_id_fkey(billing:billing_accounts!agent_runs_user_id_fkey(auth_user_id))")
    .eq("id", artifactId)
    .maybeSingle();
  if (error || !artifact) throw new ApiError("invalid_request", "产物不存在", false, 404);
  const row = artifact as unknown as { object_key: string; role: string; mime: string; user_visible: boolean; deleted_at: string | null; expires_at: string; run: { billing: { auth_user_id: string } | null } | null };
  if (!row.run?.billing || row.run.billing.auth_user_id !== user.id) {
    throw new ApiError("invalid_request", "产物不存在", false, 404);
  }
  if (row.deleted_at || Date.parse(row.expires_at) <= Date.now()) {
    throw new ApiError("invalid_request", "产物已过期", false, 410);
  }
  if (!row.user_visible || !row.mime.startsWith("image/") || !["control_reference", "stage_result", "final_result"].includes(row.role)) {
    throw new ApiError("invalid_request", "该产物不可下载", false, 403);
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
    .select("id,role,mime,user_visible,run:agent_runs!agent_artifacts_run_id_fkey(billing:billing_accounts!agent_runs_user_id_fkey(auth_user_id))")
    .eq("id", artifactId)
    .maybeSingle();
  if (error || !artifact) throw new ApiError("invalid_request", "产物不存在", false, 404);
  const row = artifact as unknown as { id: string; role: string; mime: string; user_visible: boolean; run: { billing: { auth_user_id: string } | null } | null };
  if (!row.run?.billing || row.run.billing.auth_user_id !== user.id) {
    throw new ApiError("invalid_request", "产物不存在", false, 404);
  }
  if (!row.user_visible || !row.mime.startsWith("image/") || !["control_reference", "stage_result", "final_result"].includes(row.role)) {
    throw new ApiError("invalid_request", "只能确认用户可见图片产物", false, 403);
  }
  const { error: updateError } = await admin.from("agent_artifacts")
    .update({ downloaded_at: new Date().toISOString() })
    .eq("id", artifactId);
  if (updateError) throw new ApiError("internal_error", "确认失败", true);
  return jsonResponse({ artifactId, received: true });
}

async function actionResultFeedback(admin: Parameters<typeof billingAccountId>[0], user: { id: string }, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const action = body.feedbackAction === "accept" ? "accept" : body.feedbackAction === "retry" ? "retry" : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!runId || !action) throw new ApiError("invalid_request", "缺少 runId/feedbackAction");
  if (text.length > 2000) throw new ApiError("invalid_request", "反馈文本过长");
  const own = await loadOwnRun(admin, runId, user.id);
  if (own.status !== "awaiting_result_feedback") {
    throw new ApiError("invalid_request", "Run 当前不等待结果反馈", false, 409);
  }
  const feedbackId = crypto.randomUUID();
  const feedbackKey = `runs/${runId}/feedback/${feedbackId}.json`;
  const payload = new TextEncoder().encode(JSON.stringify({ action, text, createdAt: new Date().toISOString() }));
  const { error: uploadError } = await admin.storage.from(BUCKET).upload(feedbackKey, payload, {
    contentType: "application/json",
    upsert: false,
  });
  if (uploadError) throw new ApiError("internal_error", "反馈保存失败", true);
  const { error: updateError } = await admin.from("agent_runs").update({
    status: "queued",
    queued_at: new Date().toISOString(),
    current_step: action === "accept" ? "export" : "diagnose_feedback",
    feedback_object_key: feedbackKey,
    result_feedback_action: action,
  }).eq("id", runId).eq("status", "awaiting_result_feedback");
  if (updateError) throw new ApiError("internal_error", "结果反馈提交失败", true);
  return jsonResponse({ conversationId: own.conversation_id, runId, feedbackAction: action, status: "queued" });
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
      case "result_feedback":
        return await actionResultFeedback(admin, user, body);
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
