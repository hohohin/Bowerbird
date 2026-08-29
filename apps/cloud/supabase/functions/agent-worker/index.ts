// Bowerbird Agent Runtime A1-T4: worker-side Run actions.
// Auth: high-entropy Worker Token (constant-time compare), never a user JWT,
// never service_role exposure to the VPS. Usage credits are computed here from
// versioned service_costs — worker-reported totals are never authoritative.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  agentUsageService,
  creditsForAgentUsage,
  estimateProviderCostMicros,
  normalizeAgentUsageItem,
  parseAgentUsagePricing,
  type AgentUsageItem,
  type AgentUsagePricing,
} from "../_shared/agent-usage-pricing.ts";
import {
  agentRunObjectDirectories,
  checkedAgentObjectKey,
  storageListObjectKey,
} from "../_shared/agent-content-ttl.ts";
import {
  canonicalUnifiedAgentPlanJson,
  estimateUnifiedAgentPlanCredits,
  hashUnifiedAgentPlan,
  hashUnifiedAgentPlanArguments,
  parseUnifiedAgentPlan,
  type UnifiedAgentPlan,
  type UnifiedAgentPlanEstimate,
} from "../_shared/unified-agent-plan.ts";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { imageMetadata } from "../_shared/image-metadata.ts";
import { corsHeaders } from "../_shared/limits.ts";

const BUCKET = "agent-temp";
const MAX_EVENTS_PER_BATCH = 100;
const MAX_USAGE_PER_BATCH = 100;
const CHECKPOINT_URL_SECONDS = 300;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const CLEANUP_ROW_LIMIT = 100;
const CLEANUP_RUN_LIMIT = 25;
const STORAGE_LIST_LIMIT = 100;
const CONTENT_EXPIRABLE_RUN_STATUSES = [
  "uploading", "queued", "awaiting_clarification", "awaiting_approval",
  "awaiting_result_feedback", "awaiting_local_task", "succeeded", "failed", "cancelled",
];
const UNLEASED_PARKED_RUN_STATUSES = [
  "uploading", "queued", "awaiting_clarification", "awaiting_approval",
  "awaiting_result_feedback", "awaiting_local_task",
];

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
  image_provider: string;
}

async function signOrNull(admin: SupabaseClient, objectKey: string): Promise<string | null> {
  try {
    const result = await admin.storage.from(BUCKET).createSignedUrl(objectKey, CHECKPOINT_URL_SECONDS);
    return result.error ? null : result.data?.signedUrl ?? null;
  } catch {
    return null;
  }
}

async function listExpiredRunObjects(admin: SupabaseClient, runId: string): Promise<string[]> {
  const keys: string[] = [];
  for (const directory of agentRunObjectDirectories(runId)) {
    for (let offset = 0; ; offset += STORAGE_LIST_LIMIT) {
      const listed = await admin.storage.from(BUCKET).list(directory, {
        limit: STORAGE_LIST_LIMIT,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (listed.error) throw new ApiError("internal_error", "过期对象枚举失败", true);
      for (const object of listed.data ?? []) {
        const key = storageListObjectKey(directory, object.name);
        if (key) keys.push(key);
      }
      if ((listed.data?.length ?? 0) < STORAGE_LIST_LIMIT) break;
    }
  }
  return keys;
}

function addOwnedKey(keys: Set<string>, runId: string, objectKey: unknown): void {
  const checked = checkedAgentObjectKey(runId, objectKey);
  if (checked) keys.add(checked);
}

async function removeStorageObjects(admin: SupabaseClient, keys: string[]): Promise<void> {
  for (let index = 0; index < keys.length; index += CLEANUP_ROW_LIMIT) {
    const removed = await admin.storage.from(BUCKET).remove(keys.slice(index, index + CLEANUP_ROW_LIMIT));
    if (removed.error) throw new ApiError("internal_error", "过期对象删除失败", true);
  }
}

async function actionCleanupExpired(admin: SupabaseClient): Promise<Response> {
  const now = new Date().toISOString();
  const [expiredParked, runs, artifacts, approvals, clarifications, localTasks] = await Promise.all([
    // Deliberately independent of content_deleted_at: migration 0032 may have
    // tombstoned old content before lifecycle expiry was introduced.
    admin.from("agent_runs")
      .select("id,status,lease_id")
      .lte("content_expires_at", now)
      .in("status", UNLEASED_PARKED_RUN_STATUSES)
      .is("lease_id", null)
      .order("content_expires_at", { ascending: true })
      .limit(CLEANUP_ROW_LIMIT),
    admin.from("agent_runs")
      .select("id,status,lease_id")
      .lte("content_expires_at", now)
      .is("content_deleted_at", null)
      .in("status", CONTENT_EXPIRABLE_RUN_STATUSES)
      .order("content_expires_at", { ascending: true })
      .limit(CLEANUP_RUN_LIMIT),
    admin.from("agent_artifacts")
      .select("id,run_id,object_key")
      .lte("expires_at", now)
      .is("deleted_at", null)
      .order("expires_at", { ascending: true })
      .limit(CLEANUP_ROW_LIMIT),
    admin.from("agent_approvals")
      .select("id,run_id,proposal_object_key")
      .lte("expires_at", now)
      .is("content_deleted_at", null)
      .order("expires_at", { ascending: true })
      .limit(CLEANUP_ROW_LIMIT),
    admin.from("agent_clarifications")
      .select("id,run_id,question_object_key,answer_object_key")
      .lte("expires_at", now)
      .is("content_deleted_at", null)
      .order("expires_at", { ascending: true })
      .limit(CLEANUP_ROW_LIMIT),
    admin.from("agent_local_tasks")
      .select("id,run_id,params_object_key,result_object_key")
      .lte("expires_at", now)
      .is("content_deleted_at", null)
      .order("expires_at", { ascending: true })
      .limit(CLEANUP_ROW_LIMIT),
  ]);
  for (const result of [expiredParked, runs, artifacts, approvals, clarifications, localTasks]) {
    if (result.error) throw new ApiError("internal_error", "过期内容查询失败", true);
  }

  const runRows = runs.data ?? [];
  const artifactRows = artifacts.data ?? [];
  const approvalRows = approvals.data ?? [];
  const clarificationRows = clarifications.data ?? [];
  const localTaskRows = localTasks.data ?? [];
  const parkedRows = expiredParked.data ?? [];
  for (const run of parkedRows) {
    const settled = await admin.rpc("cancel_unleased_agent_run", { p_run_id: run.id });
    if (settled.error) throw new ApiError("internal_error", "过期停车 Run 结算失败", true);
  }
  const keys = new Set<string>();
  for (const run of runRows) {
    for (const key of await listExpiredRunObjects(admin, String(run.id))) keys.add(key);
  }
  for (const row of artifactRows) addOwnedKey(keys, String(row.run_id), row.object_key);
  for (const row of approvalRows) addOwnedKey(keys, String(row.run_id), row.proposal_object_key);
  for (const row of clarificationRows) {
    addOwnedKey(keys, String(row.run_id), row.question_object_key);
    addOwnedKey(keys, String(row.run_id), row.answer_object_key);
  }
  for (const row of localTaskRows) {
    addOwnedKey(keys, String(row.run_id), row.params_object_key);
    addOwnedKey(keys, String(row.run_id), row.result_object_key);
  }
  await removeStorageObjects(admin, [...keys]);

  const runIds = runRows.map((row) => String(row.id));
  const artifactIds = artifactRows.map((row) => String(row.id));
  const approvalIds = approvalRows.map((row) => String(row.id));
  const clarificationIds = clarificationRows.map((row) => String(row.id));
  const localTaskIds = localTaskRows.map((row) => String(row.id));
  const updates: Array<PromiseLike<{ error: unknown }>> = [];
  if (runIds.length) {
    updates.push(admin.from("agent_runs").update({
      content_deleted_at: now,
      checkpoint_object_key: null,
      feedback_object_key: null,
    }).in("id", runIds));
    updates.push(admin.from("agent_artifacts").update({ deleted_at: now }).in("run_id", runIds).is("deleted_at", null));
  }
  if (artifactIds.length) updates.push(admin.from("agent_artifacts").update({ deleted_at: now }).in("id", artifactIds));
  if (approvalIds.length) updates.push(admin.from("agent_approvals").update({ content_deleted_at: now }).in("id", approvalIds));
  if (clarificationIds.length) updates.push(admin.from("agent_clarifications").update({ content_deleted_at: now }).in("id", clarificationIds));
  if (localTaskIds.length) updates.push(admin.from("agent_local_tasks").update({ content_deleted_at: now }).in("id", localTaskIds));
  const results = await Promise.all(updates);
  if (results.some((result) => result.error)) throw new ApiError("internal_error", "过期内容标记失败", true);

  const deletedEvents = await admin.from("agent_events")
    .delete({ count: "exact" })
    .lte("content_expires_at", now);
  if (deletedEvents.error) throw new ApiError("internal_error", "过期事件删除失败", true);
  return jsonResponse({
    removedObjects: keys.size,
    deletedEvents: deletedEvents.count ?? 0,
    expiredRuns: runIds.length,
    expiredParkedRuns: parkedRows.length,
  });
}

async function actionMetrics(admin: SupabaseClient): Promise<Response> {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const since = new Date(nowMs - 24 * 3600 * 1000).toISOString();
  const activeStatuses = [
    "uploading", "queued", "leased", "running", "awaiting_clarification",
    "awaiting_approval", "awaiting_result_feedback", "awaiting_local_task",
    "exporting", "cancel_requested",
  ];
  const leasedStatuses = ["leased", "running", "exporting", "cancel_requested"];
  const [queue, oldest, active, expiredLeases, terminal, testTerminal, expiredRuns, expiredArtifacts] = await Promise.all([
    admin.from("agent_runs").select("id", { count: "exact", head: true }).eq("status", "queued"),
    admin.from("agent_runs").select("queued_at").eq("status", "queued")
      .order("queued_at", { ascending: true }).limit(1).maybeSingle(),
    admin.from("agent_runs").select("id", { count: "exact", head: true }).in("status", activeStatuses),
    admin.from("agent_runs").select("id", { count: "exact", head: true })
      .in("status", leasedStatuses).lt("lease_expires_at", now),
    admin.from("agent_runs").select("status,actual_credits,error_code")
      .in("status", ["succeeded", "failed", "cancelled"])
      .eq("is_test", false).gte("finished_at", since)
      .order("finished_at", { ascending: false }).limit(1000),
    admin.from("agent_runs").select("status")
      .in("status", ["succeeded", "failed", "cancelled"])
      .eq("is_test", true).gte("finished_at", since)
      .order("finished_at", { ascending: false }).limit(1000),
    admin.from("agent_runs").select("id", { count: "exact", head: true })
      .lte("content_expires_at", now).is("content_deleted_at", null),
    admin.from("agent_artifacts").select("id", { count: "exact", head: true })
      .lte("expires_at", now).is("deleted_at", null),
  ]);
  for (const result of [queue, oldest, active, expiredLeases, terminal, testTerminal, expiredRuns, expiredArtifacts]) {
    if (result.error) throw new ApiError("internal_error", "Agent 指标读取失败", true);
  }

  const terminalRows = terminal.data ?? [];
  const testTerminalRows = testTerminal.data ?? [];
  const succeeded = terminalRows.filter((row) => row.status === "succeeded").length;
  const failed = terminalRows.filter((row) => row.status === "failed").length;
  const cancelled = terminalRows.filter((row) => row.status === "cancelled").length;
  const completed = succeeded + failed;
  const credits = terminalRows
    .map((row) => Number(row.actual_credits))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const failuresByCode: Record<string, number> = {};
  for (const row of terminalRows) {
    if (row.status !== "failed") continue;
    const code = typeof row.error_code === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(row.error_code)
      ? row.error_code
      : "unknown";
    failuresByCode[code] = (failuresByCode[code] ?? 0) + 1;
  }
  const queuedAt = typeof oldest.data?.queued_at === "string" ? Date.parse(oldest.data.queued_at) : Number.NaN;
  return jsonResponse({
    measuredAt: now,
    queueDepth: queue.count ?? 0,
    oldestQueuedAgeSeconds: Number.isFinite(queuedAt) ? Math.max(0, Math.floor((nowMs - queuedAt) / 1000)) : 0,
    activeRuns: active.count ?? 0,
    expiredLeases: expiredLeases.count ?? 0,
    last24h: {
      succeeded,
      failed,
      cancelled,
      successRate: completed ? succeeded / completed : null,
      averageCredits: credits.length ? credits.reduce((sum, value) => sum + value, 0) / credits.length : null,
      maxCredits: credits.length ? Math.max(...credits) : null,
      failuresByCode,
      sampleSize: terminalRows.length,
      truncated: terminalRows.length === 1000,
    },
    testLast24h: {
      succeeded: testTerminalRows.filter((row) => row.status === "succeeded").length,
      failed: testTerminalRows.filter((row) => row.status === "failed").length,
      cancelled: testTerminalRows.filter((row) => row.status === "cancelled").length,
      sampleSize: testTerminalRows.length,
      truncated: testTerminalRows.length === 1000,
    },
    ttlBacklog: {
      runs: expiredRuns.count ?? 0,
      artifacts: expiredArtifacts.count ?? 0,
    },
  });
}

function percentileOf(sortedValues: number[], fraction: number): number | null {
  if (!sortedValues.length) return null;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(fraction * sortedValues.length) - 1));
  return sortedValues[index];
}

