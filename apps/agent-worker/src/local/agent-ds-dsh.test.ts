import { test } from "node:test";
import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import type { HarnessPromptBlock } from "../harness/contracts.ts";
import { ToolGatewayError } from "../harness/scoped-tool-gateway.ts";
import {
  AGENT_DS_TOOL_NAMES,
  composeAgentDsPromptText,
  createAgentDsToolDispatch,
  isAgentDsSession,
  MAX_INLINE_IMAGES,
  newAgentDsSession,
  runAgentDsDshTurn,
  trimHistory,
  type AgentDsDshSession,
  type AgentDsEvent,
  type AgentDsSession,
} from "./agent-ds-dsh.ts";

type Harness = {
  sessions: AgentDsDshSession[];
  prompts: HarnessPromptBlock[][];
  events: AgentDsEvent[];
  imageFiles: Map<string, { mimeType: string; base64: string } | null>;
};

function makeHarness(result: { stopReason?: string; chunks?: string[] } = {}): Harness {
  const harness: Harness = { sessions: [], prompts: [], events: [], imageFiles: new Map() };
  harness.sessions.push({
    async prompt(blocks, onText) {
      harness.prompts.push(blocks);
      for (const chunk of result.chunks ?? ["好的，图已生成。"]) onText(chunk);
      return { stopReason: result.stopReason ?? "end_turn" };
    },
    async dispose() {},
  });
  return harness;
}

function depsOf(harness: Harness) {
  return {
    openSession: async () => harness.sessions.shift()!,
    readImageFile: (path: string) => harness.imageFiles.get(path) ?? null,
    emit: (event: AgentDsEvent) => harness.events.push(event),
  };
}

test("composeAgentDsPromptText joins history, message and image path notes", () => {
  const session: AgentDsSession = {
    version: 2,
    createdAt: "2026-09-21T00:00:00.000Z",
    turns: [
      { role: "user", text: "画一只鸟" },
      { role: "assistant", text: "已生成。" },
    ],
  };
  const prompt = composeAgentDsPromptText(session, "再画一张", ["D:/a.png", "D:/b.png"]);
  ok(prompt.includes("[历史对话]"));
  ok(prompt.includes("用户：画一只鸟"));
  ok(prompt.includes("助手：已生成。"));
  ok(prompt.includes("[用户本次消息]\n再画一张"));
  ok(prompt.includes("- D:/a.png"));
  ok(prompt.includes("- D:/b.png"));
});

test("trimHistory keeps at most ten pairs and drops oldest pairs over the char budget", () => {
  const turns = [];
  for (let index = 0; index < 15; index++) {
    turns.push({ role: "user" as const, text: `问题${index}` }, { role: "assistant" as const, text: `回答${index}` });
  }
  const trimmed = trimHistory(turns);
  equal(trimmed.length, 20);
  equal(trimmed[0]?.text, "问题5");

  const longTurns = [
    { role: "user" as const, text: "x".repeat(9_000) },
    { role: "assistant" as const, text: "y".repeat(9_000) },
    { role: "user" as const, text: "短问题" },
    { role: "assistant" as const, text: "短回答" },
  ];
  const kept = trimHistory(longTurns);
  deepEqual(kept, longTurns.slice(2));
});

test("createAgentDsToolDispatch rejects unknown tools and routes known tools through rpc with events", async () => {
  const events: AgentDsEvent[] = [];
  const rpcCalls: { tool: string; args: unknown }[] = [];
  const dispatch = createAgentDsToolDispatch({
    rpc: async (tool, args) => {
      rpcCalls.push({ tool, args });
      return { images: [{ id: "a1" }] };
    },
    emit: (event) => events.push(event),
  });

  const result = await dispatch.dispatch({ toolName: "dreamina_generate", arguments: { prompt: "鸟" } });
  deepEqual(rpcCalls, [{ tool: "dreamina_generate", args: { prompt: "鸟" } }]);
  deepEqual(events, [{ kind: "ds_status", phase: "tool", text: "Agent DS 正在生成图片（即梦）…" }]);
  deepEqual(result.value, { ok: true, result: { images: [{ id: "a1" }] } });
  ok(result.callId.startsWith("agent-ds-"));

  await rejects(
    () => dispatch.dispatch({ toolName: "shell", arguments: {} }),
    (error: unknown) => error instanceof ToolGatewayError && error.code === "tool_not_registered",
  );
});

