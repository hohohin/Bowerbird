import { RunContextTools } from "../../../../../apps/agent-worker/src/harness/run-context-tools.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { DshAcpHarnessAdapter } from "../../../../../apps/agent-worker/src/harness/dsh-acp-harness-adapter.ts";
import { createRunControlToolDefinitions } from "../../../../../apps/agent-worker/src/harness/run-control-tools.ts";
import { ScopedToolGateway } from "../../../../../apps/agent-worker/src/harness/scoped-tool-gateway.ts";
import { UnifiedPlanningHarnessRunner } from "../../../../../apps/agent-worker/src/harness/unified-planning-harness-runner.ts";
import { UnifiedPlanningToolBridge } from "../../../../../apps/agent-worker/src/harness/unified-planning-tool-bridge.ts";
import { canonicalJson, sha256Hex } from "../../../../../apps/agent-worker/src/kernel/tool-ledger.ts";
import { NodeDshAcpPort } from "../scripts/dsh-acp-port.mjs";
import { loadUnifiedAgentSkill } from "../../../../../apps/agent-worker/src/skills/bowerbird-unified-agent/loader.ts";
import { spikeRoot } from "../scripts/runtime.mjs";

const BRIDGE_PATCH = "profiles/bowerbird-u1/cordis.bridge.patch.yml";

test("real DSH dispatches eight independent image calls concurrently before finalization", async () => {
  let requests = 0, active = 0, peak = 0, completed = 0;
  const nativeRequests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    const wire = JSON.parse(body);
    nativeRequests.push(wire);
    requests++;
    const event = JSON.parse(toolCallSse("call_tool", {}, requests).split("\n")[0].slice(6));
    event.choices[0].delta.tool_calls = (requests === 1 ? Array.from({ length: 8 }, (_, index) => ({
      actionId: `scene-${index}`, toolName: "generate_image", inputJson: "{}",
    })) : [{ actionId: "deliver", toolName: "finalize_output", inputJson: "{}" }]).map((args, index) => ({
      index, id: `batch-${requests}-${index}`, type: "function",
      function: { name: "call_tool", arguments: JSON.stringify(args) },
    }));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previous = { allow: process.env.BOWERBIRD_U1_ALLOW_NETWORK, key: process.env.DEEPSEEK_API_KEY, base: process.env.DEEPSEEK_BASE_URL };
  process.env.BOWERBIRD_U1_ALLOW_NETWORK = "1";
  process.env.DEEPSEEK_API_KEY = "fixture-only";
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const runner = new UnifiedPlanningHarnessRunner({ runId: "run-parallel", async dispatch(call) {
      if (call.arguments.toolName === "finalize_output") {
        assert.equal(completed, 8);
        return { callId: "deliver", value: { terminalReason: "awaiting_result_feedback" } };
      }
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 150));
      active--; completed++;
      return { callId: call.arguments.actionId, value: { artifactId: call.arguments.actionId } };
    } }, (toolBridge) => new DshAcpHarnessAdapter({ cwd: spikeRoot,
      createPort: () => new NodeDshAcpPort({ allowNetwork: true, patches: [BRIDGE_PATCH], toolBridge }),
    }));
    const result = await runner.run({ schemaVersion: 1, runId: "run-parallel", checkpointVersion: 0,
      phase: "execute_approved_plan", approvedPlanHash: "a".repeat(64), compactedFacts: [], completedToolResults: [] },
      [{ type: "text", text: "Generate the authorized images." }]);
    assert.equal(result.stopReason, "end_turn");
    assert.equal(peak, 8);
    assert.equal(requests, 2);
    const tail = nativeRequests[1].messages.slice(-9);
    assert.equal(tail[0].role, "assistant");
    assert.equal(tail[0].tool_calls.length, 8);
    assert.equal(tail.slice(1).every(message => message.role === "tool"), true);
    assert.deepEqual(tail.slice(1).map(message => message.tool_call_id), tail[0].tool_calls.map(call => call.id));
    assert.ok(tail.slice(1).every(message => message.content.includes("artifactId")));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of [["BOWERBIRD_U1_ALLOW_NETWORK", previous.allow], ["DEEPSEEK_API_KEY", previous.key], ["DEEPSEEK_BASE_URL", previous.base]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

function toolCallSse(name, argumentsValue, sequence) {
  const event = {
    id: `fixture-${sequence}`,
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: `fixture-call-${sequence}`,
          type: "function",
          function: { name, arguments: JSON.stringify(argumentsValue) },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 12,
    },
  };
  return `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`;
}