function averageOf(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** A8-T2 观察期聚合：跨天窗口的成功率、审批漏斗/放弃率、耗时、重试率、积分与上游成本、
 *  当前 TTL 积压。与 metrics 的 24h 滚动窗口互补；不含任何用户内容。
 *  「审批后放弃」= pending 审批随 Run 取消/过期被置为 expired（0040 起统一生效）。 */
async function actionObservation(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const nowMs = Date.now();
  const sinceInput = typeof body.since === "string" ? Date.parse(body.since) : Number.NaN;
  const untilInput = typeof body.until === "string" ? Date.parse(body.until) : Number.NaN;
  const until = Number.isFinite(untilInput) ? untilInput : nowMs;
  const since = Number.isFinite(sinceInput) ? sinceInput : until - 14 * 24 * 3600 * 1000;
  if (!Number.isFinite(since) || since >= until) throw new ApiError("invalid_request", "观察窗口无效");
  if (until - since > 92 * 24 * 3600 * 1000) throw new ApiError("invalid_request", "观察窗口最长 92 天", false, 400);
  const sinceIso = new Date(since).toISOString();
  const untilIso = new Date(until).toISOString();

  const [runs, testRuns, approvals, clarifications, usage, ttlRuns, ttlArtifacts] = await Promise.all([
    admin.from("agent_runs")
      .select("status,actual_credits,created_at,queued_at,started_at,finished_at,result_feedback_action,error_code")
      .eq("is_test", false).gte("created_at", sinceIso).lt("created_at", untilIso)
      .order("created_at", { ascending: false }).limit(5000),
    admin.from("agent_runs").select("status")
      .eq("is_test", true).gte("created_at", sinceIso).lt("created_at", untilIso)
      .order("created_at", { ascending: false }).limit(5000),
    admin.from("agent_approvals")
      .select("kind,status,requested_at,decided_at,run:agent_runs!agent_approvals_run_id_fkey(is_test)")
      .gte("requested_at", sinceIso).lt("requested_at", untilIso)
      .order("requested_at", { ascending: false }).limit(5000),
    admin.from("agent_clarifications")
      .select("status,run:agent_runs!agent_clarifications_run_id_fkey(is_test)")
      .gte("asked_at", sinceIso).lt("asked_at", untilIso)
      .order("asked_at", { ascending: false }).limit(1000),
    admin.from("agent_usage_items")
      .select("kind,provider,credits,provider_cost_micros,run:agent_runs!agent_usage_items_run_id_fkey(is_test)")
      .gte("created_at", sinceIso).lt("created_at", untilIso)
      .order("created_at", { ascending: false }).limit(20000),
    admin.from("agent_runs").select("id", { count: "exact", head: true })
      .lte("content_expires_at", untilIso).is("content_deleted_at", null),
    admin.from("agent_artifacts").select("id", { count: "exact", head: true })
      .lte("expires_at", untilIso).is("deleted_at", null),
  ]);
  for (const result of [runs, testRuns, approvals, clarifications, usage, ttlRuns, ttlArtifacts]) {
    if (result.error) throw new ApiError("internal_error", "观察数据读取失败", true);
  }

  const runRows = (runs.data ?? []) as Array<{
    status: string;
    actual_credits: number | null;
    created_at: string;
    queued_at: string | null;
    started_at: string | null;
    finished_at: string | null;
    result_feedback_action: string | null;
    error_code: string | null;
  }>;
  const testRunRows = (testRuns.data ?? []) as Array<{ status: string }>;
  // 嵌入列在 postgrest-js 类型里推断为数组形状，运行时为单对象；与 agent-run 的
  // `as unknown as` 同款处理。
  const approvalRows = (approvals.data ?? []) as unknown as Array<{
    kind: string;
    status: string;
    requested_at: string;
    decided_at: string | null;
    run: { is_test: boolean | null } | null;
  }>;
  const clarificationRows = (clarifications.data ?? []) as unknown as Array<{ status: string; run: { is_test: boolean | null } | null }>;
  const usageRows = (usage.data ?? []) as unknown as Array<{
    kind: string;
    provider: string;
    credits: number;
    provider_cost_micros: number | null;
    run: { is_test: boolean | null } | null;
  }>;

  const succeeded = runRows.filter((row) => row.status === "succeeded").length;
  const failed = runRows.filter((row) => row.status === "failed").length;
  const cancelled = runRows.filter((row) => row.status === "cancelled").length;
  const completed = succeeded + failed;
  const durations: number[] = [];
  const queueWaits: number[] = [];
  const creditsList: number[] = [];
  const failuresByCode: Record<string, number> = {};
  let feedbackAccept = 0;
  let feedbackRetry = 0;
  for (const row of runRows) {
    if (row.finished_at && row.created_at) {
      const duration = Date.parse(row.finished_at) - Date.parse(row.created_at);
      if (Number.isFinite(duration) && duration >= 0) durations.push(duration);
    }
    if (row.started_at && row.queued_at) {
      const wait = Date.parse(row.started_at) - Date.parse(row.queued_at);
      if (Number.isFinite(wait) && wait >= 0) queueWaits.push(wait);
    }
    if (["succeeded", "failed", "cancelled"].includes(row.status)) {
      const value = Number(row.actual_credits);
      if (Number.isFinite(value) && value >= 0) creditsList.push(value);
    }
    if (row.status === "failed") {
      const code = typeof row.error_code === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(row.error_code)
        ? row.error_code
        : "unknown";
      failuresByCode[code] = (failuresByCode[code] ?? 0) + 1;
    }
    if (row.result_feedback_action === "accept") feedbackAccept += 1;
    if (row.result_feedback_action === "retry") feedbackRetry += 1;
  }
  durations.sort((a, b) => a - b);
  queueWaits.sort((a, b) => a - b);

  const funnel = { proposed: 0, approved: 0, rejected: 0, expired: 0, pending: 0 };
  const approvalsByKind: Record<string, typeof funnel> = {};
  const decisionLatencies: number[] = [];
  let revisionProposals = 0;
  for (const row of approvalRows) {
    if (row.run?.is_test === true) continue;
    funnel.proposed += 1;
    funnel[row.status as keyof typeof funnel] = (funnel[row.status as keyof typeof funnel] ?? 0) + 1;
    const kindBucket = approvalsByKind[row.kind] ??= { proposed: 0, approved: 0, rejected: 0, expired: 0, pending: 0 };
    kindBucket.proposed += 1;
    kindBucket[row.status as keyof typeof funnel] += 1;
    if (row.kind === "controlled_image_edit_revision") revisionProposals += 1;
    if (row.decided_at) {
      const latency = Date.parse(row.decided_at) - Date.parse(row.requested_at);
      if (Number.isFinite(latency) && latency >= 0) decisionLatencies.push(latency);
    }
  }
  const decidedOrExpired = funnel.approved + funnel.rejected + funnel.expired;

  let clarificationsAsked = 0;
  let clarificationsAnswered = 0;
  for (const row of clarificationRows) {
    if (row.run?.is_test === true) continue;
    clarificationsAsked += 1;
    if (row.status === "answered") clarificationsAnswered += 1;
  }

  const usageTotals = { items: 0, credits: 0, costMicros: 0, costKnownItems: 0 };
  const usageByKind: Record<string, { items: number; credits: number; costMicros: number }> = {};
  for (const row of usageRows) {
    if (row.run?.is_test === true) continue;
    usageTotals.items += 1;
    usageTotals.credits += Number(row.credits) || 0;
    const bucket = usageByKind[row.kind] ??= { items: 0, credits: 0, costMicros: 0 };
    bucket.items += 1;
    bucket.credits += Number(row.credits) || 0;
    if (row.provider_cost_micros !== null && row.provider_cost_micros !== undefined) {
      const micros = Number(row.provider_cost_micros) || 0;
      usageTotals.costMicros += micros;
      usageTotals.costKnownItems += 1;
      bucket.costMicros += micros;
    }
  }

  return jsonResponse({
    window: { since: sinceIso, until: untilIso },
    runs: {
      total: runRows.length,
      succeeded,
      failed,
      cancelled,
      activeUnfinished: runRows.length - completed - cancelled,
      successRate: completed ? succeeded / completed : null,
      avgDurationMs: averageOf(durations),
      p50DurationMs: percentileOf(durations, 0.5),
      p95DurationMs: percentileOf(durations, 0.95),
      avgQueueWaitMs: averageOf(queueWaits),
      avgCredits: averageOf(creditsList),
      maxCredits: creditsList.length ? Math.max(...creditsList) : null,
      failuresByCode,
      truncated: runRows.length === 5000,
    },
    testRuns: {
      total: testRunRows.length,
      succeeded: testRunRows.filter((row) => row.status === "succeeded").length,
      failed: testRunRows.filter((row) => row.status === "failed").length,
      cancelled: testRunRows.filter((row) => row.status === "cancelled").length,
      truncated: testRunRows.length === 5000,
    },
    approvals: {
      ...funnel,
      byKind: approvalsByKind,
      revisionProposals,
      approvalRate: decidedOrExpired ? funnel.approved / decidedOrExpired : null,
      abandonmentRate: decidedOrExpired ? funnel.expired / decidedOrExpired : null,
      avgDecisionMs: averageOf(decisionLatencies),
    },
    feedback: {
      accept: feedbackAccept,
      retry: feedbackRetry,
      retryRate: feedbackAccept + feedbackRetry ? feedbackRetry / (feedbackAccept + feedbackRetry) : null,
    },
    clarifications: { asked: clarificationsAsked, answered: clarificationsAnswered },
    usage: {
      items: usageTotals.items,
      creditsTotal: usageTotals.credits,
      providerCostMicrosTotal: usageTotals.costMicros,
      costCoverage: usageTotals.items ? usageTotals.costKnownItems / usageTotals.items : null,
      byKind: usageByKind,
      truncated: usageRows.length === 20000,
    },
    ttlBacklogNow: { runs: ttlRuns.count ?? 0, artifacts: ttlArtifacts.count ?? 0 },
  });
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
  const [inputUrl, checkpointUrl, feedbackUrl, artifactRows, clarificationResult] = await Promise.all([
    signOrNull(admin, inputKey),
    checkpointKey ? signOrNull(admin, checkpointKey) : Promise.resolve(null),
    feedbackKey ? signOrNull(admin, feedbackKey) : Promise.resolve(null),
    admin.from("agent_artifacts")
      .select("id,conversation_id,role,step_id,parent_artifact_id,object_key,mime,bytes,sha256,width,height,user_visible")
      .eq("run_id", claimed.id)
      .is("deleted_at", null),
    admin.from("agent_clarifications")
      .select("question_key,context_hash,answer_object_key,intent_patch_hash")
      .eq("run_id", claimed.id).eq("status", "answered")
      .order("answered_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (artifactRows.error) throw new ApiError("internal_error", "Run 产物读取失败", true);
  if (clarificationResult.error) throw new ApiError("internal_error", "澄清回答读取失败", true);
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
    width: artifact.width === null ? null : Number(artifact.width),
    height: artifact.height === null ? null : Number(artifact.height),
    userVisible: artifact.user_visible !== false,
    url: await signOrNull(admin, artifact.object_key as string),
  })));
  const clarification = clarificationResult.data as {
    question_key: string;
    context_hash: string;
    answer_object_key: string;
    intent_patch_hash: string;
  } | null;
  const clarificationAnswerUrl = clarification?.answer_object_key
    ? await signOrNull(admin, clarification.answer_object_key)
    : null;
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
      imageProvider: claimed.image_provider ?? "cloud",
    },
    lease: { leaseId: claimed.lease_id, expiresAt: null, leaseSeconds: 60 },
    inputUrl,
    checkpointUrl,
    feedbackUrl,
    clarificationAnswer: clarification && clarificationAnswerUrl ? {
      questionKey: clarification.question_key,
      contextHash: clarification.context_hash,
      intentPatchHash: clarification.intent_patch_hash,
      url: clarificationAnswerUrl,
    } : null,
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

