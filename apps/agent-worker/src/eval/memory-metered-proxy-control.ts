import { createHash } from "node:crypto";
import {
  AgentControlError,
  type PreparedToolCall,
  type RegisteredAgentArtifact,
} from "../control-plane/agent-control-client.ts";
import type { DurableToolIdentity } from "../kernel/durable-tool-dispatcher.ts";
import type { MeteredDeepSeekProxyControl } from "../harness/metered-deepseek-proxy.ts";

type StoredCall = PreparedToolCall & { argsHash: string; toolName: string; runId: string };

/** In-memory durable surface for an explicitly authorized local U4 provider eval. */
export class EvalMeteredProxyControl implements MeteredDeepSeekProxyControl {
  private readonly calls = new Map<string, StoredCall>();
  private readonly artifacts = new Map<string, { artifact: RegisteredAgentArtifact; bytes: Uint8Array }>();
  private readonly usage = new Map<string, { runId: string; inputUnits: number; outputUnits: number }>();

  async prepareTool(args: DurableToolIdentity & { argsHash: string }): Promise<PreparedToolCall> {
    const existing = this.calls.get(args.callId);
    if (existing) {
      if (existing.argsHash !== args.argsHash || existing.toolName !== args.toolName) {
        throw new Error("controlled_eval_model_args_drift");
      }
      return { ...existing, reused: true };
    }
    const created: StoredCall = {
      callId: args.callId,
      argsHash: args.argsHash,
      toolName: args.toolName,
      runId: args.runId,
      status: "prepared",
      reused: false,
    };
    this.calls.set(args.callId, created);
    return created;
  }

  async markToolSubmitted(args: {
    callId: string;
    providerRequestId?: string;
  }): Promise<PreparedToolCall> {
    const existing = this.calls.get(args.callId);
    if (!existing) throw new Error("controlled_eval_model_call_missing");
    const updated: StoredCall = { ...existing, status: "submitted", providerRequestId: args.providerRequestId };
    this.calls.set(args.callId, updated);
    return updated;
  }

  async completeTool(args: {
    callId: string;
    status: "succeeded" | "failed" | "outcome_unknown";
    resultObjectKey?: string;
    resultHash?: string;
    safeErrorCode?: string;
  }): Promise<PreparedToolCall> {
    const existing = this.calls.get(args.callId);
    if (!existing) throw new Error("controlled_eval_model_call_missing");
    const updated: StoredCall = { ...existing, ...args };
    this.calls.set(args.callId, updated);
    return updated;
  }

  async uploadDiagnostic(args: {
    runId: string;
    sourceCallId: string;
    stepId: string;
    bytes: Uint8Array;
    sha256: string;
  }): Promise<RegisteredAgentArtifact> {
    if (!args.bytes.byteLength || createHash("sha256").update(args.bytes).digest("hex") !== args.sha256) {
      throw new Error("controlled_eval_model_artifact_invalid");
    }
    const artifact: RegisteredAgentArtifact = {
      artifactId: `eval-model-${args.sourceCallId}`,
      conversationId: `eval-conversation-${args.runId}`,
      runId: args.runId,
      role: "diagnostic",
      stepId: args.stepId,
      mime: "application/json",
      bytes: args.bytes.byteLength,
      sha256: args.sha256,
      userVisible: false,
      objectKey: `memory/${args.sourceCallId}.json`,
      url: `memory://${args.sourceCallId}`,
    };
    this.artifacts.set(args.sourceCallId, { artifact, bytes: Uint8Array.from(args.bytes) });
    return artifact;
  }

  async getArtifactByCall(_runId: string, _leaseId: string, callId: string): Promise<RegisteredAgentArtifact> {
    const stored = this.artifacts.get(callId);
    if (!stored) throw new AgentControlError(409);
    return stored.artifact;
  }

  async downloadVerifiedBytes(
    url: string,
    expected: { sha256: string; bytes: number },
    maxBytes?: number,
  ): Promise<Uint8Array> {
    const stored = this.artifacts.get(url.replace("memory://", ""));
    if (!stored || stored.artifact.sha256 !== expected.sha256 || stored.artifact.bytes !== expected.bytes ||
        (maxBytes !== undefined && stored.artifact.bytes > maxBytes)) {
      throw new Error("controlled_eval_model_artifact_invalid");
    }
    return Uint8Array.from(stored.bytes);
  }

  async recordUsage(args: {
    runId: string;
    callId: string;
    inputUnits: number;
    outputUnits: number;
  }): Promise<void> {
    const value = { runId: args.runId, inputUnits: args.inputUnits, outputUnits: args.outputUnits };
    const existing = this.usage.get(args.callId);
    if (existing && (existing.runId !== value.runId || existing.inputUnits !== value.inputUnits ||
        existing.outputUnits !== value.outputUnits)) {
      throw new Error("controlled_eval_model_usage_drift");
    }
    this.usage.set(args.callId, value);
  }

  usageForRun(runId: string): { promptTokens: number; completionTokens: number; calls: number } {
    const rows = [...this.usage.values()].filter((row) => row.runId === runId);
    return {
      promptTokens: rows.reduce((sum, row) => sum + row.inputUnits, 0),
      completionTokens: rows.reduce((sum, row) => sum + row.outputUnits, 0),
      calls: rows.length,
    };
  }

  safeFailuresForRun(runId: string): Array<{ status: string; safeErrorCode: string }> {
    return [...this.calls.values()]
      .filter((call) => call.runId === runId && !!call.safeErrorCode)
      .map((call) => ({
        status: call.status,
        safeErrorCode: call.safeErrorCode!,
      }));
  }
}
