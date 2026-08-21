import { equal, rejects } from "node:assert/strict";
import { test } from "node:test";

import type { PreparedToolCall } from "../control-plane/agent-control-client.ts";
import { sha256Hex } from "./tool-ledger.ts";
import {
  DurableToolDispatcher,
  SimulatedProcessCrash,
  type DurableToolAdapter,
  type DurableToolControl,
  type DurableToolIdentity,
} from "./durable-tool-dispatcher.ts";

type Request = { prompt: string };
type Result = { artifactId: string; sha256: string };

class MemoryControl implements DurableToolControl {
  readonly rows = new Map<string, PreparedToolCall & { argsHash: string }>();

  async prepareTool(args: DurableToolIdentity & { argsHash: string }): Promise<PreparedToolCall> {
    const existing = this.rows.get(args.callId);
    if (existing) {
      if (existing.argsHash !== args.argsHash) throw new Error("call_id_args_hash_conflict");
      return { ...existing, reused: true };
    }
    const row: PreparedToolCall & { argsHash: string } = {
      callId: args.callId,
      status: "prepared",
      reused: false,
      argsHash: args.argsHash,
    };
    this.rows.set(args.callId, row);
    return row;
  }

  async markToolSubmitted(args: Pick<DurableToolIdentity, "runId" | "leaseId" | "callId">): Promise<PreparedToolCall> {
    const row = this.required(args.callId);
    row.status = "submitted";
    return row;
  }

  async completeTool(args: Pick<DurableToolIdentity, "runId" | "leaseId" | "callId"> & {
    status: "succeeded" | "failed" | "outcome_unknown";
    resultObjectKey?: string;
    resultHash?: string;
    safeErrorCode?: string;
  }): Promise<PreparedToolCall> {
    const row = this.required(args.callId);
    row.status = args.status;
    row.resultObjectKey = args.resultObjectKey;
    row.resultHash = args.resultHash;
    return row;
  }

  private required(callId: string): PreparedToolCall & { argsHash: string } {
    const row = this.rows.get(callId);
    if (!row) throw new Error("missing_tool_row");
    return row;
  }
}

class RecoverableFakeImageTool implements DurableToolAdapter<Request, Result> {
  executeCount = 0;
  readonly upstream = new Map<string, Result>();
  readonly stored = new Map<string, Result>();

  async execute(callId: string, request: Request): Promise<Result> {
    this.executeCount++;
    const result = { artifactId: `artifact-${callId}`, sha256: sha256Hex(request.prompt) };
    this.upstream.set(callId, result);
    return result;
  }

  async reconcile(callId: string): Promise<Result | null> {
    return this.upstream.get(callId) ?? null;
  }

  async persist(callId: string, result: Result) {
    this.stored.set(callId, result);
    return {
      value: result,
      resultObjectKey: `runs/run-1/tool-results/${callId}.json`,
      resultHash: sha256Hex(JSON.stringify(result)),
    };
  }

  async restore(record: PreparedToolCall): Promise<Result> {
    const result = this.stored.get(record.callId);
    if (!result) throw new Error("stored_result_missing");
    return result;
  }
}

const identity: DurableToolIdentity = {
  runId: "run-1",
  leaseId: "lease-1",
  callId: "call-1",
  phase: "execute_approved_plan",
  toolName: "generate_image",
};

test("kill after upstream result resumes by reconciliation without a second side effect", async () => {
  const control = new MemoryControl();
  const tool = new RecoverableFakeImageTool();
  const crashing = new DurableToolDispatcher(control, tool, {
    afterExecute: () => { throw new SimulatedProcessCrash(); },
  });
  await rejects(() => crashing.dispatch(identity, { prompt: "one image" }), /simulated_process_crash/);
  equal(tool.executeCount, 1);
  equal(control.rows.get(identity.callId)?.status, "submitted");

  const resumed = new DurableToolDispatcher(control, tool);
  const result = await resumed.dispatch(identity, { prompt: "one image" });
  equal(result.artifactId, "artifact-call-1");
  equal(tool.executeCount, 1);
  equal(control.rows.get(identity.callId)?.status, "succeeded");

  const replayed = await resumed.dispatch(identity, { prompt: "one image" });
  equal(replayed.artifactId, result.artifactId);
  equal(tool.executeCount, 1);
});

test("same call id with changed normalized arguments fails closed", async () => {
  const control = new MemoryControl();
  const tool = new RecoverableFakeImageTool();
  const dispatcher = new DurableToolDispatcher(control, tool);
  await dispatcher.dispatch(identity, { prompt: "approved prompt" });
  await rejects(() => dispatcher.dispatch(identity, { prompt: "changed prompt" }), /call_id_args_hash_conflict/);
  equal(tool.executeCount, 1);
});