async function loadUsagePricing(admin: SupabaseClient, pricingVersion: number): Promise<AgentUsagePricing> {
  const service = agentUsageService(pricingVersion);
  const { data, error } = await admin.from("service_costs")
    .select("pricing_version,parameters")
    .eq("service", service)
    .eq("active", true)
    .maybeSingle();
  if (error || !data || Number(data.pricing_version) !== pricingVersion) {
    throw new ApiError("internal_error", "Agent usage 费率未配置", true);
  }
  try {
    return parseAgentUsagePricing(data.parameters, pricingVersion);
  } catch {
    throw new ApiError("internal_error", "Agent usage 费率无效", true);
  }
}

function expectedImageProvider(run: RunRow): "ark" | "jimeng" | "codex" {
  if (run.image_provider === "cloud") return "ark";
  if (run.image_provider === "jimeng" || run.image_provider === "codex") return run.image_provider;
  throw new ApiError("internal_error", "Run 生图引擎无效", false);
}

function assertUsageBinding(item: AgentUsageItem, toolName: string, run: RunRow): void {
  const valid = item.kind === "model_tokens"
    ? toolName === "model_turn" && item.provider === "deepseek"
    : item.kind === "vision_call"
      ? toolName === "understand_image" && item.provider === "ark"
      : item.kind === "html_render"
      ? toolName === "render_html" && item.provider === "renderer"
      : toolName === "generate_image" && item.provider === expectedImageProvider(run);
  if (!valid) throw new ApiError("invalid_request", "usage 与已登记工具调用不一致", false, 400);
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
  const pricing = await loadUsagePricing(admin, run.pricing_version);
  const normalized = items.map((raw) => {
    try {
      return normalizeAgentUsageItem(raw);
    } catch {
      throw new ApiError("invalid_request", "usage 字段无效", false, 400);
    }
  });
  const callIds = new Set(normalized.map((item) => item.callId));
  if (callIds.size !== normalized.length) throw new ApiError("invalid_request", "usage callId 重复", false, 400);
  const { data: calls, error: callsError } = await admin.from("agent_tool_calls")
    .select("call_id,tool_name")
    .eq("run_id", runId)
    .in("call_id", [...callIds]);
  if (callsError) throw new ApiError("internal_error", "usage 工具调用读取失败", true);
  const callById = new Map((calls ?? []).map((call) => [String(call.call_id), String(call.tool_name)]));
  if (callById.size !== callIds.size) throw new ApiError("invalid_request", "usage 引用了未登记的工具调用", false, 400);

  const rows = normalized.map((item) => {
    assertUsageBinding(item, callById.get(item.callId) ?? "", run);
    let credits: number;
    try {
      credits = creditsForAgentUsage(item, pricing);
    } catch {
      throw new ApiError("invalid_request", "usage 计量组合无效", false, 400);
    }
    return {
      run_id: runId,
      call_id: item.callId,
      kind: item.kind,
      provider: item.provider,
      model: String(item.model ?? "unknown").slice(0, 120),
      input_units: Math.max(0, Number(item.inputUnits) || 0),
      output_units: Math.max(0, Number(item.outputUnits) || 0),
      image_count: Math.max(0, Number(item.imageCount) || 0),
      resolution: item.resolution ?? null,
      // A8-T2 毛利数据链：worker 未显式上报成本时按版本化费率估算（micro CNY）。
      provider_cost_micros: item.providerCostMicros ??
        (pricing.providerCost ? estimateProviderCostMicros(item, pricing.providerCost) : null),
      credits,
      pricing_version: run.pricing_version,
    };
  });
  const { data: existing, error: existingError } = await admin.from("agent_usage_items")
    .select("call_id,kind,provider,model,input_units,output_units,image_count,resolution,provider_cost_micros,credits,pricing_version")
    .eq("run_id", runId)
    .in("call_id", [...callIds]);
  if (existingError) throw new ApiError("internal_error", "usage 幂等状态读取失败", true);
  const existingById = new Map((existing ?? []).map((row) => [String(row.call_id), row]));
  for (const row of rows) {
    const prior = existingById.get(row.call_id);
    if (prior && (prior.kind !== row.kind || prior.provider !== row.provider || prior.model !== row.model ||
        Number(prior.input_units) !== row.input_units || Number(prior.output_units) !== row.output_units ||
        Number(prior.image_count) !== row.image_count || (prior.resolution ?? null) !== row.resolution ||
        (prior.provider_cost_micros === null ? null : Number(prior.provider_cost_micros)) !== row.provider_cost_micros ||
        Number(prior.credits) !== row.credits || Number(prior.pricing_version) !== row.pricing_version)) {
      throw new ApiError("invalid_request", "usage 幂等重放冲突", false, 409);
    }
  }
  const newRows = rows.filter((row) => !existingById.has(row.call_id));
  const total = newRows.reduce((sum, row) => sum + row.credits, 0);
  const spentSoFar = await spentCredits(admin, runId);
  if (spentSoFar + total > run.budget_credits) {
    throw new ApiError("insufficient_credits", "超出 Run 预算上限", false, 402);
  }
  if (newRows.length) {
    const { error } = await admin.from("agent_usage_items").insert(newRows);
    if (error) throw new ApiError("internal_error", "usage 写入失败", true);
  }
  return jsonResponse({ runId, accepted: rows.length, creditsCharged: total, spentCredits: spentSoFar + total });
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
    const providerRequestId = body.providerRequestId ? String(body.providerRequestId).slice(0, 200) : null;
    if (existing.status === "submitted") {
      if (providerRequestId && existing.provider_request_id && providerRequestId !== existing.provider_request_id) {
        throw new ApiError("invalid_request", "provider request id 冲突", false, 409);
      }
      if (providerRequestId && !existing.provider_request_id) {
        const attached = await admin.from("agent_tool_calls")
          .update({ provider_request_id: providerRequestId })
          .eq("run_id", runId).eq("call_id", callId).eq("status", "submitted").is("provider_request_id", null)
          .select("call_id,phase,tool_name,args_hash,status,provider_request_id,result_object_key,result_hash,safe_error_code")
          .maybeSingle();
        if (attached.error || !attached.data) throw new ApiError("invalid_request", "provider request id 状态已变化", false, 409);
        return responseFor(attached.data as NonNullable<typeof existing>, true);
      }
      return responseFor(existing, true);
    }
    if (existing.status !== "prepared") return responseFor(existing, true);
    const { data, error } = await admin.from("agent_tool_calls")
      .update({ status: "submitted", submitted_at: new Date().toISOString(), provider_request_id: providerRequestId })
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
  const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(fields.objectKey, { upsert: true });
  if (error || !data) throw new ApiError("internal_error", "checkpoint 上传地址签发失败", true);
  return jsonResponse({ objectKey: fields.objectKey, uploadUrl: data.signedUrl, uploadToken: data.token });
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
      : body.kind === "unified_agent_plan"
        ? "unified_agent_plan"
        : "";
  const proposalHash = typeof body.proposalHash === "string" ? body.proposalHash : "";
  let proposal = body.proposal;
  let plannedToolCount = Number(body.plannedToolCount);
  const workerEstimatedCredits = Number(body.estimatedAdditionalCredits ?? 0);
  if (!runId || !leaseId || !kind) throw new ApiError("invalid_request", "审批请求字段不完整");
  if (!/^[0-9a-f]{64}$/.test(proposalHash)) throw new ApiError("invalid_request", "proposal hash 无效");
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
    throw new ApiError("invalid_request", "proposal 无效");
  }

  const unified = kind === "unified_agent_plan";
  let unifiedPlan: UnifiedAgentPlan | null = null;
  let sourceCallId: string | null = null;
  let argsHash: string | null = null;
  type ExistingUnifiedCall = {
    id: string;
    status: string;
    kind: string;
    proposal_hash: string;
    planned_tool_count: number;
    estimated_additional_credits: number;
    args_hash: string;
    cost_policy_version: number | null;
  };
  let existingUnifiedCall: ExistingUnifiedCall | null = null;
  if (unified) {
    if (Object.prototype.hasOwnProperty.call(body, "estimatedAdditionalCredits")) {
      throw new ApiError("invalid_request", "通用计划积分只能由服务端计算");
    }
    try {
      unifiedPlan = parseUnifiedAgentPlan(proposal);
    } catch {
      throw new ApiError("invalid_request", "通用计划 schema 无效");
    }
    proposal = unifiedPlan as unknown as Record<string, unknown>;
    plannedToolCount = unifiedPlan.steps.length;
    sourceCallId = typeof body.callId === "string" ? body.callId : "";
    argsHash = typeof body.argsHash === "string" ? body.argsHash : "";
    if (!/^[0-9a-f]{64}$/.test(sourceCallId) || !/^[0-9a-f]{64}$/.test(argsHash)) {
      throw new ApiError("invalid_request", "通用计划调用身份无效");
    }
    const [expectedProposalHash, expectedArgsHash] = await Promise.all([
      hashUnifiedAgentPlan(unifiedPlan),
      hashUnifiedAgentPlanArguments(unifiedPlan),
    ]);
    if (proposalHash !== expectedProposalHash || argsHash !== expectedArgsHash) {
      throw new ApiError("invalid_request", "通用计划 hash 不匹配", false, 409);
    }
    const existingResult = await admin.from("agent_approvals")
      .select("id,status,kind,proposal_hash,planned_tool_count,estimated_additional_credits,args_hash,cost_policy_version")
      .eq("run_id", runId).eq("source_call_id", sourceCallId).maybeSingle();
    if (existingResult.error) throw new ApiError("internal_error", "审批调用身份读取失败", true);
    existingUnifiedCall = existingResult.data as ExistingUnifiedCall | null;
    if (existingUnifiedCall && (existingUnifiedCall.kind !== kind ||
        existingUnifiedCall.proposal_hash !== proposalHash ||
        existingUnifiedCall.planned_tool_count !== plannedToolCount ||
        existingUnifiedCall.args_hash !== argsHash)) {
      throw new ApiError("invalid_request", "审批调用参数发生漂移", false, 409);
    }
    if (existingUnifiedCall && existingUnifiedCall.status !== "pending") {
      throw new ApiError("invalid_request", "审批调用已经结束", false, 409);
    }
    if (existingUnifiedCall) {
      const parkedResult = await admin.from("agent_runs").select("*").eq("id", runId).maybeSingle();
      if (parkedResult.error || !parkedResult.data) {
        throw new ApiError("internal_error", "审批 Run 读取失败", true);
      }
      const parkedRun = parkedResult.data as unknown as RunRow;
      if (parkedRun.status === "awaiting_approval" && parkedRun.lease_id === null) {
        if (existingUnifiedCall.cost_policy_version !== 1 ||
            !Number.isSafeInteger(existingUnifiedCall.estimated_additional_credits) ||
            existingUnifiedCall.estimated_additional_credits < 0) {
          throw new ApiError("internal_error", "审批权威估算无效", true);
        }
        return jsonResponse({
          conversationId: parkedRun.conversation_id,
          runId,
          approvalId: existingUnifiedCall.id,
          proposalHash,
          status: "awaiting_approval",
          estimatedAdditionalCredits: existingUnifiedCall.estimated_additional_credits,
          estimateBreakdown: null,
          reused: true,
        });
      }
    }
  } else {
    if (!Number.isInteger(plannedToolCount) || plannedToolCount < 1 || plannedToolCount > 8) {
      throw new ApiError("invalid_request", "计划工具数无效");
    }
    if (!Number.isInteger(workerEstimatedCredits) || workerEstimatedCredits < 0) {
      throw new ApiError("invalid_request", "计划积分无效");
    }
    const proposalSteps = (proposal as Record<string, unknown>).steps;
    if (!Array.isArray(proposalSteps) || proposalSteps.length < 1 || proposalSteps.length > 8) {
      throw new ApiError("invalid_request", "proposal steps 无效");
    }
    let proposalGenerateCalls = 0;
    for (const rawStep of proposalSteps) {
      const usage = rawStep && typeof rawStep === "object" && !Array.isArray(rawStep)
        ? (rawStep as Record<string, unknown>).estimatedUsage
        : null;
      const row = usage && typeof usage === "object" && !Array.isArray(usage)
        ? usage as Record<string, unknown>
        : null;
      if (!row || row.generateCalls !== 1 || row.understandCalls !== 0) {
        throw new ApiError("invalid_request", "proposal usage 无效");
      }
      proposalGenerateCalls += 1;
    }
    if (proposalGenerateCalls !== plannedToolCount) {
      throw new ApiError("invalid_request", "proposal 工具数与计划不一致", false, 409);
    }
  }

  const run = await assertLease(admin, runId, leaseId);
  const pricing = await loadUsagePricing(admin, run.pricing_version);
  const imageProvider = expectedImageProvider(run);
  let estimateBreakdown: UnifiedAgentPlanEstimate | null = null;
  let estimatedCredits: number;
  if (unifiedPlan) {
    const assetIds = [...new Set(unifiedPlan.steps.flatMap((step) => step.inputAssetIds))];
    if (assetIds.length) {
      const { data: assets, error: assetsError } = await admin.from("agent_artifacts")
        .select("id").eq("run_id", runId).in("id", assetIds).is("deleted_at", null);
      if (assetsError) throw new ApiError("internal_error", "计划素材归属校验失败", true);
      if ((assets ?? []).length !== assetIds.length) {
        throw new ApiError("invalid_request", "计划引用了非本 Run 素材", false, 409);
      }
    }
    try {
      estimateBreakdown = estimateUnifiedAgentPlanCredits(unifiedPlan, pricing, imageProvider);
    } catch {
      throw new ApiError("internal_error", "通用计划成本估算失败", true);
    }
    estimatedCredits = estimateBreakdown.totalCredits;
  } else {
    const imageCredits = creditsForAgentUsage({
      callId: "planned",
      kind: "image_generation",
      provider: imageProvider,
      model: "planned-image-generation",
      inputUnits: 0,
      outputUnits: 0,
      imageCount: 1,
    }, pricing);
    estimatedCredits = plannedToolCount * imageCredits;
  }
  const spent = await spentCredits(admin, runId);
  if (spent + estimatedCredits > run.budget_credits) {
    throw new ApiError("insufficient_credits", "计划超过 Run 剩余预算", false, 402);
  }
  const encoded = new TextEncoder().encode(unifiedPlan
    ? canonicalUnifiedAgentPlanJson(unifiedPlan)
    : JSON.stringify(proposal));
  if (encoded.byteLength > 64 * 1024) throw new ApiError("invalid_request", "proposal 过大");
  const objectKey = `runs/${runId}/plans/${proposalHash}.json`;
  if (existingUnifiedCall && existingUnifiedCall.estimated_additional_credits !== estimatedCredits) {
    throw new ApiError("invalid_request", "审批调用参数发生漂移", false, 409);
  }
  const { error: uploadError } = await admin.storage.from(BUCKET).upload(objectKey, encoded, {
    contentType: "application/json",
    upsert: false,
  });
  if (uploadError && !String(uploadError.message ?? "").toLowerCase().includes("already")) {
    throw new ApiError("internal_error", "计划保存失败", true);
  }
  const { data: pending, error: pendingError } = await admin.from("agent_approvals")
    .select("id,kind,proposal_hash,planned_tool_count,estimated_additional_credits,source_call_id,args_hash")
    .eq("run_id", runId).eq("status", "pending").maybeSingle();
  if (pendingError) throw new ApiError("internal_error", "审批读取失败", true);
  if (pending && (pending.kind !== kind || pending.proposal_hash !== proposalHash ||
      pending.planned_tool_count !== plannedToolCount || pending.estimated_additional_credits !== estimatedCredits ||
      pending.source_call_id !== sourceCallId || pending.args_hash !== argsHash)) {
    throw new ApiError("invalid_request", "当前已有不同的待审批计划", false, 409);
  }
  let approval = pending as { id: string } | null;
  const reused = Boolean(approval);
  if (!approval) {
    const inserted = await admin.from("agent_approvals").insert({
      run_id: runId,
      kind,
      proposal_object_key: objectKey,
      proposal_hash: proposalHash,
      planned_tool_count: plannedToolCount,
      estimated_additional_credits: estimatedCredits,
      source_call_id: sourceCallId,
      args_hash: argsHash,
      cost_policy_version: estimateBreakdown?.policyVersion ?? null,
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
    estimatedAdditionalCredits: estimatedCredits,
    estimateBreakdown,
    reused,
  });
}

