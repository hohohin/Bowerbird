import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DeepSeekBackend, deepSeekConfigFromEnv } from "../providers/deepseek/backend.ts";
import { compilePromptWithAgent, type PromptAgentInput } from "./prompt-agent.ts";

async function main(): Promise<void> {
  const encoded = readFileSync(0, "utf8").replace(/^\uFEFF/, "");
  let input: PromptAgentInput;
  try {
    input = JSON.parse(encoded) as PromptAgentInput;
  } catch {
    throw new Error("prompt_agent_invalid_request");
  }
  const model = new DeepSeekBackend(deepSeekConfigFromEnv(process.env));
  console.log(JSON.stringify(await compilePromptWithAgent(input, model, `prompt_${randomUUID()}`)));
}

main().catch((error: unknown) => {
  const safeCode = error && typeof error === "object" && "safeCode" in error
    ? String((error as { safeCode: unknown }).safeCode)
    : error instanceof Error ? error.message : "prompt_agent_unknown_error";
  console.error(safeCode);
  process.exitCode = 1;
});
