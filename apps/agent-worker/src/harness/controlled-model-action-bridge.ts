import type { ModelTurnRequest, ModelTurnResult } from "../contracts/model.ts";
import { canonicalJson, sha256Hex } from "../kernel/tool-ledger.ts";
import { ToolGatewayError, type ToolGatewayResult } from "./scoped-tool-gateway.ts";
import type { HarnessModelToolCall } from "./unified-planning-tool-bridge.ts";

const CONTROLLED_ACTIONS = new Set([
  "record_intent_analysis",
  "request_clarification",
  "submit_plan_for_approval",
]);

function exactActionArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolGatewayError("tool_arguments_invalid");
  }
  return value as Record<string, unknown>;
}

function allowedActionNames(request: ModelTurnRequest): Set<string> {
  if (request.responseSchemaVersion !== 1 || !request.runId || !request.phase ||
      request.allowedActions.length < 1 || request.allowedActions.length > 2) {
    throw new Error("controlled_dsh_model_request_invalid");
  }
  const names = new Set<string>();
  for (const action of request.allowedActions) {
    if (!CONTROLLED_ACTIONS.has(action.name) || names.has(action.name) ||
        !action.description || !action.argumentSchema ||
        typeof action.argumentSchema !== "object" || Array.isArray(action.argumentSchema)) {
      throw new Error("controlled_dsh_model_request_invalid");
    }
    names.add(action.name);
  }
  return names;
}

/**
 * Parent-owned, side-effect-free bridge for one controlled ModelBackend turn.
 * DSH can emit one suggestion only; the existing planner/Kernel validates it.
 */
export class ControlledModelActionBridge {
  readonly runId: string;
  readonly phase: string;
  private readonly allowedActions: ReadonlySet<string>;
  private captured?: Extract<ModelTurnResult, { kind: "action" }>;

  constructor(request: ModelTurnRequest) {
    this.runId = request.runId;
    this.phase = request.phase;
    this.allowedActions = allowedActionNames(request);
  }

  get actionResult(): Extract<ModelTurnResult, { kind: "action" }> | undefined {
    return this.captured;
  }

  async dispatch(call: HarnessModelToolCall): Promise<ToolGatewayResult> {
    if (!CONTROLLED_ACTIONS.has(call.toolName) || !this.allowedActions.has(call.toolName)) {
      throw new ToolGatewayError("tool_not_allowed");
    }
    if (this.captured) throw new ToolGatewayError("tool_sequence_invalid");
    const argumentsValue = exactActionArguments(call.arguments);
    this.captured = {
      kind: "action",
      action: call.toolName,
      arguments: argumentsValue,
      // The parent metered DeepSeek proxy writes authoritative usage directly.
      providerUsage: {},
    };
    return {
      callId: sha256Hex(canonicalJson({
        schemaVersion: 1,
        runId: this.runId,
        phase: this.phase,
        action: call.toolName,
      })),
      value: {
        schemaVersion: 1,
        accepted: true,
        terminalReason: "model_action_captured",
      },
    };
  }
}