async function actionClarificationRequest(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  const proposalHash = typeof body.proposalHash === "string" ? body.proposalHash : "";
  const proposal = body.proposal;
  if (!runId || !leaseId || !/^[0-9a-f]{64}$/.test(proposalHash) ||
      !proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
    throw new ApiError("invalid_request", "澄清请求字段不完整");
  }
  const value = proposal as Record<string, unknown>;
  const questionKey = typeof value.questionKey === "string" ? value.questionKey : "";
  const contextHash = typeof value.contextHash === "string" ? value.contextHash : "";
  const question = typeof value.question === "string" ? value.question.trim() : "";
  const recommendedAnswer = typeof value.recommendedAnswer === "string" ? value.recommendedAnswer.trim() : "";
  const rationale = typeof value.rationale === "string" ? value.rationale.trim() : "";
  const options = Array.isArray(value.options) ? value.options : [];
  const optionPatches = Array.isArray(value.optionPatches) ? value.optionPatches : [];
  const affectedFields = Array.isArray(value.affectedIntentFields) ? value.affectedIntentFields : [];
  const allowedFields = new Set(["finalSubjectReferenceId", "mustTransfer", "highConsistencySignals", "strategy", "budget"]);
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(questionKey) || !/^[0-9a-f]{64}$/.test(contextHash) ||
      !question || question.length > 500 || !recommendedAnswer || recommendedAnswer.length > 240 ||
      !rationale || rationale.length > 1_000 || options.length < 2 || options.length > 4 ||
      options.some((option) => typeof option !== "string" || !option.trim() || option.length > 240) ||
      new Set(options).size !== options.length || !options.includes(recommendedAnswer) ||
      !affectedFields.length || new Set(affectedFields).size !== affectedFields.length ||
      affectedFields.some((field) => typeof field !== "string" || !allowedFields.has(field)) ||
      optionPatches.length !== options.length ||
      optionPatches.some((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return true;
        const mapping = raw as Record<string, unknown>;
        if (typeof mapping.answer !== "string" || !options.includes(mapping.answer) || !Array.isArray(mapping.patches) ||
            !mapping.patches.length || mapping.patches.length > affectedFields.length) return true;
        const patchFields = new Set<string>();
        return mapping.patches.some((rawPatch) => {
          if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) return true;
          const patch = rawPatch as Record<string, unknown>;
          const field = typeof patch.field === "string" ? patch.field : "";
          if (!affectedFields.includes(field) || patchFields.has(field) || (patch.op !== "set" && patch.op !== "clear") ||
              (patch.op === "set" && patch.value === undefined) || (patch.op === "clear" && "value" in patch)) return true;
          patchFields.add(field);
          return false;
        });
      }) || new Set(optionPatches.map((raw) => (raw as Record<string, unknown>)?.answer)).size !== options.length) {
    throw new ApiError("invalid_request", "澄清 proposal 无效");
  }
  const canonicalBytes = new TextEncoder().encode(canonicalJson(proposal));
  if (await sha256Hex(canonicalBytes) !== proposalHash) {
    throw new ApiError("invalid_request", "澄清 proposal hash 不匹配", false, 409);
  }
  const run = await assertLease(admin, runId, leaseId);
  const { data: rows, error: rowsError } = await admin.from("agent_clarifications")
    .select("id,question_key,context_hash,status,question_object_key")
    .eq("run_id", runId).order("asked_at", { ascending: true });
  if (rowsError) throw new ApiError("internal_error", "澄清记录读取失败", true);
  const existing = (rows ?? []).find((row) => row.question_key === questionKey);
  const objectKey = `runs/${runId}/clarifications/${proposalHash}.json`;
  if (existing) {
    if (existing.context_hash !== contextHash || existing.question_object_key !== objectKey || existing.status !== "pending") {
      throw new ApiError("invalid_request", "澄清 question_key 冲突", false, 409);
    }
  } else {
    if ((rows ?? []).length >= 3) throw new ApiError("invalid_request", "澄清次数已达上限", false, 409);
    const encoded = new TextEncoder().encode(JSON.stringify(proposal));
    const upload = await admin.storage.from(BUCKET).upload(objectKey, encoded, {
      contentType: "application/json",
      upsert: false,
    });
    if (upload.error && !String(upload.error.message ?? "").toLowerCase().includes("already")) {
      throw new ApiError("internal_error", "澄清问题保存失败", true);
    }
    const inserted = await admin.from("agent_clarifications").insert({
      run_id: runId,
      question_key: questionKey,
      context_hash: contextHash,
      status: "pending",
      question_object_key: objectKey,
      expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
    if (inserted.error) throw new ApiError("internal_error", "澄清记录建立失败", true);
  }
  await transitionRun(admin, {
    p_run_id: runId,
    p_lease_id: leaseId,
    p_to_status: "awaiting_clarification",
    p_current_step: questionKey,
  });
  return jsonResponse({
    conversationId: run.conversation_id,
    runId,
    questionKey,
    contextHash,
    status: "awaiting_clarification",
  });
}

type ArtifactFields = {
  runId: string;
  leaseId: string;
  callId: string;
  /** 同一 call 多输出的判别子（render_html 的 manifest/full/slice-XXXX）；空 = legacy 单输出。 */
  outputName: string | null;
  objectKey: string;
  role: string;
  sha256: string;
  mime: "image/png" | "image/jpeg" | "image/webp" | "application/json" | "text/html";
  bytes: number;
  stepId: string | null;
  parentArtifactId: string | null;
  userVisible: boolean;
};

/** HTML 渲染新增 artifact 角色（HTML-RENDER-PLAN §4.4；migration 0044 同步扩 DB check）。 */
const RENDER_OUTPUT_ARTIFACT_ROLES = new Set(["render_manifest", "viewport_screenshot", "full_page_screenshot", "slice_screenshot"]);
const RENDER_ARTIFACT_ROLES = new Set(["html_document", ...RENDER_OUTPUT_ARTIFACT_ROLES]);
const USER_VISIBLE_RENDER_ARTIFACT_ROLES = new Set(["viewport_screenshot", "full_page_screenshot", "slice_screenshot"]);

function artifactFields(body: Record<string, unknown>): ArtifactFields {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  const callId = typeof body.sourceCallId === "string" ? body.sourceCallId : "";
  const role = typeof body.role === "string" ? body.role : "";
  const allowedRoles = new Set(["input", "control_reference", "stage_result", "final_result", "plan", "diagnostic", ...RENDER_ARTIFACT_ROLES]);
  const sha256 = typeof body.sha256 === "string" ? body.sha256 : "";
  const mime = typeof body.mime === "string" ? body.mime : "";
  const bytes = Number(body.bytes);
  const outputName = typeof body.outputName === "string" ? body.outputName : null;
  if (outputName !== null && !/^[a-z0-9-]{1,40}$/.test(outputName)) throw new ApiError("invalid_request", "artifact 输出名无效");
  if (!runId || !leaseId || !/^[0-9a-f]{64}$/.test(callId)) throw new ApiError("invalid_request", "artifact 标识无效");
  if (!allowedRoles.has(role)) throw new ApiError("invalid_request", "artifact role 无效");
  if (role === "render_manifest" && outputName !== "manifest") throw new ApiError("invalid_request", "render manifest 输出名无效");
  if (role === "viewport_screenshot" && outputName !== "viewport") throw new ApiError("invalid_request", "viewport 截图输出名无效");
  if (role === "full_page_screenshot" && outputName !== "full") throw new ApiError("invalid_request", "整页截图输出名无效");
  if (role === "slice_screenshot" && !/^slice-\d{4}$/.test(outputName ?? "")) throw new ApiError("invalid_request", "切片截图输出名无效");
  if (!RENDER_OUTPUT_ARTIFACT_ROLES.has(role) && outputName !== null) throw new ApiError("invalid_request", "该 artifact 不允许多输出名");
  let allowedMime: boolean;
  if (role === "diagnostic" || role === "render_manifest") allowedMime = mime === "application/json";
  else if (role === "html_document") allowedMime = mime === "text/html";
  else if (RENDER_ARTIFACT_ROLES.has(role)) allowedMime = mime === "image/png";
  else allowedMime = ["image/png", "image/jpeg", "image/webp"].includes(mime);
  const maxBytes = role === "html_document" ? 2 * 1024 * 1024 : mime === "application/json" ? 64 * 1024 : MAX_ARTIFACT_BYTES;
  if (!/^[0-9a-f]{64}$/.test(sha256) || !allowedMime ||
      !Number.isInteger(bytes) || bytes <= 0 || bytes > maxBytes) {
    throw new ApiError("invalid_request", "artifact 元数据无效");
  }
  const suffix = mime === "application/json" ? "json" : mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "text/html" ? "html" : "png";
  return {
    runId,
    leaseId,
    callId,
    outputName,
    objectKey: `runs/${runId}/artifacts/${callId}${outputName ? `-${outputName}` : ""}.${suffix}`,
    role,
    sha256,
    mime: mime as ArtifactFields["mime"],
    bytes,
    stepId: typeof body.stepId === "string" ? body.stepId.slice(0, 120) : null,
    parentArtifactId: typeof body.parentArtifactId === "string" ? body.parentArtifactId : null,
    userVisible: mime === "application/json" || mime === "text/html" ? false : body.userVisible !== false,
  };
}

async function actionArtifactPrepare(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const fields = artifactFields(body);
  await assertLease(admin, fields.runId, fields.leaseId);
  const { data: call } = await admin.from("agent_tool_calls").select("call_id,status,tool_name")
    .eq("run_id", fields.runId).eq("call_id", fields.callId).maybeSingle();
  if (!call || !["submitted", "outcome_unknown", "succeeded"].includes(call.status as string)) {
    throw new ApiError("invalid_request", "artifact 未关联已提交的工具调用", false, 409);
  }
  if (RENDER_OUTPUT_ARTIFACT_ROLES.has(fields.role) && call.tool_name !== "render_html") {
    throw new ApiError("invalid_request", "渲染多输出只能关联 render_html", false, 409);
  }
  const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(fields.objectKey);
  if (error || !data) throw new ApiError("internal_error", "artifact 上传地址签发失败", true);
  return jsonResponse({ objectKey: fields.objectKey, uploadUrl: data.signedUrl, uploadToken: data.token });
}

async function actionArtifact(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const fields = artifactFields(body);
  const { runId, leaseId, objectKey, role, sha256, mime, bytes } = fields;
  const run = await assertLease(admin, runId, leaseId);
  const { data: sourceCall } = await admin.from("agent_tool_calls").select("call_id,status,tool_name")
    .eq("run_id", runId).eq("call_id", fields.callId).maybeSingle();
  if (!sourceCall || !["submitted", "outcome_unknown", "succeeded"].includes(sourceCall.status as string)) {
    throw new ApiError("invalid_request", "artifact 未关联已提交的工具调用", false, 409);
  }
  if (RENDER_OUTPUT_ARTIFACT_ROLES.has(role) && sourceCall.tool_name !== "render_html") {
    throw new ApiError("invalid_request", "渲染多输出只能关联 render_html", false, 409);
  }
  const object = await admin.storage.from(BUCKET).download(objectKey);
  if (object.error || !object.data) throw new ApiError("invalid_request", "artifact 对象不存在", false, 409);
  const objectBytes = new Uint8Array(await object.data.arrayBuffer());
  const metadata = imageMetadata(objectBytes);
  let contentValid = metadata?.mime === mime;
  if (mime === "application/json") {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(objectBytes));
      contentValid = !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
    } catch {
      contentValid = false;
    }
  } else if (mime === "text/html") {
    // html_document：严格 UTF-8 可解码即可；内容由 Worker/renderer sanitizer 管控，容器内永不执行。
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(objectBytes);
      contentValid = true;
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
    .select("id,conversation_id,role,step_id,parent_artifact_id,object_key,mime,bytes,sha256,width,height,user_visible")
    .eq("run_id", runId).eq("source_call_id", fields.callId).eq("object_key", objectKey).maybeSingle();
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
      width: existing.width === null ? null : Number(existing.width),
      height: existing.height === null ? null : Number(existing.height),
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
    width: metadata?.width ?? null,
    height: metadata?.height ?? null,
    source_call_id: fields.callId,
    parent_artifact_id: parentArtifactId,
    user_visible: fields.userVisible,
    expires_at: new Date(Date.now() + (role === "final_result" || USER_VISIBLE_RENDER_ARTIFACT_ROLES.has(role) ? 7 : 1) * 24 * 3600 * 1000).toISOString(),
  }).select("id").single();
  if (error || !artifact) throw new ApiError("internal_error", "artifact 登记失败", true);
  return jsonResponse({
    conversationId: run.conversation_id, runId, artifactId: artifact.id, role,
    stepId: fields.stepId, parentArtifactId, mime, bytes, sha256,
    width: metadata?.width ?? null, height: metadata?.height ?? null,
    userVisible: fields.userVisible, objectKey, reused: false,
  });
}

