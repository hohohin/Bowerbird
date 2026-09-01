import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { DeepSeekAdapter, resolveAdapterOptions } from "@deepseek-ai/dsh-llm-deepseek";
import { probeAcpLifecycle } from "../scripts/acp-probe.mjs";
import { assessReleaseState } from "../scripts/check-release.mjs";
import { auditComposedConfig, parseComposedConfig } from "../scripts/config-audit.mjs";
import { buildDshEnv, runDsh, spikeRoot } from "../scripts/runtime.mjs";
import { NodeDshAcpPort } from "../scripts/dsh-acp-port.mjs";
import { runFormalVisionSmoke } from "../scripts/formal-vision-smoke.mjs";
import {
  assertU3ProductPlanForSmoke,
  createU3VisualProfileFixture,
  runU3ProductPlanningSmoke,
} from "../scripts/u3-product-planning-smoke.mjs";
import { htmlExecutionToolDefinitions } from "../plugins/bowerbird-html-execution-tools.mjs";
import { contentExecutionToolDefinitions } from "../plugins/bowerbird-content-execution-tools.mjs";
import { planningToolDefinitions } from "../plugins/bowerbird-planning-tools.mjs";
import { controlledModelToolDefinitions } from "../plugins/bowerbird-controlled-model-tools.mjs";

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
    assert.deepEqual(requestBody.stream_options, { include_usage: true });
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

test("formal Vision smoke refuses provider access without its explicit CLI flag", async () => {
  await assert.rejects(() => runFormalVisionSmoke(), /real_vision_flag_required/);
});

test("U3 product planning smoke requires both explicit provider gates", async () => {
  await assert.rejects(
    () => runU3ProductPlanningSmoke({ argv: [], env: {} }),
    /real_u3_planning_flag_required/,
  );
  await assert.rejects(
    () => runU3ProductPlanningSmoke({ argv: ["--allow-real-u3-planning"], env: {} }),
    /BOWERBIRD_U1_ALLOW_NETWORK_required/,
  );
});

test("U3 product planning quality gate accepts only separated product and style duties", () => {
  const profile = createU3VisualProfileFixture();
  const plan = {
    schemaVersion: 2,
    title: "产品长图",
    summary: "产品事实与排版参考分离。",
    contentPlan: {
      assetAssignments: [
        { assetId: "asset-product", roles: ["product", "logo", "copy_source"], rationale: "产品可见事实。" },
        { assetId: "asset-typography-style", roles: ["style_reference"], rationale: "只参考排版节奏。" },
      ],
      informationArchitecture: [
        { id: "hero", purpose: "产品主视觉", sourceAssetIds: ["asset-product"], copySource: "user_goal" },
        { id: "rhythm", purpose: "排版节奏", sourceAssetIds: ["asset-typography-style"], copySource: "none" },
      ],
      missingAssets: [
        { id: "unverified_claims", purpose: "不使用无法核验的功效事实", decision: "not_needed", resolutionStepId: null },
      ],
      visualProfile: {
        profileId: profile.profileId,
        version: profile.version,
        hash: profile.hash,
        applied: ["信息层级清楚"],
        ignoredContentThemes: ["咖啡器具"],
      },
    },
    steps: [
      { id: "compose", kind: "compose_html", goal: "编排", inputAssetIds: ["asset-product", "asset-typography-style"], dependsOn: [] },
      { id: "render", kind: "render_html", goal: "渲染", inputAssetIds: ["asset-product", "asset-typography-style"], dependsOn: ["compose"] },
      { id: "inspect", kind: "inspect_artifact", goal: "检查", inputAssetIds: [], dependsOn: ["render"] },
      { id: "finalize", kind: "finalize_output", goal: "完成", inputAssetIds: [], dependsOn: ["inspect"] },
    ],
  };
  assert.doesNotThrow(() => assertU3ProductPlanForSmoke(
    plan,
    profile,
    ["asset-product", "asset-typography-style"],
  ));

  const leaked = structuredClone(plan);
  leaked.contentPlan.assetAssignments[1].roles.push("copy_source");
  assert.throws(() => assertU3ProductPlanForSmoke(
    leaked,
    profile,
    ["asset-product", "asset-typography-style"],
  ));
});

