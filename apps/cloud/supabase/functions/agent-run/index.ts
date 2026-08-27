// Bowerbird Agent Runtime A1-T3: user-side Run control actions.
// Bearer JWT + publishable key (requireUser); all writes go through the service
// client so RLS own-row SELECT stays the only direct user privilege.

import { requireUser } from "../_shared/auth.ts";
import type { AuthContext } from "../_shared/auth.ts";
import { ensureDailyCredits, holdCredits, rollbackCredits } from "../_shared/billing.ts";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { activeTier, policyForUser } from "../_shared/feature-policy.ts";
import { corsHeaders } from "../_shared/limits.ts";
import { reserveManagedUsage } from "../_shared/usage.ts";

const BUCKET = "agent-temp";
const ALLOWED_SKILLS = new Set(["smart-refinement", "bowerbird-controlled-image-edit"]);
const MAX_INPUTS = 8;
const MAX_GOAL_CHARS = 4000;
const SIGNED_URL_SECONDS = 300;
const ACTIVE_AGENT_STATUSES = [
  "uploading", "queued", "leased", "running", "awaiting_clarification",
  "awaiting_approval", "awaiting_result_feedback", "awaiting_local_task",
  "exporting", "cancel_requested",
];

function globalAgentCapacity(): number {
  const value = Number.parseInt(Deno.env.get("AGENT_GLOBAL_ACTIVE_LIMIT") ?? "100", 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > 10000) {
    throw new ApiError("not_configured", "Agent 全站容量配置无效", false, 503);
  }
  return value;
}

interface CreateInput {
  skillId: string;
  goal: string;
  inputCount: number;
  inputManifestHash: string;
  ratio?: string;
  imageProvider?: string;
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
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

type VisualProfileTrace = { profileId: string; version: number; hash: string };
const VISUAL_PROFILE_CATEGORIES = new Set(["composition", "light", "palette", "mood", "material", "medium", "layout"]);

function parseVisualProfileTrace(value: unknown): VisualProfileTrace | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("invalid_request", "视觉设定追踪信息无效");
  const trace = value as Record<string, unknown>;
  if (typeof trace.profileId !== "string" || !trace.profileId.trim() || trace.profileId.length > 120 ||
      !Number.isInteger(trace.version) || Number(trace.version) < 1 || !sha256Pattern(trace.hash)) {
    throw new ApiError("invalid_request", "视觉设定追踪信息无效");
  }
  return { profileId: trace.profileId, version: Number(trace.version), hash: trace.hash as string };
}

async function validateVisualProfileCapsule(value: unknown): Promise<VisualProfileTrace | null> {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("invalid_request", "视觉设定胶囊无效");
  const capsule = value as Record<string, unknown>;
  const trace = parseVisualProfileTrace(capsule);
  if (capsule.schemaVersion !== 1 || typeof capsule.sourceScopeHash !== "string" || !capsule.sourceScopeHash.trim() ||
      typeof capsule.summary !== "string" || !Array.isArray(capsule.contentThemes) ||
      !(capsule.contentThemes as unknown[]).every((item) => typeof item === "string")) {
    throw new ApiError("invalid_request", "视觉设定胶囊无效");
  }
  for (const polarity of ["must", "prefer", "avoid"] as const) {
    const rules = capsule[polarity];
    if (!Array.isArray(rules) || !(rules as unknown[]).every((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
      const rule = raw as Record<string, unknown>;
      return VISUAL_PROFILE_CATEGORIES.has(String(rule.category)) && rule.polarity === polarity &&
        typeof rule.value === "string" && !!rule.value.trim() && rule.value.length <= 500;
    })) throw new ApiError("invalid_request", "视觉设定规则无效");
  }
  const { hash: _hash, ...payload } = capsule;
  const computed = await sha256Hex(new TextEncoder().encode(canonicalJson(payload)));
  if (computed !== trace!.hash) throw new ApiError("invalid_request", "视觉设定胶囊哈希不匹配");
  return trace;
}

