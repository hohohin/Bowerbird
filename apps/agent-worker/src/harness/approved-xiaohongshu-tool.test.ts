import { deepEqual, equal, rejects } from "node:assert/strict";
import { test } from "node:test";

import type { PreparedToolCall, RegisteredAgentArtifact } from "../control-plane/agent-control-client.ts";
import { ScopedToolGateway } from "./scoped-tool-gateway.ts";
import { createApprovedComposeXiaohongshuToolDefinition } from "./approved-xiaohongshu-tool.ts";

test("compose_xiaohongshu durably binds parent-owned image order and replays without another artifact", async () => {
  const calls = new Map<string, PreparedToolCall>();
  const artifacts = new Map<string, RegisteredAgentArtifact>();
  const uploaded: string[] = [];
  let packageValue: Record<string, unknown> | undefined;
  const control = {
    async prepareTool(args: { callId: string }) {
      return calls.get(args.callId) ?? { callId: args.callId, status: "prepared", reused: false };
    },
    async markToolSubmitted(args: { callId: string }) {
      const value = { callId: args.callId, status: "submitted" as const, reused: false };
      calls.set(args.callId, value);
      return value;
    },
    async completeTool(args: { callId: string; resultObjectKey?: string; resultHash?: string }) {
      const value = {
        callId: args.callId,
        status: "succeeded" as const,
        reused: false,
        resultObjectKey: args.resultObjectKey,
        resultHash: args.resultHash,
      };
      calls.set(args.callId, value);
      return value;
    },
    async uploadArtifact(args: { sourceCallId: string; runId: string; bytes: Uint8Array; sha256: string; role: string; mime: string }) {
      uploaded.push(args.sourceCallId);
      packageValue = JSON.parse(new TextDecoder().decode(args.bytes));
      const artifact = {
        artifactId: "xhs-package", conversationId: "conversation-xhs", runId: args.runId,
        role: args.role, stepId: "compose_xhs", parentArtifactId: "slice-0001", mime: args.mime,
        bytes: args.bytes.byteLength, sha256: args.sha256, userVisible: true,
        objectKey: `runs/${args.runId}/${args.sourceCallId}.json`,
      } as RegisteredAgentArtifact;
      artifacts.set(args.sourceCallId, artifact);
      return artifact;
    },
    async getArtifactByCall(_runId: string, _leaseId: string, callId: string) {
      const artifact = artifacts.get(callId);
      if (!artifact) throw new Error("missing");
      return artifact;
    },
  };
  const gateway = new ScopedToolGateway([createApprovedComposeXiaohongshuToolDefinition({
    runId: "run-xhs", leaseId: "lease-xhs", approvedPlanHash: "a".repeat(64),
    step: { id: "compose_xhs", kind: "compose_xiaohongshu", goal: "派生图文稿", inputAssetIds: [], dependsOn: ["render"] },
    imageArtifactIds: ["slice-0001", "slice-0002"], parentArtifactId: "slice-0001", control,
  })]);
  const request = {
    runId: "run-xhs", leaseId: "lease-xhs", phase: "execute_approved_plan", toolName: "compose_xiaohongshu",
    arguments: { schemaVersion: 1, title: "产品重点速览", body: "从核心信息到细节，按图浏览。", tags: ["产品设计"], imageNotes: ["封面", "细节"] },
    trustedSlot: { logicalSlot: 2, revisionIndex: 0 }, allowedTools: new Set(["compose_xiaohongshu"]), approvedPlanHash: "a".repeat(64),
  };
  const first = await gateway.dispatch(request);
  const second = await gateway.dispatch(request);
  equal(first.callId, second.callId);
  equal(uploaded.length, 1);
  equal((first.value as { artifactId: string }).artifactId, "xhs-package");
  deepEqual(packageValue?.images, [
    { position: 1, artifactId: "slice-0001", note: "封面" },
    { position: 2, artifactId: "slice-0002", note: "细节" },
  ]);
  await rejects(() => gateway.dispatch({
    ...request,
    arguments: { ...request.arguments, imageNotes: ["少了一张"] },
  }), /tool_arguments_invalid/);
});
