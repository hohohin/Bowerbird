import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type LoadedUnifiedAgentSkill = {
  id: "bowerbird-unified-agent";
  version: string;
  instructionHash: string;
  instructions: string;
};

export function loadUnifiedAgentSkill(): LoadedUnifiedAgentSkill {
  const folder = import.meta.dirname;
  const metadata = JSON.parse(readFileSync(join(folder, "skill.json"), "utf8")) as {
    id: string;
    version: string;
    instructionHash: string;
  };
  if (metadata.id !== "bowerbird-unified-agent") throw new Error("unified_agent_skill_id_mismatch");
  const instructions = readFileSync(join(folder, "SKILL.md"), "utf8");
  const instructionHash = createHash("sha256").update(`SKILL.md\n${instructions}`).digest("hex");
  if (instructionHash !== metadata.instructionHash) throw new Error("unified_agent_skill_hash_mismatch");
  return { id: "bowerbird-unified-agent", version: metadata.version, instructionHash, instructions };
}
