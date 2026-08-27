import { createHash } from "node:crypto";
import { deepEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";

import {
  burstBackoffMs,
  configFromEnv,
  runUnderstandWorker,
  visionPrompt,
  type UnderstandWorkerConfig,
  type WorkerFetch,
} from "./runtime.ts";

const CONTROL_URL = "https://example.supabase.co/functions/v1/understand-worker";
const INPUT_URL = "https://example.supabase.co/storage/input";

function baseConfig(overrides: Partial<UnderstandWorkerConfig> = {}): UnderstandWorkerConfig {
  return {
    controlUrl: CONTROL_URL,
    workerToken: "token",
    workerId: "understand-worker-1",
    arkApiKey: "ark-key",
    arkBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    arkVisionModel: "doubao-vision-model",
    mock: false,
    pollIntervalMs: 1,
    heartbeatIntervalMs: 1_000,
    burstRetryMax: 3,
    burstRetryBaseMs: 1,
    ...overrides,
  };
}

test("config requires understand control credentials and vision model", () => {
  const config = configFromEnv({
    UNDERSTAND_CONTROL_URL: CONTROL_URL,
    UNDERSTAND_WORKER_TOKEN: "token",
    UNDERSTAND_WORKER_ID: "understand-1",
    ARK_API_KEY: "ark-key",
    ARK_VISION_MODEL: "doubao-vision",
  });
  equal(config.workerId, "understand-1");
  equal(config.arkVisionModel, "doubao-vision");
  equal(config.mock, false);
  equal(config.pollIntervalMs, 2_000);
});

test("visionPrompt prefers the explicit instruction then falls back per operation", () => {
  const image = { mime: "image/jpeg" as const, base64: "abc" };
  equal(visionPrompt({ schema_version: 1, operation: "caption", image, instruction: " 自定义指令 ", mock_scenario: null }), "自定义指令");
  ok(visionPrompt({ schema_version: 1, operation: "autoname", image, instruction: null, mock_scenario: null }).includes("图片名称"));
  ok(visionPrompt({ schema_version: 1, operation: "classify", image, instruction: null, mock_scenario: null }).includes("[[CAT:"));
  ok(visionPrompt({ schema_version: 1, operation: "caption", image, instruction: null, mock_scenario: null }).includes("反推提示词"));
});

interface Recorded {
  controlActions: string[];
  finishBody: Record<string, unknown> | null;
  settleBody: Record<string, unknown> | null;
  arkRequestBody: unknown;
}

/** fake fetch：控制面按 action 应答，输入 URL 返回与 manifest hash 匹配的 request.json，方舟可注入行为。 */
function makeFetch(
  inputPayload: string,
  arkBehavior: (url: string) => Promise<{ ok: boolean; status: number; body: string }>,
): { fetch: WorkerFetch; recorded: Recorded } {
  const recorded: Recorded = { controlActions: [], finishBody: null, settleBody: null, arkRequestBody: null };
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
          job: {
            id: "job-1",
            inputManifestHash: createHash("sha256").update(inputPayload).digest("hex"),
            attempt: 1,
          },
          lease: { leaseId: "lease-1", leaseSeconds: 90 },
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
    recorded.arkRequestBody = JSON.parse(requestBody);
    const outcome = await arkBehavior(url);
    return {
      ok: outcome.ok,
      status: outcome.status,
      headers: { get: () => null },
      text: async () => outcome.body,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  return { fetch, recorded };
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

const INPUT = JSON.stringify({
  schema_version: 1,
  operation: "caption",
  image: { mime: "image/jpeg", base64: "aGVsbG8=" },
  instruction: "请描述这张图片",
  mock_scenario: null,
});

async function runOnce(
  arkBehavior: Parameters<typeof makeFetch>[1],
  config = baseConfig(),
  inputPayload: string = INPUT,
) {
  const { fetch, recorded } = makeFetch(inputPayload, arkBehavior);
  const stop = { requested: false };
  const worker = runUnderstandWorker(config, fetch, stop);
  // 第一次 claim 领到任务并结算后，第二次 claim 返回空，随即请求停止。
  while (recorded.controlActions.filter((action) => action === "claim").length < 2) {
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 1));
  }
  stop.requested = true;
  await worker;
  return recorded;
}

test("success flow claims, submits, calls vision and finishes with result text", async () => {
  const recorded = await runOnce(async () => ({
    ok: true,
    status: 200,
    body: JSON.stringify({ choices: [{ message: { content: "  **类型**\nMock 图像描述  " } }] }),
  }));
  deepEqual(recorded.controlActions, ["claim", "submitted", "finish", "claim"]);
  equal((recorded.finishBody?.resultText as string).trim(), "**类型**\nMock 图像描述");
  const arkBody = recorded.arkRequestBody as { model: string; temperature: number; messages: unknown[] };
  equal(arkBody.model, "doubao-vision-model");
  equal(arkBody.temperature, 0.2);
});

test("known Ark moderation failure settles as fail with a safe code", async () => {
  const recorded = await runOnce(async () => ({
    ok: false,
    status: 400,
    body: JSON.stringify({ error: { code: "InputImageSensitiveContentDetected" } }),
  }));
  deepEqual(recorded.controlActions, ["claim", "submitted", "fail", "claim"]);
  equal(recorded.settleBody?.safeErrorCode, "content_moderation");
});

test("text-only autoname input sends a single text part to ark", async () => {
  // image=null（维度数据命名）：输入校验放行，方舟消息只含 text 部分（无 image_url）。
  const input = JSON.stringify({
    schema_version: 1,
    operation: "autoname",
    image: null,
    instruction: "下面是这张图片的生成参数（按【维度】标注）。请取名。",
    mock_scenario: null,
  });
  const recorded = await runOnce(async () => ({
    ok: true,
    status: 200,
    body: JSON.stringify({ choices: [{ message: { content: "雨夜霓虹" } }] }),
  }), baseConfig(), input);
  deepEqual(recorded.controlActions, ["claim", "submitted", "finish", "claim"]);
  equal(recorded.finishBody?.resultText, "雨夜霓虹");
  const arkBody = recorded.arkRequestBody as {
    messages: Array<{ content: Array<{ type: string; text?: string }> }>;
  };
  const parts = arkBody.messages[0].content;
  deepEqual(parts.map((part) => part.type), ["text"]);
  ok(parts[0].text?.includes("【维度】"));
});

test("transport error after submission settles as outcome_unknown", async () => {
  const recorded = await runOnce(async () => {
    throw new Error("connection_reset");
  });
  deepEqual(recorded.controlActions, ["claim", "submitted", "outcome_unknown", "claim"]);
  equal(recorded.settleBody?.safeErrorCode, "connection_reset");
});

test("mock mode returns canned text without contacting Ark", async () => {
  let arkCalled = false;
  const recorded = await runOnce(async () => {
    arkCalled = true;
    return { ok: true, status: 200, body: "{}" };
  }, baseConfig({ mock: true }));
  ok(!arkCalled);
  ok(typeof recorded.finishBody?.resultText === "string");
  equal(recorded.controlActions[2], "finish");
});

test("burstBackoffMs grows exponentially within a jitter band", () => {
  equal(burstBackoffMs(0, 1_000, () => 0), 1_000);
  equal(burstBackoffMs(0, 1_000, () => 0.99), 1_495);
  equal(burstBackoffMs(2, 1_000, () => 0.5), 5_000);
});

test("RequestBurstTooFast is retried with backoff and then succeeds", async () => {
  let arkCalls = 0;
  const recorded = await runOnce(async () => {
    arkCalls += 1;
    if (arkCalls <= 2) {
      return {
        ok: false,
        status: 429,
        body: JSON.stringify({ error: { code: "RequestBurstTooFast" } }),
      };
    }
    return {
      ok: true,
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: "重试后的描述" } }] }),
    };
  });
  equal(arkCalls, 3, "两次 429 后第三次成功");
  deepEqual(recorded.controlActions, ["claim", "submitted", "finish", "claim"]);
  equal(recorded.finishBody?.resultText, "重试后的描述");
});

