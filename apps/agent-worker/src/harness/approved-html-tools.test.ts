import { deepEqual, equal, rejects } from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import type { PreparedToolCall, RegisteredAgentArtifact } from "../control-plane/agent-control-client.ts";
import { ScopedToolGateway } from "./scoped-tool-gateway.ts";
import {
  createApprovedComposeHtmlToolDefinition,
  createApprovedRenderHtmlToolDefinition,
  type ApprovedHtmlControl,
} from "./approved-html-tools.ts";

const approvedPlanHash = "a".repeat(64);

function control(): ApprovedHtmlControl & { uploads: number } {
  const calls = new Map<string, PreparedToolCall>();
  const argsHashes = new Map<string, string>();
  const artifacts = new Map<string, RegisteredAgentArtifact>();
  return {
    uploads: 0,
    async prepareTool(args) {
      const existing = calls.get(args.callId);
      if (existing) {
        if (argsHashes.get(args.callId) !== args.argsHash) throw new Error("tool_args_hash_mismatch");
        return existing;
      }
      const created = { callId: args.callId, status: "prepared" as const, reused: false };
      argsHashes.set(args.callId, args.argsHash);
      calls.set(args.callId, created);
      return created;
    },
    async markToolSubmitted(args) {
      const current = calls.get(args.callId)!;
      const next = { ...current, status: "submitted" as const };
      calls.set(args.callId, next);
      return next;
    },
    async completeTool(args) {
      const current = calls.get(args.callId)!;
      const next = { ...current, status: args.status, resultObjectKey: args.resultObjectKey, resultHash: args.resultHash };
      calls.set(args.callId, next);
      return next;
    },
    async uploadArtifact(args) {
      this.uploads++;
      const artifact = {
        artifactId: "html-artifact", conversationId: "conversation-html", runId: args.runId,
        role: args.role, stepId: args.stepId, mime: args.mime, bytes: args.bytes.byteLength,
        sha256: args.sha256, userVisible: false, objectKey: `runs/${args.runId}/${args.sourceCallId}.html`,
      } as RegisteredAgentArtifact;
      artifacts.set(args.sourceCallId, artifact);
      return artifact;
    },
    async getArtifactByCall(_runId, _leaseId, callId) {
      const artifact = artifacts.get(callId);
      if (!artifact) throw new Error("artifact_missing");
      return artifact;
    },
  };
}

test("approved HTML tools bind resources and renderer settings to the approved parent plan", async () => {
  const durable = control();
  const remembered: string[] = [];
  const compose = createApprovedComposeHtmlToolDefinition({
    runId: "run-html", leaseId: "lease-html", approvedPlanHash,
    step: { id: "compose", kind: "compose_html", goal: "排版", inputAssetIds: ["asset-1"], dependsOn: [] },
    resourceArtifactIds: ["asset-1"], control: durable,
    workspace: {
      rememberHtmlDocument(artifact, html) { remembered.push(`${artifact.artifactId}:${html.length}`); },
      rememberRemoteArtifact(artifact) { remembered.push(`${artifact.artifactId}:remote`); },
    },
  });
  const composeGateway = new ScopedToolGateway([compose]);
  const html = "<main><img src=\"asset:reference-1\"><h1>产品</h1></main>";
  const composed = await composeGateway.dispatch({
    runId: "run-html", leaseId: "lease-html", phase: "execute_approved_plan", toolName: "compose_html",
    arguments: { schemaVersion: 1, html, resourceArtifactIds: ["asset-1"] },
    trustedSlot: { logicalSlot: 0, revisionIndex: 0 }, allowedTools: new Set(["compose_html"]), approvedPlanHash,
  });
  equal((composed.value as { artifactId: string }).artifactId, "html-artifact");
  equal(durable.uploads, 1);
  deepEqual(remembered, [`html-artifact:${html.length}`]);

  let renderRequest: unknown;
  const fixedInput = {
    schemaVersion: 1 as const, htmlArtifactId: "html-artifact", resourceArtifactIds: ["asset-1"],
    viewport: { widthCssPx: 900, heightCssPx: 700, deviceScaleFactor: 1 as const },
    capture: { mode: "full_page_and_slices" as const, sliceHeightCssPx: 900, overlapCssPx: 0 },
    background: "opaque" as const,
  };
  const renderGateway = new ScopedToolGateway([createApprovedRenderHtmlToolDefinition({
    runId: "run-html", leaseId: "lease-html", approvedPlanHash,
    step: { id: "render", kind: "render_html", goal: "渲染", inputAssetIds: [], dependsOn: ["compose"] },
    input: fixedInput,
    executor: { async render(request) { renderRequest = request; return { manifestArtifactId: "manifest" }; } },
  })]);
  const rendered = await renderGateway.dispatch({
    runId: "run-html", leaseId: "lease-html", phase: "execute_approved_plan", toolName: "render_html",
    arguments: {}, trustedSlot: { logicalSlot: 1, revisionIndex: 0 },
    allowedTools: new Set(["render_html"]), approvedPlanHash,
  });
  equal((rendered.value as { manifestArtifactId: string }).manifestArtifactId, "manifest");
  deepEqual((renderRequest as { input: unknown }).input, fixedInput);

  await rejects(() => composeGateway.dispatch({
    runId: "run-html", leaseId: "lease-html", phase: "execute_approved_plan", toolName: "compose_html",
    arguments: { schemaVersion: 1, html, resourceArtifactIds: ["asset-foreign"] },
    trustedSlot: { logicalSlot: 0, revisionIndex: 0 }, allowedTools: new Set(["compose_html"]), approvedPlanHash,
  }), /tool_arguments_invalid/);
  await rejects(() => renderGateway.dispatch({
    runId: "run-html", leaseId: "lease-html", phase: "execute_approved_plan", toolName: "render_html",
    arguments: { viewport: "model-controlled" }, trustedSlot: { logicalSlot: 1, revisionIndex: 0 },
    allowedTools: new Set(["render_html"]), approvedPlanHash,
  }), /tool_arguments_invalid/);
  equal(createHash("sha256").update(new TextEncoder().encode(html)).digest("hex").length, 64);
});
