import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { FakeModel, scriptedActions } from "../fakes/fake-model.ts";
import { advanceLocalAgent, createLocalAgentCheckpoint } from "./runtime.ts";

test("local runtime pauses for approval and resumes through both provider tools", async () => {
  const model = new FakeModel(scriptedActions([
    { action: "parse_intent", arguments: { intent: { goal: "提亮" } } },
    { action: "assign_reference_roles", arguments: { assignments: [] } },
    { action: "score_dimensions", arguments: { scores: [{ dim: "light", score: 4 }] } },
    { action: "submit_refine_plan", arguments: { changes: "提亮主体，保留构图" } },
    { action: "refine_once", arguments: { prompt: "提亮主体，保留原构图" } },
    { action: "inspect_generated_image", arguments: { artifactCallId: "invented" } },
    { action: "finish_run", arguments: { artifactCallIds: [] } },
  ]));
  let checkpoint = createLocalAgentCheckpoint("local-1", {
    targetAssetId: "asset-1",
    goal: "让主体更明亮",
    caption: "居中构图，主体偏暗",
  });
  checkpoint = await advanceLocalAgent({ checkpoint }, model);
  equal(checkpoint.status, "awaiting_approval");
  ok(checkpoint.approval);
  checkpoint = await advanceLocalAgent({ checkpoint, approval: true }, model);
  equal(checkpoint.pendingTool?.action, "refine_once");
  equal((checkpoint.pendingTool?.arguments as { referenceAssetIds: string[] }).referenceAssetIds[0], "asset-1");
  checkpoint = await advanceLocalAgent({ checkpoint, toolResult: { callId: checkpoint.pendingTool!.callId, result: { generatedAssetId: "asset-2" } } }, model);
  equal(checkpoint.pendingTool?.action, "inspect_generated_image");
  const generatedCallId = checkpoint.records.find((record) => record.action === "refine_once")!.callId;
  equal((checkpoint.pendingTool?.arguments as { artifactCallId: string }).artifactCallId, generatedCallId);
  checkpoint = await advanceLocalAgent({ checkpoint, toolResult: { callId: checkpoint.pendingTool!.callId, result: { summary: "主体已提亮" } } }, model);
  equal(checkpoint.status, "succeeded");
  equal(checkpoint.phase, "done");
  equal(checkpoint.generateAttemptCount, 1);
});
test("local runtime rejects approval without silently generating", async () => {
  const model = new FakeModel(scriptedActions([
    { action: "parse_intent", arguments: { intent: { goal: "g" } } },
    { action: "assign_reference_roles", arguments: { assignments: [] } },
    { action: "score_dimensions", arguments: { scores: [] } },
    { action: "submit_refine_plan", arguments: { changes: "change" } },
  ]));
  let checkpoint = createLocalAgentCheckpoint("local-2", { targetAssetId: "asset-1", goal: "调整" });
  checkpoint = await advanceLocalAgent({ checkpoint }, model);
  checkpoint = await advanceLocalAgent({ checkpoint, approval: false }, model);
  equal(checkpoint.status, "cancelled");
  equal(checkpoint.generateAttemptCount, 0);
});