test("burst retries exhausted settle as fail with provider_burst", async () => {
  let arkCalls = 0;
  const recorded = await runOnce(async () => {
    arkCalls += 1;
    return {
      ok: false,
      status: 429,
      body: JSON.stringify({ error: { code: "RequestBurstTooFast" } }),
    };
  }, baseConfig({ burstRetryMax: 1 }));
  equal(arkCalls, 2, "1 次重试用尽后停止");
  deepEqual(recorded.controlActions, ["claim", "submitted", "fail", "claim"]);
  equal(recorded.settleBody?.safeErrorCode, "provider_burst");
});

test("other 429 errors are not retried", async () => {
  let arkCalls = 0;
  const recorded = await runOnce(async () => {
    arkCalls += 1;
    return {
      ok: false,
      status: 429,
      body: JSON.stringify({ error: { code: "QuotaExceeded" } }),
    };
  });
  equal(arkCalls, 1, "非 RequestBurstTooFast 的 429 不重试");
  deepEqual(recorded.controlActions, ["claim", "submitted", "fail", "claim"]);
  equal(recorded.settleBody?.safeErrorCode, "provider_busy");
});

test("burst retry can be disabled via config", async () => {
  let arkCalls = 0;
  const recorded = await runOnce(async () => {
    arkCalls += 1;
    return {
      ok: false,
      status: 429,
      body: JSON.stringify({ error: { code: "RequestBurstTooFast" } }),
    };
  }, baseConfig({ burstRetryMax: 0 }));
  equal(arkCalls, 1);
  equal(recorded.settleBody?.safeErrorCode, "provider_burst");
});
