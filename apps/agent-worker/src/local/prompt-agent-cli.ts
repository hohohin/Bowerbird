import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DeepSeekBackend, deepSeekConfigFromEnv } from "../providers/deepseek/backend.ts";
import { loadPromptReviewSkill } from "./assembly/skill-loader.ts";
import { reviewWithSkill } from "./assembly/review-agent.ts";
import { compilePromptWithAgent, type PromptAgentInput } from "./prompt-agent.ts";

async function main(): Promise<void> {
  const encoded = readFileSync(0, "utf8").replace(/^\uFEFF/, "");
  let input: PromptAgentInput & { expandedPrompt?: string };
  try {
    input = JSON.parse(encoded) as PromptAgentInput & { expandedPrompt?: string };
  } catch {
    throw new Error("prompt_agent_invalid_request");
  }
  const model = new DeepSeekBackend(deepSeekConfigFromEnv(process.env));
  // 分派：带 expandedPrompt = 方案 B（skill 审查修复）；缺省 = 方案 A（子句挑选）。
  if (typeof input.expandedPrompt === "string" && input.expandedPrompt.trim()) {
    console.log(JSON.stringify(await reviewWithSkill({
      intentPrompt: input.originalPrompt,
      expandedPrompt: input.expandedPrompt,
      references: input.references,
      ...(input.output ? { output: input.output } : {}),
    }, model, `prompt_${randomUUID()}`, loadPromptReviewSkill())));
    return;
  }
  const { expandedPrompt: _expanded, ...selectInput } = input;
  void _expanded;
  console.log(JSON.stringify(await compilePromptWithAgent(selectInput, model, `prompt_${randomUUID()}`)));
}

main().catch((error: unknown) => {
  const safeCode = error && typeof error === "object" && "safeCode" in error
    ? String((error as { safeCode: unknown }).safeCode)
    : error instanceof Error ? error.message : "prompt_agent_unknown_error";
  console.error(safeCode);
  process.exitCode = 1;
});