test("planning bridge injects only an exact loopback endpoint and one short-lived capability", () => {
  const bridge = {
    BOWERBIRD_TOOL_BRIDGE_ENDPOINT: "http://127.0.0.1:39171/v1/run-tools/call",
    BOWERBIRD_TOOL_BRIDGE_CAPABILITY: "a".repeat(64),
  };
  const env = buildDshEnv({
    SystemRoot: "C:\\Windows",
    WORKER_TOKEN: "must-not-pass",
    ARK_API_KEY: "must-not-pass",
  }, { toolBridge: bridge });
  assert.equal(env.BOWERBIRD_TOOL_BRIDGE_ENDPOINT, bridge.BOWERBIRD_TOOL_BRIDGE_ENDPOINT);
  assert.equal(env.BOWERBIRD_TOOL_BRIDGE_CAPABILITY, bridge.BOWERBIRD_TOOL_BRIDGE_CAPABILITY);
  assert.equal(env.WORKER_TOKEN, undefined);
  assert.equal(env.ARK_API_KEY, undefined);
  assert.throws(
    () => buildDshEnv({}, { toolBridge: { ...bridge, WORKER_TOKEN: "injected" } }),
    /invalid Bowerbird tool bridge environment/,
  );
  assert.throws(
    () => buildDshEnv({}, { toolBridge: { ...bridge, BOWERBIRD_TOOL_BRIDGE_ENDPOINT: "http://example.com/" } }),
    /invalid Bowerbird tool bridge environment/,
  );
});

test("approved HTML execution profile exposes only the four ordered execution tools", () => {
  assert.deepEqual(
    htmlExecutionToolDefinitions().map((definition) => definition.name).sort(),
    ["compose_html", "finalize_output", "inspect_artifact", "render_html"],
  );
});

test("approved content execution profile reuses HTML tools and adds only the Xiaohongshu compiler", () => {
  assert.deepEqual(
    contentExecutionToolDefinitions().map((definition) => definition.name).sort(),
    ["compose_html", "compose_xiaohongshu", "finalize_output", "inspect_artifact", "render_html"],
  );
});

test("planning profile advertises backward-compatible v1 and structured v2 plans", () => {
  const submitPlan = planningToolDefinitions().find((definition) => definition.name === "submit_plan");
  assert.ok(submitPlan);
  const plan = submitPlan.parameters.properties.plan;
  assert.deepEqual(plan.properties.schemaVersion.enum, [1, 2]);
  assert.equal(plan.properties.contentPlan.type, "object");
  assert.equal(plan.properties.contentPlan.properties.assetAssignments.type, "array");
  assert.equal(plan.properties.contentPlan.properties.informationArchitecture.type, "array");
  assert.equal(plan.properties.contentPlan.properties.missingAssets.type, "array");
  assert.equal(plan.properties.contentPlan.properties.visualProfile.oneOf.length, 2);
});

test("controlled model profile exposes only the three structured suggestion actions", () => {
  const definitions = controlledModelToolDefinitions();
  assert.deepEqual(definitions.map((definition) => definition.name).sort(), [
    "record_intent_analysis",
    "request_clarification",
    "submit_plan_for_approval",
  ]);
  const analysis = definitions.find((definition) => definition.name === "record_intent_analysis");
  const plan = definitions.find((definition) => definition.name === "submit_plan_for_approval");
  assert.equal(analysis.parameters.properties.analysis.additionalProperties, false);
  assert.ok(analysis.parameters.properties.analysis.required.includes("intentSummary"));
  assert.equal(plan.parameters.properties.plan.properties.steps.type, "array");
  assert.ok(plan.parameters.properties.plan.required.includes("strategy"));
  assert.ok(plan.parameters.properties.plan.properties.referenceRoles.items.properties.role.enum.includes("style"));
});

test("DSH loads the trusted planning plugin without provider, filesystem, or business secrets", async () => {
  const port = new NodeDshAcpPort({
    patches: ["profiles/bowerbird-u1/cordis.bridge.patch.yml"],
    toolBridge: {
      BOWERBIRD_TOOL_BRIDGE_ENDPOINT: "http://127.0.0.1:39171/v1/run-tools/call",
      BOWERBIRD_TOOL_BRIDGE_CAPABILITY: "b".repeat(64),
    },
  });
  try {
    const initialized = await port.initialize();
    assert.equal(initialized.protocolVersion, 1);
    const session = await port.newSession({ cwd: spikeRoot });
    assert.ok(session.sessionId);
  } finally {
    await port.dispose();
  }
});

test("DSH loads the controlled model profile with only its loopback capability", async () => {
  const port = new NodeDshAcpPort({
    patches: ["profiles/bowerbird-u1/cordis.controlled-model.patch.yml"],
    toolBridge: {
      BOWERBIRD_TOOL_BRIDGE_ENDPOINT: "http://127.0.0.1:39171/v1/run-tools/call",
      BOWERBIRD_TOOL_BRIDGE_CAPABILITY: "c".repeat(64),
    },
  });
  try {
    const initialized = await port.initialize();
    assert.equal(initialized.protocolVersion, 1);
    const session = await port.newSession({ cwd: spikeRoot });
    assert.ok(session.sessionId);
  } finally {
    await port.dispose();
  }
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
