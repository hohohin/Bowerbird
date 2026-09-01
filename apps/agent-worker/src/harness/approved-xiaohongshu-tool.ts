import { createHash } from "node:crypto";

import {
  AgentControlError,
  type PreparedToolCall,
  type RegisteredAgentArtifact,
} from "../control-plane/agent-control-client.ts";
import {
  DurableToolDispatcher,
  type DurableToolAdapter,
  type DurableToolControl,
  type DurableToolIdentity,
} from "../kernel/durable-tool-dispatcher.ts";
import {
  compileXiaohongshuPackageV1,
  validateXiaohongshuDraftV1,
  type XiaohongshuDraftV1,
  type XiaohongshuPackageV1,
} from "../skills/bowerbird-unified-agent/xiaohongshu-output.ts";
import type { HarnessPlanStep } from "./run-control-tools.ts";
import type { ToolGatewayDefinition } from "./scoped-tool-gateway.ts";

export type ApprovedXiaohongshuArtifact = {
  artifactId: string;
  mime: "application/json";
  bytes: number;
  sha256: string;
};

export interface ApprovedXiaohongshuControl extends DurableToolControl {
  uploadArtifact(args: {
    runId: string;
    leaseId: string;
    sourceCallId: string;
    role: string;
    stepId: string;
    parentArtifactId?: string;
    mime: string;
    bytes: Uint8Array;
    sha256: string;
    userVisible?: boolean;
  }): Promise<RegisteredAgentArtifact>;
  getArtifactByCall(runId: string, leaseId: string, callId: string): Promise<RegisteredAgentArtifact>;
}

type ComposeResult = {
  packageValue?: XiaohongshuPackageV1;
  packageJson?: string;
  artifact?: RegisteredAgentArtifact;
};

class ApprovedComposeXiaohongshuAdapter implements DurableToolAdapter<XiaohongshuDraftV1, ComposeResult> {
  private readonly args: {
    runId: string;
    leaseId: string;
    approvedPlanHash: string;
    stepId: string;
    imageArtifactIds: readonly string[];
    parentArtifactId?: string;
    visualProfile?: { profileId: string; version: number; hash: string };
    control: ApprovedXiaohongshuControl;
  };

  constructor(args: ApprovedComposeXiaohongshuAdapter["args"]) {
    this.args = args;
  }

  async execute(_callId: string, draft: XiaohongshuDraftV1): Promise<ComposeResult> {
    const compiled = compileXiaohongshuPackageV1({
      draft,
      imageArtifactIds: this.args.imageArtifactIds,
      approvedPlanHash: this.args.approvedPlanHash,
      ...(this.args.visualProfile ? { visualProfile: this.args.visualProfile } : {}),
    });
    return { packageValue: compiled.value, packageJson: compiled.json };
  }

  async reconcile(callId: string): Promise<ComposeResult | null> {
    try {
      return { artifact: await this.args.control.getArtifactByCall(this.args.runId, this.args.leaseId, callId) };
    } catch (error) {
      if (error instanceof AgentControlError && error.status === 409) return null;
      throw error;
    }
  }

  async persist(callId: string, result: ComposeResult) {
    if (result.artifact) {
      return { value: result, resultObjectKey: result.artifact.objectKey, resultHash: result.artifact.sha256 };
    }
    if (!result.packageJson || !result.packageValue) throw new Error("xiaohongshu_package_missing");
    const bytes = new TextEncoder().encode(result.packageJson);
    const artifact = await this.args.control.uploadArtifact({
      runId: this.args.runId,
      leaseId: this.args.leaseId,
      sourceCallId: callId,
      role: "final_result",
      stepId: this.args.stepId,
      ...(this.args.parentArtifactId ? { parentArtifactId: this.args.parentArtifactId } : {}),
      mime: "application/json",
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      userVisible: true,
    });
    return {
      value: { ...result, artifact },
      resultObjectKey: artifact.objectKey,
      resultHash: artifact.sha256,
    };
  }

  async restore(record: PreparedToolCall): Promise<ComposeResult> {
    const artifact = await this.args.control.getArtifactByCall(this.args.runId, this.args.leaseId, record.callId);
    if (record.resultHash && artifact.sha256 !== record.resultHash) {
      throw new Error("xiaohongshu_restore_hash_mismatch");
    }
    return { artifact };
  }
}

function xiaohongshuArtifact(result: ComposeResult): ApprovedXiaohongshuArtifact {
  const artifact = result.artifact;
  if (!artifact || artifact.role !== "final_result" || artifact.mime !== "application/json" ||
      !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
    throw new Error("xiaohongshu_artifact_invalid");
  }
  return {
    artifactId: artifact.artifactId,
    mime: "application/json",
    bytes: artifact.bytes,
    sha256: artifact.sha256,
  };
}

/** The model authors bounded copy; the parent binds image identity/order and commits one durable final package. */
export function createApprovedComposeXiaohongshuToolDefinition(args: {
  runId: string;
  leaseId: string;
  approvedPlanHash: string;
  step: HarnessPlanStep;
  imageArtifactIds: readonly string[];
  parentArtifactId?: string;
  visualProfile?: { profileId: string; version: number; hash: string };
  control: ApprovedXiaohongshuControl;
}): ToolGatewayDefinition {
  if (args.step.kind !== "compose_xiaohongshu" || !/^[0-9a-f]{64}$/.test(args.approvedPlanHash)) {
    throw new Error("xiaohongshu_definition_invalid");
  }
  const imageArtifactIds = [...args.imageArtifactIds];
  const dispatcher = new DurableToolDispatcher(args.control, new ApprovedComposeXiaohongshuAdapter({
    runId: args.runId,
    leaseId: args.leaseId,
    approvedPlanHash: args.approvedPlanHash,
    stepId: args.step.id,
    imageArtifactIds,
    ...(args.parentArtifactId ? { parentArtifactId: args.parentArtifactId } : {}),
    ...(args.visualProfile ? { visualProfile: { ...args.visualProfile } } : {}),
    control: args.control,
  }));
  return {
    name: "compose_xiaohongshu",
    execution: "durable",
    allowedPhases: ["execute_approved_plan"],
    requiresApproval: true,
    approvedPlanHash: args.approvedPlanHash,
    validate: (value) => validateXiaohongshuDraftV1(value, imageArtifactIds.length),
    dispatcher: {
      async dispatch(identity: DurableToolIdentity, value: unknown) {
        if (identity.runId !== args.runId || identity.leaseId !== args.leaseId || identity.toolName !== "compose_xiaohongshu") {
          throw new Error("xiaohongshu_identity_invalid");
        }
        return xiaohongshuArtifact(await dispatcher.dispatch(identity, value as XiaohongshuDraftV1));
      },
    },
  };
}
