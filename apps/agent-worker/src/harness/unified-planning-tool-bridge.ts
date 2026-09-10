import { RunContextTools } from "./run-context-tools.ts";
import type { VisualObservationMemory } from "./visual-observation-memory.ts";
import type { AgentLeaseSignal } from "../cloud-agent/runtime.ts";
import { RunWorkspace } from "../cloud-agent/run-workspace.ts";
import {
  AgentControlClient,
  type AgentWorkerFetch,
  type ClaimedAgentRun,
} from "../control-plane/agent-control-client.ts";
import { AgentControlRunToolsPort, runAssetManifestFromClaim } from "./agent-control-run-tools-port.ts";
import { createRunControlToolDefinitions } from "./run-control-tools.ts";
import type { HarnessPlanStep } from "./run-control-tools.ts";
import { listUnifiedDomainSkills } from "../skills/bowerbird-unified-agent/domain-skills.ts";
import { loadUnifiedAgentSkill } from "../skills/bowerbird-unified-agent/loader.ts";
import { canonicalJson, sha256Hex } from "../kernel/tool-ledger.ts";
import type { ClarificationProposal } from "../contracts/clarification.ts";
import { ScopedToolGateway, ToolGatewayError, type ToolGatewayResult } from "./scoped-tool-gateway.ts";
import {
  createUnderstandAssetToolDefinition,
  UNDERSTAND_ASSET_FOCUS,
  type ArkAssetUnderstandingConfig,
  type UnderstandAssetFocus,
} from "./understand-asset-tool.ts";

export type HarnessModelToolCall = {
  toolName: string;
  arguments: unknown;
};

/**
 * Parent-owned U2 planning surface. A DSH plugin may forward only name+arguments;
 * all business identity and stable slots are derived here from the current claim.
 */
export class UnifiedPlanningToolBridge {
  private readonly claimed: ClaimedAgentRun & {
    run: NonNullable<ClaimedAgentRun["run"]>;
    lease: NonNullable<ClaimedAgentRun["lease"]>;
  };
  private readonly gateway: ScopedToolGateway;
  private readonly assetIndexes: ReadonlyMap<string, number>;
  private readonly allowedTools = new Set(["list_run_assets", "understand_asset", "submit_plan", "request_task_authorization"]);
  private planApprovalRequested = false;
  private readonly revisionIndex: number;
  private readonly clarify?: (proposal: ClarificationProposal) => Promise<void>;
  private readonly contextHash?: string;
  private clarificationRequested = false;
  private readonly contextTools: RunContextTools;
  private readonly observations?: VisualObservationMemory;

  constructor(args: {
    claimed: ClaimedAgentRun & {
      run: NonNullable<ClaimedAgentRun["run"]>;
      lease: NonNullable<ClaimedAgentRun["lease"]>;
    };
    gateway: ScopedToolGateway;
    revisionIndex?: number;
    clarify?: (proposal: ClarificationProposal) => Promise<void>;
    contextHash?: string;
    contextTools?: RunContextTools;
    observations?: VisualObservationMemory;
  }) {
    this.contextTools = args.contextTools ?? new RunContextTools([]);
    this.observations = args.observations;
    this.claimed = args.claimed;
    this.gateway = args.gateway;
    this.revisionIndex = args.revisionIndex ?? 0;
    this.clarify = args.clarify;
    this.contextHash = args.contextHash;
    const manifest = runAssetManifestFromClaim(args.claimed);
    this.assetIndexes = new Map(manifest.assets.map((asset, index) => [asset.assetId, index]));
  }

  get runId(): string {
    return this.claimed.run.id;
  }

  get awaitingPlanApproval(): boolean {
    return this.planApprovalRequested;
  }

  get awaitingClarification(): boolean { return this.clarificationRequested; }

