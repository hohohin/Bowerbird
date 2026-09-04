import type { DurableToolIdentity } from "../kernel/durable-tool-dispatcher.ts";
import { deriveCallId } from "../kernel/tool-ledger.ts";

type ToolGatewayDefinitionBase = {
  name: string;
  allowedPhases: readonly string[];
  /** 高成本/有副作用工具必须绑定控制面已批准的 proposal hash。 */
  requiresApproval?: boolean;
  /** 工具由批准计划实例化时，必须精确绑定该计划；只校验“存在某个 hash”不够。 */
  approvedPlanHash?: string;
  validate(argumentsValue: unknown): unknown;
};

export type ToolGatewayControlDispatcher = {
  /**
   * Bowerbird 控制面动作（只读查询、停车等）的窄端口。实现必须用传入的
   * callId/argsHash 保证重放幂等；外部 provider 副作用不得使用此分支。
   */
  dispatch(identity: DurableToolIdentity, argumentsValue: unknown): Promise<unknown>;
};

export type ToolGatewayDurableDispatcher = {
  /** Provider 副作用必须由实现内部的 DurableToolDispatcher 覆盖。 */
  dispatch(identity: DurableToolIdentity, argumentsValue: unknown): Promise<unknown>;
};

export type ToolGatewayDefinition = ToolGatewayDefinitionBase & ({
  execution: "durable";
  dispatcher: ToolGatewayDurableDispatcher;
} | {
  execution: "control";
  dispatcher: ToolGatewayControlDispatcher;
});

export type ToolGatewayRequest = {
  runId: string;
  leaseId: string;
  phase: string;
  toolName: string;
  arguments: unknown;
  /** 由批准计划/Kernel 提供，不接受模型自报 call_id。 */
  trustedSlot: { logicalSlot: number; revisionIndex: number };
  /** 当前 Global ∩ Skill ∩ Run ∩ FeaturePolicy 的最终交集。 */
  allowedTools: ReadonlySet<string>;
  /** 来自可信 claim/checkpoint，不接受模型参数中的同名字段。 */
  approvedPlanHash?: string;
};

export type ToolGatewayResult = {
  callId: string;
  value: unknown;
};

export class ToolGatewayError extends Error {
  readonly code:
    | "tool_not_registered"
    | "tool_not_allowed"
    | "tool_phase_denied"
    | "tool_approval_required"
    | "tool_arguments_invalid"
    | "tool_sequence_invalid"
    | "trusted_slot_invalid";

  constructor(code: ToolGatewayError["code"]) {
    super(code);
    this.name = "ToolGatewayError";
    this.code = code;
  }
}

export class ScopedToolGateway {
  private readonly definitions: ReadonlyMap<string, ToolGatewayDefinition>;

  constructor(definitions: readonly ToolGatewayDefinition[]) {
    const byName = new Map<string, ToolGatewayDefinition>();
    for (const definition of definitions) {
      if (!definition.name || byName.has(definition.name)) {
        throw new ToolGatewayError("tool_not_registered");
      }
      byName.set(definition.name, definition);
    }
    this.definitions = byName;
  }

  async dispatch(request: ToolGatewayRequest): Promise<ToolGatewayResult> {
    const definition = this.definitions.get(request.toolName);
    if (!definition) throw new ToolGatewayError("tool_not_registered");
    if (!request.allowedTools.has(request.toolName)) throw new ToolGatewayError("tool_not_allowed");
    if (!definition.allowedPhases.includes(request.phase)) {
      throw new ToolGatewayError("tool_phase_denied");
    }
    if (definition.requiresApproval) {
      const approvedPlanHash = request.approvedPlanHash ?? "";
      if (!/^[0-9a-f]{64}$/.test(approvedPlanHash) ||
          (definition.approvedPlanHash !== undefined && definition.approvedPlanHash !== approvedPlanHash)) {
        throw new ToolGatewayError("tool_approval_required");
      }
    }
    if (
      !Number.isSafeInteger(request.trustedSlot.logicalSlot) ||
      request.trustedSlot.logicalSlot < 0 ||
      !Number.isSafeInteger(request.trustedSlot.revisionIndex) ||
      request.trustedSlot.revisionIndex < 0
    ) {
      throw new ToolGatewayError("trusted_slot_invalid");
    }

    let validatedArguments: unknown;
    try {
      validatedArguments = definition.validate(request.arguments);
    } catch {
      throw new ToolGatewayError("tool_arguments_invalid");
    }

    const callId = deriveCallId({
      runId: request.runId,
      phase: request.phase,
      logicalSlot: request.trustedSlot.logicalSlot,
      revisionIndex: request.trustedSlot.revisionIndex,
    });
    const value = await definition.dispatcher.dispatch(
      {
        runId: request.runId,
        leaseId: request.leaseId,
        callId,
        phase: request.phase,
        toolName: request.toolName,
      },
      validatedArguments,
    );
    return { callId, value };
  }
}
