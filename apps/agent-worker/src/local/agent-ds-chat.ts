// Agent DS 对话 loop（dev-only；桌面端经 agent-ds-chat-cli.ts detached 拉起）。
// 一轮用户消息 → 至多 MAX_MODEL_TURNS 个 DeepSeek 回合（deepseek-chat，tool calling）：
// 模型要么回纯文本（终答，写 ds_reply 事件 → 创作板追加），要么调工具
// （dreamina_generate / understand_asset，经 .agent-z/rpc 文件契约回 Bowerbird 桌面端执行，
// 与 Agent Z 的 MCP 桥同一契约）→ 工具结果以 role:"tool" 回注继续下一回合。
// DeepSeek 无视觉：模型看不到图片本身，看图必须走 understand_asset（系统提示词约束）。
// 这是约定 36 的姊妹实验（对话面 = 创作板），不是约定 25 的 Agent Kernel / Skill Runtime。

import type {
  ChatMessage,
  ChatTool,
  ChatToolCall,
  ChatTurnResult,
} from "../providers/deepseek/backend.ts";

/** 回传事件（写 .agent-z/inbox/<ts>.json，桌面端 watcher → agent-z://output）：
 *  ds_reply = 终答文本；ds_status = 阶段通知（tool/done/error，done 文本为空）。 */
export type AgentDsEvent =
  | { kind: "ds_reply"; text: string }
  | { kind: "ds_status"; phase: "tool" | "done" | "error"; text: string };

/** 会话文件（.agent-z/ds-session.json）：messages 不含 system——每次运行时前置，
 *  改系统提示词对进行中的会话即时生效。 */
export type AgentDsSession = {
  version: 1;
  createdAt: string;
  messages: ChatMessage[];
};

export type AgentDsChatDeps = {
  chat: (
    messages: ChatMessage[],
    tools: ChatTool[],
    signal: { aborted: boolean },
  ) => Promise<ChatTurnResult>;
  /** 能力 RPC（.agent-z/rpc 文件契约）；失败 reject，loop 转成工具错误结果回给模型自纠。 */
  rpc: (tool: string, args: unknown) => Promise<unknown>;
  emit: (event: AgentDsEvent) => void;
};

export class AgentDsChatError extends Error {
  readonly safeCode: string;
  constructor(safeCode: string) {
    super(safeCode);
    this.name = "AgentDsChatError";
    this.safeCode = safeCode;
  }
}

export const AGENT_DS_SYSTEM_PROMPT = [
  "你是 Bowerbird 桌面应用内嵌的「Agent DS」生图对话助手，不是编码助手。",
  "只围绕用户的图片创作诉求思考、追问与行动：dreamina_generate 生图（产物自动存入素材库并出现在瀑布流）、understand_asset 反推看图。",
  "你看不到图片本身——用户给出参考图绝对路径后，需要了解其内容时必须先调用 understand_asset 获取描述，不要凭空猜测画面。",
  "回复用中文、简明直接；用户要生图时先把完整提示词组织清楚再调用工具，生成后结合工具返回的图片路径说明结果。",
  "禁止阅读或修改任何代码，禁止对 Bowerbird 项目本身提出建议或分析其实现。",
].join("\n");

const TOOL_LABELS: Record<string, string> = {
  dreamina_generate: "Agent DS 正在生成图片（即梦）…",
  understand_asset: "Agent DS 正在反推图片…",
};

export const AGENT_DS_TOOLS: ChatTool[] = [
  {
    type: "function",
    function: {
      name: "dreamina_generate",
      description:
        "用即梦（Dreamina，火山引擎）生成图片并自动存入 Bowerbird 素材库（瀑布流可见），返回生成图的资产 id 与路径。" +
        "涉及生图时必须用本工具，不要自己调 CLI 或编造结果。需要 Bowerbird 桌面端运行中。",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "完整生图提示词" },
          images: {
            type: "array",
            items: { type: "string" },
            description: "参考图绝对路径（可选，最多 10 张）",
          },
          ratio: { type: "string", description: "画面比例，如 16:9 / 1:1（可选，默认自动）" },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "understand_asset",
      description:
        "对一张参考图执行反推（图像理解）。你看不到图片本身——需要了解任何参考图的内容时先调用本工具。" +
        "可用自定义指令聚焦画面某部分；结果以 agentz-<时间> 新维度追加到该图已有维度数据之后（不覆盖现有维度）。" +
        "需要 Bowerbird 桌面端运行中。",
      parameters: {
        type: "object",
        properties: {
          image_path: { type: "string", description: "素材库内图片的绝对路径（store_path）" },
          prompt: {
            type: "string",
            description: "自定义反推指令（可选，≤4000 字符）。例：『着重描述画面右侧人物的动作与穿着，忽略背景』；不传则用应用默认指令",
          },
        },
        required: ["image_path"],
      },
    },
  },
];

