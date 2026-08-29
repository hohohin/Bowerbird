import type { DurableToolIdentity } from "../kernel/durable-tool-dispatcher.ts";
import { canonicalJson, computeArgsHash, sha256Hex } from "../kernel/tool-ledger.ts";
import type {
  ToolGatewayControlDispatcher,
  ToolGatewayDefinition,
} from "./scoped-tool-gateway.ts";

const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STEP_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const PLAN_STEP_KINDS = new Set([
  "understand_asset",
  "generate_image",
  "compose_html",
  "render_html",
  "inspect_artifact",
  "finalize_output",
]);

export type RunAssetView = {
  assetId: string;
  role: "input" | "reference" | "generated";
  mime: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  /** 来自用户或模型的普通数据，注入上下文时仍按 untrusted 处理。 */
  caption?: string;
};

export type RunAssetManifest = {
  schemaVersion: 1;
  runId: string;
  manifestHash: string;
  assets: RunAssetView[];
};

export type HarnessPlanStep = {
  id: string;
  kind: "understand_asset" | "generate_image" | "compose_html" | "render_html" | "inspect_artifact" | "finalize_output";
  goal: string;
  inputAssetIds: string[];
  dependsOn: string[];
};

export type HarnessPlan = {
  schemaVersion: 1;
  title: string;
  summary: string;
  steps: HarnessPlanStep[];
};

export type PlanApprovalRequest = {
  runId: string;
  leaseId: string;
  callId: string;
  argsHash: string;
  proposalHash: string;
  proposal: HarnessPlan;
  plannedToolCount: number;
};

export interface RunControlToolsPort {
  readRunAssets(identity: Pick<DurableToolIdentity, "runId" | "leaseId">): Promise<RunAssetManifest>;
  /** 控制面必须以 callId + argsHash 幂等；同 call 参数漂移必须 fail closed。 */
  requestPlanApproval(request: PlanApprovalRequest): Promise<{
    reused: boolean;
    /** 只能来自控制面版本化费率与可信 Policy，不接受模型或 Worker 自报。 */
    estimatedAdditionalCredits: number;
  }>;
}

export type RunControlToolLimits = {
  maxAssets: number;
  maxPlanSteps: number;
};

const DEFAULT_LIMITS: RunControlToolLimits = {
  maxAssets: 64,
  maxPlanSteps: 12,
};

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_object");
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("unexpected_property");
  }
  return record;
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string") throw new Error("invalid_text");
  const text = value.trim();
  if (!text || text.length > max) throw new Error("invalid_text");
  return text;
}

function uniqueStrings(value: unknown, max: number, pattern: RegExp): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("invalid_array");
  const strings = value.map((item) => {
    if (typeof item !== "string" || !pattern.test(item)) throw new Error("invalid_array_item");
    return item;
  });
  if (new Set(strings).size !== strings.length) throw new Error("duplicate_array_item");
  return strings;
}

function validateEmptyArguments(value: unknown): Record<string, never> {
  exactRecord(value, []);
  return {};
}

function validatePlanArguments(value: unknown, limits: RunControlToolLimits): { plan: HarnessPlan } {
  const wrapper = exactRecord(value, ["plan"]);
  const planRecord = exactRecord(wrapper.plan, ["schemaVersion", "title", "summary", "steps"]);
  if (planRecord.schemaVersion !== 1) throw new Error("plan_schema_version_invalid");
  if (!Array.isArray(planRecord.steps) || !planRecord.steps.length || planRecord.steps.length > limits.maxPlanSteps) {
    throw new Error("plan_steps_invalid");
  }

  const steps = planRecord.steps.map((value): HarnessPlanStep => {
    const step = exactRecord(value, ["id", "kind", "goal", "inputAssetIds", "dependsOn"]);
    const id = boundedText(step.id, 64);
    if (!STEP_ID.test(id) || typeof step.kind !== "string" || !PLAN_STEP_KINDS.has(step.kind)) {
      throw new Error("plan_step_invalid");
    }
    return {
      id,
      kind: step.kind as HarnessPlanStep["kind"],
      goal: boundedText(step.goal, 1_000),
      inputAssetIds: uniqueStrings(step.inputAssetIds, limits.maxAssets, ASSET_ID),
      dependsOn: uniqueStrings(step.dependsOn, limits.maxPlanSteps, STEP_ID),
    };
  });

  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id) || step.dependsOn.some((dependency) => !ids.has(dependency))) {
      throw new Error("plan_dependency_invalid");
    }
    ids.add(step.id);
  }
  const finalizeIndexes = steps.flatMap((step, index) => step.kind === "finalize_output" ? [index] : []);
  if (finalizeIndexes.length !== 1 || finalizeIndexes[0] !== steps.length - 1) {
    throw new Error("plan_finalize_invalid");
  }

  return {
    plan: {
      schemaVersion: 1,
      title: boundedText(planRecord.title, 120),
      summary: boundedText(planRecord.summary, 2_000),
      steps,
    },
  };
}

