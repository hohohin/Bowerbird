/**
 * FakeModel —— 确定性、可脚本化的 ModelBackend（M0 eval 专用）。
 *
 * 不调用任何真实模型；按预编排脚本逐回合产出 action/message/refusal。
 * 用于：驱动最小智能精修状态流程、注入对抗性动作验证 Kernel 拒绝。
 * 真实 Ark ModelBackend adapter 属于 A3，不在 M0。
 */

import type {
  ModelBackend,
  ModelTurnRequest,
  ModelTurnResult,
  ProviderUsage,
} from "../contracts/model.ts";

export type ScriptedTurn =
  | ModelTurnResult
  | ((req: ModelTurnRequest) => ModelTurnResult);

const NO_USAGE: ProviderUsage = { totalTokens: 0 };

/** 用一组「动作」快速构造脚本。 */
export function scriptedActions(
  actions: Array<{ action: string; arguments?: unknown }>,
): ScriptedTurn[] {
  return actions.map((a) => ({
    kind: "action" as const,
    action: a.action,
    arguments: a.arguments ?? {},
    providerUsage: { ...NO_USAGE },
  }));
}

export class FakeModel implements ModelBackend {
  readonly id = "fake" as const;
  private readonly script: ScriptedTurn[];
  /** 记录每次收到的 request，供 eval 断言上下文组装（如 allowedActions）。 */
  readonly requests: ModelTurnRequest[] = [];

  constructor(script: ScriptedTurn[]) {
    this.script = [...script];
  }

  async turn(
    request: ModelTurnRequest,
    signal: { readonly aborted: boolean },
  ): Promise<ModelTurnResult> {
    this.requests.push(request);
    if (signal.aborted) {
      return { kind: "refusal", reason: "aborted", providerUsage: { ...NO_USAGE } };
    }
    const next = this.script.shift();
    if (next === undefined) {
      return { kind: "refusal", reason: "script_exhausted", providerUsage: { ...NO_USAGE } };
    }
    return typeof next === "function" ? next(request) : next;
  }

  /** 剩余未消费脚本数（eval 断言「脚本是否如期耗尽」）。 */
  remaining(): number {
    return this.script.length;
  }
}