test("createAgentDsToolDispatch returns rpc failures as tool values for self-correction", async () => {
  const dispatch = createAgentDsToolDispatch({
    rpc: async () => {
      throw new Error("等待 Bowerbird 响应超时");
    },
    emit: () => undefined,
  });
  const result = await dispatch.dispatch({ toolName: "understand_asset", arguments: { image_path: "D:/a.png" } });
  deepEqual(result.value, { ok: false, error: "等待 Bowerbird 响应超时" });
});

test("runAgentDsDshTurn appends turns, emits ds_reply and inlines readable images", async () => {
  const harness = makeHarness({ chunks: ["已生成", "一张鸟图。"] });
  harness.imageFiles.set("D:/a.png", { mimeType: "image/png", base64: "AAAA" });
  harness.imageFiles.set("D:/b.png", null);
  const session = newAgentDsSession();

  const updated = await runAgentDsDshTurn(depsOf(harness), session, "画图", ["D:/a.png", "D:/b.png"]);

  const blocks = harness.prompts[0]!;
  equal(blocks.length, 2);
  equal(blocks[0]?.type, "text");
  equal(blocks[1]?.type, "image");
  equal((blocks[1] as { mimeType?: string }).mimeType, "image/png");
  const text = (blocks[0] as { text: string }).text;
  ok(text.includes("已直接附上 1 张参考图"));
  ok(text.includes("- D:/a.png"));
  ok(text.includes("未附上"));
  ok(text.includes("- D:/b.png"));
  deepEqual(harness.events, [{ kind: "ds_reply", text: "已生成一张鸟图。" }]);
  equal(updated.turns.length, 2);
  deepEqual(updated.turns[0], { role: "user", text: "画图", images: ["D:/a.png", "D:/b.png"] });
  deepEqual(updated.turns[1], { role: "assistant", text: "已生成一张鸟图。" });
});

test("runAgentDsDshTurn caps inline images and notes the remainder as paths", async () => {
  const harness = makeHarness();
  const paths = Array.from({ length: MAX_INLINE_IMAGES + 1 }, (_value, index) => `D:/img${index}.png`);
  for (const path of paths) harness.imageFiles.set(path, { mimeType: "image/png", base64: "AAAA" });

  await runAgentDsDshTurn(depsOf(harness), newAgentDsSession(), "画图", paths);

  const blocks = harness.prompts[0]!;
  const imageBlocks = blocks.filter((block) => block.type === "image");
  equal(imageBlocks.length, MAX_INLINE_IMAGES);
  const text = (blocks[0] as { text: string }).text;
  ok(text.includes("未附上"));
  ok(text.includes(`- D:/img${paths.length - 1}.png`));
});

test("runAgentDsDshTurn fails closed on abnormal stop or empty reply and disposes the session", async () => {
  const stopped = makeHarness({ stopReason: "max_tokens" });
  await rejects(
    () => runAgentDsDshTurn(depsOf(stopped), newAgentDsSession(), "画图", []),
    (error: unknown) => (error as { safeCode?: string }).safeCode === "agent_ds_turn_max_tokens",
  );

  const silent = makeHarness({ chunks: ["   "] });
  await rejects(
    () => runAgentDsDshTurn(depsOf(silent), newAgentDsSession(), "画图", []),
    (error: unknown) => (error as { safeCode?: string }).safeCode === "agent_ds_empty_reply",
  );
  deepEqual(silent.events, []);
});

test("isAgentDsSession accepts only v2 shape", () => {
  ok(isAgentDsSession(newAgentDsSession()));
  ok(!isAgentDsSession({ version: 1, messages: [] }));
  ok(!isAgentDsSession(null));
  ok(!isAgentDsSession(AGENT_DS_TOOL_NAMES));
});
