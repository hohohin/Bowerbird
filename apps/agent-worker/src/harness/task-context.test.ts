import { deepEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";
import { actionContextPages, actionOutputIds, executionProgress } from "./task-context.ts";
import type { TaskAuthorization } from "../contracts/task-authorization.ts";
import { RunContextTools } from "./run-context-tools.ts";
import type { AdaptiveAction } from "./adaptive-tool-gateway.ts";

test("progress counts candidates separately from delivery and survives recovery", () => {
  const authorization: TaskAuthorization = { schemaVersion: 3, title: "场景", summary: "八张", assetIds: [],
    outputCount: 8, modelTurns: 20, capabilities: [{ tool: "generate_image", maxCalls: 12 }] };
  const actions: AdaptiveAction[] = Array.from({ length: 4 }, (_, i) => ({ actionId: `scene-${i}`,
    toolName: "generate_image", slot: i, arguments: {}, argsHash: "a".repeat(64), status: i < 3 ? "completed" : "pending" }));
  const progress = executionProgress(authorization, actions, ["image-1", "image-2", "image-3", "image-3"]);
  equal(progress.availableCandidateCount, 3);
  equal(progress.minimumAdditionalOutputs, 5);
  equal(progress.finalizedOutputCount, 0);
  deepEqual(progress.pendingActionIds, ["scene-3"]);
  deepEqual(progress.capabilities, [{ tool: "generate_image", used: 4, remaining: 8 }]);
  deepEqual(executionProgress(authorization, JSON.parse(JSON.stringify(actions)), progress.candidateArtifactIds), progress);
});

test("dynamic action pages are lossless, claim-bound and available after recovery", () => {
  const actions: AdaptiveAction[] = [];
  const context = new RunContextTools(() => actionContextPages(actions));
  equal(context.catalog().length, 0);
  actions.push({ actionId: "compose-1", toolName: "compose_html", argsHash: "a".repeat(64), slot: 0,
    arguments: { html: "产品\u{1f642}".repeat(4000) }, status: "completed", result: { artifactId: "document-1" } });
  const pages = actionContextPages(actions);
  ok(pages.length > 1);
  const reconstructed = pages.map((page) => (page.read() as { text: string }).text).join("");
  deepEqual(JSON.parse(reconstructed), actions[0]);
  deepEqual(actionContextPages(JSON.parse(JSON.stringify(actions))).map((page) => page.read()), pages.map((page) => page.read()));
  equal((context.dispatch({ toolName: "read_context", arguments: { id: "action:another-run:0" } })!.value as { status: string }).status, "retry_required");
  const first = context.dispatch({ toolName: "read_context", arguments: { id: "action:compose-1:0" } });
  equal((first!.value as { content: { nextId: string } }).content.nextId, "action:compose-1:1");
  ok((first!.value as { content: { text: string } }).content.text.includes('"artifactId":"document-1"'));
  deepEqual(actionOutputIds(actions[0]!), ["document-1"]);
});
