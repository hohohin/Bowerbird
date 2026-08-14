/**
 * ToolLedger 纯函数（v1）—— 依据 AGENT-RUNTIME-PLAN.md §7.8。
 *
 * 稳定 call_id 派生 + 规范化 args_hash + 幂等结果 memo。
 * 这些是确定性的纯函数，Kernel 与 eval 复用；不含任何 I/O。
 */

import { createHash } from "node:crypto";
import type { CallIdComponents, ToolCall } from "../contracts/tools.ts";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 递归排序对象 key，产出规范化 JSON 字符串（args_hash 用）。数组顺序保留。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .filter((k) => {
      const v = (value as Record<string, unknown>)[k];
      return v !== undefined;
    })
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

export function computeArgsHash(args: unknown): string {
  return sha256Hex(canonicalJson(args));
}

/**
 * 派生稳定 call_id：run_id + phase + logical_slot + revision_index（§7.8）。
 * 模型重复请求相同逻辑动作 → 同 call_id → 复用既有结果，不重复扣费/生成。
 */
export function deriveCallId(c: CallIdComponents): string {
  return sha256Hex(`call|${c.runId}|${c.phase}|${c.logicalSlot}|${c.revisionIndex}`);
}

/** in-memory 幂等账本：call_id -> 已记录的 tool call。 */
export class ToolLedger {
  private readonly calls = new Map<string, ToolCall>();

  has(callId: string): boolean {
    return this.calls.has(callId);
  }

  get(callId: string): ToolCall | undefined {
    return this.calls.get(callId);
  }

  /**
   * 若同 call_id 且 args_hash 一致 → 返回既有结果（幂等，不重复执行）。
   * args_hash 变化但 call_id 相同 → 仅当 Skill 允许 revision 才产生新 call；
   * 否则视为模型漂移，拒绝（返回 conflict）。
   */
  remember(call: ToolCall): void {
    this.calls.set(call.callId, call);
  }

  snapshot(): ToolCall[] {
    return [...this.calls.values()];
  }
}

/** 判断「同 call_id、args_hash 一致」的复用条件。 */
export function isIdempotentReuse(
  existing: ToolCall | undefined,
  argsHash: string,
): existing is ToolCall {
  return !!existing && existing.argsHash === argsHash;
}
