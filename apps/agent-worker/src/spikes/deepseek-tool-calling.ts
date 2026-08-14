import type { ContextBlock, ModelTurnRequest } from "../contracts/model.ts";
import { sha256Hex } from "../kernel/tool-ledger.ts";
import {
  DeepSeekBackend,
  DeepSeekBackendError,
  deepSeekConfigFromEnv,
} from "../providers/deepseek/backend.ts";

function request(
  phase: string,
  context: ContextBlock[],
  action: { name: string; description: string; argumentSchema: Record<string, unknown> },
): ModelTurnRequest {
  return {
    runId: "spike-deepseek-synthetic",
    phase,
    systemPolicy: "Bowerbird Agent Kernel spike. Use only the supplied action.",
    skillInstructions: "This is a synthetic tool-calling check with no user data.",
    context,
    allowedActions: [{ ...action, kind: "workspace", maxCallsPerRun: 1 }],
    responseSchemaVersion: 1,
  };
}

async function main(): Promise<void> {
  const config = deepSeekConfigFromEnv(process.env);
  const backend = new DeepSeekBackend(config);
  const startedAt = Date.now();

  const first = await backend.turn(request("inspect", [], {
    name: "record_observation",
    description: "Record one synthetic observation before finalizing.",
    argumentSchema: {
      type: "object",
      properties: { observation: { type: "string" } },
      required: ["observation"],
      additionalProperties: false,
    },
  }), { aborted: false });
  if (first.kind !== "action" || first.action !== "record_observation") {
    throw new Error(`spike_first_turn_${first.kind}`);
  }

  const fakeToolResult = { observation: "synthetic fixture acknowledged", source: "fake_tool" };
  const toolContext: ContextBlock = {
    kind: "tool_result",
    source: "call-synthetic-1",
    trust: "approved",
    contentHash: sha256Hex(JSON.stringify(fakeToolResult)),
    body: fakeToolResult,
  };
  const second = await backend.turn(request("finalize", [toolContext], {
    name: "finish_spike",
    description: "Finish after reading the approved synthetic tool result.",
    argumentSchema: {
      type: "object",
      properties: { acknowledged: { type: "boolean", const: true } },
      required: ["acknowledged"],
      additionalProperties: false,
    },
  }), { aborted: false });
  if (second.kind !== "action" || second.action !== "finish_spike") {
    throw new Error(`spike_second_turn_${second.kind}`);
  }

  console.log(JSON.stringify({
    schemaVersion: 1,
    provider: "deepseek",
    configuredModel: config.model,
    flow: [first.action, "fake_tool_result", second.action],
    usage: {
      first: {
        promptTokens: first.providerUsage.promptTokens,
        completionTokens: first.providerUsage.completionTokens,
        totalTokens: first.providerUsage.totalTokens,
      },
      second: {
        promptTokens: second.providerUsage.promptTokens,
        completionTokens: second.providerUsage.completionTokens,
        totalTokens: second.providerUsage.totalTokens,
      },
    },
    elapsedMs: Date.now() - startedAt,
    containsUserData: false,
  }));
}

main().catch((error: unknown) => {
  const safeCode = error instanceof Error ? error.message : "deepseek_spike_failed";
  console.error(JSON.stringify({
    ok: false,
    safeCode,
    status: error instanceof DeepSeekBackendError ? error.status : undefined,
    providerCode: error instanceof DeepSeekBackendError ? error.providerCode : undefined,
    retryable: error instanceof DeepSeekBackendError ? error.retryable : undefined,
  }));
  process.exitCode = 1;
});
