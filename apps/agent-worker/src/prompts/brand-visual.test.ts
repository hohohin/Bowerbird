import { test } from "node:test";
import { equal, ok, throws } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND_OBSERVATION_TASK, loadBrandPrompt } from "./brand-visual.ts";
import { visionPrompt } from "../cloud-understand/runtime.ts";

test("brand task resolves to VPS observation file; ordinary caption instructions remain intact", () => {
  const input = { schema_version: 1 as const, operation: "caption" as const, image: { mime: "image/png" as const, base64: "aA==" }, instruction: BRAND_OBSERVATION_TASK, mock_scenario: null };
  equal(visionPrompt(input), loadBrandPrompt("observation"));
  ok(visionPrompt(input).includes("HEX、RGB、CMYK、Pantone"));
  equal(visionPrompt({...input, instruction: "用户自己的指令"}), "用户自己的指令");
  throws(() => visionPrompt({...input, image: null}), /brand_observation_image_required/);
});
test("prompt files can be maintained between tasks without bundling prose into the desktop", () => {
  const root = mkdtempSync(join(tmpdir(), "brand-prompts-"));
  try {
    writeFileSync(join(root,"extraction.md"), "Version one", "utf8");
    const frozen = loadBrandPrompt("extraction",root);
    writeFileSync(join(root,"extraction.md"), "Version two", "utf8");
    equal(frozen, "Version one"); equal(loadBrandPrompt("extraction",root), "Version two");
    writeFileSync(join(root,"extraction.md"), " ", "utf8");
    throws(() => loadBrandPrompt("extraction",root), /brand_prompt_invalid/);
    throws(() => loadBrandPrompt("observation",root));
  } finally { rmSync(root,{recursive:true,force:true}); }
});
