import { equal, ok, throws } from "node:assert/strict";
import { test } from "node:test";

import type { SkillManifest } from "../contracts/skill.ts";
import {
  BUILTIN_SKILL_REGISTRY,
  BuiltinSkillRegistry,
  type BuiltinSkillRegistration,
} from "./builtin-skill-registry.ts";

test("built-in registry resolves the pinned controlled Skill bundle", () => {
  const resolved = BUILTIN_SKILL_REGISTRY.resolve("bowerbird-controlled-image-edit", "0.1.2");
  equal(resolved.id, "bowerbird-controlled-image-edit");
  equal(resolved.runner, "controlled-image-edit");
  equal(resolved.bundle.id, resolved.manifest.id);
  equal(resolved.bundle.version, resolved.manifest.version);
  ok(/^[0-9a-f]{64}$/.test(resolved.bundle.instructionHash));
  equal(BUILTIN_SKILL_REGISTRY.list().length, 2);
});

test("built-in registry rejects unknown ids, paths and unavailable versions before loading files", () => {
  throws(
    () => BUILTIN_SKILL_REGISTRY.resolve("unknown-skill", "0.0.1"),
    /agent_skill_not_supported/,
  );
  throws(
    () => BUILTIN_SKILL_REGISTRY.resolve("..\/bowerbird-controlled-image-edit", "0.1.2"),
    /agent_skill_not_supported/,
  );
  throws(
    () => BUILTIN_SKILL_REGISTRY.resolve("bowerbird-controlled-image-edit", "9.9.9"),
    /agent_skill_version_unavailable/,
  );
});

test("built-in registry keeps snapshot schema compatibility explicit", () => {
  const resolved = BUILTIN_SKILL_REGISTRY.resolve("bowerbird-controlled-image-edit", "0.1.2");
  BUILTIN_SKILL_REGISTRY.assertSnapshotCompatible(resolved, 1);
  throws(
    () => BUILTIN_SKILL_REGISTRY.assertSnapshotCompatible(resolved, 2),
    /agent_skill_snapshot_incompatible/,
  );
});

test("built-in registry rejects duplicate or mismatched static registrations", () => {
  const manifest = BUILTIN_SKILL_REGISTRY.resolve("bowerbird-controlled-image-edit", "0.1.2").manifest;
  const registration: BuiltinSkillRegistration = {
    id: manifest.id,
    version: manifest.version,
    loadBundle: () => ({
      id: manifest.id,
      version: manifest.version,
      instructionHash: "a".repeat(64),
      instructions: "test",
    }),
    manifest,
    runner: "controlled-image-edit",
  };
  throws(() => new BuiltinSkillRegistry([registration, registration]), /builtin_skill_registration_duplicate/);
  throws(
    () => new BuiltinSkillRegistry([{ ...registration, manifest: { ...manifest, id: "other" } as SkillManifest }]),
    /builtin_skill_registration_id_invalid/,
  );
});
