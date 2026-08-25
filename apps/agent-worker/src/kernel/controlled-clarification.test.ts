import { test } from "node:test";
import { deepEqual, equal, throws } from "node:assert/strict";
import type { ClarificationProposal } from "../contracts/clarification.ts";
import { loadControlledImageEditSkill } from "../skills/bowerbird-controlled-image-edit/loader.ts";
import {
  applyControlledIntentPatch,
  controlledClarificationContextHash,
  createControlledRunnerCheckpoint,
  proposeControlledClarification,
} from "./controlled-image-edit-runner.ts";

function checkpoint() {
  const skill = loadControlledImageEditSkill();
  return createControlledRunnerCheckpoint({
    runId: "run-clarification",
    conversationId: "conversation-clarification",
    skillVersion: skill.version,
    skillHash: skill.instructionHash,
    input: {
      schemaVersion: 1,
      intentPrompt: "把图1和图2组合成一张图",
      references: [
        { referenceId: "ref-1", token: "@图1", ordinal: 1, mime: "image/png", bytes: 10, sha256: "1".repeat(64) },
        { referenceId: "ref-2", token: "@图2", ordinal: 2, mime: "image/png", bytes: 20, sha256: "2".repeat(64) },
      ],
    },
  });
}

function proposal(contextHash: string, key = "choose.base"): ClarificationProposal {
  return {
    questionKey: key,
    contextHash,
    question: "哪张图是最终主体？",
    recommendedAnswer: "图1",
    options: ["图1", "图2"],
    optionPatches: [
      { answer: "图1", patches: [{ field: "finalSubjectReferenceId", op: "set", value: "ref-1" }] },
      { answer: "图2", patches: [{ field: "finalSubjectReferenceId", op: "set", value: "ref-2" }] },
    ],
    affectedIntentFields: ["finalSubjectReferenceId"],
    rationale: "主体选择会改变底图和全部后续步骤。",
  };
}

test("controlled clarification parks without advancing the semantic phase", () => {
  const initial = checkpoint();
  const parked = proposeControlledClarification(initial, proposal(controlledClarificationContextHash(initial)));
  equal(parked.phase, "analyze_intent_text_only");
  equal(parked.status, "awaiting_clarification");
  equal(parked.clarificationHistory?.length, 1);
  equal(parked.pendingClarification?.questionKey, "choose.base");
});

test("same clarification replay is idempotent and changed key content is denied", () => {
  const initial = checkpoint();
  const current = proposal(controlledClarificationContextHash(initial));
  const parked = proposeControlledClarification(initial, current);
  const replaySource = { ...parked, status: "running" as const, pendingClarification: undefined };
  const replay = proposeControlledClarification(replaySource, current);
  equal(replay.clarificationHistory?.length, 1);
  throws(() => proposeControlledClarification(replaySource, { ...current, question: "到底选择哪张？" }),
    /clarification_question_key_conflict/);
});

test("answer applies IntentPatch and invalidates every stale plan/approval binding", () => {
  const initial = checkpoint();
  const current = proposal(controlledClarificationContextHash(initial));
  const parked = proposeControlledClarification(initial, current);
  const withStaleBindings = {
    ...parked,
    proposedPlanHash: "a".repeat(64),
    approvedPlanHash: "a".repeat(64),
    plannedToolCount: 4,
    stepCursor: 2,
  };
  const resumed = applyControlledIntentPatch(withStaleBindings, {
    sourceQuestionKey: current.questionKey,
    contextHash: current.contextHash,
    patches: [{ field: "finalSubjectReferenceId", op: "set", value: "ref-2" }],
  });
  equal(resumed.status, "running");
  equal(resumed.phase, "analyze_intent_text_only");
  deepEqual(resumed.intentOverrides, { finalSubjectReferenceId: "ref-2" });
  equal(resumed.proposedPlanHash, undefined);
  equal(resumed.approvedPlanHash, undefined);
  equal(resumed.plannedToolCount, 0);
  equal(resumed.stepCursor, 0);
  equal(resumed.clarificationHistory?.[0].status, "answered");
  equal(resumed.clarificationHistory?.[0].intentPatchHash?.length, 64);
});

test("stale or unrelated answers cannot resume the Run", () => {
  const initial = checkpoint();
  const current = proposal(controlledClarificationContextHash(initial));
  const parked = proposeControlledClarification(initial, current);
  throws(() => applyControlledIntentPatch(parked, {
    sourceQuestionKey: current.questionKey,
    contextHash: "f".repeat(64),
    patches: [{ field: "finalSubjectReferenceId", op: "set", value: "ref-2" }],
  }), /intent_patch_context_hash_mismatch/);
  throws(() => applyControlledIntentPatch(parked, {
    sourceQuestionKey: current.questionKey,
    contextHash: current.contextHash,
    patches: [{ field: "budget", op: "set", value: "more" }],
  }), /intent_patch_field_not_allowed/);
});
