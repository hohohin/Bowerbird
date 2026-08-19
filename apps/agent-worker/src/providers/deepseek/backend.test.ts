import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import type { ModelTurnRequest } from "../../contracts/model.ts";
import {
  DeepSeekBackend,
  DeepSeekBackendError,
  deepSeekConfigFromEnv,
  type DeepSeekFetch,
} from "./backend.ts";

const REQUEST: ModelTurnRequest = {
  runId: "run-deepseek-test",
  phase: "parse_intent",
  systemPolicy: "kernel policy",
  skillInstructions: "smart refinement",
  context: [],
  allowedActions: [
    {
      name: "write_artifact",
      kind: "workspace",
      description: "Write structured intent.",
      argumentSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false,
      },
    },
  ],
  responseSchemaVersion: 1,
};

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

test("DeepSeekBackend maps one tool call and usage to ModelTurnResult.action", async () => {
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> = {};
  const fetch: DeepSeekFetch = async (url, request) => {
    capturedUrl = url;
    capturedBody = JSON.parse(request.body) as Record<string, unknown>;
    equal(request.headers.authorization, "Bearer test-key");
    return response({
      id: "chatcmpl-safe-id",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: [{
            id: "call-safe-id",
            type: "function",
            function: { name: "write_artifact", arguments: '{"summary":"ok"}' },
          }],
        },
      }],
      usage: { prompt_tokens: 19, completion_tokens: 7, total_tokens: 26 },
    });
  };
  const backend = new DeepSeekBackend(
    { apiKey: "test-key", baseUrl: "https://api.deepseek.test/v1/", model: "deepseek-chat" },
    fetch,
  );
  const result = await backend.turn(REQUEST, { aborted: false });
  equal(capturedUrl, "https://api.deepseek.test/v1/chat/completions");
  equal(capturedBody.tool_choice, "required");
  equal((capturedBody.tools as unknown[]).length, 1);
  deepEqual(result, {
    kind: "action",
    action: "write_artifact",
    arguments: { summary: "ok" },
    providerUsage: {
      promptTokens: 19,
      completionTokens: 7,
      totalTokens: 26,
      providerRequestId: "chatcmpl-safe-id",
    },
  });
});

test("DeepSeekBackend fails closed for invalid or parallel tool calls", async () => {
  const bodies = [
    {
      choices: [{ message: { tool_calls: [{ function: { name: "write_artifact", arguments: "{" } }] } }],
    },
    {
      choices: [{ message: { tool_calls: [
        { function: { name: "write_artifact", arguments: "{}" } },
        { function: { name: "finish_run", arguments: "{}" } },
      ] } }],
    },
  ];
  for (const body of bodies) {
    const backend = new DeepSeekBackend(
      { apiKey: "test-key", baseUrl: "https://api.deepseek.test", model: "deepseek-chat" },
      async () => response(body),
    );
    const result = await backend.turn(REQUEST, { aborted: false });
    equal(result.kind, "refusal");
  }
});

test("DeepSeekBackend recovers from DeepSeek arguments with unescaped inner quotes", async () => {
  const backend = new DeepSeekBackend(
    { apiKey: "test-key", baseUrl: "https://api.deepseek.test", model: "deepseek-chat" },
    async () =>
      response({
        id: "chatcmpl-safe-id",
        choices: [{
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{
              id: "call-safe-id",
              type: "function",
              function: {
                name: "write_artifact",
                arguments: '{"summary":"ok","tags":["a"b","c"],"nested":{"note":"raw"quoted"text"}}',
              },
            }],
          },
        }],
        usage: { prompt_tokens: 19, completion_tokens: 7, total_tokens: 26 },
      }),
  );
  const result = await backend.turn(REQUEST, { aborted: false });
  equal(result.kind, "action");
  if (result.kind !== "action") throw new Error("expected action");
  deepEqual(result.arguments, {
    summary: "ok",
    tags: ['a"b', "c"],
    nested: { note: 'raw"quoted"text' },
  });
});

test("DeepSeekBackend exposes only stable HTTP error metadata", async () => {
  const backend = new DeepSeekBackend(
    { apiKey: "test-key", baseUrl: "https://api.deepseek.test", model: "deepseek-chat" },
    async () => response({ error: { message: "must not escape", type: "rate_limit" } }, 429),
  );
  try {
    await backend.turn(REQUEST, { aborted: false });
    ok(false, "expected DeepSeekBackendError");
  } catch (error) {
    if (!(error instanceof DeepSeekBackendError)) throw error;
    equal(error.safeCode, "deepseek_http_error");
    equal(error.status, 429);
    equal(error.providerCode, "rate_limit");
    equal(error.retryable, true);
    equal(error.message.includes("must not escape"), false);
  }
});

test("DeepSeekBackend returns an aborted refusal before network I/O", async () => {
  let called = false;
  const backend = new DeepSeekBackend(
    { apiKey: "test-key", baseUrl: "https://api.deepseek.test", model: "deepseek-chat" },
    async () => {
      called = true;
      return response({});
    },
  );
  const result = await backend.turn(REQUEST, { aborted: true });
  equal(called, false);
  deepEqual(result, { kind: "refusal", reason: "aborted", providerUsage: {} });
});

test("DeepSeekBackend normalizes transport failures without leaking details", async () => {
  const backend = new DeepSeekBackend(
    { apiKey: "test-key", baseUrl: "https://api.deepseek.test", model: "deepseek-chat" },
    async () => { throw new Error("socket failure with sensitive upstream details"); },
  );
  try {
    await backend.turn(REQUEST, { aborted: false });
    ok(false, "expected DeepSeekBackendError");
  } catch (error) {
    if (!(error instanceof DeepSeekBackendError)) throw error;
    equal(error.safeCode, "deepseek_network_error");
    equal(error.retryable, true);
    equal(error.message.includes("sensitive"), false);
  }
});

test("deepSeekConfigFromEnv requires an explicit model and defaults only the base URL", () => {
  deepEqual(deepSeekConfigFromEnv({
    DEEPSEEK_API_KEY: "test-key",
    DEEPSEEK_MODEL: "deepseek-chat",
  }), {
    apiKey: "test-key",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
  });
  try {
    deepSeekConfigFromEnv({ DEEPSEEK_API_KEY: "test-key" });
    ok(false, "expected missing model error");
  } catch (error) {
    if (!(error instanceof DeepSeekBackendError)) throw error;
    equal(error.safeCode, "deepseek_config_model_missing");
  }
});

test("DeepSeekBackend rejects the explicitly disallowed reasoner alias", () => {
  try {
    new DeepSeekBackend({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-reasoner",
    }, async () => response({}));
    ok(false, "expected DeepSeekBackendError");
  } catch (error) {
    if (!(error instanceof DeepSeekBackendError)) throw error;
    equal(error.safeCode, "deepseek_reasoner_disallowed");
  }
});