async function startFakeDeepSeek(plan) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push(parsed);
    const sequence = requests.length;
    const invalidPlan = structuredClone(plan);
    invalidPlan.capabilities = [{ tool: "generate_image", maxCalls: 32 }];
    const actions = [
      ["list_run_assets", {}], ["list_skills", {}],
      ["read_skill", { skillId: "bowerbird-controlled-image-edit" }],
      ["read_context", { id: "project_visual_profile" }],
      ["request_task_authorization", invalidPlan], ["request_task_authorization", plan],
    ];
    const action = actions[sequence - 1];
    if (!action) { response.writeHead(500); response.end(); return; }
    const payload = toolCallSse(action[0], action[1], sequence);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.end(payload);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("real DSH loads methods on demand and submits a minimal plan without context pollution", async () => {
  const assets = [{
    assetId: "asset-product",
    role: "input",
    mime: "image/png",
    width: 640,
    height: 480,
  }];
  const manifest = {
    schemaVersion: 1,
    runId: "run-real-dsh-bridge",
    manifestHash: sha256Hex(canonicalJson({ schemaVersion: 1, assets })),
    assets,
  };
  const plan = { schemaVersion: 3, title: "产品图片", summary: "基于产品图生成图片", assetIds: ["asset-product"],
    outputCount: 1, modelTurns: 8, capabilities: [{ tool: "generate_image", maxCalls: 1 }] };
  const approvals = [];
  const identities = [];
  const controlPort = {
    async readRunAssets(identity) {
      identities.push(identity);
      return manifest;
    },
    async requestPlanApproval(request) {
      approvals.push(request);
      return { reused: false, estimatedAdditionalCredits: 2 };
    },
  };
  const claimed = {
    run: {
      id: manifest.runId,
      conversationId: "conversation-real-dsh-bridge",
      skillId: "unified-agent",
      skillVersion: "0.1.0",
      inputManifestHash: "a".repeat(64),
      approvedPlanHash: null,
      plannedToolCount: null,
      resultFeedbackAction: null,
      budgetCredits: 10,
      pricingVersion: 1,
      checkpointHash: null,
      snapshotSchemaVersion: null,
    },
    lease: { leaseId: "lease-real-dsh-bridge", leaseSeconds: 60 },
    artifactUrls: [{
      artifactId: "asset-product",
      conversationId: "conversation-real-dsh-bridge",
      runId: manifest.runId,
      role: "input",
      mime: "image/png",
      bytes: 24,
      sha256: "b".repeat(64),
      width: 640,
      height: 480,
      userVisible: true,
    }],
  };
  const planningBridge = new UnifiedPlanningToolBridge({
    claimed,
    contextTools: new RunContextTools([{ id: "project_visual_profile", description: "Brand context", read: () => ({ must: ["PROFILE_SENTINEL_NAVY"] }) }]),
    gateway: new ScopedToolGateway(createRunControlToolDefinitions(controlPort, {}, {

      requiredVisualProfile: null,
    })),
  });
  const modelServer = await startFakeDeepSeek(plan);
  const previous = {
    allow: process.env.BOWERBIRD_U1_ALLOW_NETWORK,
    key: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL,
  };
  process.env.BOWERBIRD_U1_ALLOW_NETWORK = "1";
  process.env.DEEPSEEK_API_KEY = "fixture-only-deepseek-key";
  process.env.DEEPSEEK_BASE_URL = modelServer.baseUrl;

  try {
    const runner = new UnifiedPlanningHarnessRunner(planningBridge, (toolBridge) =>
      new DshAcpHarnessAdapter({
        cwd: spikeRoot,
        createPort: () => new NodeDshAcpPort({
          allowNetwork: true,
          patches: [BRIDGE_PATCH],
          toolBridge,
        }),
      }));
    const result = await runner.run({
      schemaVersion: 1,
      runId: manifest.runId,
      checkpointVersion: 0,
      phase: "compose_plan",
      compactedFacts: [],
      completedToolResults: [],
      input: { htmlOutput: { capture: { mode: "full_page_and_slices" } } },
    }, [{ type: "text", text: `${loadUnifiedAgentSkill().instructions}\n[BOWERBIRD_USER_GOAL_V1]\n${canonicalJson({ goal: "请为当前产品图制定一个最小计划。", revision: 0, feedback: [] })}\n[/BOWERBIRD_USER_GOAL_V1]` }]);
    assert.equal(result.stopReason, "end_turn");
    assert.equal(modelServer.requests.length, 6);
    assert.ok(modelServer.requests[5].messages.some((message) => message.role === "tool" && message.content.includes("retry_required") && message.content.includes("31")));
    assert.deepEqual(
      modelServer.requests[0].tools.map((tool) => tool.function.name).sort(),
      ["ask_user", "call_tool", "list_run_assets", "list_skills", "read_context", "read_skill", "request_task_authorization", "understand_asset"],
    );
    assert.ok(modelServer.requests[1].messages.some(
      (message) => message.role === "tool" && message.content.includes("asset-product"),
    ));
    const initial = JSON.stringify(modelServer.requests[0]);
    for (const forbidden of ["htmlOutput", "full_page_and_slices", "contentPlan", "informationArchitecture", "Start with general", "ControlledImageEditPlan", "普通修图", "staged_controlled", "BOWERBIRD_CHECKPOINT_V1", "Current runtime context."]) {
      assert.ok(!initial.includes(forbidden), forbidden);
    }
    assert.ok(!initial.includes("参考图数量本身不决定步骤数"));
    assert.ok(JSON.stringify(modelServer.requests[3]).includes("参考图数量本身不决定步骤数"));
    assert.ok(!JSON.stringify(modelServer.requests).includes("# HTML 图文排版"));
    assert.ok(!JSON.stringify(modelServer.requests.slice(0, 4)).includes("PROFILE_SENTINEL_NAVY"));
    assert.ok(JSON.stringify(modelServer.requests[4]).includes("PROFILE_SENTINEL_NAVY"));
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].proposal.schemaVersion, 3);
    assert.equal(approvals[0].proposal.contentPlan, undefined);
    assert.equal(approvals[0].proposalHash, sha256Hex(canonicalJson(plan)));
    assert.equal(identities.length, 2);
    assert.equal(identities.every((identity) => identity.runId === manifest.runId), true);
    assert.equal(identities.every((identity) => identity.leaseId === claimed.lease.leaseId), true);
  } finally {
    await modelServer.close();
    if (previous.allow === undefined) delete process.env.BOWERBIRD_U1_ALLOW_NETWORK;
    else process.env.BOWERBIRD_U1_ALLOW_NETWORK = previous.allow;
    if (previous.key === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous.key;
    if (previous.baseUrl === undefined) delete process.env.DEEPSEEK_BASE_URL;
    else process.env.DEEPSEEK_BASE_URL = previous.baseUrl;
  }
});
