import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { DeepSeekAdapter, resolveAdapterOptions } from "@deepseek-ai/dsh-llm-deepseek";
import { probeAcpLifecycle } from "../scripts/acp-probe.mjs";
import { assessReleaseState } from "../scripts/check-release.mjs";
import { auditComposedConfig, parseComposedConfig } from "../scripts/config-audit.mjs";
import { buildDshEnv, runDsh } from "../scripts/runtime.mjs";

const require = createRequire(import.meta.url);

async function packageJson(name) {
  const packagePath = require.resolve(`${name}/package.json`);
  return JSON.parse(await readFile(packagePath, "utf8"));
}

function packageFile(name, file) {
  return path.join(path.dirname(require.resolve(`${name}/package.json`)), file);
}

function createOfflineAdapter() {
  const connection = resolveAdapterOptions({
    baseURL: "https://u1.invalid",
    thinking: "disabled",
    reasoningEffort: "off",
  });
  return new DeepSeekAdapter({
    options: () => connection,
    resolveApiKey: async () => "fixture-only-key",
    resolveUserId: () => "fixture-user",
  });
}

function sseResponse(events) {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

test("all selected DeepSeek Harness packages are exactly pinned to one release", async () => {
  for (const name of [
    "@deepseek-ai/dsh",
    "@deepseek-ai/dsh-acp",
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-llm-deepseek",
    "@deepseek-ai/dsh-tools",
  ]) {
    const manifest = await packageJson(name);
    assert.equal(manifest.version, "0.1.1-rc.2", name);
    assert.equal(manifest.license, "MIT", name);
  }
});

test("release check flags a capability reassessment when the published candidate changes", () => {
  assert.equal(
    assessReleaseState("@deepseek-ai/dsh-acp", {
      "dist-tags": { latest: "0.0.1-rc.1", next: "0.1.1-rc.2" },
    }).readyForRetest,
    false,
  );
  assert.equal(
    assessReleaseState("@deepseek-ai/dsh-acp", {
      "dist-tags": { latest: "0.0.1-rc.1", next: "0.1.1-rc.3" },
    }).readyForRetest,
    true,
  );
});

test("published adapter and ACP limitations remain explicit compatibility boundaries", async () => {
  const adapterManifest = await packageJson("@deepseek-ai/dsh-llm-deepseek");
  const adapterReadme = await readFile(packageFile("@deepseek-ai/dsh-llm-deepseek", "README.md"), "utf8");
  const acpReadme = await readFile(packageFile("@deepseek-ai/dsh-acp", "README.md"), "utf8");

  assert.equal(adapterManifest.version, "0.1.1-rc.2");
  assert.match(adapterReadme, /`tool_choice` is not mapped/i);
  assert.match(acpReadme, /Fresh sessions only/i);
  assert.match(acpReadme, /load, list, resume, delete, and fork are unsupported/i);
  assert.match(acpReadme, /per-session close is not implemented/i);
  assert.match(acpReadme, /usage stay off the wire/i);
});

test("DeepSeek adapter fixture preserves reasoning, raw tool JSON, usage, and tool_choice gap", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  const malformedArguments = '{"summary":"ok","tags":["a"b","c"]}';
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return sseResponse([
      {
        id: "fixture",
        choices: [{ index: 0, delta: { reasoning_content: "think", content: "ready" }, finish_reason: null }],
      },
      {
        id: "fixture",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "call-fixture",
              type: "function",
              function: { name: "write_artifact", arguments: malformedArguments },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: {
          prompt_tokens: 19,
          completion_tokens: 7,
          total_tokens: 26,
          prompt_cache_hit_tokens: 3,
          prompt_cache_miss_tokens: 16,
        },
      },
    ]);
  };

  try {
    const chunks = await collect(createOfflineAdapter().stream({
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: [{ type: "text", text: "write the artifact" }] }],
      tools: [{ name: "write_artifact", description: "fixture tool", parameters: { type: "object" } }],
    }));
    const completedTool = chunks.find((chunk) => chunk.type === "block-end" && chunk.block.type === "tool-call");
    const usage = chunks.find((chunk) => chunk.type === "usage");

    assert.equal(requestBody.tool_choice, undefined);
    assert.equal(requestBody.tools.length, 1);
    assert.ok(chunks.some((chunk) => chunk.type === "reasoning-delta" && chunk.text === "think"));
    assert.equal(completedTool.block.arguments, malformedArguments);
    assert.throws(() => JSON.parse(completedTool.block.arguments), SyntaxError);
    assert.deepEqual(usage.usage, { inputTokens: 16, outputTokens: 7, cacheReadTokens: 3 });
    assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "tool-calls" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DeepSeek adapter normalizes malformed SSE JSON without network access", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("data: {bad json}\n\ndata: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

  try {
    await assert.rejects(
      collect(createOfflineAdapter().stream({
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: [{ type: "text", text: "fixture" }] }],
      })),
      (error) => error?.code === "MALFORMED_RESPONSE",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("child environment strips Bowerbird and provider business secrets", () => {
  const env = buildDshEnv({
    SystemRoot: "C:\\Windows",
    PATH: "/usr/bin",
    SUPABASE_SERVICE_ROLE_KEY: "must-not-pass",
    SUPABASE_URL: "must-not-pass",
    WORKER_TOKEN: "must-not-pass",
    ARK_API_KEY: "must-not-pass",
    VOLC_ACCESSKEY: "must-not-pass",
    DEEPSEEK_API_KEY: "also-not-by-default",
  });

  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.equal(env.SUPABASE_URL, undefined);
  assert.equal(env.WORKER_TOKEN, undefined);
  assert.equal(env.ARK_API_KEY, undefined);
  assert.equal(env.VOLC_ACCESSKEY, undefined);
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.DSH_TELEMETRY_DISABLED, "1");
  assert.equal(env.DSH_PERMISSION_MODE, "read-only");
});

