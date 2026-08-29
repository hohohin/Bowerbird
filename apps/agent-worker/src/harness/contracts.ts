/**
 * 通用 Harness 边界。DSH session 只承载模型上下文；Bowerbird checkpoint
 * 与 Tool Ledger 才是可恢复的业务事实源。
 */

export type HarnessCheckpointSeed = {
  schemaVersion: 1;
  runId: string;
  checkpointVersion: number;
  phase: string;
  approvedPlanHash?: string;
  compactedFacts: unknown[];
  completedToolResults: Array<{
    callId: string;
    toolName: string;
    argsHash: string;
    result: unknown;
  }>;
};

export type HarnessPromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

export type HarnessTurnResult = {
  stopReason: "end_turn" | "cancelled" | "max_tokens" | string;
  committedContent: HarnessPromptBlock[];
};

export interface HarnessSession {
  readonly sessionId: string;
  readonly runId: string;
  /** 只返回 committed answer；隐藏思维链不进入 Bowerbird 事件。 */
  turn(prompt: HarnessPromptBlock[]): Promise<HarnessTurnResult>;
  cancel(): Promise<void>;
  /** 当前 DSH rc 使用连接级关闭；不得假装调用不存在的 ACP session/close。 */
  close(): Promise<void>;
}

export interface HarnessAdapter {
  readonly id: string;
  /** 每次都创建 fresh session；恢复数据由 Bowerbird checkpoint 显式重建。 */
  open(seed: HarnessCheckpointSeed): Promise<HarnessSession>;
}
