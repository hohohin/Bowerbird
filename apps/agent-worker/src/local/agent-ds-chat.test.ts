import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import type { ChatMessage, ChatTurnResult } from "../providers/deepseek/backend.ts";
import {
  composeUserMessage,
  MAX_HISTORY_MESSAGES,
  runAgentDsTurn,
  trimHistory,
  type AgentDsChatDeps,
  type AgentDsEvent,
  type AgentDsSession,
} from "./agent-ds-chat.ts";

function textTurn(text: string): ChatTurnResult {
  return {
    message: { role: "assistant", content: text },
    content: text,
    toolCalls: [],
    finishReason: "stop",
    usage: {},
  };
}

function toolTurn(
  calls: { id?: string; name: string; args?: unknown }[],
): ChatTurnResult {
  const message = {
    role: "assistant",
    content: null,
    tool_calls: calls.map((call, index) => ({
      id: call.id ?? `call_${index}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
    })),
  };
  return {
    message,
    content: "",
    toolCalls: calls.map((call, index) => ({
      id: call.id ?? `call_${index}`,
      name: call.name,
      arguments: call.args ?? {},
    })),
    finishReason: "tool_calls",
    usage: {},
  };
}

type Harness = {
  deps: AgentDsChatDeps;
  events: AgentDsEvent[];
  rpcCalls: { tool: string; args: unknown }[];
};

function makeHarness(turns: ChatTurnResult[], rpcResult: unknown = { images: [] }): Harness {
  const events: AgentDsEvent[] = [];
  const rpcCalls: { tool: string; args: unknown }[] = [];
  let cursor = 0;
  const deps: AgentDsChatDeps = {
    chat: async (messages) => {
      ok(messages[0].role === "system", "system 提示词应前置");
      const turn = turns[cursor++];
      if (!turn) throw new Error("fake chat 耗尽");
      return turn;
    },
    rpc: async (tool, args) => {
      rpcCalls.push({ tool, args });
      if (rpcResult instanceof Error) throw rpcResult;
      return rpcResult;
    },
    emit: (event) => events.push(event),
  };
  return { deps, events, rpcCalls };
}

function emptySession(): AgentDsSession {
  return { version: 1, createdAt: "t", messages: [] };
}

test("composeUserMessage appends reference image paths as machine-readable note", () => {
  equal(composeUserMessage("一只猫\n在月光下", []), "一只猫\n在月光下");
  const withImages = composeUserMessage("改造这张图", ["D:/a/1.png", "D:/b/2.png"]);
  ok(withImages.startsWith("改造这张图\n\n参考图"));
  ok(withImages.includes("- D:/a/1.png"));
  ok(withImages.includes("- D:/b/2.png"));
});

test("trimHistory keeps short history intact and cuts long history on a user message", () => {
  const short = [{ role: "user", content: "hi" }];
  deepEqual(trimHistory(short), short);
  const messages: ChatMessage[] = [];
  for (let round = 0; round < 5; round++) {
    messages.push({ role: "user", content: `round ${round}` });
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: `c${round}`, type: "function", function: { name: "dreamina_generate", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: `c${round}`, content: "{}" });
    messages.push({ role: "assistant", content: `done ${round}` });
  }
  const trimmed = trimHistory(messages);
  ok(trimmed.length <= MAX_HISTORY_MESSAGES);
  equal(trimmed[0].role, "user");
  // 切口之后的 tool 响应与其 assistant tool_calls 保持配对完整
  for (const message of trimmed) {
    if (message.role === "tool") {
      const paired = trimmed.some(
        (other) => other.role === "assistant"
          && Array.isArray(other.tool_calls)
          && (other.tool_calls as { id: string }[]).some((call) => call.id === message.tool_call_id),
      );
      ok(paired, "tool 消息的 assistant 配对应保留");
    }
  }
});

test("runAgentDsTurn returns final text reply without touching rpc", async () => {
  const harness = makeHarness([textTurn("已生成一只猫。")]);
  const session = await runAgentDsTurn(harness.deps, emptySession(), "画一只猫", []);
  deepEqual(harness.events, [{ kind: "ds_reply", text: "已生成一只猫。" }]);
  deepEqual(harness.rpcCalls, []);
  equal(session.messages.length, 2);
  equal(session.messages[0].role, "user");
  equal((session.messages[1] as { content?: string }).content, "已生成一只猫。");
});

test("runAgentDsTurn executes tool calls via rpc and feeds results back as role:tool", async () => {
  const harness = makeHarness(
    [toolTurn([{ id: "call-1", name: "dreamina_generate", args: { prompt: "一只猫" } }]), textTurn("图已生成并入库。")],
    { images: [{ id: "a1", name: "猫.png", path: "D:/lib/猫.png" }] },
  );
  const session = await runAgentDsTurn(harness.deps, emptySession(), "画一只猫", ["D:/ref/1.png"]);
  deepEqual(harness.rpcCalls, [{ tool: "dreamina_generate", args: { prompt: "一只猫" } }]);
  deepEqual(harness.events, [
    { kind: "ds_status", phase: "tool", text: "Agent DS 正在生成图片（即梦）…" },
    { kind: "ds_reply", text: "图已生成并入库。" },
  ]);
  const roles = session.messages.map((message) => message.role);
  deepEqual(roles, ["user", "assistant", "tool", "assistant"]);
  const toolMessage = session.messages[2] as { tool_call_id?: string; content?: string };
  equal(toolMessage.tool_call_id, "call-1");
  ok(toolMessage.content?.includes("D:/lib/猫.png"));
  // 用户消息带参考图附注
  ok((session.messages[0].content as string).includes("D:/ref/1.png"));
});

test("runAgentDsTurn turns rpc failures into tool error content for the model to recover", async () => {
  const harness = makeHarness(
    [toolTurn([{ name: "understand_asset", args: { image_path: "D:/x/1.png" } }]), textTurn("反推暂时失败，稍后再试。")],
    new Error("等待 Bowerbird 响应超时"),
  );
  const session = await runAgentDsTurn(harness.deps, emptySession(), "看看这张图", ["D:/x/1.png"]);
  const toolMessage = session.messages[2] as { content?: string };
  ok(toolMessage.content?.includes("error"));
  ok(toolMessage.content?.includes("等待 Bowerbird 响应超时"));
  equal(harness.events.at(-1)?.kind, "ds_reply");
});

test("runAgentDsTurn rejects unknown tools without calling rpc", async () => {
  const harness = makeHarness(
    [toolTurn([{ name: "read_file", args: { path: "D:/secret" } }]), textTurn("我只有生图与反推工具。")],
  );
  const session = await runAgentDsTurn(harness.deps, emptySession(), "读个文件", []);
  deepEqual(harness.rpcCalls, []);
  const toolMessage = session.messages[2] as { content?: string };
  ok(toolMessage.content?.includes("未知工具"));
});

test("runAgentDsTurn fails closed on empty reply, too many tool calls, and exhausted turns", async () => {
  const empty = makeHarness([textTurn("   ")]);
  await assertSafeCode(empty, "agent_ds_empty_reply");

  const crowded = makeHarness([toolTurn([
    { name: "dreamina_generate" }, { name: "dreamina_generate" }, { name: "dreamina_generate" }, { name: "dreamina_generate" },
  ])]);
  await assertSafeCode(crowded, "agent_ds_too_many_tool_calls");

  const loops = makeHarness(
    Array.from({ length: 8 }, () => toolTurn([{ name: "understand_asset" }])),
  );
  await assertSafeCode(loops, "agent_ds_max_turns");
});

async function assertSafeCode(harness: Harness, safeCode: string): Promise<void> {
  try {
    await runAgentDsTurn(harness.deps, emptySession(), "hi", []);
    ok(false, `expected ${safeCode}`);
  } catch (error) {
    ok(error instanceof Error && error.message === safeCode, `got ${String(error)}`);
  }
}
