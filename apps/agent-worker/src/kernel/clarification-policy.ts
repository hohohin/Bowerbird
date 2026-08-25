import type {
  ClarificationProposal,
  IntentPatch,
  IntentPatchOp,
} from "../contracts/clarification.ts";
import { canonicalJson, sha256Hex } from "./tool-ledger.ts";

const QUESTION_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export type ClarificationHistoryEntry = {
  proposal: ClarificationProposal;
  proposalHash: string;
  status: "pending" | "answered";
  intentPatchHash?: string;
};

export type ClarificationPolicy = {
  maxPerRun: number;
  intentFields: readonly string[];
};

export type ClarificationValidation =
  | { kind: "new"; proposalHash: string }
  | { kind: "existing"; proposalHash: string; entry: ClarificationHistoryEntry };

export type AppliedIntentPatch<TIntent extends Record<string, unknown>> = {
  intent: TIntent;
  intentPatchHash: string;
};

function fail(code: string): never {
  throw new Error(code);
}

function normalizedText(value: unknown, maxLength: number, code: string): string {
  if (typeof value !== "string") fail(code);
  const text = value.trim();
  if (!text || text.length > maxLength) fail(code);
  return text;
}

function assertPolicy(policy: ClarificationPolicy): void {
  if (!Number.isInteger(policy.maxPerRun) || policy.maxPerRun < 0 || policy.maxPerRun > 3) {
    fail("clarification_policy_max_invalid");
  }
  if (!policy.intentFields.length || new Set(policy.intentFields).size !== policy.intentFields.length ||
      policy.intentFields.some((field) => typeof field !== "string" || !field.trim())) {
    fail("clarification_policy_fields_invalid");
  }
}

export function clarificationContextHash(context: unknown): string {
  return sha256Hex(canonicalJson(context));
}

export function clarificationProposalHash(proposal: ClarificationProposal): string {
  return sha256Hex(canonicalJson(proposal));
}

/**
 * Validates a model-proposed question outside the model boundary. An identical
 * proposal is returned as existing so a Worker retry can replay the same pause
 * without asking twice; reuse of the same key for changed content fails closed.
 */
export function validateClarificationProposal(args: {
  proposal: ClarificationProposal;
  expectedContextHash: string;
  history: readonly ClarificationHistoryEntry[];
  policy: ClarificationPolicy;
}): ClarificationValidation {
  assertPolicy(args.policy);
  const proposal = args.proposal;
  if (!proposal || typeof proposal !== "object") fail("clarification_proposal_invalid");
  if (!QUESTION_KEY_PATTERN.test(proposal.questionKey)) fail("clarification_question_key_invalid");
  if (!HASH_PATTERN.test(proposal.contextHash) || proposal.contextHash !== args.expectedContextHash) {
    fail("clarification_context_hash_mismatch");
  }
  normalizedText(proposal.question, 500, "clarification_question_invalid");
  const recommended = normalizedText(
    proposal.recommendedAnswer,
    240,
    "clarification_recommended_answer_invalid",
  );
  normalizedText(proposal.rationale, 1_000, "clarification_rationale_invalid");
  if (!Array.isArray(proposal.options) || proposal.options.length < 2 || proposal.options.length > 4) {
    fail("clarification_options_invalid");
  }
  const options = proposal.options.map((option) =>
    normalizedText(option, 240, "clarification_options_invalid")
  );
  if (new Set(options).size !== options.length || !options.includes(recommended)) {
    fail("clarification_options_invalid");
  }
  if (!Array.isArray(proposal.affectedIntentFields) || !proposal.affectedIntentFields.length ||
      new Set(proposal.affectedIntentFields).size !== proposal.affectedIntentFields.length ||
      proposal.affectedIntentFields.some((field) => !args.policy.intentFields.includes(field))) {
    fail("clarification_intent_fields_invalid");
  }
  if (!Array.isArray(proposal.optionPatches) || proposal.optionPatches.length !== options.length ||
      new Set(proposal.optionPatches.map((item) => item?.answer)).size !== options.length) {
    fail("clarification_option_patches_invalid");
  }
  for (const mapping of proposal.optionPatches) {
    if (!mapping || typeof mapping.answer !== "string" || !options.includes(mapping.answer) ||
        !Array.isArray(mapping.patches) || !mapping.patches.length ||
        mapping.patches.length > proposal.affectedIntentFields.length ||
        new Set(mapping.patches.map((op) => op?.field)).size !== mapping.patches.length) {
      fail("clarification_option_patches_invalid");
    }
    for (const op of mapping.patches) validatePatchOp(op, proposal, args.policy);
  }

  const proposalHash = clarificationProposalHash(proposal);
  const existing = args.history.find((entry) => entry.proposal.questionKey === proposal.questionKey);
  if (existing) {
    if (existing.proposalHash !== proposalHash || existing.proposal.contextHash !== proposal.contextHash) {
      fail("clarification_question_key_conflict");
    }
    return { kind: "existing", proposalHash, entry: existing };
  }
  if (args.history.length >= args.policy.maxPerRun) fail("max_clarifications_exceeded");
  return { kind: "new", proposalHash };
}

function validatePatchOp(
  op: IntentPatchOp,
  proposal: ClarificationProposal,
  policy: ClarificationPolicy,
): void {
  if (!op || typeof op !== "object" || typeof op.field !== "string" ||
      !policy.intentFields.includes(op.field) || !proposal.affectedIntentFields.includes(op.field)) {
    fail("intent_patch_field_not_allowed");
  }
  if (op.op !== "set" && op.op !== "clear") fail("intent_patch_operation_invalid");
  if (op.op === "set" && op.value === undefined) fail("intent_patch_value_required");
  if (op.op === "clear" && Object.hasOwn(op, "value")) fail("intent_patch_clear_value_forbidden");
}

/** Applies only structured, question-bound fields; raw answer text never enters intent state. */
export function applyIntentPatch<TIntent extends Record<string, unknown>>(args: {
  intent: TIntent;
  proposal: ClarificationProposal;
  patch: IntentPatch;
  policy: ClarificationPolicy;
}): AppliedIntentPatch<TIntent> {
  assertPolicy(args.policy);
  if (args.patch.sourceQuestionKey !== args.proposal.questionKey) fail("intent_patch_question_mismatch");
  if (!HASH_PATTERN.test(args.patch.contextHash) || args.patch.contextHash !== args.proposal.contextHash) {
    fail("intent_patch_context_hash_mismatch");
  }
  if (!Array.isArray(args.patch.patches) || !args.patch.patches.length ||
      args.patch.patches.length > args.proposal.affectedIntentFields.length) {
    fail("intent_patch_operations_invalid");
  }
  const fields = args.patch.patches.map((op) => op?.field);
  if (new Set(fields).size !== fields.length) fail("intent_patch_field_duplicate");
  for (const op of args.patch.patches) validatePatchOp(op, args.proposal, args.policy);

  const intent: Record<string, unknown> = { ...args.intent };
  for (const op of args.patch.patches) {
    if (op.op === "clear") delete intent[op.field];
    else intent[op.field] = op.value;
  }
  return {
    intent: intent as TIntent,
    intentPatchHash: sha256Hex(canonicalJson(args.patch)),
  };
}
