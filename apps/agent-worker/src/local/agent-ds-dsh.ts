// Agent DS 对话 turn（DSH 版；dev-only）。拉起本地 DSH harness 作为 Agent loop：
// 模型多回合、上下文与工具选择归 DSH（与 Agent Z 拉 Claude Code 同类定位，只是
// 模型/harness 不同）；Bowerbird 能力（dreamina_generate / understand_asset）经
// loopback 工具桥 → .agent-z/rpc 文件契约由桌面端执行。deepseek-flash 为多模态，
// 参考图以 ACP image block 直接附给模型；understand_asset 保留为聚焦反推/入库维度。
// ACP rc.2 无 session resume，每个用户消息一个 fresh DSH session；跨轮对话历史以
// transcript 文本注入 prompt（云端 checkpoint 重建同式）。会话文件只在整轮成功后
// 写回（回滚语义）：失败轮不落盘，用户原样重发即可。

import type { HarnessPromptBlock } from "../harness/contracts.ts";
import { ToolGatewayError, type ToolGatewayResult } from "../harness/scoped-tool-gateway.ts";
import type { PlanningToolDispatchPort } from "../harness/loopback-tool-bridge-server.ts";

/** 回传事件（写 .agent-z/inbox/<ts>.json，桌面端 watcher → agent-z://output）：
 *  ds_reply = 终答文本；ds_status = 阶段通知（tool/done/error，done 文本为空）。 */
export type AgentDsEvent =
  | { kind: "ds_reply"; text: string }
  | { kind: "ds_status"; phase: "tool" | "done" | "error"; text: string };

/** 会话文件（.agent-z/ds-session.json）v2：按轮存 user/assistant 文本与参考图路径。
 *  v1（直连循环的 OpenAI messages）不迁移——读取失败按现状容忍为新建。 */
export type AgentDsTurn = { role: "user" | "assistant"; text: string; images?: string[] };

export type AgentDsSession = {
  version: 2;
  createdAt: string;
  turns: AgentDsTurn[];
};

/** runner 眼中的 DSH 会话：一个 prompt（含若干 text/image block）→ committed 文本。 */
export type AgentDsDshSession = {
  prompt(blocks: HarnessPromptBlock[], onText: (chunk: string) => void): Promise<{ stopReason: string }>;
  dispose(): Promise<void>;
};

export type AgentDsImageFile = { mimeType: string; base64: string };

export type AgentDsDshDeps = {
  openSession(): Promise<AgentDsDshSession>;
  /** 读参考图为 base64；不存在/不支持的类型返回 null（退化为路径注记）。 */
  readImageFile(path: string): AgentDsImageFile | null;
  emit(event: AgentDsEvent): void;
};

export const TOOL_LABELS: Record<string, string> = {
  dreamina_generate: "Agent DS 正在生成图片（即梦）…",
  understand_asset: "Agent DS 正在反推图片…",
};

export const AGENT_DS_TOOL_NAMES = ["dreamina_generate", "understand_asset"] as const;

/** 内联附图上限：DSH 附件层按模型预算投影每图（默认 ≤1 MiB），累计 6 MiB 走到
 *  代理的 8 MiB 请求上限前留出文本余量；超出部分仅以路径注记（可 understand_asset）。 */
export const MAX_INLINE_IMAGES = 6;
const MAX_INLINE_TOTAL_BYTES = 6 * 1024 * 1024;

/** 历史裁剪：最近 10 个 user/assistant 对，且总字符 ≤16000（超出从最旧开始丢整对）。 */
const MAX_HISTORY_PAIRS = 10;
const MAX_HISTORY_CHARS = 16_000;

export function newAgentDsSession(): AgentDsSession {
  return { version: 2, createdAt: new Date().toISOString(), turns: [] };
}

export function isAgentDsSession(value: unknown): value is AgentDsSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 2 && Array.isArray(record.turns);
}

function turnText(turn: AgentDsTurn): string {
  const label = turn.role === "user" ? "用户" : "助手";
  const images = turn.role === "user" && turn.images?.length
    ? `（参考图：${turn.images.join("、")}）`
    : "";
  return `${label}：${turn.text}${images}`;
}

export function trimHistory(turns: AgentDsTurn[]): AgentDsTurn[] {
  const tail = turns.slice(-MAX_HISTORY_PAIRS * 2);
  let kept = tail;
  while (kept.length > 2) {
    const total = kept.reduce((sum, turn) => sum + turnText(turn).length, 0);
    if (total <= MAX_HISTORY_CHARS) break;
    // 裁剪不产生孤立的 assistant 开头：成对从最旧移除
    const drop = kept[0]?.role === "user" ? 2 : 1;
    kept = kept.slice(drop);
  }
  return kept;
}

