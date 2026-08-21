import { equal, throws } from "node:assert/strict";
import { test } from "node:test";

import { createControlledRunnerCheckpoint } from "./controlled-image-edit-runner.ts";
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
