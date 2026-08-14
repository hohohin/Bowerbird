import { readFileSync } from "node:fs";
import { DeepSeekBackend, deepSeekConfigFromEnv } from "../providers/deepseek/backend.ts";
import { advanceLocalAgent, type LocalAgentAdvanceRequest } from "./runtime.ts";

async function main(): Promise<void> {
  const encoded = readFileSync(0, "utf8").replace(/^\uFEFF/, "");
  let input: LocalAgentAdvanceRequest;
  try {
    input = JSON.parse(encoded) as LocalAgentAdvanceRequest;
  } catch {
    throw new Error("local_agent_invalid_request");
  }
  const model = new DeepSeekBackend(deepSeekConfigFromEnv(process.env));
  console.log(JSON.stringify(await advanceLocalAgent(input, model)));
}

main().catch((error: unknown) => {
  const safeCode = error && typeof error === "object" && "safeCode" in error
    ? String((error as { safeCode: unknown }).safeCode)
    : error instanceof Error ? error.message : "local_agent_unknown_error";
  console.error(safeCode);
  process.exitCode = 1;
});
