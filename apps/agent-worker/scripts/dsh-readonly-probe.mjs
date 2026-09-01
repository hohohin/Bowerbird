import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createServer } from "node:http";
import {
  controlledDshProcessorFromEnv,
  unifiedPlanningProcessorFromEnv,
} from "../src/cloud-agent/main.ts";
import { createDshRuntimeHome } from "../src/harness/dsh-runtime-home.ts";
import { NodeDshAcpPort } from "../src/harness/node-dsh-acp-port.ts";
import { hashIntentAnalysis } from "../src/skills/bowerbird-controlled-image-edit/planner.ts";
import {
  TOOL_BRIDGE_CAPABILITY_ENV,
  TOOL_BRIDGE_ENDPOINT_ENV,
} from "../src/harness/loopback-tool-bridge-server.ts";

const templateDir = process.env.BOWERBIRD_DSH_PROFILE_TEMPLATE;
const runtimeRoot = process.env.BOWERBIRD_DSH_RUNTIME_ROOT;
const workspaceRoot = process.env.AGENT_WORKSPACE_ROOT?.trim() || "/tmp/bowerbird-agent-workspaces";
if (!templateDir || !runtimeRoot) throw new Error("dsh_candidate_paths_missing");

function toolCallSse(name, argumentsValue, sequence) {
  return `data: ${JSON.stringify({
    id: `candidate-${sequence}`,
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: `candidate-call-${sequence}`,
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
  })}\n\ndata: [DONE]\n\n`;
}

async function startFakeDeepSeek(actions) {
  const requests = [];
  const authorizationHeaders = [];
  const server = createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push(parsed);
    authorizationHeaders.push(request.headers.authorization);
    const sequence = requests.length;
    const action = actions[sequence - 1];
    if (!action) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "candidate_fake_deepseek_sequence_exhausted" }));
      return;
    }
    const payload = toolCallSse(action.name, action.arguments, sequence);
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
  if (!address || typeof address === "string") throw new Error("candidate_fake_deepseek_address_invalid");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    authorizationHeaders,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

let finalConfig = "";
for (let attempt = 0; attempt < 2; attempt += 1) {
  const runtime = createDshRuntimeHome({ templateDir, runtimeRoot });
  try {
    const result = spawnSync(process.execPath, [
      runtime.dshBin,
      "--profile",
      runtime.profileName,
      "--patch",
      runtime.bridgePatch,
      "--dump-config",
    ], {
      cwd: runtime.home,
      env: {
        PATH: process.env.PATH,
        DSH_HOME: runtime.home,
        DSH_TELEMETRY_DISABLED: "1",
        DSH_PERMISSION_MODE: "read-only",
      },
      encoding: "utf8",
    });
    if (result.status !== 0) {
      process.stderr.write(result.stderr || "dsh_readonly_probe_failed\n");
      process.exit(result.status ?? 1);
    }
    finalConfig = result.stdout;
  } finally {
    runtime.dispose();
  }
}

const port = await NodeDshAcpPort.create({
  profileTemplateDir: templateDir,
  runtimeRoot,
  childEnvironment: {
    [TOOL_BRIDGE_ENDPOINT_ENV]: "http://127.0.0.1:43123/v1/run-tools/call",
    [TOOL_BRIDGE_CAPABILITY_ENV]: "a".repeat(64),
  },
  parentEnvironment: { PATH: process.env.PATH },
  timeoutMs: 20_000,
});
let initialize;
let session;
try {
  initialize = await port.initialize();
  session = await port.newSession({ cwd: runtimeRoot });
  await port.cancel({ sessionId: session.sessionId });
} finally {
  await port.dispose();
}