  async dispatch(call: HarnessModelToolCall): Promise<ToolGatewayResult> {
    if (this.planApprovalRequested || this.clarificationRequested) throw new ToolGatewayError("tool_phase_denied");
    const observation = await this.observations?.readContext(call);
    if (observation) return observation;
    const contextResult = this.contextTools.dispatch(call);
    if (contextResult) return contextResult;
    if (call.toolName === "ask_user") {
      const value = call.arguments as { question?: string; options?: string[] } | null;
      if (!this.clarify || !this.contextHash || !value || Object.keys(value).sort().join(",") !== "options,question" ||
          typeof value.question !== "string" || !value.question.trim() || value.question.length > 500 ||
          !Array.isArray(value.options) || value.options.length < 2 || value.options.length > 4 ||
          value.options.some((option) => typeof option !== "string" || !option.trim() || option.length > 240) ||
          new Set(value.options).size !== value.options.length) {
        return this.correction("ask_user takes {question, options}: one question (<=500 characters), 2–4 distinct answers (<=240 characters each), recommended answer first.");
      }
      const questionKey = `unified-${sha256Hex(canonicalJson({ contextHash: this.contextHash, question: value.question })).slice(0, 48)}`;
      const proposal: ClarificationProposal = { questionKey, contextHash: this.contextHash, question: value.question,
        recommendedAnswer: value.options[0]!, options: value.options,
        affectedIntentFields: ["goal"], rationale: "用户回答将补充当前创作目标。",
        optionPatches: value.options.map((answer) => ({ answer, patches: [{ field: "goal", op: "set", value: answer }] })) };
      await this.clarify(proposal);
      this.clarificationRequested = true;
      return { callId: questionKey, value: { terminalReason: "awaiting_clarification" } };
    }
    // Skills are methods for this same Agent, never additional runners or sessions.
    if (call.toolName === "list_skills") {
      if (!call.arguments || typeof call.arguments !== "object" || Object.keys(call.arguments).length) {
        return this.correction("Use list_skills with {}.");
      }
      return { callId: "skill-catalog", value: listUnifiedDomainSkills() };
    }
    if (call.toolName === "read_skill") {
      const record = call.arguments as { skillId?: string } | null;
      const entry = listUnifiedDomainSkills().find((skill) => skill.id === record?.skillId);
      if (!entry || !record || Object.keys(record).length !== 1) {
        return this.correction("Choose a skillId from list_skills and pass only {skillId}.");
      }
      const skill = loadUnifiedAgentSkill();
      return { callId: `skill:${entry.id}`, value: {
        id: entry.id, instructions: skill.methods[entry.id],
      } };
    }
    try {
      if (call.toolName === "understand_asset") {
        const cached = await this.observations?.replay(call);
        if (cached) return cached;
      }
      const result = await this.gateway.dispatch({
        runId: this.claimed.run.id,
        leaseId: this.claimed.lease.leaseId,
        phase: "compose_plan",
        toolName: call.toolName,
        arguments: call.arguments,
        trustedSlot: { logicalSlot: this.logicalSlot(call), revisionIndex: this.revisionIndex },
        allowedTools: this.allowedTools,
      });
      if (call.toolName === "understand_asset") await this.observations?.remember(call, result);
      if (["submit_plan", "request_task_authorization"].includes(call.toolName) && result.value && typeof result.value === "object" &&
          (result.value as Record<string, unknown>).terminalReason === "awaiting_plan_approval") {
        this.planApprovalRequested = true;
      }
      return result;
    } catch (error) {
      const code = error instanceof ToolGatewayError ? error.validationCode ?? error.code
        : error instanceof Error ? error.message : "";
      const corrections: Record<string, string> = {
        task_authorization_invalid: "Use schemaVersion 3 with title, summary, assetIds, outputCount (1–31), modelTurns (1–128), capabilities [{tool,maxCalls}]. Total capability calls <=31; each tool appears once. Do not provide steps or credits.",
        tool_arguments_invalid: "Check the tool schema. understand_asset.focus must be general, subject, text, layout or style. submit_plan takes {plan}.",
        plan_content_invalid: "contentPlan allows 0–64 assetAssignments, 1–64 informationArchitecture sections, and at most 12 missingAssets. Each entry must match the schema; generated missing assets must reference a generate_image step.",
        plan_steps_invalid: "Use 1–12 plan steps. Information sections are separate and may contain up to 64 entries.",
        plan_step_invalid: "Step ids must match ^[a-z][a-z0-9_-]{0,63}$ and kinds must match the tool schema.",
        plan_dependency_invalid: "Use unique step ids. dependsOn can reference only earlier steps; remove cycles and unknown dependencies.",
        plan_finalize_invalid: "End the plan with exactly one finalize_output step.",
        invalid_text: "Check string limits: title 120, summary 2000, step goal 1000, section purpose and asset rationale 500 characters. Required text cannot be empty.",
        unexpected_property: "Remove extra fields and include all required fields from the tool schema, including contentPlan for schemaVersion 2.",
        invalid_array: "Check array limits and use arrays for all list fields.",
        duplicate_array_item: "Remove duplicate values within array fields.",
        plan_asset_not_in_run: "Use only assetIds returned by list_run_assets. Generated outputs flow through dependsOn, not invented assetIds.",
        plan_asset_assignment_incomplete: "Assign a role to each Run asset exactly once; use [] when the Run has no images.",
        plan_structured_required: "Use schemaVersion 2 and include contentPlan.",
        plan_visual_profile_mismatch: "Copy the frozen visual profile identity exactly; use null if no profile was provided.",
      };
      if (corrections[code]) return this.correction(corrections[code]!, code);
      throw error;
    }
  }

