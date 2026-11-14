import type { PreparedToolCall } from "../control-plane/agent-control-client.ts";
import { computeArgsHash } from "./tool-ledger.ts";

export type DurableToolIdentity = {
  runId: string;
  leaseId: string;
  callId: string;
  phase: string;
  toolName: string;
  directDeepSeekV1Model?: string;
};

export interface DurableToolControl {
  prepareTool(args: DurableToolIdentity & { argsHash: string }): Promise<PreparedToolCall>;
  markToolSubmitted(args: Pick<DurableToolIdentity, "runId" | "leaseId" | "callId"> & {
    providerRequestId?: string;
  }): Promise<PreparedToolCall>;
  completeTool(args: Pick<DurableToolIdentity, "runId" | "leaseId" | "callId"> & {
    status: "succeeded" | "failed" | "outcome_unknown";
    resultObjectKey?: string;
    resultHash?: string;
    safeErrorCode?: string;
    pendingUsage?: PreparedToolCall["pendingUsage"];
  }): Promise<PreparedToolCall>;
}

export type PersistedToolResult<TResult> = {
  value: TResult;
  resultObjectKey: string;
  resultHash: string;
  providerRequestId?: string;
};

export interface DurableToolAdapter<TRequest, TResult> {
  /** Called only after submitted is durable. */
  execute(callId: string, request: TRequest): Promise<TResult>;
  /** Query an already-submitted call. Must never submit a second side effect. */
  reconcile(callId: string, request: TRequest, record: PreparedToolCall): Promise<TResult | null>;
  /** Persist normalized result before tool_complete. */
  persist(callId: string, result: TResult): Promise<PersistedToolResult<TResult>>;
  /** Restore a succeeded call from resultObjectKey/resultHash. */
  restore(record: PreparedToolCall): Promise<TResult>;
}

export class DurableProviderError extends Error {
  readonly outcome: "terminal" | "unknown";
  readonly safeCode: string;

  readonly pendingUsage?: PreparedToolCall["pendingUsage"];

  constructor(outcome: "terminal" | "unknown", safeCode: string, pendingUsage?: PreparedToolCall["pendingUsage"]) {
    super(safeCode);
    this.name = "DurableProviderError";
    this.outcome = outcome;
    this.safeCode = safeCode;
    this.pendingUsage = pendingUsage;
  }
}

/** Test-only failure class that represents kill -9: no catch/finalizer may mutate durable state. */
export class SimulatedProcessCrash extends Error {
  constructor() {
    super("simulated_process_crash");
    this.name = "SimulatedProcessCrash";
  }
}

export class DurableToolDispatcher<TRequest, TResult> {
  private readonly control: DurableToolControl;
  private readonly adapter: DurableToolAdapter<TRequest, TResult>;
  private readonly afterExecute?: () => void;
  private readonly onUnexpectedError?: (error: unknown, identity: DurableToolIdentity) => void;

  constructor(
    control: DurableToolControl,
    adapter: DurableToolAdapter<TRequest, TResult>,
    options: {
      afterExecute?: () => void;
      /** Test/diagnostic observer only. It must not affect the durable error contract. */
      onUnexpectedError?: (error: unknown, identity: DurableToolIdentity) => void;
    } = {},
  ) {
    this.control = control;
    this.adapter = adapter;
    this.afterExecute = options.afterExecute;
    this.onUnexpectedError = options.onUnexpectedError;
  }

  async dispatch(identity: DurableToolIdentity, request: TRequest): Promise<TResult> {
    const argsHash = computeArgsHash(request);
    const record = await this.control.prepareTool({ ...identity, argsHash });
    this.assertModelContract(identity, record);
    if (record.status === "succeeded") return await this.adapter.restore(record);
    if (record.status === "failed") throw this.priorFailure(record);

    try {
      if (record.status !== "prepared") return await this.recover(identity, request, record);
      return await this.submit(identity, request);
    } catch (error) {
      return await this.recordFailure(identity, error);
    }
  }

  private assertModelContract(identity: DurableToolIdentity, record: PreparedToolCall): void {
    if (!identity.directDeepSeekV1Model || record.directDeepSeekV1Model === identity.directDeepSeekV1Model) return;
    // Legacy direct calls already past preparation can only be restored or reconciled.
    if (record.reused && record.status !== "prepared" && record.directDeepSeekV1Model === null) return;
    throw new Error("direct_model_contract_unavailable");
  }

  private priorFailure(record: PreparedToolCall): DurableProviderError {
    return new DurableProviderError("terminal", record.safeErrorCode ?? "durable_tool_previously_failed");
  }

  private async submit(identity: DurableToolIdentity, request: TRequest): Promise<TResult> {
    const {runId, leaseId, callId} = identity;
    const record = await this.control.markToolSubmitted({runId, leaseId, callId});
    if (record.status === "succeeded") return await this.adapter.restore(record);
    if (record.status === "failed") throw this.priorFailure(record);
    if (identity.directDeepSeekV1Model && (record.status !== "submitted" || record.reused !== false)) {
      return await this.recover(identity, request, record);
    }

    const result = await this.adapter.execute(callId, request);
    this.afterExecute?.();
    return await this.persistAndComplete(identity, result);
  }

  private async recover(identity: DurableToolIdentity, request: TRequest, record: PreparedToolCall): Promise<TResult> {
    const result = await this.adapter.reconcile(identity.callId, request, record);
    if (result === null) throw new DurableProviderError("unknown", record.safeErrorCode || "provider_outcome_unknown");
    return await this.persistAndComplete(identity, result);
  }

  private async recordFailure(identity: DurableToolIdentity, error: unknown): Promise<never> {
    if (error instanceof SimulatedProcessCrash) throw error;
    let failure: DurableProviderError;
    if (error instanceof DurableProviderError) {
      failure = error;
    } else {
      try {
        this.onUnexpectedError?.(error, identity);
      } catch {
        // Observability must never change provider durability semantics.
      }
      failure = new DurableProviderError("unknown", "provider_outcome_unknown");
    }
    await this.control.completeTool({
      runId: identity.runId,
      leaseId: identity.leaseId,
      callId: identity.callId,
      status: failure.outcome === "terminal" ? "failed" : "outcome_unknown",
      safeErrorCode: failure.safeCode,
      ...(failure.pendingUsage ? {pendingUsage: failure.pendingUsage} : {}),
    });
    throw failure;
  }

  private async persistAndComplete(identity: DurableToolIdentity, result: TResult): Promise<TResult> {
    const persisted = await this.adapter.persist(identity.callId, result);
    if (!persisted.resultObjectKey || !/^[0-9a-f]{64}$/.test(persisted.resultHash)) {
      throw new DurableProviderError("terminal", "durable_tool_result_invalid");
    }
    await this.control.completeTool({
      runId: identity.runId,
      leaseId: identity.leaseId,
      callId: identity.callId,
      status: "succeeded",
      resultObjectKey: persisted.resultObjectKey,
      resultHash: persisted.resultHash,
    });
    return persisted.value;
  }
}
