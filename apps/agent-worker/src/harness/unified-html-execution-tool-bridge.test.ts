import { equal, rejects } from "node:assert/strict";
import { test } from "node:test";

import type { ToolGatewayDefinition } from "./scoped-tool-gateway.ts";
import { UnifiedHtmlExecutionToolBridge } from "./unified-html-execution-tool-bridge.ts";

const approvedPlanHash = "b".repeat(64);

function definition(name: "compose_html" | "render_html" | "inspect_artifact" | "compose_xiaohongshu" | "finalize_output", value: unknown): ToolGatewayDefinition {
  return {
    name,
    execution: "durable",
    allowedPhases: ["execute_approved_plan"],
    requiresApproval: true,
    approvedPlanHash,
    validate(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid");
      return input;
    },
    dispatcher: { async dispatch() { return value; } },
  };
}

test("approved HTML execution bridge permits only compose, render, optional inspect, then finalize", async () => {
  const bridge = new UnifiedHtmlExecutionToolBridge<{ manifestArtifactId: string }, { summary: string }, { primaryArtifactId: string }>({
    runId: "run-html", leaseId: "lease-html", approvedPlanHash, composeSlot: 2, renderSlot: 3, inspectSlot: 4, finalizeSlot: 5,
    composeDefinition: definition("compose_html", {
      artifactId: "html-artifact", mime: "text/html", bytes: 10, sha256: "c".repeat(64),
    }),
    createRenderDefinition(document) {
      equal(document.artifactId, "html-artifact");
      return definition("render_html", { manifestArtifactId: "render-manifest" });
    },
    createInspectDefinition(render) {
      equal(render.manifestArtifactId, "render-manifest");
      return definition("inspect_artifact", { summary: "layout checked" });
    },
    createFinalizeDefinition(render, inspection) {
      equal(render.manifestArtifactId, "render-manifest");
      equal(inspection?.summary, "layout checked");
      return definition("finalize_output", { primaryArtifactId: "full-page" });
    },
  });
  await rejects(() => bridge.dispatch({ toolName: "render_html", arguments: {} }), /tool_sequence_invalid/);
  await rejects(() => bridge.dispatch({ toolName: "generate_image", arguments: {} }), /tool_not_registered/);
  const composed = await bridge.dispatch({ toolName: "compose_html", arguments: { html: "fixture" } });
  equal(composed.callId.length, 64);
  equal(bridge.document?.artifactId, "html-artifact");
  const rendered = await bridge.dispatch({ toolName: "render_html", arguments: {} });
  equal(rendered.callId.length, 64);
  equal((bridge.renderResult as { manifestArtifactId: string }).manifestArtifactId, "render-manifest");
  await rejects(() => bridge.dispatch({ toolName: "finalize_output", arguments: {} }), /tool_sequence_invalid/);
  const inspected = await bridge.dispatch({ toolName: "inspect_artifact", arguments: {} });
  equal(inspected.callId.length, 64);
  equal(bridge.inspectionResult?.summary, "layout checked");
  const finalized = await bridge.dispatch({ toolName: "finalize_output", arguments: {} });
  equal(finalized.callId.length, 64);
  equal(bridge.finalResult?.primaryArtifactId, "full-page");
  equal(bridge.completedCalls.length, 4);
  await rejects(() => bridge.dispatch({ toolName: "render_html", arguments: {} }), /tool_sequence_invalid/);
  await rejects(() => bridge.dispatch({ toolName: "compose_html", arguments: { html: "late" } }), /tool_sequence_invalid/);
  await rejects(() => bridge.dispatch({ toolName: "inspect_artifact", arguments: {} }), /tool_sequence_invalid/);
});

test("the same approved execution bridge can append a Xiaohongshu package before parent-owned finalize", async () => {
  const bridge = new UnifiedHtmlExecutionToolBridge<
    { manifestArtifactId: string },
    unknown,
    { primaryArtifactId: string },
    { artifactId: string }
  >({
    runId: "run-content", leaseId: "lease-content", approvedPlanHash,
    composeSlot: 0, renderSlot: 1, socialSlot: 2, finalizeSlot: 3,
    composeDefinition: definition("compose_html", {
      artifactId: "html-artifact", mime: "text/html", bytes: 10, sha256: "c".repeat(64),
    }),
    createRenderDefinition: () => definition("render_html", { manifestArtifactId: "render-manifest" }),
    createSocialDefinition: () => definition("compose_xiaohongshu", { artifactId: "xhs-package" }),
    createFinalizeDefinition(_render, _inspection, social) {
      equal(social?.artifactId, "xhs-package");
      return definition("finalize_output", { primaryArtifactId: social?.artifactId });
    },
  });
  await bridge.dispatch({ toolName: "compose_html", arguments: {} });
  await bridge.dispatch({ toolName: "render_html", arguments: {} });
  await rejects(() => bridge.dispatch({ toolName: "finalize_output", arguments: {} }), /tool_sequence_invalid/);
  await bridge.dispatch({ toolName: "compose_xiaohongshu", arguments: { schemaVersion: 1 } });
  await bridge.dispatch({ toolName: "finalize_output", arguments: {} });
  equal(bridge.socialResult?.artifactId, "xhs-package");
  equal(bridge.finalResult?.primaryArtifactId, "xhs-package");
  equal(bridge.completedCalls.length, 4);
});
