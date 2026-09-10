import { loadBrandPrompt } from "../prompts/brand-visual.ts";
import { declaredStandards } from "./declared-standards.ts";
// V2 视觉设定云端提炼 · VPS 消费循环（AGENT-RUNTIME-PLAN §8.7 / §11 V2-T2）。
// 任务执行 = 分批事实抽取（DeepSeek 文本回合，全库唯一模型依赖）+ 确定性聚合
// （复用 V0 阈值语义：≥60% 出 prefer 规则 / 次势力 ≥25% 记冲突 / palette+mood 聚类出候选方向）。
// 输入输出都只有反推文字：Worker 无从取得图片，也不请求图片。

import { createHash, randomUUID } from "node:crypto";
import { IdlePollBackoff } from "../idle-poll-backoff.ts";

import {
  isRecord,
  safeErrorKind,
  sleep,
  type WorkerFetch,
} from "../cloud-generation/runtime.ts";
import { DeepSeekBackend } from "../providers/deepseek/backend.ts";
import type { VisualEvidenceCard } from "../contracts/visual-profile.ts";
import { planBatches } from "../visual/batch.ts";

export type { WorkerFetch } from "../cloud-generation/runtime.ts";

type JsonRecord = Record<string, unknown>;
const CLEANUP_INTERVAL_MS = 10 * 60_000;

export interface VisualWorkerConfig {
  controlUrl: string;
  workerToken: string;
  workerId: string;
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  deepseekTimeoutMs: number;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  maxCharsPerBatch: number;
}

interface ClaimedJob {
  job: null | { id: string; inputManifestHash: string; attempt: number };
  lease?: { leaseId: string; leaseSeconds: number };
  inputUrl?: string;
}

/** 单批模型产出的事实（已按闭集与输入 assetId 白名单过滤）。 */
interface ExtractedFact {
  category: string;
  value: string;
  assetIds: string[];
}

interface BatchFacts {
  facts: ExtractedFact[];
  themes: ExtractedFact[];
}

/** 云端聚合出的 draft（无 sourceScopeHash——它是本地身份指纹，由桌面在落库时附加）。 */
export interface CloudVisualDraft {
  schemaVersion: 1;
  summary: string;
  visualRules: Array<{
    category: string;
    value: string;
    polarity: "must" | "prefer";
    confidence: number;
    supportingAssetIds: string[];
    opposingAssetIds: string[];
    confirmedByUser: false;
  }>;
  contentThemes: Array<{
    value: string;
    supportingAssetIds: string[];
    coverage: number;
    confidence: number;
  }>;
  conflicts: Array<{
    description: string;
    sideA: { value: string; assetIds: string[] };
    sideB: { value: string; assetIds: string[] };
  }>;
  candidateDirections: Array<{
    label: string;
    summary: string;
    supportingAssetIds: string[];
    opposingAssetIds: string[];
  }>;
}

const VISUAL_CATEGORIES = new Set(["composition", "light", "palette", "mood", "material", "medium", "layout"]);
const DOMINANT_COVERAGE = 0.6;
const SECONDARY_CONFLICT_RATIO = 0.25;
const MIN_DIRECTION_RATIO = 0.2;
const MAX_CANDIDATE_DIRECTIONS = 3;
const MAX_FACTS_PER_BATCH = 40;
const MAX_THEMES_PER_BATCH = 20;
const MAX_RESULT_CHARS = 65_536;

/** 与 Edge 相同的模型调用形态：注入以便测试替换（无 mock env 分支）。 */
export type ModelChat = (userContent: string) => Promise<string>;

function defaultFetch(): WorkerFetch {
  const candidate = (globalThis as unknown as { fetch?: WorkerFetch }).fetch;
  if (!candidate) throw new Error("fetch_unavailable");
  return candidate.bind(globalThis);
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name}_missing`);
  return value;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name}_invalid`);
  return parsed;
}