async function actionArtifactGet(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  const callId = typeof body.callId === "string" ? body.callId : "";
  const outputName = typeof body.outputName === "string" ? body.outputName : null;
  if (!runId || !leaseId || !/^[0-9a-f]{64}$/.test(callId)) throw new ApiError("invalid_request", "artifact 查询字段无效");
  if (outputName !== null && !/^[a-z0-9-]{1,40}$/.test(outputName)) throw new ApiError("invalid_request", "artifact 输出名无效");
  await assertLease(admin, runId, leaseId);
  let query = admin.from("agent_artifacts")
    .select("id,conversation_id,role,step_id,parent_artifact_id,object_key,mime,bytes,sha256,width,height,user_visible")
    .eq("run_id", runId).eq("source_call_id", callId);
  // render_html 一次 call 产出 manifest/full/slice-XXXX 多输出：outputName 判别后仍保证单行。
  if (outputName) query = query.like("object_key", `%-${outputName}.%`);
  const { data: artifact, error } = await query.maybeSingle();
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
    width: artifact.width === null ? null : Number(artifact.width),
    height: artifact.height === null ? null : Number(artifact.height),
    userVisible: artifact.user_visible !== false,
    objectKey: artifact.object_key,
    url,
  });
}

/** 本机 CLI provider 的执行委托：Worker 登记任务参数并停车，桌面拉取执行。
 *  与审批暂停同款模式——任务行先落库（幂等 by run_id+call_id），转换由 local_task_await
 *  单独执行，保证「saveCheckpoint → await」顺序下租约仍有效。 */
