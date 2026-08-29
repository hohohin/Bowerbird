import { deepEqual, equal, rejects } from "node:assert/strict";
import { test } from "node:test";

import type { PreparedToolCall } from "../control-plane/agent-control-client.ts";
import {
  DurableToolDispatcher,
  SimulatedProcessCrash,
  type DurableToolAdapter,
  type DurableToolControl,
  type DurableToolIdentity,
} from "../kernel/durable-tool-dispatcher.ts";
import { sha256Hex } from "../kernel/tool-ledger.ts";
import { ScopedToolGateway, type ToolGatewayDefinition } from "./scoped-tool-gateway.ts";

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

  async markToolSubmitted(args: Pick<DurableToolIdentity, "runId" | "leaseId" | "callId">) {
    const row = this.required(args.callId);
    row.status = "submitted";
    return row;
  }

  async completeTool(args: Pick<DurableToolIdentity, "runId" | "leaseId" | "callId"> & {
    status: "succeeded" | "failed" | "outcome_unknown";
    resultObjectKey?: string;
    resultHash?: string;
  }) {
    const row = this.required(args.callId);
    row.status = args.status;
    row.resultObjectKey = args.resultObjectKey;
    row.resultHash = args.resultHash;
    return row;
  }

  private required(callId: string) {
    const row = this.rows.get(callId);
    if (!row) throw new Error("missing_tool_row");
    return row;
  }
}

type ToolRequest = { prompt: string };
type ToolResult = { artifactId: string };

class RecoverableTool implements DurableToolAdapter<unknown, unknown> {
  executeCount = 0;
  readonly upstream = new Map<string, ToolResult>();
  readonly stored = new Map<string, ToolResult>();

  async execute(callId: string, requestValue: unknown) {
    const request = requestValue as ToolRequest;
    this.executeCount++;
    const result = { artifactId: `artifact-${sha256Hex(request.prompt).slice(0, 8)}` };
    this.upstream.set(callId, result);
    return result;
  }

  async reconcile(callId: string) {
    return this.upstream.get(callId) ?? null;
  }

  async persist(callId: string, resultValue: unknown) {
    const result = resultValue as ToolResult;
    this.stored.set(callId, result);
    return {
      value: result,
      resultObjectKey: `runs/run-u2/tool-results/${callId}.json`,
      resultHash: sha256Hex(JSON.stringify(result)),
    };
  }

  async restore(record: PreparedToolCall) {
    const result = this.stored.get(record.callId);
    if (!result) throw new Error("stored_result_missing");
    return result;
  }
}

function validateRequest(value: unknown): ToolRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.prompt !== "string" || !record.prompt) {
    throw new Error("invalid");
  }
  return { prompt: record.prompt };
}

function definition(dispatcher: DurableToolDispatcher<unknown, unknown>): ToolGatewayDefinition {
  return {
    name: "generate_image",
    allowedPhases: ["execute_approved_plan"],
    requiresApproval: true,
    validate: validateRequest,
    execution: "durable",
    dispatcher,
  };
}

const baseRequest = {
  runId: "run-u2",
  leaseId: "lease-u2",
  phase: "execute_approved_plan",
  toolName: "generate_image",
  arguments: { prompt: "approved prompt" },
  trustedSlot: { logicalSlot: 2, revisionIndex: 0 },
  allowedTools: new Set(["generate_image"]),
  approvedPlanHash: "f".repeat(64),
};

test("Gateway rejects unregistered, unallowed, wrong-phase, and model-injected identity before side effects", async () => {
  const control = new MemoryControl();
  const tool = new RecoverableTool();
  const gateway = new ScopedToolGateway([definition(new DurableToolDispatcher(control, tool))]);

  await rejects(() => gateway.dispatch({ ...baseRequest, toolName: "bash" }), /tool_not_registered/);
  await rejects(() => gateway.dispatch({ ...baseRequest, allowedTools: new Set() }), /tool_not_allowed/);
  await rejects(() => gateway.dispatch({ ...baseRequest, phase: "compose_plan" }), /tool_phase_denied/);
  await rejects(
    () => gateway.dispatch({ ...baseRequest, approvedPlanHash: undefined }),
    /tool_approval_required/,
  );
  await rejects(
    () => gateway.dispatch({ ...baseRequest, arguments: { prompt: "approved prompt", callId: "model-owned" } }),
    /tool_arguments_invalid/,
  );
  equal(tool.executeCount, 0);
  equal(control.rows.size, 0);
});

test("Gateway rebuild reuses stable call id and reconciles submitted side effect exactly once", async () => {
  const control = new MemoryControl();
  const tool = new RecoverableTool();
  const crashing = new DurableToolDispatcher(control, tool, {
    afterExecute: () => { throw new SimulatedProcessCrash(); },
  });
  const beforeCrash = new ScopedToolGateway([definition(crashing)]);
  await rejects(() => beforeCrash.dispatch(baseRequest), /simulated_process_crash/);
  equal(tool.executeCount, 1);
  const [submitted] = [...control.rows.values()];
  equal(submitted?.status, "submitted");

  const afterCrash = new ScopedToolGateway([
    definition(new DurableToolDispatcher(control, tool)),
  ]);
  const recovered = await afterCrash.dispatch(baseRequest);
  const replayed = await afterCrash.dispatch(baseRequest);
  equal(recovered.callId, replayed.callId);
  deepEqual(recovered.value, replayed.value);
  equal(tool.executeCount, 1);
  equal(control.rows.get(recovered.callId)?.status, "succeeded");

  await rejects(
    () => afterCrash.dispatch({ ...baseRequest, arguments: { prompt: "drifted prompt" } }),
    /call_id_args_hash_conflict/,
  );
  equal(tool.executeCount, 1);
});