/** 组装 prompt 文本：历史 transcript + 本次消息 + 全部参考图路径注记（内联与否都列出，
 *  模型把路径回填进 dreamina_generate.images）。内联附图由 runAgentDsDshTurn 追加。 */
export function composeAgentDsPromptText(session: AgentDsSession, text: string, images: string[]): string {
  const history = trimHistory(session.turns);
  const sections: string[] = [];
  if (history.length) {
    sections.push(["[历史对话]", ...history.map(turnText)].join("\n"));
  }
  const current = [`[用户本次消息]\n${text}`];
  if (images.length) current.push(`参考图绝对路径（供 dreamina_generate.images 回填）：\n${images.map((path) => `- ${path}`).join("\n")}`);
  sections.push(current.join("\n\n"));
  return sections.join("\n\n");
}

/** loopback 工具桥的父进程侧分发：白名单两工具 → 通知事件 → rpc 文件契约。
 *  失败不抛给 DSH，而是作为工具结果值回传（模型自纠），与旧直连循环一致。 */
export function createAgentDsToolDispatch(deps: {
  rpc(tool: string, args: unknown): Promise<unknown>;
  emit(event: AgentDsEvent): void;
}): PlanningToolDispatchPort {
  let seq = 0;
  return {
    async dispatch(call: { toolName: string; arguments: unknown }): Promise<ToolGatewayResult> {
      if (!(AGENT_DS_TOOL_NAMES as readonly string[]).includes(call.toolName)) {
        throw new ToolGatewayError("tool_not_registered");
      }
      const callId = `agent-ds-${Date.now()}-${String(seq++).padStart(4, "0")}`;
      deps.emit({ kind: "ds_status", phase: "tool", text: TOOL_LABELS[call.toolName] ?? call.toolName });
      try {
        const result = await deps.rpc(call.toolName, call.arguments);
        return { callId, value: { ok: true, result } };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Bowerbird 工具执行失败";
        return { callId, value: { ok: false, error: message } };
      }
    },
  };
}

export class AgentDsChatError extends Error {
  readonly safeCode: string;
  constructor(safeCode: string) {
    super(safeCode);
    this.name = "AgentDsChatError";
    this.safeCode = safeCode;
  }
}

/** 跑一个用户消息轮：fresh DSH session → prompt（文本 + 内联图）→ committed 文本。
 *  成功返回追加了本轮 user/assistant 的新会话；失败抛错（调用方不写回旧会话）。 */
export async function runAgentDsDshTurn(
  deps: AgentDsDshDeps,
  session: AgentDsSession,
  text: string,
  images: string[],
): Promise<AgentDsSession> {
  const promptText = composeAgentDsPromptText(session, text, images);
  const blocks: HarnessPromptBlock[] = [{ type: "text", text: promptText }];
  const inline: string[] = [];
  const noted: string[] = [];
  let inlineBytes = 0;
  for (const path of images) {
    const file = inline.length < MAX_INLINE_IMAGES && inlineBytes < MAX_INLINE_TOTAL_BYTES
      ? deps.readImageFile(path)
      : null;
    if (file) {
      inline.push(path);
      inlineBytes += file.base64.length;
      blocks.push({ type: "image", mimeType: file.mimeType, data: file.base64 });
    } else {
      noted.push(path);
    }
  }
  if (inline.length || noted.length) {
    const notes: string[] = [];
    if (inline.length) {
      notes.push(`以上已直接附上 ${inline.length} 张参考图，可直接查看：\n${inline.map((path) => `- ${path}`).join("\n")}`);
    }
    if (noted.length) {
      notes.push(`以下参考图仅提供路径、未附上，需要看图时用 understand_asset：\n${noted.map((path) => `- ${path}`).join("\n")}`);
    }
    blocks[0] = { type: "text", text: `${promptText}\n\n${notes.join("\n\n")}` };
  }

  const dsh = await deps.openSession();
  let committed = "";
  try {
    const result = await dsh.prompt(blocks, (chunk) => {
      committed += chunk;
    });
    if (result.stopReason !== "end_turn") {
      throw new AgentDsChatError(`agent_ds_turn_${result.stopReason}`);
    }
    const reply = committed.trim();
    if (!reply) throw new AgentDsChatError("agent_ds_empty_reply");
    deps.emit({ kind: "ds_reply", text: reply });
    return {
      ...session,
      turns: [
        ...session.turns,
        { role: "user", text, ...(images.length ? { images } : {}) },
        { role: "assistant", text: reply },
      ],
    };
  } finally {
    await dsh.dispose();
  }
}