test("network smoke requires two explicit gates", () => {
  assert.throws(
    () => buildDshEnv({ DEEPSEEK_API_KEY: "secret" }, { allowNetwork: true }),
    /BOWERBIRD_U1_ALLOW_NETWORK/,
  );
  assert.throws(
    () => buildDshEnv({ BOWERBIRD_U1_ALLOW_NETWORK: "1" }, { allowNetwork: true }),
    /DEEPSEEK_API_KEY/,
  );
  const env = buildDshEnv(
    {
      BOWERBIRD_U1_ALLOW_NETWORK: "1",
      DEEPSEEK_API_KEY: "secret",
      DEEPSEEK_BASE_URL: "https://api.deepseek.example/v1",
      SUPABASE_SERVICE_ROLE_KEY: "must-not-pass",
    },
    { allowNetwork: true },
  );
  assert.equal(env.DEEPSEEK_API_KEY, "secret");
  assert.equal(env.DEEPSEEK_BASE_URL, "https://api.deepseek.example/v1");
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, undefined);
});

test("fully composed profile disables every forbidden capability", async () => {
  const result = await runDsh(["--dump-config"]);
  assert.equal(result.exitCode, 0, result.stderr);
  const report = auditComposedConfig(parseComposedConfig(result.stdout));
  assert.ok(report.forbiddenRowsChecked >= 30);
  assert.ok(report.enabledRows.includes("acp"));
  assert.ok(report.enabledRows.includes("agent-loop"));
  assert.ok(report.enabledRows.includes("u1-fixture-tool"));
  assert.ok(!report.enabledRows.includes("tool-web"));
});

test("published ACP lifecycle is measured without provider or filesystem access", async () => {
  const report = await probeAcpLifecycle();
  assert.equal(report.session.created, true);
  assert.equal(report.session.cancelAccepted, true);
  assert.equal(report.optionalLifecycle.list.supported, false);
  assert.equal(report.optionalLifecycle.resume.supported, false);
  assert.equal(report.optionalLifecycle.close.supported, false);
});
