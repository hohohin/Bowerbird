import type {
  ApprovedStepExecutor,
  GeneratedApprovedStep,
} from "../kernel/controlled-image-edit-runner.ts";
import type { DurableToolIdentity } from "../kernel/durable-tool-dispatcher.ts";
import type { HarnessPlanStep } from "./run-control-tools.ts";
import type { ToolGatewayDefinition } from "./scoped-tool-gateway.ts";

function validateEmptyArguments(value: unknown): Record<string, never> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 0) {
    throw new Error("approved_generate_arguments_invalid");
  }
  return {};
}

function validateGenerated(value: GeneratedApprovedStep): GeneratedApprovedStep {
  if (!value.artifactId || !value.mime.startsWith("image/") ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 1 ||
      !/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw new Error("unified_agent_generated_artifact_invalid");
  }
  return value;
}

/**
 * Instantiates one generate_image tool from trusted approved-plan data.
 * The caller/model supplies only `{}`; prompt, assets, role and identity remain parent-owned.
 */
export function createApprovedGenerateImageToolDefinition(args: {
  runId: string;
  conversationId: string;
  approvedPlanHash: string;
  step: HarnessPlanStep;
  inputArtifactIds: readonly string[];
  parentArtifactId?: string;
  outputRole: "stage_result" | "final_result";
  executor: ApprovedStepExecutor;
}): ToolGatewayDefinition {
  if (args.step.kind !== "generate_image" || !/^[0-9a-f]{64}$/.test(args.approvedPlanHash)) {
    throw new Error("unified_agent_generate_definition_invalid");
  }
  const inputArtifactIds = [...args.inputArtifactIds];
  return {
    name: "generate_image",
    execution: "durable",
    allowedPhases: ["execute_approved_plan"],
    requiresApproval: true,
    approvedPlanHash: args.approvedPlanHash,
    validate: validateEmptyArguments,
    dispatcher: {
      async dispatch(identity: DurableToolIdentity) {
        if (identity.runId !== args.runId || identity.toolName !== "generate_image" ||
            identity.phase !== "execute_approved_plan") {
          throw new Error("unified_agent_generate_identity_invalid");
        }
        return validateGenerated(await args.executor.generate({
          runId: args.runId,
          conversationId: args.conversationId,
          callId: identity.callId,
          stepId: args.step.id,
          prompt: args.step.goal,
          inputArtifactIds,
          parentArtifactId: args.parentArtifactId,
          outputRole: args.outputRole,
        }));
      },
    },
  };
}
