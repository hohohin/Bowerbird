import type {
  AbortSignalLike,
  ModelBackend,
  ModelTurnRequest,
  ModelTurnResult,
  ProviderUsage,
} from "../../contracts/model.ts";
import {
  AgentControlError,
  type PreparedToolCall,
  type RegisteredAgentArtifact,
} from "../../control-plane/agent-control-client.ts";
import {
  DurableProviderError,
  DurableToolDispatcher,
  type DurableToolControl,
} from "../../kernel/durable-tool-dispatcher.ts";
import { canonicalJson, sha256Hex } from "../../kernel/tool-ledger.ts";
import { DeepSeekBackendError } from "./backend.ts";

export interface MeteredModelControl extends DurableToolControl {
  uploadDiagnostic(args: {
    runId: string;
    leaseId: string;
    sourceCallId: string;
    stepId: string;
    bytes: Uint8Array;
    sha256: string;
  }): Promise<RegisteredAgentArtifact>;
  getArtifactByCall(runId: string, leaseId: string, callId: string): Promise<RegisteredAgentArtifact>;
  downloadVerifiedBytes(url: string, expected: { sha256: string; bytes: number }, maxBytes?: number): Promise<Uint8Array>;
  recordUsage(args: {
    runId: string;
    leaseId: string;
    callId: string;
    kind: "model_tokens";
    provider: "deepseek";
    model: string;
    inputUnits?: number;
    outputUnits?: number;
    imageCount?: number;
  }): Promise<void>;
}

type PersistedModelTurn = ModelTurnResult;

function safeUsage(usage: ProviderUsage): ProviderUsage {
  const integer = (value: number | undefined): number | undefined =>
    Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
  const providerRequestId = typeof usage.providerRequestId === "string" && usage.providerRequestId.length <= 200
    ? usage.providerRequestId
    : undefined;
  return {
    promptTokens: integer(usage.promptTokens),
    completionTokens: integer(usage.completionTokens),
    totalTokens: integer(usage.totalTokens),
    upstreamElapsedMs: integer(usage.upstreamElapsedMs),
    providerRequestId,
  };
}

function persistableResult(result: ModelTurnResult): PersistedModelTurn {
  const providerUsage = safeUsage(result.providerUsage);
  if (result.kind === "action") return { kind: "action", action: result.action, arguments: result.arguments, providerUsage };
  if (result.kind === "message") return { kind: "message", text: result.text, providerUsage };
  return { kind: "refusal", reason: result.reason, providerUsage };
}

function parsePersistedResult(value: unknown): PersistedModelTurn {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("agent_model_result_invalid");
  const row = value as Record<string, unknown>;
  const usage = row.providerUsage && typeof row.providerUsage === "object" && !Array.isArray(row.providerUsage)
    ? safeUsage(row.providerUsage as ProviderUsage)
    : {};
  if (row.kind === "action" && typeof row.action === "string" && row.action.length <= 80 &&
      row.arguments && typeof row.arguments === "object" && !Array.isArray(row.arguments)) {
    return { kind: "action", action: row.action, arguments: row.arguments, providerUsage: usage };
  }
  if (row.kind === "message" && typeof row.text === "string" && row.text.length <= 64_000) {
    return { kind: "message", text: row.text, providerUsage: usage };
  }
  if (row.kind === "refusal" && typeof row.reason === "string" && row.reason.length <= 1_000) {
    return { kind: "refusal", reason: row.reason, providerUsage: usage };
  }
  throw new Error("agent_model_result_invalid");
}

class MeteredModelAdapter {
  private readonly base: ModelBackend;
  private readonly control: MeteredModelControl;
  private readonly runId: string;
  private readonly leaseId: string;
  private readonly model: string;
  private readonly request: ModelTurnRequest;
  private readonly signal: AbortSignalLike;

  constructor(args: {
    base: ModelBackend;
    control: MeteredModelControl;
    runId: string;
    leaseId: string;
    model: string;
    request: ModelTurnRequest;
    signal: AbortSignalLike;
  }) {
    this.base = args.base;
    this.control = args.control;
    this.runId = args.runId;
    this.leaseId = args.leaseId;
    this.model = args.model;
    this.request = args.request;
    this.signal = args.signal;
  }

  async execute(callId: string, _request: ModelTurnRequest): Promise<ModelTurnResult> {
    try {
      return await this.base.turn(this.request, this.signal);
    } catch (error) {
      if (error instanceof DeepSeekBackendError) {
        if (error.status === undefined) await this.recordUsage(callId, {});
        throw new DurableProviderError(error.status === undefined ? "unknown" : "terminal", error.safeCode);
      }
      throw error;
    }
  }

