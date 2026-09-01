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
  "compose_xiaohongshu",
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
  kind: "understand_asset" | "generate_image" | "compose_html" | "render_html" | "inspect_artifact" | "compose_xiaohongshu" | "finalize_output";
  goal: string;
  inputAssetIds: string[];
  dependsOn: string[];
};

export type HarnessPlanContent = {
  assetAssignments: Array<{
    assetId: string;
    roles: Array<"product" | "logo" | "copy_source" | "style_reference" | "supporting">;
    rationale: string;
  }>;
  informationArchitecture: Array<{
    id: string;
    purpose: string;
    sourceAssetIds: string[];
    copySource: "user_goal" | "asset_observation" | "none";
  }>;
  missingAssets: Array<{
    id: string;
    purpose: string;
    decision: "generate" | "reuse_existing" | "not_needed";
    resolutionStepId: string | null;
  }>;
  visualProfile: null | {
    profileId: string;
    version: number;
    hash: string;
    applied: string[];
    ignoredContentThemes: string[];
  };
};

type HarnessPlanBase = {
  title: string;
  summary: string;
  steps: HarnessPlanStep[];
};

export type HarnessPlan =
  | (HarnessPlanBase & { schemaVersion: 1 })
  | (HarnessPlanBase & { schemaVersion: 2; contentPlan: HarnessPlanContent });

