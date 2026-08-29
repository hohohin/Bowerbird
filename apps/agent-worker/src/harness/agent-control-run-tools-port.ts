import type { ClaimedAgentRun } from "../control-plane/agent-control-client.ts";
import { canonicalJson, sha256Hex } from "../kernel/tool-ledger.ts";
import type { PlanApprovalRequest, RunAssetManifest, RunControlToolsPort } from "./run-control-tools.ts";

export interface UnifiedPlanApprovalClient {
  requestUnifiedPlanApproval(args: {
    runId: string;
    leaseId: string;
    callId: string;
    argsHash: string;
    proposalHash: string;
    proposal: Record<string, unknown>;
  }): Promise<{
    status: "awaiting_approval";
    proposalHash: string;
    estimatedAdditionalCredits: number;
    reused: boolean;
  }>;
}

function copyManifest(manifest: RunAssetManifest): RunAssetManifest {
  return {
    schemaVersion: 1,
    runId: manifest.runId,
    manifestHash: manifest.manifestHash,
    assets: manifest.assets.map((asset) => ({ ...asset })),
  };
}

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function runAssetManifestFromClaim(claimed: ClaimedAgentRun): RunAssetManifest {
  if (!claimed.run?.id) throw new Error("run_manifest_claim_missing");
  const assets = (claimed.artifactUrls ?? [])
    .filter((artifact) => IMAGE_MIMES.has(artifact.mime))
    .map((artifact): RunAssetManifest["assets"][number] => {
      if (!Number.isSafeInteger(artifact.width) || !Number.isSafeInteger(artifact.height) ||
          Number(artifact.width) < 1 || Number(artifact.width) > 16_384 ||
          Number(artifact.height) < 1 || Number(artifact.height) > 16_384) {
        throw new Error("run_asset_dimensions_unavailable");
      }
      return {
        assetId: artifact.artifactId,
        role: artifact.role === "input"
          ? "input"
          : artifact.role === "control_reference" ? "reference" : "generated",
        mime: artifact.mime as RunAssetManifest["assets"][number]["mime"],
        width: Number(artifact.width),
        height: Number(artifact.height),
      };
    })
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
  return {
    schemaVersion: 1,
    runId: claimed.run.id,
    manifestHash: sha256Hex(canonicalJson({ schemaVersion: 1, assets })),
    assets,
  };
}

/**
 * U2 transport：资产 manifest 直接来自已校验的 claim，计划提交复用现有
 * agent-worker approval_request。Edge 成功响应时已把 Run 停到 awaiting_approval 并释放租约。
 */
export class AgentControlRunToolsPort implements RunControlToolsPort {
  private readonly manifest: RunAssetManifest;
  private readonly control: UnifiedPlanApprovalClient;

  constructor(claimed: ClaimedAgentRun, control: UnifiedPlanApprovalClient) {
    this.manifest = runAssetManifestFromClaim(claimed);
    this.control = control;
  }

  async readRunAssets(identity: { runId: string; leaseId: string }): Promise<RunAssetManifest> {
    if (identity.runId !== this.manifest.runId || !identity.leaseId) {
      throw new Error("run_manifest_identity_mismatch");
    }
    return copyManifest(this.manifest);
  }

  async requestPlanApproval(request: PlanApprovalRequest) {
    if (request.runId !== this.manifest.runId) throw new Error("plan_run_identity_mismatch");
    const result = await this.control.requestUnifiedPlanApproval({
      runId: request.runId,
      leaseId: request.leaseId,
      callId: request.callId,
      argsHash: request.argsHash,
      proposalHash: request.proposalHash,
      proposal: request.proposal as unknown as Record<string, unknown>,
    });
    if (result.status !== "awaiting_approval" || result.proposalHash !== request.proposalHash) {
      throw new Error("plan_approval_transport_mismatch");
    }
    return {
      reused: result.reused,
      estimatedAdditionalCredits: result.estimatedAdditionalCredits,
    };
  }
}
