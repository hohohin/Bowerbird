import type { DurableToolIdentity } from "../kernel/durable-tool-dispatcher.ts";
import type { HarnessPlanStep } from "./run-control-tools.ts";
import type { ToolGatewayDefinition } from "./scoped-tool-gateway.ts";

const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type ApprovedFinalizedOutput = {
  schemaVersion: 1;
  primaryArtifactId: string;
  visibleArtifactIds: string[];
};

function validateOutput(value: ApprovedFinalizedOutput): ApprovedFinalizedOutput {
  if (value.schemaVersion !== 1 || !ARTIFACT_ID.test(value.primaryArtifactId) ||
      !Array.isArray(value.visibleArtifactIds) || value.visibleArtifactIds.length < 1 || value.visibleArtifactIds.length > 33 ||
      new Set(value.visibleArtifactIds).size !== value.visibleArtifactIds.length ||
      value.visibleArtifactIds.some((id) => !ARTIFACT_ID.test(id)) || !value.visibleArtifactIds.includes(value.primaryArtifactId)) {
    throw new Error("approved_finalize_output_invalid");
  }
  return { schemaVersion: 1, primaryArtifactId: value.primaryArtifactId, visibleArtifactIds: [...value.visibleArtifactIds] };
}

function emptyArguments(value: unknown): Record<string, never> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 0) {
    throw new Error("approved_finalize_output_arguments_invalid");
  }
  return {};
}

/** Model can only signal completion; the parent owns the exact artifact set and primary identity. */
export function createApprovedFinalizeOutputToolDefinition(args: {
  runId: string;
  leaseId: string;
  approvedPlanHash: string;
  step: HarnessPlanStep;
  output: ApprovedFinalizedOutput;
}): ToolGatewayDefinition {
  if (args.step.kind !== "finalize_output" || !/^[0-9a-f]{64}$/.test(args.approvedPlanHash)) {
    throw new Error("approved_finalize_output_definition_invalid");
  }
  const output = validateOutput(args.output);
  return {
    name: "finalize_output",
    execution: "control",
    allowedPhases: ["execute_approved_plan"],
    requiresApproval: true,
    approvedPlanHash: args.approvedPlanHash,
    validate: emptyArguments,
    dispatcher: {
      async dispatch(identity: DurableToolIdentity) {
        if (identity.runId !== args.runId || identity.leaseId !== args.leaseId || identity.toolName !== "finalize_output") {
          throw new Error("approved_finalize_output_identity_invalid");
        }
        return output;
      },
    },
  };
}