const plan = {
  schemaVersion: 2,
  title: "候选容器计划",
  summary: "明确当前产品素材的职责与信息区块后完成受控输出。",
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
const controlledIntent = {
  schemaVersion: 1,
  intentSummary: "生成极简蓝色海报",
  mustPreserve: [],
  mustTransfer: [],
  mustExclude: [],
  mayChange: [],
  highConsistencySignals: [],
  assumptions: [],
};
const controlledPlan = {
  schemaVersion: 1,
  intentAnalysisHash: hashIntentAnalysis(controlledIntent),
  intentSummary: controlledIntent.intentSummary,
  strategy: "direct",
  referenceRoles: [],
  assumptions: [],
  steps: [{
    id: "generate-final",
    kind: "direct_generate",
    goal: "生成最终海报",
    inputs: [],
    modifies: ["画面"],
    preserves: [],
    excludes: [],
    outputRole: "final_result",
    rationale: "纯文本生图无需控制参考",
    estimatedUsage: { generateCalls: 1, understandCalls: 0 },
  }],
};
const unifiedModelServer = await startFakeDeepSeek([
  { name: "list_run_assets", arguments: {} },
  { name: "submit_plan", arguments: { plan } },
]);
let checkpointSaved = false;
let planningEventRecorded = false;
let approvalParked = false;
let controlledCheckpointSaves = 0;
let controlledIntentEventRecorded = false;
let controlledPlanEventRecorded = false;
let controlledApprovalParked = false;
const modelCalls = new Map();
const modelArtifacts = new Map();
const modelUsage = new Map();
const control = {
  async loadRawCheckpoint() { return null; },
  async loadControlledCheckpoint() { return null; },
  async downloadVerifiedJson(url) {
    if (url === "https://local.invalid/controlled-request.json") {
      return { schemaVersion: 1, intentPrompt: controlledIntent.intentSummary, references: [] };
    }
    return { schemaVersion: 1, goal: "把当前产品素材规划为一个受控输出" };
  },
  async saveRawCheckpoint(args) {
    checkpointSaved = args.step === "compose_plan" && args.progress === 10 && args.bytes.length > 0;
    return { checkpointHash: args.sha256, objectKey: "candidate/checkpoint.json" };
  },
  async saveCheckpoint(args) {
    if (args.runId !== "run-candidate-controlled" || args.leaseId !== "lease-candidate-controlled") {
      throw new Error("candidate_controlled_checkpoint_identity_invalid");
    }
    controlledCheckpointSaves += 1;
    return { checkpointHash: "c".repeat(64), objectKey: "candidate/controlled-checkpoint.json" };
  },
  async appendEvents(_runId, _leaseId, events) {
    planningEventRecorded ||= events.some((event) => event.type === "unified.planning.started");
    controlledIntentEventRecorded ||= events.some((event) => event.type === "intent.analysis.completed");
    controlledPlanEventRecorded ||= events.some((event) => event.type === "plan.proposed");
  },
  async prepareTool(args) {
    const existing = modelCalls.get(args.callId);
    if (existing) {
      if (existing.argsHash !== args.argsHash) throw new Error("candidate_model_args_drift");
      return { ...existing, reused: true };
    }
    const created = { ...args, status: "prepared", reused: false };
    modelCalls.set(args.callId, created);
    return created;
  },
  async markToolSubmitted(args) {
    const existing = modelCalls.get(args.callId);
    if (!existing) throw new Error("candidate_model_call_missing");
    const updated = { ...existing, status: "submitted", providerRequestId: args.providerRequestId };
    modelCalls.set(args.callId, updated);
    return updated;
  },
  async completeTool(args) {
    const existing = modelCalls.get(args.callId);
    if (!existing) throw new Error("candidate_model_call_missing");
    const updated = { ...existing, ...args };
    modelCalls.set(args.callId, updated);
    return updated;
  },
  async uploadDiagnostic(args) {
    const conversationId = args.runId === "run-candidate-controlled"
      ? "conversation-candidate-controlled"
      : "conversation-candidate-processor";
    const artifact = {
      artifactId: `model-${args.sourceCallId}`,
      conversationId,
      runId: args.runId,
      role: "diagnostic",
      stepId: args.stepId,
      mime: "application/json",
      bytes: args.bytes.byteLength,
      sha256: args.sha256,
      userVisible: false,
      objectKey: `memory/${args.sourceCallId}.json`,
      url: `memory://${args.sourceCallId}`,
    };
    modelArtifacts.set(args.sourceCallId, { artifact, bytes: Uint8Array.from(args.bytes) });
    return artifact;
  },
  async getArtifactByCall(_runId, _leaseId, callId) {
    const stored = modelArtifacts.get(callId);
    if (!stored) throw new Error("agent_control_http_409");
    return stored.artifact;
  },
  async downloadVerifiedBytes(url) {
    const stored = modelArtifacts.get(url.replace("memory://", ""));
    if (!stored) throw new Error("candidate_model_artifact_missing");
    return Uint8Array.from(stored.bytes);
  },
  async recordUsage(args) {
    if (args.kind !== "model_tokens" || args.provider !== "deepseek") {
      throw new Error("candidate_model_usage_invalid");
    }
    const value = { runId: args.runId, inputUnits: args.inputUnits, outputUnits: args.outputUnits, model: args.model };
    const existing = modelUsage.get(args.callId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(value)) throw new Error("candidate_model_usage_drift");
    modelUsage.set(args.callId, value);
  },
  async requestUnifiedPlanApproval(args) {
    approvalParked = args.proposalHash.length === 64 && args.callId.length === 64 && args.argsHash.length === 64;
    return {
      status: "awaiting_approval",
      proposalHash: args.proposalHash,
      estimatedAdditionalCredits: 2,
      reused: false,
    };
  },
  async requestApproval(args) {
    controlledApprovalParked = args.runId === "run-candidate-controlled" &&
      args.leaseId === "lease-candidate-controlled" &&
      args.kind === "controlled_image_edit_plan" &&
      args.proposalHash.length === 64 &&
      args.plannedToolCount === 1 &&
      args.estimatedAdditionalCredits === 5;
  },
};
const claimed = {
  run: {
    id: "run-candidate-processor",
    conversationId: "conversation-candidate-processor",
    skillId: "bowerbird-unified-agent",
    skillVersion: "0.1.0",
    agentRuntime: "dsh",
    inputManifestHash: "a".repeat(64),
    approvedPlanHash: null,
    plannedToolCount: null,
    resultFeedbackAction: null,
    budgetCredits: 10,
    pricingVersion: 1,
    checkpointHash: null,
    snapshotSchemaVersion: null,
  },
  lease: { leaseId: "lease-candidate-processor", leaseSeconds: 60 },
  inputUrl: "https://local.invalid/request.json",
  artifactUrls: [{
    artifactId: "asset-product",
    conversationId: "conversation-candidate-processor",
    runId: "run-candidate-processor",
    role: "input",
    mime: "image/png",
    bytes: 24,
    sha256: "b".repeat(64),
    width: 640,
    height: 480,
    userVisible: true,
  }],
};
try {
  const processor = unifiedPlanningProcessorFromEnv({
    PATH: process.env.PATH,
    BOWERBIRD_UNIFIED_AGENT_DSH_ENABLED: "true",
    BOWERBIRD_DSH_PROFILE_TEMPLATE: templateDir,
    BOWERBIRD_DSH_RUNTIME_ROOT: runtimeRoot,
    DEEPSEEK_API_KEY: "candidate-fixture-only",
    DEEPSEEK_BASE_URL: unifiedModelServer.baseUrl,
    ARK_API_KEY: "must-not-enter-dsh",
  }, workspaceRoot, {
    apiKey: "unused-parent-vision",
    baseUrl: "https://ark.invalid",
    model: "unused",
    mock: true,
  }, {
    apiKey: "candidate-fixture-only",
    baseUrl: unifiedModelServer.baseUrl,
    model: "deepseek-v4-flash",
  }, { allowInsecureLoopback: true });
  if (!processor) throw new Error("candidate_unified_processor_not_injected");
  await processor.process({
    claimed,
    control,
    signal: { aborted: false, cancelRequested: false, leaseLost: false, stopRequested: false },
  });
} finally {
  await unifiedModelServer.close();
}

const controlledModelServer = await startFakeDeepSeek([
  { name: "record_intent_analysis", arguments: { analysis: controlledIntent } },
  { name: "submit_plan_for_approval", arguments: { plan: controlledPlan } },
]);
try {
  const processor = controlledDshProcessorFromEnv({
    PATH: process.env.PATH,
    BOWERBIRD_CONTROLLED_IMAGE_EDIT_DSH_ENABLED: "true",
    BOWERBIRD_DSH_PROFILE_TEMPLATE: templateDir,
    BOWERBIRD_DSH_RUNTIME_ROOT: runtimeRoot,
    DEEPSEEK_API_KEY: "candidate-fixture-only",
    DEEPSEEK_BASE_URL: controlledModelServer.baseUrl,
    ARK_API_KEY: "must-not-enter-dsh",
  }, {
    apiKey: "candidate-fixture-only",
    baseUrl: controlledModelServer.baseUrl,
    model: "deepseek-v4-flash",
  }, () => ({
    generate: async () => { throw new Error("candidate_generation_before_approval"); },
  }), { allowInsecureLoopback: true });
  if (!processor) throw new Error("candidate_controlled_processor_not_injected");
  await processor.process({
    claimed: {
      run: {
        id: "run-candidate-controlled",
        conversationId: "conversation-candidate-controlled",
        skillId: "bowerbird-controlled-image-edit",
        skillVersion: "0.1.2",
        agentRuntime: "dsh",
        inputManifestHash: "c".repeat(64),
        approvedPlanHash: null,
        plannedToolCount: null,
        resultFeedbackAction: null,
        budgetCredits: 10,
        pricingVersion: 1,
        checkpointHash: null,
        snapshotSchemaVersion: null,
      },
      lease: { leaseId: "lease-candidate-controlled", leaseSeconds: 60 },
      inputUrl: "https://local.invalid/controlled-request.json",
      artifactUrls: [],
    },
    control,
    signal: { aborted: false, cancelRequested: false, leaseLost: false, stopRequested: false },
  });
} finally {
  await controlledModelServer.close();
}

const runtimeEntries = readdirSync(runtimeRoot);
const firstRequestTools = unifiedModelServer.requests[0]?.tools?.map((tool) => tool.function.name).sort() ?? [];
const controlledIntentTools = controlledModelServer.requests[0]?.tools?.map((tool) => tool.function.name).sort() ?? [];
const controlledPlanTools = controlledModelServer.requests[1]?.tools?.map((tool) => tool.function.name).sort() ?? [];
const succeededModelCallsFor = (runId) => [...modelCalls.values()].filter(
  (call) => call.runId === runId && call.status === "succeeded",
).length;
const modelUsageFor = (runId) => [...modelUsage.values()].filter((usage) => usage.runId === runId);
const result = {
  ok: true,
  configBoots: 2,
  acpInitialized: initialize?.protocolVersion === 1,
  acpSessionCreated: Boolean(session?.sessionId),
  acpCancelAccepted: true,
  runtimeHomesCleaned: runtimeEntries.length === 0,
  dangerousToolRowsDisabled: /id: tool-bash[\s\S]*?disabled: true/.test(finalConfig),
  planningPluginPresent: finalConfig.includes("bowerbird-planning-tools"),
  formalProcessorInjected: true,
  formalProcessorCheckpointSaved: checkpointSaved,
  formalProcessorEventRecorded: planningEventRecorded,
  formalProcessorModelTurns: unifiedModelServer.requests.length,
  formalProcessorModelCallsDurable: succeededModelCallsFor("run-candidate-processor") === 2,
  formalProcessorModelUsageMetered: modelUsageFor("run-candidate-processor").length === 2 && modelUsageFor("run-candidate-processor").every(
    (usage) => usage.inputUnits === 12 && usage.outputUnits === 4 && usage.model === "deepseek-v4-flash",
  ),
  realDeepSeekKeyStayedInParent: [...unifiedModelServer.authorizationHeaders, ...controlledModelServer.authorizationHeaders].every(
    (header) => header === "Bearer candidate-fixture-only",
  ),
  formalProcessorToolSurfaceClosed: firstRequestTools.join(",") === "list_run_assets,submit_plan,understand_asset",
  formalProcessorSawCurrentAsset: unifiedModelServer.requests[1]?.messages?.some(
    (message) => message.role === "tool" && message.content.includes("asset-product"),
  ) === true,
  formalProcessorApprovalParked: approvalParked,
  controlledProcessorInjected: true,
  controlledProcessorModelTurns: controlledModelServer.requests.length,
  controlledProcessorModelCallsDurable: succeededModelCallsFor("run-candidate-controlled") === 2,
  controlledProcessorModelUsageMetered: modelUsageFor("run-candidate-controlled").length === 2 && modelUsageFor("run-candidate-controlled").every(
    (usage) => usage.inputUnits === 12 && usage.outputUnits === 4 && usage.model === "deepseek-v4-flash",
  ),
  controlledProcessorToolSurfaceClosed: controlledIntentTools.join(",") === "record_intent_analysis,request_clarification,submit_plan_for_approval" &&
    controlledPlanTools.join(",") === "record_intent_analysis,request_clarification,submit_plan_for_approval",
  controlledProcessorIntentBound: controlledModelServer.requests[0]?.messages?.some(
    (message) => message.content.includes("[BOWERBIRD_CONTROLLED_MODEL_TURN_V1]") && message.content.includes(controlledIntent.intentSummary),
  ) === true,
  controlledProcessorPlanHashBound: controlledModelServer.requests[1]?.messages?.some(
    (message) => message.content.includes(controlledPlan.intentAnalysisHash),
  ) === true,
  controlledProcessorCheckpointsSaved: controlledCheckpointSaves === 2,
  controlledProcessorEventsRecorded: controlledIntentEventRecorded && controlledPlanEventRecorded,
  controlledProcessorApprovalParked: controlledApprovalParked,
};
const failedChecks = Object.entries(result)
  .filter(([key, value]) => value === false || (key.endsWith("ProcessorModelTurns") && value !== 2))
  .map(([key]) => key);
if (failedChecks.length) throw new Error(`dsh_candidate_probe_failed:${failedChecks.join(",")}`);
process.stdout.write(`${JSON.stringify(result)}\n`);
