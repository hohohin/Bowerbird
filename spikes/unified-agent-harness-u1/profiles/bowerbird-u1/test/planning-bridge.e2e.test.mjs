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
import { spikeRoot } from "../scripts/runtime.mjs";

const BRIDGE_PATCH = "profiles/bowerbird-u1/cordis.bridge.patch.yml";

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
    const payload = sequence === 1
      ? toolCallSse("list_run_assets", {}, sequence)
      : toolCallSse("submit_plan", { plan }, sequence);
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

test("real DSH plugin executes list_run_assets then parks one authoritative plan through the parent bridge", async () => {
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
  const plan = {
    schemaVersion: 2,
    title: "产品长图计划",
    summary: "明确当前产品素材的职责和信息区块后产出最终结果。",
    contentPlan: {
      assetAssignments: [{
        assetId: "asset-product",
        roles: ["product", "copy_source"],
        rationale: "当前 Run 素材提供产品主体与可核验包装文字。",
      }],
      informationArchitecture: [{
        id: "hero",
        purpose: "展示产品主体与核心卖点",
        sourceAssetIds: ["asset-product"],
        copySource: "asset_observation",
      }],
      missingAssets: [],
      visualProfile: null,
    },
    steps: [{
      id: "finalize",
      kind: "finalize_output",
      goal: "提交最终结果",
      inputAssetIds: ["asset-product"],
      dependsOn: [],
    }],
  };
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
    gateway: new ScopedToolGateway(createRunControlToolDefinitions(controlPort, {}, {
      requireStructuredPlan: true,
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
    }, [{ type: "text", text: "请为当前产品图制定一个最小计划。" }]);
    assert.equal(result.stopReason, "end_turn");
    assert.equal(modelServer.requests.length, 2);
    assert.deepEqual(
      modelServer.requests[0].tools.map((tool) => tool.function.name).sort(),
      ["list_run_assets", "submit_plan", "understand_asset"],
    );
    assert.ok(modelServer.requests[1].messages.some(
      (message) => message.role === "tool" && message.content.includes("asset-product"),
    ));
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].proposal.schemaVersion, 2);
    assert.equal(approvals[0].proposal.contentPlan.assetAssignments[0].assetId, "asset-product");
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
