import { deepEqual, equal, rejects, throws } from "node:assert/strict";
import { test } from "node:test";
import type { ModelTurnRequest } from "../contracts/model.ts";
import { ControlledModelActionBridge } from "./controlled-model-action-bridge.ts";

function request(names = ["record_intent_analysis"]): ModelTurnRequest {
  return {
    runId: "run-controlled",
    phase: "analyze_intent_text_only",
    systemPolicy: "policy",
    skillInstructions: "skill",
    context: [],
    responseSchemaVersion: 1,
    allowedActions: names.map((name) => ({
      name,
      kind: "kernel" as const,
      description: name,
      argumentSchema: { type: "object" },
    })),
  };
}

test("controlled model action bridge captures one currently allowed suggestion", async () => {
  const bridge = new ControlledModelActionBridge(request());
  const result = await bridge.dispatch({
    toolName: "record_intent_analysis",
    arguments: { analysis: { intentSummary: "x" } },
  });
  equal(result.callId.length, 64);
  deepEqual(result.value, { schemaVersion: 1, accepted: true, terminalReason: "model_action_captured" });
  deepEqual(bridge.actionResult, {
    kind: "action",
    action: "record_intent_analysis",
    arguments: { analysis: { intentSummary: "x" } },
    providerUsage: {},
  });
  await rejects(() => bridge.dispatch({
    toolName: "record_intent_analysis",
    arguments: {},
  }), /tool_sequence_invalid/);
});

test("controlled model action bridge rejects widened tools, actions and envelopes", async () => {
  const bridge = new ControlledModelActionBridge(request());
  await rejects(() => bridge.dispatch({ toolName: "generate_image", arguments: {} }), /tool_not_allowed/);
  await rejects(() => bridge.dispatch({
    toolName: "submit_plan_for_approval",
    arguments: {},
  }), /tool_not_allowed/);
  await rejects(() => bridge.dispatch({
    toolName: "record_intent_analysis",
    arguments: [],
  }), /tool_arguments_invalid/);
  equal(bridge.actionResult, undefined);
});

test("controlled model action bridge accepts only the frozen controlled action surface", () => {
  throws(() => new ControlledModelActionBridge(request([])), /controlled_dsh_model_request_invalid/);
  throws(() => new ControlledModelActionBridge(request(["generate_image"])), /controlled_dsh_model_request_invalid/);
  throws(() => new ControlledModelActionBridge(request(["record_intent_analysis", "record_intent_analysis"])),
    /controlled_dsh_model_request_invalid/);
});
