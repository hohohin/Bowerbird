import type { AgentLeaseSignal } from "../cloud-agent/runtime.ts";
import { RunWorkspace } from "../cloud-agent/run-workspace.ts";
import {
  AgentControlClient,
  type AgentWorkerFetch,
  type ClaimedAgentRun,
} from "../control-plane/agent-control-client.ts";
import { AgentControlRunToolsPort, runAssetManifestFromClaim } from "./agent-control-run-tools-port.ts";
import { createRunControlToolDefinitions } from "./run-control-tools.ts";
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
  private readonly allowedTools = new Set(["list_run_assets", "understand_asset", "submit_plan"]);
  private planApprovalRequested = false;

  constructor(args: {
    claimed: ClaimedAgentRun & {
      run: NonNullable<ClaimedAgentRun["run"]>;
      lease: NonNullable<ClaimedAgentRun["lease"]>;
    };
    gateway: ScopedToolGateway;
  }) {
    this.claimed = args.claimed;
    this.gateway = args.gateway;
    const manifest = runAssetManifestFromClaim(args.claimed);
    this.assetIndexes = new Map(manifest.assets.map((asset, index) => [asset.assetId, index]));
  }

  get runId(): string {
    return this.claimed.run.id;
  }

  get awaitingPlanApproval(): boolean {
    return this.planApprovalRequested;
  }

  async dispatch(call: HarnessModelToolCall): Promise<ToolGatewayResult> {
    const result = await this.gateway.dispatch({
      runId: this.claimed.run.id,
      leaseId: this.claimed.lease.leaseId,
      phase: "compose_plan",
      toolName: call.toolName,
      arguments: call.arguments,
      trustedSlot: { logicalSlot: this.logicalSlot(call), revisionIndex: 0 },
      allowedTools: this.allowedTools,
    });
    if (call.toolName === "submit_plan" && result.value && typeof result.value === "object" &&
        (result.value as Record<string, unknown>).terminalReason === "awaiting_plan_approval") {
      this.planApprovalRequested = true;
    }
    return result;
  }

  private logicalSlot(call: HarnessModelToolCall): number {
    if (call.toolName === "list_run_assets") return 0;
    if (call.toolName === "submit_plan") return 10_000;
    if (call.toolName !== "understand_asset") return 0;
    if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) {
      throw new ToolGatewayError("tool_arguments_invalid");
    }
    const record = call.arguments as Record<string, unknown>;
    const assetIndex = typeof record.assetId === "string" ? this.assetIndexes.get(record.assetId) : undefined;
    const focusIndex = UNDERSTAND_ASSET_FOCUS.indexOf(record.focus as UnderstandAssetFocus);
    if (assetIndex === undefined || focusIndex < 0) throw new ToolGatewayError("tool_arguments_invalid");
    // One durable observation slot per Run asset. Repeating the same focus replays;
    // changing focus for an already-observed asset becomes args drift before Ark.
    return 1 + assetIndex;
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
  signal: AgentLeaseSignal;
  fetch?: AgentWorkerFetch;
}): UnifiedPlanningToolBridge {
  const controlPort = new AgentControlRunToolsPort(args.claimed, args.control);
  const gateway = new ScopedToolGateway([
    ...createRunControlToolDefinitions(controlPort, {}, {
      requireStructuredPlan: true,
      requiredVisualProfile: args.visualProfile ?? null,
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
  return new UnifiedPlanningToolBridge({ claimed: args.claimed, gateway });
}