export const MAX_MODEL_TURNS = 8;
export const MAX_TOOL_CALLS_PER_TURN = 3;
/** 历史裁剪上限（条，不含 system）。单轮最多 1+8×(1+3)+1=34 条，连续两轮内必有 user 消息。 */
export const MAX_HISTORY_MESSAGES = 40;

/** 用户消息组装：保留原文换行（无 TUI 折行约束）；参考图以绝对路径附注（模型用 understand_asset 看）。 */
export function composeUserMessage(text: string, images: string[]): string {
  if (images.length === 0) return text;
  const lines = images.map((path) => `- ${path}`).join("\n");
  return `${text}\n\n参考图（绝对路径，你看不到图片本身，需要了解内容时用 understand_asset）：\n${lines}`;
}

/** 裁剪历史：最多保留最近 MAX_HISTORY_MESSAGES 条，且切口必须落在 user 消息上
 *  （user 消息不会紧跟在带 tool_calls 的 assistant 之后，避免切出「孤儿 tool 响应」
 *  破坏 messages 结构）。 */
export function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages;
  for (let cut = messages.length - MAX_HISTORY_MESSAGES; cut < messages.length; cut++) {
    if (messages[cut].role === "user") return messages.slice(cut);
  }
  // 理论不可达（每轮以 user 开头且单轮 ≤34 条）；兜底不裁，宁超长不破损。
  return messages;
}

/** 单个 tool call → role:"tool" 消息。未知工具与 RPC 失败都转成错误结果回给模型（自纠），不中断会话。 */
async function runToolCall(deps: AgentDsChatDeps, call: ChatToolCall): Promise<ChatMessage> {
  let content: string;
  if (call.name !== "dreamina_generate" && call.name !== "understand_asset") {
    content = JSON.stringify({ error: `未知工具：${call.name}（只能用 dreamina_generate / understand_asset）` });
  } else {
    try {
      content = JSON.stringify({ ok: true, result: await deps.rpc(call.name, call.arguments) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      content = JSON.stringify({ error: message });
    }
  }
  return { role: "tool", tool_call_id: call.id, content };
}

/** 跑一轮用户消息。成功返回更新后的 session（含本轮全部 messages）；
 *  失败抛 AgentDsChatError——调用方应保留旧 session（回滚，用户可原样重发）。
 *  emit 顺序：每个工具调用前一条 tool 状态；终答一条 ds_reply。 */
export async function runAgentDsTurn(
  deps: AgentDsChatDeps,
  session: AgentDsSession,
  text: string,
  images: string[],
  signal: { aborted: boolean } = { aborted: false },
): Promise<AgentDsSession> {
  const messages = trimHistory(session.messages);
  messages.push({ role: "user", content: composeUserMessage(text, images) });
  const outbound = (): ChatMessage[] => [
    { role: "system", content: AGENT_DS_SYSTEM_PROMPT },
    ...messages,
  ];
  for (let turn = 0; turn < MAX_MODEL_TURNS; turn++) {
    const result = await deps.chat(outbound(), AGENT_DS_TOOLS, signal);
    messages.push(result.message);
    if (result.toolCalls.length === 0) {
      const reply = result.content.trim();
      if (!reply) throw new AgentDsChatError("agent_ds_empty_reply");
      deps.emit({ kind: "ds_reply", text: reply });
      return { ...session, messages };
    }
    if (result.toolCalls.length > MAX_TOOL_CALLS_PER_TURN) {
      throw new AgentDsChatError("agent_ds_too_many_tool_calls");
    }
    for (const call of result.toolCalls) {
      deps.emit({ kind: "ds_status", phase: "tool", text: TOOL_LABELS[call.name] ?? `Agent DS 正在调用 ${call.name}…` });
      messages.push(await runToolCall(deps, call));
    }
  }
  throw new AgentDsChatError("agent_ds_max_turns");
}
