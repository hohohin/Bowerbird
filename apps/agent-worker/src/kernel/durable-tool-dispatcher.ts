import type { PreparedToolCall } from "../control-plane/agent-control-client.ts";
import { computeArgsHash } from "./tool-ledger.ts";

export type DurableToolIdentity = {
  runId: string;
  leaseId: string;
  callId: string;
  phase: string;
  toolName: string;
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
  reconcile(callId: string, request: TRequest): Promise<TResult | null>;
  /** Persist normalized result before tool_complete. */
  persist(callId: string, result: TResult): Promise<PersistedToolResult<TResult>>;
  /** Restore a succeeded call from resultObjectKey/resultHash. */
  restore(record: PreparedToolCall): Promise<TResult>;
}

export class DurableProviderError extends Error {
  readonly outcome: "terminal" | "unknown";
  readonly safeCode: string;

  constructor(outcome: "terminal" | "unknown", safeCode: string) {
    super(safeCode);
    this.name = "DurableProviderError";
    this.outcome = outcome;
    this.safeCode = safeCode;
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

  constructor(
    control: DurableToolControl,
    adapter: DurableToolAdapter<TRequest, TResult>,
    options: { afterExecute?: () => void } = {},
  ) {
    this.control = control;
    this.adapter = adapter;
    this.afterExecute = options.afterExecute;
  }

  async dispatch(identity: DurableToolIdentity, request: TRequest): Promise<TResult> {
    const argsHash = computeArgsHash(request);
    let record = await this.control.prepareTool({ ...identity, argsHash });
    if (record.status === "succeeded") return await this.adapter.restore(record);
    if (record.status === "failed") {
      throw new DurableProviderError("terminal", record.safeErrorCode ?? "durable_tool_previously_failed");
    }

    try {
      if (record.status === "submitted" || record.status === "outcome_unknown") {
        const reconciled = await this.adapter.reconcile(identity.callId, request);
        if (reconciled === null) {
          const safeErrorCode = record.safeErrorCode ?? "provider_outcome_unknown";
          await this.control.completeTool({
            runId: identity.runId,
            leaseId: identity.leaseId,
            callId: identity.callId,
            status: "outcome_unknown",
            safeErrorCode,
          });
          throw new DurableProviderError("unknown", safeErrorCode);
        }
        return await this.persistAndComplete(identity, reconciled);
      }

      record = await this.control.markToolSubmitted({
        runId: identity.runId,
        leaseId: identity.leaseId,
        callId: identity.callId,
      });
      if (record.status === "succeeded") return await this.adapter.restore(record);
      const result = await this.adapter.execute(identity.callId, request);
      this.afterExecute?.();
      return await this.persistAndComplete(identity, result);
    } catch (error) {
      if (error instanceof SimulatedProcessCrash) throw error;
      if (error instanceof DurableProviderError) {
        if (error.safeCode !== "provider_outcome_unknown") {
          await this.control.completeTool({
            runId: identity.runId,
            leaseId: identity.leaseId,
            callId: identity.callId,
            status: error.outcome === "terminal" ? "failed" : "outcome_unknown",
            safeErrorCode: error.safeCode,
          });
        }
        throw error;
      }
      await this.control.completeTool({
        runId: identity.runId,
        leaseId: identity.leaseId,
        callId: identity.callId,
        status: "outcome_unknown",
        safeErrorCode: "provider_outcome_unknown",
      });
      throw new DurableProviderError("unknown", "provider_outcome_unknown");
    }
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