  private correction(correction: string, errorCode = "tool_arguments_invalid"): ToolGatewayResult {
    return { callId: "validation", value: { status: "retry_required", errorCode, correction } };
  }

  private logicalSlot(call: HarnessModelToolCall): number {
    if (call.toolName === "list_run_assets") return 0;
    if (call.toolName === "submit_plan" || call.toolName === "request_task_authorization") return 10_000;
    if (call.toolName !== "understand_asset") return 0;
    if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) {
      throw new ToolGatewayError("tool_arguments_invalid");
    }
    const record = call.arguments as Record<string, unknown>;
    const assetIndex = typeof record.assetId === "string" ? this.assetIndexes.get(record.assetId) : undefined;
    const focusIndex = UNDERSTAND_ASSET_FOCUS.indexOf(record.focus as UnderstandAssetFocus);
    if (assetIndex === undefined || focusIndex < 0) throw new ToolGatewayError("tool_arguments_invalid");
    // Keep the original general slot for recovery; additional focuses have distinct
    // stable slots. Repeating a focus replays without another provider charge.
    return focusIndex === 0 ? 1 + assetIndex : 1_000 + assetIndex * UNDERSTAND_ASSET_FOCUS.length + focusIndex;
  }
}

export function createUnifiedPlanningToolBridge(args: {
  claimed: ClaimedAgentRun & {
    run: NonNullable<ClaimedAgentRun["run"]>;
    lease: NonNullable<ClaimedAgentRun["lease"]>;
  };
  control: AgentControlClient;
  workspace: RunWorkspace;
  vision: ArkAssetUnderstandingConfig;
  visualProfile?: { profileId: string; version: number; hash: string };
  requiredStepKinds?: HarnessPlanStep["kind"][];
  contextTools?: RunContextTools;
  observations?: VisualObservationMemory;
  revisionIndex?: number;
  clarificationContextHash?: string;
  onClarification?: (proposal: ClarificationProposal) => Promise<void>;
  signal: AgentLeaseSignal;
  fetch?: AgentWorkerFetch;
}): UnifiedPlanningToolBridge {
  const controlPort = new AgentControlRunToolsPort(args.claimed, args.control);
  const gateway = new ScopedToolGateway([
    ...createRunControlToolDefinitions(controlPort, {}, {
      requiredVisualProfile: args.visualProfile ?? null,
      requiredStepKinds: args.requiredStepKinds,
    }),
    createUnderstandAssetToolDefinition({
      claimed: args.claimed,
      control: args.control,
      workspace: args.workspace,
      config: args.vision,
      signal: args.signal,
      fetch: args.fetch,
    }),
  ]);
  return new UnifiedPlanningToolBridge({ claimed: args.claimed, gateway, revisionIndex: args.revisionIndex, contextTools: args.contextTools, observations: args.observations,
    contextHash: args.clarificationContextHash,
    clarify: args.onClarification ? async (proposal) => {
      await args.onClarification!(proposal);
      await args.control.requestClarification({ runId: args.claimed.run.id, leaseId: args.claimed.lease.leaseId,
        proposal, proposalHash: sha256Hex(canonicalJson(proposal)) });
    } : undefined,
  });
}
