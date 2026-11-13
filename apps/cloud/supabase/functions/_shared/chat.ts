export const CHAT_SERVICE = "chat_deepseek";

const failureReasons: Record<string, string> = {
  chat_upstream_connection: "与上游模型的连接中断。",
  chat_upstream_timeout: "等待上游模型回复超时。",
  chat_reply_json: "上游模型返回的回复无法解析。",
  chat_reply_format: "上游模型返回的回复格式无效。",
  chat_reply_tool_arguments: "上游模型返回的工具参数无法解析。",
  chat_input_unavailable: "云端未能读取本轮输入。",
  chat_upload_failed: "本轮输入未能上传到云端。",
  chat_expired: "本轮输入已过期。",
  chat_upstream_rejected: "云端未能完成本轮请求。",
  chat_worker_error: "云端处理回复时发生错误。",
  chat_cancelled: "这轮云端对话已停止。",
  chat_dsh_deadline: "云端 DSH 对话等待执行或桌面工具回执超时。",
};

export function chatFailure(status: string, candidate: unknown) {
  const code = typeof candidate === "string" ? candidate : "";
  const http = /^chat_upstream_http_([45]\d{2})$/.exec(code);
  const known = Object.hasOwn(failureReasons, code);
  return {
    code: http || known ? code : status === "failed" ? "chat_failed" : "chat_outcome_unknown",
    message: (http ? `上游模型服务返回 HTTP ${http[1]}。` : known ? failureReasons[code] : "") +
      "本轮云端任务已结束，没有可取回的回复。",
    recoverable: false,
  };
}
export type ChatToolCall = {
  id: string;
  type: "function";
  function: { name: "create_canvas_cards"; arguments: string };
};
export type ChatMessage = {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
};
export const DSH_CHAT_ENGINE = "dsh-vps-v1";
export const DSH_CHAT_ENGINE_V2 = "dsh-vps-v2";
export type DshChatEngine = typeof DSH_CHAT_ENGINE | typeof DSH_CHAT_ENGINE_V2;
export function isDshChatEngine(value: unknown): value is DshChatEngine {
  return value === DSH_CHAT_ENGINE || value === DSH_CHAT_ENGINE_V2;
}
type ChatSkill = { id: "h3-video-prompt"; parameters: Record<string, unknown> } | { id: "text-editor" };
export type ChatInput = { messages: ChatMessage[]; tools_enabled: boolean; engine?: DshChatEngine; conversation_id?: string; skill?: ChatSkill };
export class ChatInputError extends Error {}
const invalid = () => new ChatInputError("对话内容格式无效，请重新发送");
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

export function parseChatToolCalls(value: unknown): ChatToolCall[] {
  if (!Array.isArray(value) || value.length > 4) throw invalid();
  return value.map((call) => {
    if (
      !record(call) || !keys(call, ["id", "type", "function"]) ||
      typeof call.id !== "string" || !/^[\w-]{1,120}$/.test(call.id) ||
      call.type !== "function" || !record(call.function) ||
      !keys(call.function, ["name", "arguments"]) ||
      call.function.name !== "create_canvas_cards" ||
      typeof call.function.arguments !== "string"
    ) throw invalid();
    try {
      if (!record(JSON.parse(call.function.arguments))) throw invalid();
    } catch {
      throw invalid();
    }
    return call as ChatToolCall;
  });
}

function parseMessage(value: unknown): ChatMessage {
  if (
    !record(value) ||
    !keys(value, ["role", "content", "tool_calls", "tool_call_id"]) ||
    !["user", "assistant", "tool"].includes(String(value.role))
  ) throw invalid();
  if (
    typeof value.content !== "string" &&
    !(value.role === "assistant" && value.content === null)
  ) throw invalid();
  const message: ChatMessage = {
    role: value.role as ChatMessage["role"],
    content: value.content as string | null,
  };
  if (value.tool_calls !== undefined) {
    if (value.role !== "assistant") throw invalid();
    message.tool_calls = parseChatToolCalls(value.tool_calls);
  }
  if (value.role === "tool") {
    if (typeof value.tool_call_id !== "string") throw invalid();
    message.tool_call_id = value.tool_call_id;
  } else if (value.tool_call_id !== undefined) throw invalid();
  if (!message.content && !message.tool_calls?.length) throw invalid();
  return message;
}

