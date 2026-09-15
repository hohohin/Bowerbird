import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UNIFIED_DOMAIN_SKILLS } from "./domain-skills.ts";

export type LoadedUnifiedAgentSkill = {
  id: "bowerbird-unified-agent";
  version: string;
  instructionHash: string;
  instructions: string;
  previousInstructionHashes: string[];
  methods: Readonly<Record<string, string>>;
};

export function loadUnifiedAgentSkill(): LoadedUnifiedAgentSkill {
  const folder = import.meta.dirname;
  const metadata = JSON.parse(readFileSync(join(folder, "skill.json"), "utf8")) as {
    id: string;
    version: string;
    instructionHash: string;
    previousInstructionHashes?: string[];
  };
  if (metadata.id !== "bowerbird-unified-agent") throw new Error("unified_agent_skill_id_mismatch");
  const instructions = readFileSync(join(folder, "SKILL.md"), "utf8");
  const methods: Record<string, string> = {};
  const hash = createHash("sha256").update(`SKILL.md\n${instructions}`);
  for (const { id, description, file } of UNIFIED_DOMAIN_SKILLS) {
    methods[id] = readFileSync(join(folder, file), "utf8");
    hash.update(`\n${id}\n${description}\n${file}\n${methods[id]}`);
  }
  const instructionHash = hash.digest("hex");
  if (instructionHash !== metadata.instructionHash) throw new Error("unified_agent_skill_hash_mismatch");
  return { id: "bowerbird-unified-agent", version: metadata.version, instructionHash, instructions, methods,
    previousInstructionHashes: metadata.previousInstructionHashes ?? [] };
}