export function configFromEnv(env: Record<string, string | undefined>): VisualWorkerConfig {
  const workerId = env.VISUAL_PROFILE_WORKER_ID?.trim() || `visual-${env.HOSTNAME?.trim() || randomUUID()}`;
  if (workerId.length > 120) throw new Error("VISUAL_PROFILE_WORKER_ID_invalid");
  return {
    controlUrl: required(env, "VISUAL_PROFILE_CONTROL_URL"),
    workerToken: required(env, "VISUAL_PROFILE_WORKER_TOKEN"),
    workerId,
    deepseekApiKey: required(env, "DEEPSEEK_API_KEY"),
    deepseekBaseUrl: (env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com/v1").replace(/\/+$/, ""),
    deepseekModel: required(env, "DEEPSEEK_MODEL"),
    deepseekTimeoutMs: positiveInt(env.DEEPSEEK_TIMEOUT_MS, 180_000, "DEEPSEEK_TIMEOUT_MS"),
    pollIntervalMs: positiveInt(env.VISUAL_PROFILE_POLL_INTERVAL_MS, 2_000, "VISUAL_PROFILE_POLL_INTERVAL_MS"),
    heartbeatIntervalMs: positiveInt(env.VISUAL_PROFILE_HEARTBEAT_INTERVAL_MS, 30_000, "VISUAL_PROFILE_HEARTBEAT_INTERVAL_MS"),
    maxCharsPerBatch: positiveInt(env.VISUAL_PROFILE_BATCH_CHARS, 12_000, "VISUAL_PROFILE_BATCH_CHARS"),
  };
}


function cardForPrompt(card: VisualEvidenceCard): JsonRecord {
  return {
    assetId: card.assetId,
    sections: card.sections.filter((section) => section.title.trim() !== "品牌规范"),
    dimensions: card.dimensions,
    ...(card.textFallback ? { text: card.textFallback } : {}),
  };
}

function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

/** 校验并过滤单批模型输出：闭集类别、assetId 白名单、数量与长度钳制。 */
export function sanitizeFacts(raw: unknown, batch: VisualEvidenceCard[]): BatchFacts {
  const known = new Set(batch.map((card) => card.assetId));
  const source = isRecord(raw) ? raw : {};
  const clean = (items: unknown, kind: "facts" | "themes") => {
    if (!Array.isArray(items)) return [];
    const limit = kind === "facts" ? MAX_FACTS_PER_BATCH : MAX_THEMES_PER_BATCH;
    const out: ExtractedFact[] = [];
    for (const item of items) {
      if (out.length >= limit) break;
      if (!isRecord(item)) continue;
      const value = typeof item.value === "string" ? item.value.trim().slice(0, 200) : "";
      if (!value) continue;
      const category = typeof item.category === "string" ? item.category.trim() : "";
      if (kind === "facts" && !VISUAL_CATEGORIES.has(category)) continue;
      const rawIds = Array.isArray(item.assetIds) ? item.assetIds : [];
      const assetIds = [...new Set(rawIds.filter((id): id is string => typeof id === "string" && known.has(id)))];
      if (!assetIds.length) continue;
      out.push(kind === "facts" ? { category, value, assetIds } : { category: "", value, assetIds });
    }
    return out;
  };
  return { facts: clean(source.facts, "facts"), themes: clean(source.themes, "themes") };
}

async function extractBatch(chat: ModelChat, batch: VisualEvidenceCard[], attempt = 0): Promise<BatchFacts> {
  const userContent = JSON.stringify({ cards: batch.map(cardForPrompt) });
  const content = await chat(userContent);
  try {
    return sanitizeFacts(parseJsonLoose(content), batch);
  } catch (error) {
    // 一次纠错回合（受控编辑计划回合同款容错）；二次仍坏则任务失败。
    if (attempt === 0) {
      return extractBatch(
        (question) => chat(`${question}\n\n上一次输出不是有效 JSON（错误：${String(error).slice(0, 120)}）。请只输出符合约定格式的 JSON。`),
        batch,
        1,
      );
    }
    throw new Error("visual_fact_json_invalid");
  }
}

function aggregateGroups(values: Array<{ value: string; assetId: string }>): Array<{ value: string; assetIds: string[] }> {
  const map = new Map<string, Set<string>>();
  for (const { value, assetId } of values) {
    const arr = map.get(value) ?? new Set<string>();
    arr.add(assetId);
    map.set(value, arr);
  }
  return [...map.entries()]
    .map(([value, assetIds]) => ({ value, assetIds: [...assetIds].sort() }))
    .sort((a, b) => b.assetIds.length - a.assetIds.length || (a.value < b.value ? -1 : 1));
}

/** 确定性聚合（阈值与 V0 extract.ts 一致）：facts → 规则/冲突，themes → 内容主题，palette+mood → 候选方向。 */
export function aggregateDraft(cards: VisualEvidenceCard[], collected: BatchFacts[]): CloudVisualDraft {
  const known = new Set(cards.map((card) => card.assetId));
  const total = known.size || 1;
  const byCategory = new Map<string, Array<{ value: string; assetId: string }>>();
  for (const { facts } of collected) {
    for (const fact of facts) {
      const arr = byCategory.get(fact.category) ?? [];
      for (const assetId of fact.assetIds) if (known.has(assetId)) arr.push({ value: fact.value, assetId });
      byCategory.set(fact.category, arr);
    }
  }
  const visualRules: CloudVisualDraft["visualRules"] = declaredStandards(cards);
  const conflicts: CloudVisualDraft["conflicts"] = [];
  for (const [category, values] of byCategory) {
    const agg = aggregateGroups(values);
    const top = agg[0];
    if (!top) continue;
    const dominant = agg.filter((group) => group.assetIds.length / total >= DOMINANT_COVERAGE).slice(0, 3);
    if (dominant.length) {
      visualRules.push(...dominant.map((group) => ({
        category,
        value: group.value,
        polarity: "prefer" as const,
        confidence: group.assetIds.length / total,
        supportingAssetIds: group.assetIds,
        opposingAssetIds: [],
        confirmedByUser: false as const,
      })));
    } else if (agg.length >= 2 && agg[1].assetIds.length / total >= SECONDARY_CONFLICT_RATIO) {
      // Keep both evidenced directions selectable; an empty rule set cannot become a usable brand profile.
      visualRules.push(...agg.filter((group) => group.assetIds.length / total >= SECONDARY_CONFLICT_RATIO).slice(0, 3).map((group) => ({
        category, value: group.value, polarity: "prefer" as const,
        confidence: group.assetIds.length / total, supportingAssetIds: group.assetIds,
        opposingAssetIds: [], confirmedByUser: false as const,
      })));
      conflicts.push({
        description: `${category}: ${agg[0].value} vs ${agg[1].value}`,
        sideA: { value: agg[0].value, assetIds: agg[0].assetIds },
        sideB: { value: agg[1].value, assetIds: agg[1].assetIds },
      });
    }
  }

  const themeValues: Array<{ value: string; assetId: string }> = [];
  for (const { themes } of collected) {
    for (const theme of themes) {
      for (const assetId of theme.assetIds) if (known.has(assetId)) themeValues.push({ value: theme.value, assetId });
    }
  }
  const themeTotal = total;
  const contentThemes = aggregateGroups(themeValues).map(({ value, assetIds }) => {
    const coverage = assetIds.length / themeTotal;
    return { value, supportingAssetIds: assetIds, coverage, confidence: coverage };
  });

  // 候选方向：从 facts 重建每素材的 palette|mood 签名后聚类（与 V0 的维度签名语义一致）。
  const signatureByAsset = new Map<string, { palette?: string; mood?: string }>();
  for (const { facts } of collected) {
    for (const fact of facts) {
      if (fact.category !== "palette" && fact.category !== "mood") continue;
      for (const assetId of fact.assetIds) {
        if (!known.has(assetId)) continue;
        const entry = signatureByAsset.get(assetId) ?? {};
        entry[fact.category] = fact.value;
        signatureByAsset.set(assetId, entry);
      }
    }
  }
  const clusters = new Map<string, string[]>();
  for (const [assetId, signature] of signatureByAsset) {
    const key = `${signature.palette ?? ""}|${signature.mood ?? ""}`;
    const arr = clusters.get(key) ?? [];
    arr.push(assetId);
    clusters.set(key, arr);
  }
  const sortedClusters = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  const totalAssets = signatureByAsset.size || 1;
  const candidateDirections: CloudVisualDraft["candidateDirections"] = [];
  if (sortedClusters.length >= 2) {
    for (const [signature, assetIds] of sortedClusters) {
      if (assetIds.length / totalAssets < MIN_DIRECTION_RATIO) continue;
      if (candidateDirections.length >= MAX_CANDIDATE_DIRECTIONS) break;
      candidateDirections.push({
        label: signature.split("|").filter(Boolean).join(" · ") || "另一种风格",
        summary: signature.split("|").filter(Boolean).join("，"),
        supportingAssetIds: assetIds,
        opposingAssetIds: sortedClusters.filter(([s]) => s !== signature).flatMap(([, ids]) => ids),
      });
    }
  }

  return {
    schemaVersion: 1,
    summary: visualRules.length
      ? `${["mood", "palette", "composition", "light", "material", "medium", "layout"].flatMap((category) => visualRules.filter((rule) => rule.category === category).slice(0, 1).map((rule) => rule.value.replace(/[。；;]+$/, ""))).slice(0, 4).join("；")}。`
      : "这些图片呈现了不同的视觉方向，可以选择更接近品牌的一种，或补充更一致的作品。",
    visualRules,
    contentThemes,
    conflicts,
    candidateDirections,
  };
}

/** 完整任务执行：分批 → 抽取（每批一次纠错）→ 聚合 → draft JSON。 */
export async function extractVisualDraft(
  cards: VisualEvidenceCard[],
  chat: ModelChat,
  maxCharsPerBatch: number,
): Promise<string> {
  const batches = planBatches(cards, maxCharsPerBatch);
  const collected: BatchFacts[] = [];
  for (const batch of batches) {
    collected.push(await extractBatch(chat, batch));
  }
  const draft = aggregateDraft(cards, collected);
  const json = JSON.stringify(draft);
  if (json.length > MAX_RESULT_CHARS) throw new Error("visual_draft_too_large");
  return json;
}

function parseCards(value: unknown): VisualEvidenceCard[] {
  if (!isRecord(value) || value.schema_version !== 1 || !Array.isArray(value.cards) || !value.cards.length) {
    throw new Error("invalid_visual_input");
  }
  return value.cards as VisualEvidenceCard[];
}

async function fetchInput(fetchImpl: WorkerFetch, url: string, expectedHash: string): Promise<VisualEvidenceCard[]> {
  const response = await fetchImpl(url, { method: "GET" });
  if (!response.ok) throw new Error(`input_http_${response.status}`);
  const text = await response.text();
  const actualHash = createHash("sha256").update(text).digest("hex");
  if (actualHash !== expectedHash) throw new Error("input_manifest_hash_mismatch");
  return parseCards(JSON.parse(text));
}

class ControlClient {
  private readonly config: VisualWorkerConfig;
  private readonly fetch: WorkerFetch;

  constructor(config: VisualWorkerConfig, fetchImpl: WorkerFetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async post(body: JsonRecord): Promise<JsonRecord> {
    const response = await this.fetch(this.config.controlUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.workerToken}`,
        "content-type": "application/json",
        "x-worker-id": this.config.workerId,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let value: unknown;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      value = null;
    }
    if (!response.ok || !isRecord(value)) throw new Error(`control_http_${response.status}`);
    return value;
  }
}

async function heartbeatLoop(control: ControlClient, jobId: string, leaseId: string, intervalMs: number, state: { stopped: boolean }): Promise<void> {
  while (!state.stopped) {
    await sleep(intervalMs);
    if (state.stopped) return;
    try {
      await control.post({ action: "heartbeat", jobId, leaseId });
    } catch (error) {
      console.error(JSON.stringify({ event: "visual_heartbeat_failed", job_id: jobId, error: safeErrorKind(error) }));
    }
  }
}

async function executeClaim(
  config: VisualWorkerConfig,
  control: ControlClient,
  chat: ModelChat | undefined,
  fetchImpl: WorkerFetch,
  claimed: ClaimedJob,
): Promise<void> {
  if (!claimed.job || !claimed.lease?.leaseId || !claimed.inputUrl) throw new Error("invalid_claim_response");
  const { id: jobId } = claimed.job;
  const leaseId = claimed.lease.leaseId;
  const heartbeatState = { stopped: false };
  void heartbeatLoop(control, jobId, leaseId, config.heartbeatIntervalMs, heartbeatState);
  let submitted = false;
  try {
    const cards = await fetchInput(fetchImpl, claimed.inputUrl, claimed.job.inputManifestHash);
    declaredStandards(cards); // Validate before charging/submitting a model request.
    const jobChat = chat ?? createVisualChat(config);
    await control.post({ action: "submitted", jobId, leaseId });
    submitted = true;
    const resultText = await extractVisualDraft(cards, jobChat, config.maxCharsPerBatch);
    await control.post({ action: "finish", jobId, leaseId, resultText });
    console.log(JSON.stringify({ event: "visual_succeeded", job_id: jobId, cards: cards.length, chars: resultText.length }));
  } catch (error) {
    // 首个模型请求提交后失败 → 结果未知不盲重试（与 understand/agent 同款边界）。
    const action = submitted ? "outcome_unknown" : "fail";
    const safeErrorCode = safeErrorKind(error);
    const safeMessage = submitted
      ? "请求已提交模型，但 Worker 与上游或控制面连接中断，结果状态暂时无法确认"
      : "视觉设定提炼任务启动失败";
    try {
      await control.post({ action, jobId, leaseId, safeErrorCode, safeMessage });
    } catch (settlementError) {
      console.error(JSON.stringify({ event: "visual_settlement_failed", job_id: jobId, error: safeErrorKind(settlementError) }));
    }
    console.error(JSON.stringify({ event: `visual_${action}`, job_id: jobId, error: safeErrorCode }));
  } finally {
    heartbeatState.stopped = true;
  }
}

function createVisualChat(config: VisualWorkerConfig): ModelChat {
  const prompt = loadBrandPrompt("extraction");
  const backend = new DeepSeekBackend({
    apiKey: config.deepseekApiKey,
    baseUrl: config.deepseekBaseUrl,
    model: config.deepseekModel,
    timeoutMs: config.deepseekTimeoutMs,
  });
  return async (userContent) => {
    // AbortSignalLike 只有 aborted 一个字段；DeepSeek 调用不设主动超时中断，
    // 生命周期由租约心跳管理（生图/理解同款铁律）。
    const result = await backend.chat(
      [
        { role: "system", content: prompt },
        { role: "user", content: userContent },
      ],
      [],
      { aborted: false },
    );
    if (!result.content.trim()) throw new Error("deepseek_empty_content");
    return result.content;
  };
}

export async function runVisualProfileWorker(
  config: VisualWorkerConfig,
  modelChat?: ModelChat,
  fetchImpl: WorkerFetch = defaultFetch(),
  stop: { requested: boolean } = { requested: false },
): Promise<void> {
  const control = new ControlClient(config, fetchImpl);
  const idleBackoff = new IdlePollBackoff(config.pollIntervalMs);
  let nextCleanupAt = Date.now() + CLEANUP_INTERVAL_MS;
  console.log(JSON.stringify({ event: "visual_worker_started", worker_id: config.workerId }));
  while (!stop.requested) {
    if (Date.now() >= nextCleanupAt) {
      nextCleanupAt = Date.now() + CLEANUP_INTERVAL_MS;
      try {
        await control.post({ action: "cleanup_expired" });
      } catch (error) {
        console.error(JSON.stringify({ event: "visual_cleanup_failed", error: safeErrorKind(error) }));
      }
    }
    try {
      const claimed = await control.post({ action: "claim" }) as unknown as ClaimedJob;
      if (claimed.job) {
        idleBackoff.reset();
        await executeClaim(config, control, modelChat, fetchImpl, claimed);
      } else {
        await sleep(idleBackoff.nextDelayMs());
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "visual_claim_failed", error: safeErrorKind(error) }));
      await sleep(Math.max(idleBackoff.nextDelayMs(), 5_000));
    }
  }
}