type LocalTaskParamsInput = { artifactId: string; role: string; stepId: string | null };

function localTaskFields(body: Record<string, unknown>): {
  runId: string;
  leaseId: string;
  callId: string;
  provider: string;
  stepId: string;
  expiresInSeconds: number;
} {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  const callId = typeof body.callId === "string" ? body.callId : "";
  const provider = body.provider === "jimeng" || body.provider === "codex" ? body.provider : "";
  const stepId = typeof body.stepId === "string" ? body.stepId.slice(0, 120) : "";
  const expiresInSeconds = Number(body.expiresInSeconds ?? 1800);
  if (!runId || !leaseId || !/^[0-9a-f]{64}$/.test(callId)) throw new ApiError("invalid_request", "local task 标识无效");
  if (!provider) throw new ApiError("invalid_request", "local task provider 无效");
  if (!stepId) throw new ApiError("invalid_request", "local task stepId 无效");
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 300 || expiresInSeconds > 7200) {
    throw new ApiError("invalid_request", "local task 有效期无效");
  }
  return { runId, leaseId, callId, provider, stepId, expiresInSeconds };
}

function parseLocalTaskParams(value: unknown): { prompt: string; ratio: string | null; inputs: LocalTaskParamsInput[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("invalid_request", "local task 参数无效");
  }
  const params = value as Record<string, unknown>;
  const prompt = typeof params.prompt === "string" ? params.prompt : "";
  if (!prompt.trim() || prompt.length > 8000) throw new ApiError("invalid_request", "local task prompt 无效");
  const ratio = typeof params.ratio === "string" && params.ratio ? params.ratio.slice(0, 16) : null;
  const rawInputs = Array.isArray(params.inputs) ? params.inputs : [];
  if (rawInputs.length > 8) throw new ApiError("invalid_request", "local task 输入数量无效");
  const inputs = rawInputs.map((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const artifactId = typeof item.artifactId === "string" ? item.artifactId : "";
    const role = typeof item.role === "string" ? item.role : "";
    if (!/^[0-9a-zA-Z-]{1,80}$/.test(artifactId) ||
        !["input", "control_reference", "stage_result", "final_result"].includes(role)) {
      throw new ApiError("invalid_request", "local task 输入无效");
    }
    return { artifactId, role, stepId: typeof item.stepId === "string" ? item.stepId.slice(0, 120) : null };
  });
  return { prompt, ratio, inputs };
}

