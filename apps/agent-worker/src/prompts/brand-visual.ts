import { readFileSync } from "node:fs";
import { join } from "node:path";

// Protocol identifier only; prompt prose lives in VPS-maintained files.
export const BRAND_OBSERVATION_TASK = "bowerbird:brand-visual-observation:v2";

export function loadBrandPrompt(kind: "observation" | "extraction" | "workflow", directory = process.env.BOWERBIRD_BRAND_PROMPT_DIR): string {
  const root = directory || join(import.meta.dirname, "brand-visual");
  const text = readFileSync(join(root, `${kind}.md`), "utf8").trim();
  if (!text || text.length > 20_000) throw new Error("brand_prompt_invalid");
  return text;
}