export function validateChatInput(value: unknown): ChatInput {
  if (
    !record(value) || !keys(value, ["messages", "tools_enabled", "engine", "skill", "conversation_id"]) ||
    (value.engine !== undefined && !isDshChatEngine(value.engine)) ||
    (value.skill !== undefined && !isDshChatEngine(value.engine)) ||
    (value.engine !== DSH_CHAT_ENGINE_V2 && value.conversation_id !== undefined) ||
    !Array.isArray(value.messages) ||
    value.messages.length < 1 || value.messages.length > 128 ||
    (value.tools_enabled !== undefined &&
      typeof value.tools_enabled !== "boolean")
  ) throw invalid();
  const messages = value.messages.map(parseMessage);
  const pending = new Set<string>(), seen = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (!pending.delete(message.tool_call_id!)) throw invalid();
    } else {
      if (pending.size) throw invalid();
      for (const call of message.tool_calls ?? []) {
        if (seen.has(call.id)) throw invalid();
        seen.add(call.id);
        pending.add(call.id);
      }
    }
  }
  if (pending.size) throw invalid();
  if (isDshChatEngine(value.engine)) {
    if (messages.some(m => (m.role !== "user" && m.role !== "assistant") || m.tool_calls || typeof m.content !== "string") ||
        messages.at(-1)?.role !== "user" || value.skill !== undefined && value.tools_enabled === true) throw invalid();
    if (value.engine === DSH_CHAT_ENGINE_V2 && (typeof value.conversation_id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(value.conversation_id) || messages.length !== 1 ||
        !messages[0].content?.trim())) throw invalid();
    return { messages, tools_enabled: value.skill === undefined && value.tools_enabled !== false, engine: value.engine,
      ...(value.engine === DSH_CHAT_ENGINE_V2 ? { conversation_id: value.conversation_id as string } : {}),
      ...(value.skill === undefined ? {} : { skill: parseChatSkill(value.skill) }) };
  }
  return { messages, tools_enabled: value.tools_enabled !== false };
}

function parseChatSkill(value: unknown): ChatSkill {
  if (!record(value)) throw invalid();
  if (value.id === "text-editor" && keys(value, ["id"])) return { id: "text-editor" };
  const p = value.parameters;
  if (value.id !== "h3-video-prompt" || !keys(value, ["id", "parameters"]) || !record(p) ||
      !keys(p, ["mode", "seconds", "ratio", "firstFrameCount", "lastFrameCount"]) ||
      typeof p.mode !== "string" || !["text", "reference", "frames"].includes(p.mode) ||
      typeof p.seconds !== "number" || !Number.isFinite(p.seconds) || p.seconds <= 0 || p.seconds > 120 ||
      typeof p.ratio !== "string" || !["9:16", "16:9", "4:3", "3:4", "1:1", "auto"].includes(p.ratio) ||
      p.firstFrameCount !== (p.mode === "text" ? 0 : 1) ||
      !(p.lastFrameCount === 0 || (p.mode === "frames" && p.lastFrameCount === 1))) throw invalid();
  return { id: "h3-video-prompt", parameters: { mode: p.mode, seconds: p.seconds, ratio: p.ratio,
    firstFrameCount: p.firstFrameCount, lastFrameCount: p.lastFrameCount } };
}

export function validChatCallId(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{1,120}$/.test(value);
}

export function parseChatToolReceipt(value: unknown) {
  if (record(value)) {
    if (value.success === true && keys(value, ["success", "created_count", "run_status"]) &&
        (value.run_status === undefined || value.run_status === "started" || value.run_status === "failed" || value.run_status === "unknown") &&
        typeof value.created_count === "number" && Number.isInteger(value.created_count) &&
        value.created_count >= 0 && value.created_count <= 24) return { success: true, created_count: value.created_count,
          ...(value.run_status === undefined ? {} : { run_status: value.run_status }) };
    if (value.success === false && keys(value, ["success", "error"]) && value.error === "card_creation_failed")
      return { success: false, error: value.error };
  }
  throw invalid();
}

export function chatResult(
  value: unknown,
  engine?: DshChatEngine,
): {
  message: ChatMessage;
  usage: { input_tokens: number; output_tokens: number };
} {
  if (!record(value) || !record(value.usage)) throw invalid();
  const message = parseMessage(value.message);
  if (message.role !== "assistant" ||
      isDshChatEngine(engine) && (message.tool_calls !== undefined || !message.content?.trim())) throw invalid();
  const { input_tokens, output_tokens } = value.usage;
  if (
    ![input_tokens, output_tokens].every((n) =>
      typeof n === "number" && Number.isSafeInteger(n) && n >= 0 &&
      n <= (isDshChatEngine(engine) ? 12 * 2_000_000 : 2_000_000)
    )
  ) throw invalid();
  return {
    message,
    usage: {
      input_tokens: input_tokens as number,
      output_tokens: output_tokens as number,
    },
  };
}