  async reconcile(callId: string): Promise<ModelTurnResult | null> {
    try {
      return await this.load(callId);
    } catch (error) {
      if (!(error instanceof AgentControlError) || error.status !== 409) throw error;
      // The upstream request was durably marked submitted, but no normalized
      // result was persisted. Charge the configured minimum text unit and do
      // not repeat a request whose provider outcome cannot be reconciled.
      await this.recordUsage(callId, {});
      return null;
    }
  }

  async persist(callId: string, result: ModelTurnResult) {
    const normalized = persistableResult(result);
    const content = canonicalJson(normalized);
    const bytes = new TextEncoder().encode(content);
    if (!bytes.byteLength || bytes.byteLength > 64 * 1024) {
      throw new DurableProviderError("terminal", "agent_model_result_too_large");
    }
    const hash = sha256Hex(content);
    if (normalized.providerUsage.providerRequestId) {
      await this.control.markToolSubmitted({
        runId: this.runId,
        leaseId: this.leaseId,
        callId,
        providerRequestId: normalized.providerUsage.providerRequestId,
      });
    }
    const artifact = await this.control.uploadDiagnostic({
      runId: this.runId,
      leaseId: this.leaseId,
      sourceCallId: callId,
      stepId: `model-${this.request.phase}`.slice(0, 120),
      bytes,
      sha256: hash,
    });
    await this.recordUsage(callId, normalized.providerUsage);
    return { value: normalized, resultObjectKey: artifact.objectKey, resultHash: hash };
  }

  async restore(record: PreparedToolCall): Promise<ModelTurnResult> {
    return await this.load(record.callId);
  }

  private async recordUsage(callId: string, usage: ProviderUsage): Promise<void> {
    await this.control.recordUsage({
      runId: this.runId,
      leaseId: this.leaseId,
      callId,
      kind: "model_tokens",
      provider: "deepseek",
      model: this.model,
      inputUnits: usage.promptTokens ?? 0,
      outputUnits: usage.completionTokens ?? 0,
      imageCount: 0,
    });
  }

  private async load(callId: string): Promise<ModelTurnResult> {
    const artifact = await this.control.getArtifactByCall(this.runId, this.leaseId, callId);
    if (artifact.role !== "diagnostic" || artifact.mime !== "application/json" || !artifact.url) {
      throw new Error("agent_model_result_artifact_invalid");
    }
    const bytes = await this.control.downloadVerifiedBytes(
      artifact.url,
      { sha256: artifact.sha256, bytes: artifact.bytes },
      64 * 1024,
    );
    try {
      return parsePersistedResult(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      throw new Error("agent_model_result_invalid");
    }
  }
}

/** Durable, metered DeepSeek ModelBackend used only by the cloud Agent worker. */
export class MeteredModelBackend implements ModelBackend {
  readonly id: ModelBackend["id"];
  private readonly base: ModelBackend;
  private readonly control: MeteredModelControl;
  private readonly runId: string;
  private readonly leaseId: string;
  private readonly model: string;

  constructor(args: {
    base: ModelBackend;
    control: MeteredModelControl;
    runId: string;
    leaseId: string;
    model: string;
  }) {
    if (args.base.id !== "deepseek") throw new Error("agent_metered_model_provider_invalid");
    if (!args.model.trim() || args.model.length > 120) throw new Error("agent_metered_model_name_invalid");
    this.id = args.base.id;
    this.base = args.base;
    this.control = args.control;
    this.runId = args.runId;
    this.leaseId = args.leaseId;
    this.model = args.model;
  }

  async turn(request: ModelTurnRequest, signal: AbortSignalLike): Promise<ModelTurnResult> {
    if (request.runId !== this.runId) throw new Error("agent_metered_model_run_mismatch");
    if (signal.aborted) return await this.base.turn(request, signal);
    const requestHash = sha256Hex(canonicalJson(request));
    const callId = sha256Hex(canonicalJson({ schemaVersion: 1, runId: this.runId, phase: request.phase, requestHash }));
    const dispatcher = new DurableToolDispatcher(this.control, new MeteredModelAdapter({
      base: this.base,
      control: this.control,
      runId: this.runId,
      leaseId: this.leaseId,
      model: this.model,
      request,
      signal,
    }));
    return await dispatcher.dispatch({
      runId: this.runId,
      leaseId: this.leaseId,
      callId,
      phase: request.phase,
      toolName: "model_turn",
    }, request);
  }
}
