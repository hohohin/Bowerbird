import { deepEqual, equal, rejects } from "node:assert/strict";
import { test } from "node:test";
import type { GenerateApprovedStepRequest } from "../kernel/controlled-image-edit-runner.ts";
import { createApprovedGenerateImageToolDefinition } from "./approved-generate-image-tool.ts";
import { ScopedToolGateway } from "./scoped-tool-gateway.ts";

const approvedPlanHash = "a".repeat(64);

test("approved generate definition keeps every provider argument parent-owned", async () => {
  let observed: GenerateApprovedStepRequest | undefined;
  const gateway = new ScopedToolGateway([createApprovedGenerateImageToolDefinition({
    runId: "run-1",
    conversationId: "conversation-1",
    approvedPlanHash,
    step: {
      id: "generate_hero",
      kind: "generate_image",
      goal: "生成批准的产品主视觉",
      inputAssetIds: ["asset-input"],
      dependsOn: [],
    },
    inputArtifactIds: ["asset-input", "artifact-control"],
    parentArtifactId: "artifact-control",
    outputRole: "final_result",
    executor: {
      async generate(request) {
        observed = request;
        return { artifactId: "artifact-final", mime: "image/png", bytes: 42, sha256: "b".repeat(64) };
      },
    },
  })]);

  const result = await gateway.dispatch({
    runId: "run-1",
    leaseId: "lease-1",
    phase: "execute_approved_plan",
    toolName: "generate_image",
    arguments: {},
    trustedSlot: { logicalSlot: 3, revisionIndex: 0 },
    allowedTools: new Set(["generate_image"]),
    approvedPlanHash,
  });
  equal(result.value && (result.value as { artifactId: string }).artifactId, "artifact-final");
  deepEqual(observed, {
    runId: "run-1",
    conversationId: "conversation-1",
    callId: result.callId,
    stepId: "generate_hero",
    prompt: "生成批准的产品主视觉",
    inputArtifactIds: ["asset-input", "artifact-control"],
    parentArtifactId: "artifact-control",
    outputRole: "final_result",
  });

  await rejects(() => gateway.dispatch({
    runId: "run-1",
    leaseId: "lease-1",
    phase: "execute_approved_plan",
    toolName: "generate_image",
    arguments: { prompt: "模型篡改" },
    trustedSlot: { logicalSlot: 3, revisionIndex: 0 },
    allowedTools: new Set(["generate_image"]),
    approvedPlanHash,
  }), /tool_arguments_invalid/);
});
