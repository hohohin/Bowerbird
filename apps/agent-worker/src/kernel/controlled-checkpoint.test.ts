import { equal, throws } from "node:assert/strict";
import { test } from "node:test";

import {
  controlledClarificationContextHash,
  createControlledRunnerCheckpoint,
  proposeControlledClarification,
} from "./controlled-image-edit-runner.ts";
import { decodeControlledCheckpoint, encodeControlledCheckpoint } from "./controlled-checkpoint.ts";
import { loadControlledImageEditSkill } from "../skills/bowerbird-controlled-image-edit/loader.ts";

function checkpoint() {
  const skill = loadControlledImageEditSkill();
  return {
    skill,
    value: createControlledRunnerCheckpoint({
      runId: "run-1",
      conversationId: "conversation-1",
      skillVersion: skill.version,
      skillHash: skill.instructionHash,
      input: {
        schemaVersion: 1,
        intentPrompt: "生成一张极简海报",
        references: [],
      },
    }),
  };
}

test("controlled checkpoint round-trips with pinned run and Skill identity", () => {
  const fixture = checkpoint();
  const encoded = encodeControlledCheckpoint(fixture.value);
  const decoded = decodeControlledCheckpoint(encoded.bytes, {
    runId: "run-1",
    conversationId: "conversation-1",
    skillVersion: fixture.skill.version,
    skillHash: fixture.skill.instructionHash,
    sha256: encoded.sha256,
  });
  equal(decoded.phase, "analyze_intent_text_only");
  equal(decoded.input.intentPrompt, "生成一张极简海报");
});

test("controlled checkpoint rejects changed bytes before parsing", () => {
  const fixture = checkpoint();
  const encoded = encodeControlledCheckpoint(fixture.value);
  const changed = encoded.bytes.slice();
  changed[changed.length - 2] ^= 1;
  throws(
    () => decodeControlledCheckpoint(changed, {
      runId: "run-1",
      conversationId: "conversation-1",
      skillVersion: fixture.skill.version,
      skillHash: fixture.skill.instructionHash,
      sha256: encoded.sha256,
    }),
    /controlled_checkpoint_object_hash_mismatch/,
  );
});

test("controlled checkpoint fails closed across Skill versions", () => {
  const fixture = checkpoint();
  const encoded = encodeControlledCheckpoint(fixture.value);
  throws(
    () => decodeControlledCheckpoint(encoded.bytes, {
      runId: "run-1",
      conversationId: "conversation-1",
      skillVersion: "0.2.0",
      skillHash: fixture.skill.instructionHash,
      sha256: encoded.sha256,
    }),
    /controlled_checkpoint_skill_mismatch/,
  );
});

test("controlled checkpoint preserves a pending clarification and rejects tampering", () => {
  const fixture = checkpoint();
  const pending = proposeControlledClarification(fixture.value, {
    questionKey: "choose.output",
    contextHash: controlledClarificationContextHash(fixture.value),
    question: "输出更偏海报还是插画？",
    recommendedAnswer: "海报",
    options: ["海报", "插画"],
    optionPatches: [
      { answer: "海报", patches: [{ field: "strategy", op: "set", value: "direct" }] },
      { answer: "插画", patches: [{ field: "strategy", op: "set", value: "controlled" }] },
    ],
    affectedIntentFields: ["strategy"],
    rationale: "路线会改变计划结构。",
  });
  const encoded = encodeControlledCheckpoint(pending);
  const decoded = decodeControlledCheckpoint(encoded.bytes, {
    runId: "run-1",
    conversationId: "conversation-1",
    skillVersion: fixture.skill.version,
    skillHash: fixture.skill.instructionHash,
    sha256: encoded.sha256,
  });
  equal(decoded.pendingClarification?.questionKey, "choose.output");
  throws(() => encodeControlledCheckpoint({
    ...pending,
    pendingClarification: { ...pending.pendingClarification!, question: "已被篡改" },
  }), /controlled_checkpoint_pending_clarification_invalid/);
});
