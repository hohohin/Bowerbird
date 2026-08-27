import { createHash } from "node:crypto";
import { deepEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";

import type { VisualEvidenceCard } from "../contracts/visual-profile.ts";
import {
  aggregateDraft,
  configFromEnv,
  extractVisualDraft,
  runVisualProfileWorker,
  sanitizeFacts,
  type ModelChat,
  type VisualWorkerConfig,
  type WorkerFetch,
} from "./runtime.ts";

const CONTROL_URL = "https://example.supabase.co/functions/v1/visual-profile-worker";
const INPUT_URL = "https://example.supabase.co/storage/input";

function baseConfig(overrides: Partial<VisualWorkerConfig> = {}): VisualWorkerConfig {
  return {
    controlUrl: CONTROL_URL,
    workerToken: "token",
    workerId: "visual-worker-1",
    deepseekApiKey: "key",
    deepseekBaseUrl: "https://api.deepseek.com/v1",
    deepseekModel: "deepseek-chat",
    deepseekTimeoutMs: 5_000,
    pollIntervalMs: 1,
    heartbeatIntervalMs: 60_000,
    maxCharsPerBatch: 12_000,
    ...overrides,
  };
}

function card(assetId: string, dims: Record<string, string>, sections: Array<{ title: string; body: string }>): VisualEvidenceCard {
  return {
    assetId,
    captionId: `cap-${assetId}`,
    captionHash: `hash-${assetId}`,
    sections,
    dimensions: dims,
    parseStatus: "structured",
    sourceClass: "imported",
  };
}

const CARDS: VisualEvidenceCard[] = Array.from({ length: 6 }, (_, i) =>
  card(`a${i}`, { palette: "低饱和暖调", mood: "宁静" }, [{ title: "主体", body: "茶具" }, { title: "材质", body: "哑光陶瓷" }]),
);

test("config requires visual profile control credentials and deepseek model", () => {
  const config = configFromEnv({
    VISUAL_PROFILE_CONTROL_URL: CONTROL_URL,
    VISUAL_PROFILE_WORKER_TOKEN: "token",
    DEEPSEEK_API_KEY: "key",
    DEEPSEEK_MODEL: "deepseek-chat",
  });
  equal(config.controlUrl, CONTROL_URL);
  equal(config.deepseekModel, "deepseek-chat");
  equal(config.pollIntervalMs, 2_000);
  equal(config.maxCharsPerBatch, 12_000);
});

test("sanitizeFacts enforces closed categories, asset allow-list and caps", () => {
  const batch = CARDS.slice(0, 2);
  const cleaned = sanitizeFacts({
    facts: [
      { category: "palette", value: "低饱和暖调", assetIds: ["a0", "a1"] },
      { category: "subject", value: "越权类别", assetIds: ["a0"] },
      { category: "light", value: "引用未知素材", assetIds: ["ghost", "a1"] },
      { category: "mood", value: "", assetIds: ["a0"] },
    ],
    themes: [{ value: "茶具", assetIds: ["a0", "ghost"] }],
  }, batch);
  equal(cleaned.facts.length, 2);
  ok(cleaned.facts.every((fact) => fact.assetIds.every((id) => id === "a0" || id === "a1")));
  equal(cleaned.themes.length, 1);
  deepEqual(cleaned.themes[0]!.assetIds, ["a0"]);
});

test("aggregateDraft derives rules, themes and directions with provenance only from input assets", () => {
  const collected = [
    {
      facts: [
        { category: "palette", value: "低饱和暖调", assetIds: ["a0", "a1", "a2", "a3", "a4", "a5"] },
        { category: "material", value: "哑光陶瓷", assetIds: ["a0", "a1", "a2", "a3", "a4", "a5"] },
      ],
      themes: [{ category: "", value: "茶具", assetIds: ["a0", "a1", "a2", "a3", "a4", "a5"] }],
    },
  ];
  const draft = aggregateDraft(CARDS, collected);
  equal(draft.schemaVersion, 1);
  ok(draft.visualRules.some((rule) => rule.category === "palette" && rule.confidence >= 0.6));
  ok(draft.visualRules.every((rule) => rule.polarity === "prefer"));
  ok(draft.contentThemes.some((theme) => theme.value === "茶具"));
  // 单一 palette|mood 方向 → 不产出候选方向
  equal(draft.candidateDirections.length, 0);
  const known = new Set(CARDS.map((c) => c.assetId));
  for (const rule of draft.visualRules) {
    ok(rule.supportingAssetIds.every((id) => known.has(id)));
  }
});

test("aggregateDraft reports conflict instead of rule when split and derives two directions", () => {
  // 3:3 平分 → 主导 <60% 且次势力 ≥25% → 冲突而非规则
  const facts = [
    ...CARDS.slice(0, 3).map((c) => ({ category: "palette", value: "暗调", assetIds: [c.assetId] })),
    ...CARDS.slice(3).map((c) => ({ category: "palette", value: "亮调", assetIds: [c.assetId] })),
    ...CARDS.slice(0, 3).map((c) => ({ category: "mood", value: "沉静", assetIds: [c.assetId] })),
    ...CARDS.slice(3).map((c) => ({ category: "mood", value: "明快", assetIds: [c.assetId] })),
  ];
  const draft = aggregateDraft(CARDS, [{ facts, themes: [] }]);
  ok(draft.visualRules.every((rule) => rule.category !== "palette"));
  equal(draft.conflicts.length, 2); // palette 与 mood 各一处
  equal(draft.candidateDirections.length, 2);
});

test("extractVisualDraft batches all cards, tolerates one bad json reply, and outputs draft json", async () => {
  const seen: string[] = [];
  let call = 0;
  const chat: ModelChat = async (userContent) => {
    seen.push(userContent);
    call += 1;
    if (call === 1) return "不是 JSON";
    const ids = [...JSON.parse(userContent.split("\n")[0]!).cards.map((c: VisualEvidenceCard) => c.assetId)];
    return JSON.stringify({
      facts: [{ category: "palette", value: "低饱和暖调", assetIds: ids }],
      themes: [{ value: "茶具", assetIds: ids }],
    });
  };
  const json = await extractVisualDraft(CARDS, chat, 40);
  const draft = JSON.parse(json) as { visualRules: unknown[]; contentThemes: unknown[] };
  ok(draft.visualRules.length >= 1);
  ok(draft.contentThemes.length >= 1);
  // 单批足够小 → 分了两批，且每批都覆盖（第二批同样经历纠错回合）
  ok(seen.length >= 3, `expected batch + retry calls, got ${seen.length}`);
});

interface Recorded {
  controlActions: string[];
  finishBody: Record<string, unknown> | null;
  settleBody: Record<string, unknown> | null;
}

function jsonResponse(value: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(value),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function makeFetch(inputPayload: string): { fetch: WorkerFetch; recorded: Recorded } {
  const recorded: Recorded = { controlActions: [], finishBody: null, settleBody: null };
  let claimed = false;
  const fetch: WorkerFetch = async (url, request) => {
    const requestBody = typeof request?.body === "string" ? request.body : "{}";
    if (url === CONTROL_URL) {
      const body = JSON.parse(requestBody) as { action: string };
      recorded.controlActions.push(body.action);
      if (body.action === "claim") {
        if (claimed) return jsonResponse({ job: null });
        claimed = true;
        return jsonResponse({
          job: { id: "job-1", inputManifestHash: createHash("sha256").update(inputPayload).digest("hex"), attempt: 1 },
          lease: { leaseId: "lease-1", leaseSeconds: 120 },
          inputUrl: INPUT_URL,
        });
      }
      if (body.action === "heartbeat") return jsonResponse({ status: "running" });
      if (body.action === "submitted") return jsonResponse({ jobId: "job-1", status: "running" });
      if (body.action === "finish") {
        recorded.finishBody = body as unknown as Record<string, unknown>;
        return jsonResponse({ jobId: "job-1", status: "succeeded" });
      }
      recorded.settleBody = body as unknown as Record<string, unknown>;
      return jsonResponse({ jobId: "job-1", status: "failed" });
    }
    if (url === INPUT_URL) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => inputPayload,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    throw new Error(`unexpected_fetch_${String(url)}`);
  };
  return { fetch, recorded };
}

const INPUT_PAYLOAD = JSON.stringify({ schema_version: 1, cards: CARDS });

test("worker loop claims, submits, extracts and finishes with valid draft json", async () => {
  const { fetch, recorded } = makeFetch(INPUT_PAYLOAD);
  const chat: ModelChat = async (userContent) => {
    const ids = [...JSON.parse(userContent.split("\n")[0]!).cards.map((c: VisualEvidenceCard) => c.assetId)];
    return JSON.stringify({
      facts: [{ category: "palette", value: "低饱和暖调", assetIds: ids }],
      themes: [{ value: "茶具", assetIds: ids }],
    });
  };
  const stop = { requested: false };
  const worker = runVisualProfileWorker(baseConfig({ pollIntervalMs: 1, heartbeatIntervalMs: 10_000 }), chat, fetch, stop);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
  stop.requested = true;
  await worker;
  ok(recorded.controlActions.includes("claim"));
  ok(recorded.controlActions.includes("submitted"));
  ok(recorded.controlActions.includes("finish"));
  const resultText = String(recorded.finishBody?.resultText);
  const draft = JSON.parse(resultText) as { visualRules: Array<{ supportingAssetIds: string[] }> };
  const known = new Set(CARDS.map((c) => c.assetId));
  ok(draft.visualRules.every((rule) => rule.supportingAssetIds.every((id) => known.has(id))));
});

test("worker loop fails before submit when the input manifest hash mismatches", async () => {
  const { fetch, recorded } = makeFetch(INPUT_PAYLOAD + "tampered");
  const stop = { requested: false };
  const worker = runVisualProfileWorker(baseConfig({ pollIntervalMs: 1, heartbeatIntervalMs: 10_000 }), async () => {
    throw new Error("model_should_not_run");
  }, fetch, stop);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
  stop.requested = true;
  await worker;
  ok(recorded.controlActions.includes("fail"));
  ok(!recorded.controlActions.includes("submitted"));
  ok(!recorded.controlActions.includes("finish"));
});
