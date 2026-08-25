import { test } from "node:test";
import { deepEqual, equal, throws } from "node:assert/strict";
import type { ClarificationProposal, IntentPatch } from "../contracts/clarification.ts";
import {
  applyIntentPatch,
  clarificationContextHash,
  clarificationProposalHash,
  validateClarificationProposal,
  type ClarificationHistoryEntry,
} from "./clarification-policy.ts";

const policy = {
  maxPerRun: 3,
  intentFields: ["finalSubjectReferenceId", "mustTransfer", "strategy", "budget"],
} as const;

function proposal(contextHash: string, questionKey = "choose.base"): ClarificationProposal {
  return {
    questionKey,
    contextHash,
    question: "哪张图应作为最终主体？",
    recommendedAnswer: "使用图1",
    options: ["使用图1", "使用图2"],
    optionPatches: [
      { answer: "使用图1", patches: [{ field: "finalSubjectReferenceId", op: "set", value: "ref-1" }] },
      { answer: "使用图2", patches: [{ field: "finalSubjectReferenceId", op: "set", value: "ref-2" }] },
    ],
    affectedIntentFields: ["finalSubjectReferenceId"],
    rationale: "不同主体会改变后续全部编辑步骤。",
  };
}

test("clarification proposal is bound to the canonical current context", () => {
  const contextHash = clarificationContextHash({ goal: "换装", refs: ["图1", "图2"] });
  const result = validateClarificationProposal({
    proposal: proposal(contextHash),
    expectedContextHash: contextHash,
    history: [],
    policy,
  });
  equal(result.kind, "new");
  equal(result.proposalHash, clarificationProposalHash(proposal(contextHash)));
  throws(() => validateClarificationProposal({
    proposal: proposal("0".repeat(64)),
    expectedContextHash: contextHash,
    history: [],
    policy,
  }), /clarification_context_hash_mismatch/);
});

test("identical retry reuses the existing question but changed content conflicts", () => {
  const contextHash = clarificationContextHash({ goal: "换装" });
  const current = proposal(contextHash);
  const history: ClarificationHistoryEntry[] = [{
    proposal: current,
    proposalHash: clarificationProposalHash(current),
    status: "pending",
  }];
  equal(validateClarificationProposal({
    proposal: current,
    expectedContextHash: contextHash,
    history,
    policy,
  }).kind, "existing");
  throws(() => validateClarificationProposal({
    proposal: { ...current, question: "改用哪一张主体图？" },
    expectedContextHash: contextHash,
    history,
    policy,
  }), /clarification_question_key_conflict/);
});

test("a fourth distinct clarification is rejected", () => {
  const contextHash = clarificationContextHash({ goal: "换装" });
  const history = ["one", "two", "three"].map((key): ClarificationHistoryEntry => {
    const item = proposal(contextHash, key);
    return { proposal: item, proposalHash: clarificationProposalHash(item), status: "answered" };
  });
  throws(() => validateClarificationProposal({
    proposal: proposal(contextHash, "four"),
    expectedContextHash: contextHash,
    history,
    policy,
  }), /max_clarifications_exceeded/);
});

test("question must affect an allowlisted intent field and include its recommendation", () => {
  const contextHash = clarificationContextHash({ goal: "换装" });
  throws(() => validateClarificationProposal({
    proposal: { ...proposal(contextHash), affectedIntentFields: ["promptInjection"] },
    expectedContextHash: contextHash,
    history: [],
    policy,
  }), /clarification_intent_fields_invalid/);
  throws(() => validateClarificationProposal({
    proposal: { ...proposal(contextHash), recommendedAnswer: "使用图3" },
    expectedContextHash: contextHash,
    history: [],
    policy,
  }), /clarification_options_invalid/);
});

test("IntentPatch applies only fields bound to the active question", () => {
  const contextHash = clarificationContextHash({ goal: "换装" });
  const active = proposal(contextHash);
  const patch: IntentPatch = {
    sourceQuestionKey: active.questionKey,
    contextHash,
    patches: [{ field: "finalSubjectReferenceId", op: "set", value: "ref-2" }],
  };
  const applied = applyIntentPatch({ intent: { strategy: "controlled" }, proposal: active, patch, policy });
  deepEqual(applied.intent, { strategy: "controlled", finalSubjectReferenceId: "ref-2" });
  equal(applied.intentPatchHash.length, 64);
});

test("IntentPatch rejects stale context, duplicate fields and unrelated fields", () => {
  const contextHash = clarificationContextHash({ goal: "换装" });
  const active = proposal(contextHash);
  throws(() => applyIntentPatch({
    intent: {},
    proposal: active,
    patch: { sourceQuestionKey: active.questionKey, contextHash: "f".repeat(64), patches: [{ field: "finalSubjectReferenceId", op: "set", value: "ref-1" }] },
    policy,
  }), /intent_patch_context_hash_mismatch/);
  throws(() => applyIntentPatch({
    intent: {},
    proposal: active,
    patch: { sourceQuestionKey: active.questionKey, contextHash, patches: [
      { field: "finalSubjectReferenceId", op: "set", value: "ref-1" },
      { field: "finalSubjectReferenceId", op: "clear" },
    ] },
    policy,
  }), /intent_patch_operations_invalid|intent_patch_field_duplicate/);
  throws(() => applyIntentPatch({
    intent: {},
    proposal: active,
    patch: { sourceQuestionKey: active.questionKey, contextHash, patches: [{ field: "strategy", op: "set", value: "direct" }] },
    policy,
  }), /intent_patch_field_not_allowed/);
});
