// The Cloud owns the model, system prompt, canonical tool schema and billing.
// DSH owns the agent loop; this module translates its pinned wire protocol only.
export const DSH_VERSION = "0.1.1-rc.2";
export const MODEL = "bowerbird-chat";
export const TOOL = "create_canvas_cards";
const CORE = new Set(["timer", "llm", "session", "agent", "agent-default-model", "tools", "system-prompt", "agent-loop", "llm-deepseek", "approval", "token-meter"]);

export function managedPatch(rows, endpoint) {
  const config = {
    "agent-default-model": { provider: "deepseek-official", model: MODEL },
    "system-prompt": { persona: "You are the managed Bowerbird chat assistant. Use only create_canvas_cards when the user requests cards." },
    "llm-deepseek": {
      apiKeyEnv: "BOWERBIRD_DSH_CAPABILITY", baseURL: endpoint,
      thinking: "disabled", reasoningEffort: "off", maxTokens: 8192,
      streamIdleTimeoutMs: 1800000,
      models: [{ id: MODEL, name: "DeepSeek Cloud", contextWindow: 131072, maxTokens: 8192 }],
    },
    tools: { mode: "native" }, approval: { policy: "never" },
  };
  return rows.map(row => ({ id: row.id, disabled: !CORE.has(row.id), ...(config[row.id] ? { config: config[row.id] } : {}) }));
}

function toolCalls(calls) {
  if (!Array.isArray(calls) || calls.length > 4) throw new Error("DSH_TOOL_CALLS_INVALID");
  return calls.map(call => {
    if (call?.type !== "function" || call.function?.name !== TOOL || typeof call.function.arguments !== "string" || !/^[\w-]{1,120}$/.test(call.id)) throw new Error("DSH_TOOL_CALL_INVALID");
    const args = JSON.parse(call.function.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("DSH_TOOL_ARGS_INVALID");
    return { id: call.id, type: "function", function: { name: TOOL, arguments: call.function.arguments } };
  });
}

export function cloudMessages(request) {
  if (request.model !== MODEL || request.stream !== true || request.thinking?.type === "enabled") throw new Error("DSH_MODEL_NOT_ALLOWED");
  if (!Array.isArray(request.tools) || request.tools.length !== 1 || request.tools[0]?.type !== "function" || request.tools[0]?.function?.name !== TOOL) throw new Error("DSH_TOOL_NOT_ALLOWED");
  if (!Array.isArray(request.messages)) throw new Error("DSH_MESSAGES_INVALID");
  const messages = request.messages.filter(message => message.role !== "system").map(message => {
    if (!["user", "assistant", "tool"].includes(message.role) || !(typeof message.content === "string" || (message.role === "assistant" && message.content === null)) || message.reasoning_content) throw new Error("DSH_MESSAGE_INVALID");
    const result = { role: message.role, content: message.content };
    if (message.tool_calls) {
      if (message.role !== "assistant") throw new Error("DSH_MESSAGE_INVALID");
      result.tool_calls = toolCalls(message.tool_calls);
    }
    if (message.role === "tool") {
      if (typeof message.tool_call_id !== "string") throw new Error("DSH_MESSAGE_INVALID");
      result.tool_call_id = message.tool_call_id;
    }
    return result;
  });
  if (!messages.length || messages.length > 128 || Buffer.byteLength(JSON.stringify(messages)) > 300000) throw new Error("DSH_MESSAGES_LIMIT");
  return messages;
}

export function completionSse(message) {
  if (message?.role !== "assistant") throw new Error("DSH_COMPLETION_INVALID");
  const calls = message.tool_calls?.length ? toolCalls(message.tool_calls) : [];
  if (!calls.length && !message.content) throw new Error("DSH_COMPLETION_EMPTY");
  if (message.content !== null && message.content !== undefined && typeof message.content !== "string") throw new Error("DSH_COMPLETION_INVALID");
  const delta = { role: "assistant", ...(message.content ? { content: message.content } : {}) };
  if (calls.length) delta.tool_calls = calls.map((call, index) => ({ index, ...call }));
  const chunk = (value) => `data: ${JSON.stringify(value)}\n\n`;
  return chunk({ choices: [{ index: 0, delta, finish_reason: null }] }) +
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }] }) + "data: [DONE]\n\n";
}