function validatePreferenceCapsule(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("invalid_request", "偏好胶囊无效");
  }
  const capsule = value as Record<string, unknown>;
  const scope = capsule.scope;
  const generatedAt = typeof capsule.generatedAt === "string" ? Date.parse(capsule.generatedAt) : Number.NaN;
  const expiresAt = typeof capsule.expiresAt === "string" ? Date.parse(capsule.expiresAt) : Number.NaN;
  const now = Date.now();
  if (capsule.schemaVersion !== 1 || !scope || typeof scope !== "object" || Array.isArray(scope) ||
      !Number.isFinite(generatedAt) || !Number.isFinite(expiresAt) || expiresAt <= generatedAt ||
      generatedAt > now + 5 * 60 * 1000 || expiresAt <= now ||
      expiresAt - generatedAt > 30 * 24 * 60 * 60 * 1000 || expiresAt > now + 30 * 24 * 60 * 60 * 1000) {
    throw new ApiError("invalid_request", "偏好胶囊无效");
  }
  const projectId = (scope as Record<string, unknown>).projectId;
  if (projectId !== undefined && (typeof projectId !== "string" || !projectId.trim() || projectId.length > 120)) {
    throw new ApiError("invalid_request", "偏好胶囊范围无效");
  }
  const groups = [capsule.preferred, capsule.avoid, capsule.workflow];
  if (groups.some((group) => !Array.isArray(group))) throw new ApiError("invalid_request", "偏好事实无效");
  const facts = (groups as unknown[][]).flat();
  if (facts.length > 24) throw new ApiError("invalid_request", "偏好事实过多");
  const categories = new Set(["style", "subject", "palette", "composition", "medium", "workflow", "avoid"]);
  const keys = new Set<string>();
  for (const raw of facts) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError("invalid_request", "偏好事实无效");
    const fact = raw as Record<string, unknown>;
    const value = typeof fact.value === "string" ? fact.value.trim() : "";
    const confidence = Number(fact.confidence);
    const evidenceCount = Number(fact.evidenceCount);
    const key = `${fact.category}\u0000${value.toLocaleLowerCase()}`;
    if (!categories.has(String(fact.category)) || !value || value.length > 240 ||
        !Number.isFinite(confidence) || confidence < 0 || confidence > 1 ||
        !Number.isInteger(evidenceCount) || evidenceCount < 1 || fact.explicit !== true || keys.has(key)) {
      throw new ApiError("invalid_request", "偏好事实无效");
    }
    keys.add(key);
  }
}

