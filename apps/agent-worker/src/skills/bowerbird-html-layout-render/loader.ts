import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type LoadedHtmlLayoutRenderSkill = {
  id: "bowerbird-html-layout-render";
  version: string;
  instructionHash: string;
  instructions: string;
  layoutRules: string;
};

function bundleHash(instructions: string, layoutRules: string): string {
  return createHash("sha256")
    .update(`SKILL.md\n${instructions}\nreferences/html-layout-rules.md\n${layoutRules}`)
    .digest("hex");
}

export function loadHtmlLayoutRenderSkill(): LoadedHtmlLayoutRenderSkill {
  const folder = import.meta.dirname;
  const metadata = JSON.parse(readFileSync(join(folder, "skill.json"), "utf8")) as {
    id: string;
    version: string;
    instructionHash: string;
  };
  if (metadata.id !== "bowerbird-html-layout-render") throw new Error("html_layout_skill_id_mismatch");
  const instructions = readFileSync(join(folder, "SKILL.md"), "utf8");
  const layoutRules = readFileSync(join(folder, "references", "html-layout-rules.md"), "utf8");
  const instructionHash = bundleHash(instructions, layoutRules);
  if (instructionHash !== metadata.instructionHash) throw new Error("html_layout_skill_hash_mismatch");
  return { id: "bowerbird-html-layout-render", version: metadata.version, instructionHash, instructions, layoutRules };
}
