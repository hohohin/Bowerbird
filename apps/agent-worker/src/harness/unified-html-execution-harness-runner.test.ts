import { equal } from "node:assert/strict";
import { test } from "node:test";

import type { HarnessAdapter } from "./contracts.ts";
import { UnifiedHtmlExecutionHarnessRunner } from "./unified-html-execution-harness-runner.ts";
import { UnifiedHtmlExecutionToolBridge } from "./unified-html-execution-tool-bridge.ts";

test("approved HTML runner scopes a fresh session to one short-lived execution bridge", async () => {
  const approvedPlanHash = "d".repeat(64);
  const bridge = new UnifiedHtmlExecutionToolBridge({
    runId: "run-html", leaseId: "lease-html", approvedPlanHash, composeSlot: 0, renderSlot: 1,
    finalizeSlot: 2,
    composeDefinition: {
      name: "compose_html", execution: "durable", allowedPhases: ["execute_approved_plan"],
      validate: (value) => value, dispatcher: { async dispatch() { return {}; } },
    },
    createRenderDefinition() {
      return { name: "render_html", execution: "durable", allowedPhases: ["execute_approved_plan"], validate: (value) => value, dispatcher: { async dispatch() { return {}; } } };
    },
    createFinalizeDefinition() {
      return { name: "finalize_output", execution: "control", allowedPhases: ["execute_approved_plan"], validate: (value) => value, dispatcher: { async dispatch() { return {}; } } };
    },
  });
  let closed = 0;
  const adapter: HarnessAdapter = {
    id: "fixture",
    async open(seed) {
      equal(seed.phase, "execute_approved_plan");
      return {
        sessionId: "session", runId: seed.runId,
        async turn(prompt) { equal(prompt[0]?.type, "text"); return { stopReason: "end_turn", committedContent: [] }; },
        async cancel() {},
        async close() { closed++; },
      };
    },
  };
  const runner = new UnifiedHtmlExecutionHarnessRunner(bridge, (child, provider) => {
    equal(Object.keys(child).sort().join(","), "BOWERBIRD_TOOL_BRIDGE_CAPABILITY,BOWERBIRD_TOOL_BRIDGE_ENDPOINT");
    equal(provider.DEEPSEEK_API_KEY, "e".repeat(64));
    return adapter;
  });
  const result = await runner.run({
    schemaVersion: 1, runId: "run-html", checkpointVersion: 1, phase: "execute_approved_plan",
    approvedPlanHash, compactedFacts: [], completedToolResults: [],
  }, [{ type: "text", text: "execute approved html" }], {
    DEEPSEEK_API_KEY: "e".repeat(64), DEEPSEEK_BASE_URL: "http://127.0.0.1:1234",
  });
  equal(result.stopReason, "end_turn");
  equal(closed, 1);
});