function validateManifest(manifest: RunAssetManifest, identity: DurableToolIdentity, limits: RunControlToolLimits): RunAssetManifest {
  if (manifest.schemaVersion !== 1 || manifest.runId !== identity.runId || !Array.isArray(manifest.assets) ||
      manifest.assets.length > limits.maxAssets) {
    throw new Error("run_manifest_invalid");
  }
  const ids = new Set<string>();
  const assets = manifest.assets.map((assetValue): RunAssetView => {
    const keys = assetValue.caption === undefined
      ? ["assetId", "role", "mime", "width", "height"]
      : ["assetId", "role", "mime", "width", "height", "caption"];
    const asset = exactRecord(assetValue, keys);
    if (typeof asset.assetId !== "string" || !ASSET_ID.test(asset.assetId) || ids.has(asset.assetId) ||
        typeof asset.role !== "string" || !(["input", "reference", "generated"] as const).includes(asset.role as RunAssetView["role"]) ||
        typeof asset.mime !== "string" || !(["image/jpeg", "image/png", "image/webp"] as const).includes(asset.mime as RunAssetView["mime"]) ||
        !Number.isSafeInteger(asset.width) || (asset.width as number) < 1 || (asset.width as number) > 16_384 ||
        !Number.isSafeInteger(asset.height) || (asset.height as number) < 1 || (asset.height as number) > 16_384 ||
        (asset.caption !== undefined && (typeof asset.caption !== "string" || asset.caption.length > 2_000))) {
      throw new Error("run_manifest_invalid");
    }
    ids.add(asset.assetId);
    return {
      assetId: asset.assetId,
      role: asset.role as RunAssetView["role"],
      mime: asset.mime as RunAssetView["mime"],
      width: asset.width as number,
      height: asset.height as number,
      ...(asset.caption === undefined ? {} : { caption: asset.caption as string }),
    };
  });
  const expectedHash = sha256Hex(canonicalJson({ schemaVersion: 1, assets }));
  if (manifest.manifestHash !== expectedHash) throw new Error("run_manifest_hash_mismatch");
  return { schemaVersion: 1, runId: identity.runId, manifestHash: expectedHash, assets };
}

class RunControlDispatcher implements ToolGatewayControlDispatcher {
  private readonly toolName: "list_run_assets" | "submit_plan";
  private readonly port: RunControlToolsPort;
  private readonly limits: RunControlToolLimits;

  constructor(
    toolName: "list_run_assets" | "submit_plan",
    port: RunControlToolsPort,
    limits: RunControlToolLimits,
  ) {
    this.toolName = toolName;
    this.port = port;
    this.limits = limits;
  }

  async dispatch(identity: DurableToolIdentity, argumentsValue: unknown): Promise<unknown> {
    const manifest = validateManifest(await this.port.readRunAssets(identity), identity, this.limits);
    if (this.toolName === "list_run_assets") return manifest;

    const { plan } = argumentsValue as { plan: HarnessPlan };
    const knownAssets = new Set(manifest.assets.map((asset) => asset.assetId));
    if (plan.steps.some((step) => step.inputAssetIds.some((assetId) => !knownAssets.has(assetId)))) {
      throw new Error("plan_asset_not_in_run");
    }
    const proposalHash = sha256Hex(canonicalJson(plan));
    const argsHash = computeArgsHash({ plan });
    const result = await this.port.requestPlanApproval({
      runId: identity.runId,
      leaseId: identity.leaseId,
      callId: identity.callId,
      argsHash,
      proposalHash,
      proposal: plan,
      plannedToolCount: plan.steps.length,
    });
    if (!result || typeof result.reused !== "boolean" ||
        !Number.isSafeInteger(result.estimatedAdditionalCredits) || result.estimatedAdditionalCredits < 0) {
      throw new Error("plan_approval_result_invalid");
    }
    return {
      status: "awaiting_plan_approval",
      terminalReason: "awaiting_plan_approval",
      proposalHash,
      estimatedAdditionalCredits: result.estimatedAdditionalCredits,
      reused: result.reused,
    };
  }
}

export function createRunControlToolDefinitions(
  port: RunControlToolsPort,
  overrides: Partial<RunControlToolLimits> = {},
): ToolGatewayDefinition[] {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  if (!Number.isSafeInteger(limits.maxAssets) || limits.maxAssets < 1 ||
      !Number.isSafeInteger(limits.maxPlanSteps) || limits.maxPlanSteps < 1) {
    throw new Error("run_control_tool_limits_invalid");
  }
  return [
    {
      name: "list_run_assets",
      execution: "control",
      allowedPhases: ["understand_goal", "compose_plan"],
      validate: validateEmptyArguments,
      dispatcher: new RunControlDispatcher("list_run_assets", port, limits),
    },
    {
      name: "submit_plan",
      execution: "control",
      allowedPhases: ["compose_plan"],
      validate: (value) => validatePlanArguments(value, limits),
      dispatcher: new RunControlDispatcher("submit_plan", port, limits),
    },
  ];
}