export type RunControlPlanPolicy = {
  requireStructuredPlan?: boolean;
  requiredVisualProfile?: null | { profileId: string; version: number; hash: string };
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

function uniqueTexts(value: unknown, max: number, maxText: number, allowEmpty = true): string[] {
  if (!Array.isArray(value) || value.length > max || (!allowEmpty && value.length === 0)) throw new Error("invalid_array");
  const texts = value.map((item) => boundedText(item, maxText));
  if (new Set(texts).size !== texts.length) throw new Error("duplicate_array_item");
  return texts;
}

const ASSET_ROLES = new Set(["product", "logo", "copy_source", "style_reference", "supporting"]);
const COPY_SOURCES = new Set(["user_goal", "asset_observation", "none"]);
const MISSING_DECISIONS = new Set(["generate", "reuse_existing", "not_needed"]);

function validateContentPlan(value: unknown, limits: RunControlToolLimits, steps: HarnessPlanStep[]): HarnessPlanContent {
  const content = exactRecord(value, ["assetAssignments", "informationArchitecture", "missingAssets", "visualProfile"]);
  if (!Array.isArray(content.assetAssignments) || !content.assetAssignments.length ||
      content.assetAssignments.length > limits.maxAssets || !Array.isArray(content.informationArchitecture) ||
      !content.informationArchitecture.length || content.informationArchitecture.length > limits.maxPlanSteps ||
      !Array.isArray(content.missingAssets) || content.missingAssets.length > limits.maxPlanSteps) {
    throw new Error("plan_content_invalid");
  }
  const assetAssignments = content.assetAssignments.map((value) => {
    const assignment = exactRecord(value, ["assetId", "roles", "rationale"]);
    const roles = uniqueTexts(assignment.roles, ASSET_ROLES.size, 32, false);
    if (roles.some((role) => !ASSET_ROLES.has(role))) throw new Error("plan_content_invalid");
    return {
      assetId: uniqueStrings([assignment.assetId], 1, ASSET_ID)[0]!,
      roles: roles as HarnessPlanContent["assetAssignments"][number]["roles"],
      rationale: boundedText(assignment.rationale, 500),
    };
  });
  if (new Set(assetAssignments.map((item) => item.assetId)).size !== assetAssignments.length) {
    throw new Error("plan_content_invalid");
  }
  const informationArchitecture = content.informationArchitecture.map((value) => {
    const section = exactRecord(value, ["id", "purpose", "sourceAssetIds", "copySource"]);
    const id = boundedText(section.id, 64);
    if (!STEP_ID.test(id) || typeof section.copySource !== "string" || !COPY_SOURCES.has(section.copySource)) {
      throw new Error("plan_content_invalid");
    }
    return {
      id,
      purpose: boundedText(section.purpose, 500),
      sourceAssetIds: uniqueStrings(section.sourceAssetIds, limits.maxAssets, ASSET_ID),
      copySource: section.copySource as HarnessPlanContent["informationArchitecture"][number]["copySource"],
    };
  });
  if (new Set(informationArchitecture.map((item) => item.id)).size !== informationArchitecture.length) {
    throw new Error("plan_content_invalid");
  }
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const missingAssets = content.missingAssets.map((value) => {
    const item = exactRecord(value, ["id", "purpose", "decision", "resolutionStepId"]);
    const id = boundedText(item.id, 64);
    if (!STEP_ID.test(id) || typeof item.decision !== "string" || !MISSING_DECISIONS.has(item.decision)) {
      throw new Error("plan_content_invalid");
    }
    const resolutionStepId = item.resolutionStepId;
    if (item.decision === "generate") {
      if (typeof resolutionStepId !== "string" || stepById.get(resolutionStepId)?.kind !== "generate_image") {
        throw new Error("plan_content_invalid");
      }
    } else if (resolutionStepId !== null) {
      throw new Error("plan_content_invalid");
    }
    return {
      id,
      purpose: boundedText(item.purpose, 500),
      decision: item.decision as HarnessPlanContent["missingAssets"][number]["decision"],
      resolutionStepId: resolutionStepId as string | null,
    };
  });
  if (new Set(missingAssets.map((item) => item.id)).size !== missingAssets.length) {
    throw new Error("plan_content_invalid");
  }
  let visualProfile: HarnessPlanContent["visualProfile"] = null;
  if (content.visualProfile !== null) {
    const profile = exactRecord(content.visualProfile, ["profileId", "version", "hash", "applied", "ignoredContentThemes"]);
    if (!Number.isSafeInteger(profile.version) || Number(profile.version) < 1 ||
        typeof profile.hash !== "string" || !/^[0-9a-f]{64}$/.test(profile.hash)) {
      throw new Error("plan_content_invalid");
    }
    visualProfile = {
      profileId: boundedText(profile.profileId, 128),
      version: Number(profile.version),
      hash: profile.hash,
      applied: uniqueTexts(profile.applied, 24, 300, false),
      ignoredContentThemes: uniqueTexts(profile.ignoredContentThemes, 24, 300),
    };
  }
  return { assetAssignments, informationArchitecture, missingAssets, visualProfile };
}

function validateEmptyArguments(value: unknown): Record<string, never> {
  exactRecord(value, []);
  return {};
}

function validatePlanArguments(value: unknown, limits: RunControlToolLimits): { plan: HarnessPlan } {
  const wrapper = exactRecord(value, ["plan"]);
  if (!wrapper.plan || typeof wrapper.plan !== "object" || Array.isArray(wrapper.plan)) throw new Error("plan_schema_version_invalid");
  const schemaVersion = (wrapper.plan as Record<string, unknown>).schemaVersion;
  const planRecord = exactRecord(wrapper.plan, schemaVersion === 2
    ? ["schemaVersion", "title", "summary", "contentPlan", "steps"]
    : ["schemaVersion", "title", "summary", "steps"]);
  if (schemaVersion !== 1 && schemaVersion !== 2) throw new Error("plan_schema_version_invalid");
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

  const base = { title: boundedText(planRecord.title, 120), summary: boundedText(planRecord.summary, 2_000), steps };
  return schemaVersion === 2
    ? { plan: { schemaVersion: 2, ...base, contentPlan: validateContentPlan(planRecord.contentPlan, limits, steps) } }
    : { plan: { schemaVersion: 1, ...base } };
}

/** Revalidates a control-plane plan object before approved execution. */
export function validateHarnessPlan(value: unknown): HarnessPlan {
  return validatePlanArguments({ plan: value }, DEFAULT_LIMITS).plan;
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
  private readonly policy: RunControlPlanPolicy;

  constructor(
    toolName: "list_run_assets" | "submit_plan",
    port: RunControlToolsPort,
    limits: RunControlToolLimits,
    policy: RunControlPlanPolicy,
  ) {
    this.toolName = toolName;
    this.port = port;
    this.limits = limits;
    this.policy = policy;
  }

  async dispatch(identity: DurableToolIdentity, argumentsValue: unknown): Promise<unknown> {
    const manifest = validateManifest(await this.port.readRunAssets(identity), identity, this.limits);
    if (this.toolName === "list_run_assets") return manifest;

    const { plan } = argumentsValue as { plan: HarnessPlan };
    const knownAssets = new Set(manifest.assets.map((asset) => asset.assetId));
    const structuredAssetIds = plan.schemaVersion === 2 ? [
      ...plan.contentPlan.assetAssignments.map((item) => item.assetId),
      ...plan.contentPlan.informationArchitecture.flatMap((item) => item.sourceAssetIds),
    ] : [];
    if (plan.steps.some((step) => step.inputAssetIds.some((assetId) => !knownAssets.has(assetId))) ||
        structuredAssetIds.some((assetId) => !knownAssets.has(assetId))) {
      throw new Error("plan_asset_not_in_run");
    }
    if (this.policy.requireStructuredPlan && plan.schemaVersion !== 2) throw new Error("plan_structured_required");
    if (plan.schemaVersion === 2) {
      const assigned = new Set(plan.contentPlan.assetAssignments.map((item) => item.assetId));
      if (assigned.size !== knownAssets.size || [...knownAssets].some((assetId) => !assigned.has(assetId))) {
        throw new Error("plan_asset_assignment_incomplete");
      }
      if (this.policy.requiredVisualProfile !== undefined) {
        const expected = this.policy.requiredVisualProfile;
        const actual = plan.contentPlan.visualProfile;
        if ((expected === null) !== (actual === null) || (expected && actual &&
            (expected.profileId !== actual.profileId || expected.version !== actual.version || expected.hash !== actual.hash))) {
          throw new Error("plan_visual_profile_mismatch");
        }
      }
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
  policy: RunControlPlanPolicy = {},
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
      dispatcher: new RunControlDispatcher("list_run_assets", port, limits, policy),
    },
    {
      name: "submit_plan",
      execution: "control",
      allowedPhases: ["compose_plan"],
      validate: (value) => validatePlanArguments(value, limits),
      dispatcher: new RunControlDispatcher("submit_plan", port, limits, policy),
    },
  ];
}
