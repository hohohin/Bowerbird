// 多轮 tool-calling 真机验证 spike（Agent DS 的唯一未验假设）：
// deepseek-chat 的原生 messages 多轮 + assistant.tool_calls + role:"tool" 回注是否被真实端点接受。
// 两回合：turn1 诱导 tool call → 回注 role:"tool" → turn2 应拿到纯文本。输出仅安全摘要。
// 运行：npm run spike:deepseek-multiturn（需 ../cloud/.env 配 DEEPSEEK_API_KEY / DEEPSEEK_MODEL）。
import {
  DeepSeekBackend,
  deepSeekConfigFromEnv,
  type ChatMessage,
  type ChatTool,
} from "../providers/deepseek/backend.ts";

const model = new DeepSeekBackend({ ...deepSeekConfigFromEnv(process.env), timeoutMs: 60_000 });
const tools: ChatTool[] = [{
  type: "function",
  function: {
    name: "pick_flower",
    description: "从候选里选一朵花",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
}];

const messages: ChatMessage[] = [{
  role: "user",
  content: "从玫瑰、雏菊里选一朵更适合送朋友的花：先调用工具告诉我你选了什么。",
}];

const first = await model.chat(messages, tools, { aborted: false });
console.log(JSON.stringify({
  turn: 1,
  finishReason: first.finishReason,
  toolCallNames: first.toolCalls.map((call) => call.name),
  usage: first.usage,
}));
if (first.toolCalls.length === 0) throw new Error("spike_expected_tool_call");

messages.push(first.message);
for (const call of first.toolCalls) {
  messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: true, note: "选择已记录" }) });
}

const second = await model.chat(messages, tools, { aborted: false });
console.log(JSON.stringify({
  turn: 2,
  finishReason: second.finishReason,
  hasPlainText: second.content.trim().length > 0,
  toolCallCount: second.toolCalls.length,
  usage: second.usage,
}));
if (!second.content.trim()) throw new Error("spike_expected_plain_reply");
console.log(JSON.stringify({ ok: true, flow: "tool_call -> tool_result -> plain_reply" }));