async function parseControlledManifest(
  value: unknown,
  expectedCount: number,
): Promise<{ references: ControlledReference[]; visualProfile: VisualProfileTrace | null }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("invalid_request", "受控编辑输入清单无效");
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== 1 || typeof manifest.intentPrompt !== "string" ||
      !manifest.intentPrompt.trim() || manifest.intentPrompt.length > MAX_GOAL_CHARS || !Array.isArray(manifest.references)) {
    throw new ApiError("invalid_request", "受控编辑输入清单无效");
  }
  validatePreferenceCapsule(manifest.preferenceCapsule);
  const visualProfile = await validateVisualProfileCapsule(manifest.visualProfileCapsule);
  if (manifest.references.length !== expectedCount) throw new ApiError("invalid_request", "参考图数量与 Run 不一致");
  const ordinals = new Set<number>();
  const ids = new Set<string>();
  const references = manifest.references.map((raw) => {
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
  return { references, visualProfile };
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

function serviceBudget(service: string): { budget: number; pricingVersion: number; billingService: string } {
  if (service === "smart-refinement") return { budget: 15, pricingVersion: 1, billingService: "agent_smart_refinement" };
  if (service === "bowerbird-controlled-image-edit") {
    return { budget: 48, pricingVersion: 1, billingService: "agent_controlled_image_edit" };
  }
  throw new ApiError("invalid_request", "不支持的 Skill", false);
}

/** 暂时放宽 48 积分门控（0029/0031）：余额不足全档时回落到 9 积分低档，而不是直接拒绝。
 *  credit_hold 金额必须等于 service_costs.unit_cost，因此低档是独立 service 行；
 *  budget_credits 与预授权同额，保持「actual ≤ hold」的结算不变量。 */
function relaxedBudget(service: string, available: number): { budget: number; pricingVersion: number; billingService: string } {
  const full = serviceBudget(service);
  if (service !== "bowerbird-controlled-image-edit" || available >= full.budget) return full;
  return { budget: 9, pricingVersion: full.pricingVersion, billingService: `${full.billingService}_min` };
}

async function actionCreate(admin: Parameters<typeof billingAccountId>[0], user: { id: string; app_metadata?: unknown }, body: Record<string, unknown>, requestIdValue: string): Promise<Response> {
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
  const requestedImageProvider = body.imageProvider ?? "cloud";
  if (!["cloud", "jimeng", "codex"].includes(String(requestedImageProvider))) {
    throw new ApiError("invalid_request", "生图引擎无效");
  }
  const imageProvider = requestedImageProvider as "cloud" | "jimeng" | "codex";
  const visualProfile = parseVisualProfileTrace(body.visualProfile);
  if (visualProfile && skillId !== "bowerbird-controlled-image-edit") {
    throw new ApiError("invalid_request", "该 Skill 不支持项目视觉设定");
  }
  // Codex already performs its own reasoning/conversation loop. Combining it
  // with the Bowerbird Agent duplicates planning and is currently too slow,
  // so reject only new Runs while preserving existing Run/task recovery.
  if (imageProvider === "codex") {
    throw new ApiError(
      "invalid_request",
      "Codex 与 Bowerbird Agent 暂时互斥，请直接使用 Codex 或为 Agent 选择 Cloud / 即梦",
      false,
      409,
    );
  }
  if (imageProvider !== "cloud" && skillId !== "bowerbird-controlled-image-edit") {
    throw new ApiError("invalid_request", "该 Skill 不支持本机生图引擎");
  }

  const accountId = await billingAccountId(admin, user.id);
  const { data: subscription, error: subError } = await admin.from("subscriptions")
    .select("tier,status,current_period_end")
    .eq("user_id", accountId)
    .maybeSingle();
  if (subError) throw new ApiError("internal_error", "订阅状态读取失败", true);
  const policy = policyForUser(activeTier(subscription), user);
  if (!policy.can_use_agent_runs || !policy.allowed_agent_skills.includes(skillId)) {
    throw new ApiError("upgrade_required", "当前权益不支持该 Agent 能力", false, 403);
  }
  if (visualProfile && !policy.can_use_visual_profiles) {
    throw new ApiError("upgrade_required", "当前权益不支持项目视觉设定", false, 403);
  }
  // 服务端 BYO 门控读取与 entitlement 相同的 FeaturePolicy；客户端镜像不得作为唯一防线。
  if (imageProvider !== "cloud" && !policy.can_use_byo) {
    throw new ApiError("upgrade_required", "Agent 本机生图引擎需要 Pro 或 Studio 订阅", false, 403);
  }

  const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.length >= 8
    ? body.idempotencyKey.slice(0, 128)
    : `agent-run-${user.id.slice(0, 8)}-${requestIdValue}`;
  // 并发检查发生在 hold 前，避免被拒请求留下需要回滚、且不可安全复用的 idempotency key。
  // 已有同 key Run 必须绕过计数（它本身就在活动数内），后面的 hold/create 分支会幂等返回。
  const { data: priorHold, error: priorHoldError } = await admin.from("credit_holds")
    .select("id,service,estimated_amount,pricing_version,status")
    .eq("user_id", accountId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (priorHoldError) throw new ApiError("internal_error", "Agent 幂等状态读取失败", true);
  let idempotentRunExists = false;
  if (priorHold?.id) {
    const { data: priorRun, error: priorRunError } = await admin.from("agent_runs")
      .select("id")
      .eq("hold_id", priorHold.id)
      .maybeSingle();
    if (priorRunError) throw new ApiError("internal_error", "Agent 幂等状态读取失败", true);
    idempotentRunExists = !!priorRun;
    if (!idempotentRunExists && priorHold.status !== "held") {
      throw new ApiError("invalid_request", "该 Agent 幂等请求已终结，请重新发起", false, 409);
    }
  }
  if (!idempotentRunExists) {
    const { count: activeAgentRuns, error: activeAgentError } = await admin.from("agent_runs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", accountId)
      .in("status", ACTIVE_AGENT_STATUSES);
    if (activeAgentError) throw new ApiError("internal_error", "Agent 并发状态读取失败", true);
    if ((activeAgentRuns ?? 0) >= policy.max_parallel_agent_runs) {
      throw new ApiError("rate_limited", "当前 Agent 并发任务已达上限，请等待已有任务完成", true, 429);
    }
  }

  const balances = await ensureDailyCredits(admin, accountId);
  const available = balances.daily + balances.sub + balances.topup;
  const selectedBudget = relaxedBudget(skillId, available);
  const allowedBillingServices = new Set([
    serviceBudget(skillId).billingService,
    ...(skillId === "bowerbird-controlled-image-edit" ? [`${serviceBudget(skillId).billingService}_min`] : []),
  ]);
  if (priorHold && !allowedBillingServices.has(priorHold.service as string)) {
    throw new ApiError("invalid_request", "Agent 幂等请求与 Skill 不匹配", false, 409);
  }
  const budget = priorHold ? Number(priorHold.estimated_amount) : selectedBudget.budget;
  const pricingVersion = priorHold ? Number(priorHold.pricing_version) : selectedBudget.pricingVersion;
  const billingService = priorHold ? String(priorHold.service) : selectedBudget.billingService;
  const hold = await holdCredits(admin, accountId, idempotencyKey, billingService);

  // Idempotent create: if a run row already references this hold, return it.
  const { data: existing } = await admin.from("agent_runs")
    .select("id,conversation_id,status,skill_id,input_count,input_manifest_hash,request_object_key,image_provider,budget_credits,pricing_version,visual_profile_id,visual_profile_version,visual_profile_hash")
    .eq("hold_id", hold.holdId).maybeSingle();
  if (existing) {
    const row = existing as OwnRun & {
      skill_id: string; input_count: number; input_manifest_hash: string; request_object_key: string;
      image_provider: string; budget_credits: number; pricing_version: number;
      visual_profile_id: string | null; visual_profile_version: number | null; visual_profile_hash: string | null;
    };
    if (row.skill_id !== skillId || row.input_count !== inputCount ||
        row.input_manifest_hash !== body.inputManifestHash || row.image_provider !== imageProvider ||
        row.visual_profile_id !== (visualProfile?.profileId ?? null) || row.visual_profile_version !== (visualProfile?.version ?? null) ||
        row.visual_profile_hash !== (visualProfile?.hash ?? null)) {
      throw new ApiError("invalid_request", "Agent 幂等请求参数不一致", false, 409);
    }
    if (row.status === "uploading") {
      try {
        await reserveManagedUsage(admin, accountId, hold.holdId, row.budget_credits, true);
      } catch (error) {
        try {
          await rollbackCredits(admin, hold.holdId, error instanceof ApiError ? error.code : "agent_capacity_failed");
          await admin.from("agent_runs").update({
            status: "failed",
            actual_credits: 0,
            error_code: "agent_capacity_failed",
            safe_message: "Agent 云端容量暂不可用，请稍后重试",
            finished_at: new Date().toISOString(),
          }).eq("id", row.id).eq("status", "uploading");
        } catch { /* stale-hold reconciliation remains the safety net */ }
        throw error;
      }
    }
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

  let runId: string = crypto.randomUUID();
  let conversationId: string = crypto.randomUUID();
  let requestKey = skillId === "bowerbird-controlled-image-edit"
    ? `runs/${runId}/inputs/request.json`
    : `${runId}/inputs/request.json`;
  const guarded = await admin.rpc("create_agent_run_guarded", {
    p_run_id: runId,
    p_conversation_id: conversationId,
    p_user_id: accountId,
    p_skill_id: skillId,
    p_skill_version: skillId === "bowerbird-controlled-image-edit" ? "0.1.2" : "0.1.0-m0",
    p_kernel_version: "0.1.0",
    p_input_count: inputCount,
    p_input_manifest_hash: body.inputManifestHash as string,
    p_request_object_key: requestKey,
    p_image_provider: imageProvider,
    p_budget_credits: budget,
    p_hold_id: hold.holdId,
    p_pricing_version: pricingVersion,
    p_content_expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    p_max_user_parallel: policy.max_parallel_agent_runs,
    p_global_active_limit: globalAgentCapacity(),
  });
  if (guarded.error?.details === "agent_user_parallel_limit") {
    await rollbackCredits(admin, hold.holdId, "agent_user_parallel_limit");
    throw new ApiError("rate_limited", "当前 Agent 并发任务已达上限，请等待已有任务完成", true, 429);
  }
  if (guarded.error?.details === "agent_global_capacity") {
    await rollbackCredits(admin, hold.holdId, "agent_global_capacity");
    throw new ApiError("capacity_reached", "Agent 队列暂时已满，请稍后重试", true, 503);
  }
  if (guarded.error?.details === "agent_idempotency_mismatch") {
    throw new ApiError("invalid_request", "Agent 幂等请求参数不一致", false, 409);
  }
  if (guarded.error) {
    // A guarded replay mismatch may refer to an already valid Run. Only release
    // the hold when the failed transaction did not leave (or find) a Run row.
    const { data: runForHold } = await admin.from("agent_runs")
      .select("id")
      .eq("hold_id", hold.holdId)
      .maybeSingle();
    if (!runForHold) {
      try { await rollbackCredits(admin, hold.holdId, "agent_create_failed"); }
      catch { /* stale-hold reconciliation remains the safety net */ }
    }
    throw new ApiError("internal_error", "Run 创建失败", true);
  }
  const rawGuarded = Array.isArray(guarded.data) ? guarded.data[0] : guarded.data;
  if (!rawGuarded?.id) throw new ApiError("internal_error", "Run 创建返回无效", true);
  // A concurrent request with the same hold may have won the insert. From this
  // point all storage keys and response IDs must use the database winner.
  runId = String(rawGuarded.id);
  conversationId = String(rawGuarded.conversation_id);
  requestKey = String(rawGuarded.request_object_key);
  const traceUpdate = await admin.from("agent_runs").update({
    visual_profile_id: visualProfile?.profileId ?? null,
    visual_profile_version: visualProfile?.version ?? null,
    visual_profile_hash: visualProfile?.hash ?? null,
  }).eq("id", runId);
  if (traceUpdate.error) throw new ApiError("internal_error", "视觉设定追踪写入失败", true);

  try {
    // Reserve the project-wide managed cost ceiling before any user content is uploaded.
    // The full Run budget is conservative; actual billing still comes only from trusted usage.
    await reserveManagedUsage(admin, accountId, hold.holdId, budget, true);
  } catch (error) {
    try {
      await rollbackCredits(admin, hold.holdId, error instanceof ApiError ? error.code : "agent_capacity_failed");
      await admin.from("agent_runs").update({
        status: "failed",
        actual_credits: 0,
        error_code: "agent_capacity_failed",
        safe_message: "Agent 云端容量暂不可用，请稍后重试",
        finished_at: new Date().toISOString(),
      }).eq("id", runId).eq("status", "uploading");
    } catch { /* stale-hold reconciliation remains the safety net */ }
    throw error;
  }

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
    .select("id,conversation_id,status,skill_id,input_count,input_manifest_hash,request_object_key,content_expires_at,visual_profile_id,visual_profile_version,visual_profile_hash")
    .eq("id", runId)
    .maybeSingle();
  if (error || !run) throw new ApiError("invalid_request", "Run 不存在", false, 404);
  const row = run as {
    id: string; conversation_id: string; status: string; skill_id: string; input_count: number;
    input_manifest_hash: string; request_object_key: string; content_expires_at: string;
    visual_profile_id: string | null; visual_profile_version: number | null; visual_profile_hash: string | null;
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
    const parsed = await parseControlledManifest(manifest, row.input_count);
    if (row.visual_profile_id !== (parsed.visualProfile?.profileId ?? null) ||
        row.visual_profile_version !== (parsed.visualProfile?.version ?? null) ||
        row.visual_profile_hash !== (parsed.visualProfile?.hash ?? null)) {
      throw new ApiError("invalid_request", "视觉设定追踪与输入清单不一致", false, 409);
    }
    const references = parsed.references;
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
  const [{ data: run }, { data: events }, { data: approvals }, { data: clarifications }] = await Promise.all([
    admin.from("agent_runs").select(
      "id,conversation_id,status,current_step,progress,skill_id,skill_version,approved_plan_hash,planned_tool_count,budget_credits,actual_credits,result_feedback_action,visual_profile_id,visual_profile_version,visual_profile_hash,created_at,queued_at,started_at,finished_at,content_expires_at,content_deleted_at,error_code,safe_message",
    ).eq("id", runId).maybeSingle(),
    admin.from("agent_events").select("seq,type,step,progress,display_payload,created_at").eq("run_id", runId).order("seq", { ascending: true }).limit(100),
    admin.from("agent_approvals").select("id,kind,status,proposal_object_key,proposal_hash,planned_tool_count,requested_at,expires_at,content_deleted_at,estimated_additional_credits").eq("run_id", runId).order("requested_at", { ascending: false }).limit(10),
    admin.from("agent_clarifications").select("id,question_key,context_hash,status,question_object_key,asked_at,answered_at,expires_at,content_deleted_at").eq("run_id", runId).order("asked_at", { ascending: false }).limit(3),
  ]);
  const { data: artifacts } = await admin.from("agent_artifacts")
    .select("id,conversation_id,kind,role,step_id,parent_artifact_id,mime,bytes,sha256,user_visible,expires_at,downloaded_at")
    .eq("run_id", runId)
    .eq("user_visible", true)
    .is("deleted_at", null)
    .order("expires_at", { ascending: true });
  const approvalsWithProposal = await Promise.all((approvals ?? []).map(async (approval) => {
    const { proposal_object_key: proposalObjectKey, content_deleted_at: contentDeletedAt, ...safeApproval } = approval;
    if (!proposalObjectKey || contentDeletedAt) return { ...safeApproval, contentExpired: Boolean(contentDeletedAt) };
    const object = await admin.storage.from(BUCKET).download(proposalObjectKey as string);
    if (object.error || !object.data) throw new ApiError("internal_error", "审批计划读取失败", true);
    const bytes = new Uint8Array(await object.data.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > 64 * 1024) throw new ApiError("internal_error", "审批计划对象无效", true);
    let proposal: unknown;
    try { proposal = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new ApiError("internal_error", "审批计划对象无效", true); }
    return { ...safeApproval, proposal };
  }));
  const clarificationsWithQuestion = await Promise.all((clarifications ?? []).map(async (clarification) => {
    const { question_object_key: questionObjectKey, content_deleted_at: contentDeletedAt, ...safeClarification } = clarification;
    if (!questionObjectKey || contentDeletedAt) {
      return { ...safeClarification, contentExpired: Boolean(contentDeletedAt) };
    }
    const object = await admin.storage.from(BUCKET).download(questionObjectKey as string);
    if (object.error || !object.data) throw new ApiError("internal_error", "澄清问题读取失败", true);
    const bytes = new Uint8Array(await object.data.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > 16 * 1024) throw new ApiError("internal_error", "澄清问题对象无效", true);
    let question: unknown;
    try { question = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new ApiError("internal_error", "澄清问题对象无效", true); }
    return { ...safeClarification, question };
  }));

  // 本机生图停车态：内联待执行任务参数，桌面据此驱动对应 CLI。
  let pendingLocalTask: Record<string, unknown> | null = null;
  const runRow = run as { status?: string } | null;
  if (runRow?.status === "awaiting_local_task") {
    const { data: task, error: taskError } = await admin.from("agent_local_tasks")
      .select("call_id,provider,step_id,params_object_key,expires_at")
      .eq("run_id", runId).eq("status", "pending")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (taskError) throw new ApiError("internal_error", "本地任务读取失败", true);
    if (task) {
      const object = await admin.storage.from(BUCKET).download(task.params_object_key as string);
      if (object.error || !object.data) throw new ApiError("internal_error", "本地任务参数读取失败", true);
      const bytes = new Uint8Array(await object.data.arrayBuffer());
      if (!bytes.byteLength || bytes.byteLength > 64 * 1024) {
        throw new ApiError("internal_error", "本地任务参数无效", true);
      }
      let params: { prompt?: unknown; ratio?: unknown; inputs?: unknown };
      try { params = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new ApiError("internal_error", "本地任务参数无效", true); }
      const rawInputs = Array.isArray(params.inputs) ? params.inputs : [];
      const artifactIds = rawInputs.map((raw) => String((raw as Record<string, unknown>)?.artifactId ?? "")).filter(Boolean);
      const inputIndex = new Map<string, { role: string; stepId: string | null }>();
      if (artifactIds.length) {
        const { data: artifactRows, error: artifactError } = await admin.from("agent_artifacts")
          .select("id,role,step_id")
          .eq("run_id", runId).in("id", artifactIds);
        if (artifactError) throw new ApiError("internal_error", "本地任务输入读取失败", true);
        for (const row of artifactRows ?? []) {
          inputIndex.set(row.id as string, { role: row.role as string, stepId: row.step_id as string | null });
        }
      }
      pendingLocalTask = {
        callId: task.call_id,
        provider: task.provider,
        stepId: task.step_id,
        prompt: typeof params.prompt === "string" ? params.prompt : "",
        ratio: typeof params.ratio === "string" ? params.ratio : null,
        inputs: rawInputs.map((raw, index) => {
          const item = (raw ?? {}) as Record<string, unknown>;
          const artifactId = String(item.artifactId ?? "");
          const known = inputIndex.get(artifactId);
          return {
            artifactId,
            role: known?.role ?? String(item.role ?? ""),
            stepId: known?.stepId ?? (typeof item.stepId === "string" ? item.stepId : null),
            ordinal: index + 1,
          };
        }),
        expiresAt: task.expires_at,
      };
    }
  }
  return jsonResponse({
    conversationId: (run as { conversation_id?: string } | null)?.conversation_id ?? null,
    run,
    events: events ?? [],
    approvals: approvalsWithProposal,
    clarifications: clarificationsWithQuestion,
    artifacts: artifacts ?? [],
    ...(pendingLocalTask ? { pendingLocalTask } : {}),
  });
}

async function actionAnswerClarification(
  admin: Parameters<typeof billingAccountId>[0],
  user: { id: string },
  body: Record<string, unknown>,
): Promise<Response> {
  const clarificationId = typeof body.clarificationId === "string" ? body.clarificationId : "";
  const contextHash = typeof body.contextHash === "string" ? body.contextHash : "";
  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  if (!clarificationId || !/^[0-9a-f]{64}$/.test(contextHash) || !answer || answer.length > 240) {
    throw new ApiError("invalid_request", "澄清回答字段无效");
  }
  const { data: clarification, error } = await admin.from("agent_clarifications")
    .select("id,run_id,question_key,context_hash,status,question_object_key,expires_at,run:agent_runs!agent_clarifications_run_id_fkey(id,status,billing:billing_accounts!agent_runs_user_id_fkey(auth_user_id))")
    .eq("id", clarificationId).maybeSingle();
  if (error || !clarification) throw new ApiError("invalid_request", "澄清问题不存在", false, 404);
  const row = clarification as unknown as {
    id: string;
    run_id: string;
    question_key: string;
    context_hash: string;
    status: string;
    question_object_key: string;
    expires_at: string;
    run: { id: string; status: string; billing: { auth_user_id: string } | null } | null;
  };
  if (!row.run?.billing || row.run.billing.auth_user_id !== user.id) {
    throw new ApiError("invalid_request", "澄清问题不存在", false, 404);
  }
  if (row.status !== "pending" || row.run.status !== "awaiting_clarification") {
    throw new ApiError("invalid_request", "澄清问题当前不可回答", false, 409);
  }
  if (row.context_hash !== contextHash) throw new ApiError("invalid_request", "澄清上下文已失效", false, 409);
  if (Date.parse(row.expires_at) <= Date.now()) throw new ApiError("invalid_request", "澄清问题已过期", false, 410);

  const object = await admin.storage.from(BUCKET).download(row.question_object_key);
  if (object.error || !object.data) throw new ApiError("internal_error", "澄清问题读取失败", true);
  let proposal: Record<string, unknown>;
  try { proposal = JSON.parse(await object.data.text()) as Record<string, unknown>; }
  catch { throw new ApiError("internal_error", "澄清问题对象无效", true); }
  const optionPatches = Array.isArray(proposal.optionPatches) ? proposal.optionPatches : [];
  const mapping = optionPatches.find((raw) => raw && typeof raw === "object" &&
    (raw as Record<string, unknown>).answer === answer) as Record<string, unknown> | undefined;
  if (!mapping || !Array.isArray(mapping.patches) || !mapping.patches.length) {
    throw new ApiError("invalid_request", "回答不在当前选项中");
  }
  const intentPatch = {
    sourceQuestionKey: row.question_key,
    contextHash,
    patches: mapping.patches,
  };
  const intentPatchHash = await sha256Hex(new TextEncoder().encode(canonicalJson(intentPatch)));
  const answerObjectKey = `runs/${row.run_id}/clarifications/${clarificationId}-answer.json`;
  const encoded = new TextEncoder().encode(JSON.stringify({ answer, intentPatch }));
  const upload = await admin.storage.from(BUCKET).upload(answerObjectKey, encoded, {
    contentType: "application/json",
    upsert: false,
  });
  if (upload.error && !String(upload.error.message ?? "").toLowerCase().includes("already")) {
    throw new ApiError("internal_error", "澄清回答保存失败", true);
  }
  const settled = await admin.rpc("answer_agent_clarification", {
    p_clarification_id: clarificationId,
    p_run_id: row.run_id,
    p_context_hash: contextHash,
    p_answer_object_key: answerObjectKey,
    p_intent_patch_hash: intentPatchHash,
  });
  if (settled.error) {
    if (settled.error.code === "55000") throw new ApiError("invalid_request", "澄清上下文已失效", false, 409);
    throw new ApiError("internal_error", "澄清回答提交失败", true);
  }
  return jsonResponse({
    runId: row.run_id,
    clarificationId,
    questionKey: row.question_key,
    status: "queued",
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
  if (["uploading", "queued", "awaiting_clarification", "awaiting_approval", "awaiting_result_feedback", "awaiting_local_task"].includes(own.status)) {
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

/** 本机 CLI 执行结果的确定性对象 key：与 agent-worker `artifact` commit 的
 *  artifactFields 同规（runs/<runId>/artifacts/<callId>.<suffix>），桌面直传后
 *  Worker 复用既有校验/幂等登记路径，无需第二套产物协议。 */
function localResultObjectKey(runId: string, callId: string, mime: string): string | null {
  const suffix = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "image/png" ? "png" : null;
  if (!suffix) return null;
  return `runs/${runId}/artifacts/${callId}.${suffix}`;
}

async function actionLocalTaskPrepare(admin: Parameters<typeof billingAccountId>[0], user: { id: string }, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const callId = typeof body.callId === "string" ? body.callId : "";
  const mime = typeof body.mime === "string" ? body.mime : "";
  if (!runId || !/^[0-9a-f]{64}$/.test(callId)) throw new ApiError("invalid_request", "本地任务标识无效");
  if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) throw new ApiError("invalid_request", "本地任务结果格式无效");
  const own = await loadOwnRun(admin, runId, user.id);
  if (own.status !== "awaiting_local_task") throw new ApiError("invalid_request", "Run 当前不等待本地执行", false, 409);
  const objectKey = localResultObjectKey(runId, callId, mime);
  if (!objectKey) throw new ApiError("invalid_request", "本地任务结果格式无效");
  // call_id 结果允许同字节重传：桌面可能已上传成功、但 complete 回报在网络中断时丢失。
  const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(objectKey, { upsert: true });
  if (error || !data) throw new ApiError("internal_error", "本地任务上传地址签发失败", true);
  return jsonResponse({ runId, callId, objectKey, uploadUrl: data.signedUrl, uploadToken: data.token });
}

async function actionLocalTaskComplete(admin: Parameters<typeof billingAccountId>[0], user: { id: string }, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const callId = typeof body.callId === "string" ? body.callId : "";
  const mime = typeof body.mime === "string" ? body.mime : "";
  const sha256 = typeof body.sha256 === "string" ? body.sha256 : "";
  const bytes = Number(body.bytes);
  if (!runId || !/^[0-9a-f]{64}$/.test(callId) || !/^[0-9a-f]{64}$/.test(sha256) ||
      !["image/png", "image/jpeg", "image/webp"].includes(mime) ||
      !Number.isInteger(bytes) || bytes <= 0 || bytes > 20 * 1024 * 1024) {
    throw new ApiError("invalid_request", "本地任务结果元数据无效");
  }
  const own = await loadOwnRun(admin, runId, user.id);
  if (own.status !== "awaiting_local_task") throw new ApiError("invalid_request", "Run 当前不等待本地执行", false, 409);
  const objectKey = localResultObjectKey(runId, callId, mime);
  if (!objectKey) throw new ApiError("invalid_request", "本地任务结果格式无效");
  const { data: task, error: taskError } = await admin.from("agent_local_tasks")
    .select("id,status,expires_at")
    .eq("run_id", runId).eq("call_id", callId).maybeSingle();
  if (taskError) throw new ApiError("internal_error", "本地任务读取失败", true);
  if (!task) throw new ApiError("invalid_request", "本地任务不存在", false, 404);
  if (task.status !== "pending") throw new ApiError("invalid_request", "本地任务已处理", false, 409);
  if (Date.parse(task.expires_at as string) <= Date.now()) {
    throw new ApiError("invalid_request", "本地任务已超时", false, 410);
  }
  const object = await admin.storage.from(BUCKET).download(objectKey);
  if (object.error || !object.data) throw new ApiError("invalid_request", "本地任务结果尚未上传", false, 409);
  const objectBytes = new Uint8Array(await object.data.arrayBuffer());
  if (objectBytes.byteLength !== bytes || await sha256Hex(objectBytes) !== sha256 || actualImageMime(objectBytes) !== mime) {
    throw new ApiError("invalid_request", "本地任务结果校验失败", false, 409);
  }
  const { error: completeError } = await admin.from("agent_local_tasks")
    .update({
      status: "completed",
      result_object_key: objectKey,
      result_sha256: sha256,
      result_mime: mime,
      result_bytes: bytes,
      completed_at: new Date().toISOString(),
    })
    .eq("id", task.id as string)
    .eq("status", "pending");
  if (completeError) throw new ApiError("internal_error", "本地任务完成失败", true);
  const { error: queueError } = await admin.from("agent_runs")
    .update({ status: "queued", queued_at: new Date().toISOString() })
    .eq("id", runId)
    .eq("status", "awaiting_local_task");
  if (queueError) throw new ApiError("internal_error", "Run 重新入队失败", true);
  return jsonResponse({ runId, callId, status: "queued" });
}

async function actionLocalTaskFail(admin: Parameters<typeof billingAccountId>[0], user: { id: string }, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const callId = typeof body.callId === "string" ? body.callId : "";
  const errorCode = typeof body.errorCode === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(body.errorCode)
    ? body.errorCode
    : "local_task_failed";
  const safeMessage = typeof body.safeMessage === "string" && body.safeMessage.trim()
    ? body.safeMessage.trim().slice(0, 500)
    : "本地生图失败";
  if (!runId || !/^[0-9a-f]{64}$/.test(callId)) throw new ApiError("invalid_request", "本地任务标识无效");
  const own = await loadOwnRun(admin, runId, user.id);
  if (own.status !== "awaiting_local_task") throw new ApiError("invalid_request", "Run 当前不等待本地执行", false, 409);
  const { error: taskError } = await admin.from("agent_local_tasks")
    .update({
      status: "failed",
      error_code: errorCode,
      safe_message: safeMessage,
      completed_at: new Date().toISOString(),
    })
    .eq("run_id", runId).eq("call_id", callId).eq("status", "pending");
  if (taskError) throw new ApiError("internal_error", "本地任务失败登记失败", true);
  const { data, error } = await admin.rpc("fail_unleased_agent_run", {
    p_run_id: runId,
    p_error_code: errorCode,
    p_safe_message: safeMessage,
  });
  if (error) throw new ApiError("internal_error", "本地任务失败结算失败", true);
  const settled = Array.isArray(data) ? data[0] : data;
  return jsonResponse({
    runId,
    status: "failed",
    actualCredits: Number((settled as { actual_credits?: number } | null)?.actual_credits ?? 0),
  });
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
      case "answer_clarification":
        return await actionAnswerClarification(admin, user, body);
      case "cancel":
        return await actionCancel(admin, user, body);
      case "artifact_url":
        return await actionArtifactUrl(admin, user, body);
      case "artifact_received":
        return await actionArtifactReceived(admin, user, body);
      case "result_feedback":
        return await actionResultFeedback(admin, user, body);
      case "local_task_prepare":
        return await actionLocalTaskPrepare(admin, user, body);
      case "local_task_complete":
        return await actionLocalTaskComplete(admin, user, body);
      case "local_task_fail":
        return await actionLocalTaskFail(admin, user, body);
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
