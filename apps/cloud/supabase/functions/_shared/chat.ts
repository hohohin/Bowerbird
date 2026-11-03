export const CHAT_SERVICE = "chat_deepseek";
export const CHAT_MAX_BYTES = 300_000;
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
export type ChatInput = { messages: ChatMessage[]; tools_enabled: boolean };
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
    !record(value) || !keys(value, ["messages", "tools_enabled"]) ||
    !Array.isArray(value.messages) ||
    value.messages.length < 1 || value.messages.length > 128 ||
    (value.tools_enabled !== undefined &&
      typeof value.tools_enabled !== "boolean")
  ) throw invalid();
  if (new TextEncoder().encode(JSON.stringify(value)).length > CHAT_MAX_BYTES) {
    throw new ChatInputError("对话上下文过长，请新建对话");
  }
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
  return { messages, tools_enabled: value.tools_enabled !== false };
}

export function chatResult(
  value: unknown,
): {
  message: ChatMessage;
  usage: { input_tokens: number; output_tokens: number };
} {
  if (!record(value) || !record(value.usage)) throw invalid();
  const message = parseMessage(value.message);
  if (message.role !== "assistant") throw invalid();
  const { input_tokens, output_tokens } = value.usage;
  if (
    ![input_tokens, output_tokens].every((n) =>
      typeof n === "number" && Number.isSafeInteger(n) && n >= 0 &&
      n <= 2_000_000
    )
  ) throw invalid();
  if (
    new TextEncoder().encode(JSON.stringify(message)).length > CHAT_MAX_BYTES
  ) throw invalid();
  return {
    message,
    usage: {
      input_tokens: input_tokens as number,
      output_tokens: output_tokens as number,
    },
  };
}
