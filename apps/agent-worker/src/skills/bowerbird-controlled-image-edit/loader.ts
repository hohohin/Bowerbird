import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type LoadedControlledImageEditSkill = {
  id: "bowerbird-controlled-image-edit";
  version: string;
  instructionHash: string;
  instructions: string;
  controlRecipes: string;
};

function bundleHash(instructions: string, controlRecipes: string): string {
  return createHash("sha256")
    .update(`SKILL.md\n${instructions}\nreferences/control-recipes.md\n${controlRecipes}`)
    .digest("hex");
}

/** 意图分析和计划回合都必须调用此 loader，确保使用同一钉死版本。 */
export function loadControlledImageEditSkill(): LoadedControlledImageEditSkill {
  const folder = import.meta.dirname;
  const manifest = JSON.parse(readFileSync(join(folder, "skill.json"), "utf8")) as {
    id: string;
    version: string;
    instructionHash: string;
  };
  if (manifest.id !== "bowerbird-controlled-image-edit") {
    throw new Error("controlled_skill_id_mismatch");
  }
  const instructions = readFileSync(join(folder, "SKILL.md"), "utf8");
  const controlRecipes = readFileSync(join(folder, "references", "control-recipes.md"), "utf8");
  const instructionHash = bundleHash(instructions, controlRecipes);
  if (instructionHash !== manifest.instructionHash) {
    throw new Error("controlled_skill_hash_mismatch");
  }
  return {
    id: "bowerbird-controlled-image-edit",
    version: manifest.version,
    instructionHash,
    instructions,
    controlRecipes,
  };
}