async function actionLocalTaskRequest(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const fields = localTaskFields(body);
  const params = parseLocalTaskParams(body.params);
  const run = await assertLease(admin, fields.runId, fields.leaseId);
  if (run.image_provider !== fields.provider) {
    throw new ApiError("invalid_request", "local task provider 与 Run 不一致", false, 409);
  }
  const objectKey = `runs/${fields.runId}/local/${fields.callId}.json`;
  const encoded = new TextEncoder().encode(JSON.stringify(params));
  if (encoded.byteLength > 64 * 1024) throw new ApiError("invalid_request", "local task 参数过大");
  const { error: uploadError } = await admin.storage.from(BUCKET).upload(objectKey, encoded, {
    contentType: "application/json",
    upsert: true,
  });
  if (uploadError) throw new ApiError("internal_error", "local task 参数保存失败", true);

  const { data: existing, error: existingError } = await admin.from("agent_local_tasks")
    .select("id,call_id,provider,step_id,params_object_key,status,expires_at")
    .eq("run_id", fields.runId).eq("call_id", fields.callId).maybeSingle();
  if (existingError) throw new ApiError("internal_error", "local task 读取失败", true);
  if (existing && (existing.provider !== fields.provider || existing.step_id !== fields.stepId ||
      existing.params_object_key !== objectKey)) {
    throw new ApiError("invalid_request", "local task 与已登记任务冲突", false, 409);
  }
  let task = existing as { id: string; status: string; expires_at: string } | null;
  if (!task) {
    const inserted = await admin.from("agent_local_tasks").insert({
      run_id: fields.runId,
      call_id: fields.callId,
      provider: fields.provider,
      step_id: fields.stepId,
      params_object_key: objectKey,
      status: "pending",
      expires_at: new Date(Date.now() + fields.expiresInSeconds * 1000).toISOString(),
    }).select("id,status,expires_at").single();
    if (inserted.error || !inserted.data) throw new ApiError("internal_error", "local task 登记失败", true);
    task = inserted.data as { id: string; status: string; expires_at: string };
  }
  return jsonResponse({
    runId: fields.runId,
    callId: fields.callId,
    taskId: task.id,
    status: task.status,
    expiresAt: task.expires_at,
  });
}

async function actionLocalTaskStatus(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  const callId = typeof body.callId === "string" ? body.callId : "";
  if (!runId || !leaseId || !/^[0-9a-f]{64}$/.test(callId)) throw new ApiError("invalid_request", "local task 查询字段无效");
  await assertLease(admin, runId, leaseId);
  const { data: task, error } = await admin.from("agent_local_tasks")
    .select("id,call_id,status,result_object_key,result_sha256,result_mime,result_bytes,error_code,safe_message,expires_at")
    .eq("run_id", runId).eq("call_id", callId).maybeSingle();
  if (error) throw new ApiError("internal_error", "local task 查询失败", true);
  if (!task) throw new ApiError("invalid_request", "local task 尚未登记", false, 404);
  return jsonResponse({
    runId,
    callId,
    status: task.status,
    resultObjectKey: task.result_object_key,
    resultSha256: task.result_sha256,
    resultMime: task.result_mime,
    resultBytes: task.result_bytes === null ? null : Number(task.result_bytes),
    errorCode: task.error_code,
    safeMessage: task.safe_message,
    expiresAt: task.expires_at,
  });
}

async function actionLocalTaskAwait(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  const callId = typeof body.callId === "string" ? body.callId : "";
  if (!runId || !leaseId || !/^[0-9a-f]{64}$/.test(callId)) throw new ApiError("invalid_request", "local task 标识无效");
  const run = await assertLease(admin, runId, leaseId);
  const { data: task, error } = await admin.from("agent_local_tasks")
    .select("id,call_id,status,step_id")
    .eq("run_id", runId).eq("call_id", callId).maybeSingle();
  if (error) throw new ApiError("internal_error", "local task 读取失败", true);
  if (!task) throw new ApiError("invalid_request", "local task 尚未登记", false, 409);
  // 桌面可能在状态检查与停车之间已回报结果；此时不再停车，引擎继续消费。
  if (task.status !== "pending") {
    return jsonResponse({ runId, callId, status: task.status, parked: false });
  }
  if (run.image_provider === "cloud") throw new ApiError("invalid_request", "Run 未启用本地生图", false, 409);
  const transitioned = await transitionRun(admin, {
    p_run_id: runId,
    p_lease_id: leaseId,
    p_to_status: "awaiting_local_task",
    p_current_step: task.step_id,
  });
  return jsonResponse({
    runId,
    callId,
    status: transitioned.status,
    parked: true,
  });
}

async function actionAwaitResultFeedback(admin: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === "string" ? body.runId : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  if (!runId || !leaseId) throw new ApiError("invalid_request", "缺少 runId/leaseId");
  const run = await assertLease(admin, runId, leaseId);
  const resultRoles = run.skill_id === "bowerbird-html-layout-render"
    ? ["viewport_screenshot", "full_page_screenshot"]
    : ["final_result"];
  const { count, error } = await admin.from("agent_artifacts")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .in("role", resultRoles);
  if (error) throw new ApiError("internal_error", "最终产物校验失败", true);
  if (count !== 1) throw new ApiError("invalid_request", "等待反馈前必须恰有一个主产物", false, 409);
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
      case "metrics":
        return await actionMetrics(admin);
      case "observation":
        return await actionObservation(admin, body);
      case "cleanup_expired":
        return await actionCleanupExpired(admin);
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
      case "clarification_request":
        return await actionClarificationRequest(admin, body);
      case "artifact_prepare":
        return await actionArtifactPrepare(admin, body);
      case "artifact":
        return await actionArtifact(admin, body);
      case "artifact_get":
        return await actionArtifactGet(admin, body);
      case "local_task_request":
        return await actionLocalTaskRequest(admin, body);
      case "local_task_status":
        return await actionLocalTaskStatus(admin, body);
      case "local_task_await":
        return await actionLocalTaskAwait(admin, body);
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
