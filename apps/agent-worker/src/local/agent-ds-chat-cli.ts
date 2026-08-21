// Agent DS 桌面端入口（dev-only；由 Rust agent_ds_chat detached spawn，无人在下游等 stdout）。
// argv = [sessionPath, rpcDir, inboxDir]；stdin = {"text","images"}（长度/数量校验在 Rust 侧）。
// 回复与阶段状态写 inbox 事件文件（桌面端 watcher 消费）；错误时同样写 error 状态事件再退出。
// RPC 契约与 .agent-z/mcp-bridge.mjs 相同：rpc/<id>.req.json → 桌面端分发 → <id>.resp.json。
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DeepSeekBackend, deepSeekConfigFromEnv } from "../providers/deepseek/backend.ts";
import { runAgentDsTurn, type AgentDsEvent, type AgentDsSession } from "./agent-ds-chat.ts";

const [sessionPath, rpcDir, inboxDir] = process.argv.slice(2);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(() => resolve(), ms));
// 事件文件名含进程内单调序号：同毫秒多条事件（如 ds_reply 与随后的 done）按写入顺序消费，
// 不交给随机后缀决定（desktop drain_inbox 按文件名排序）。
let eventSeq = 0;

function emit(event: AgentDsEvent): void {
  if (!inboxDir) throw new Error("agent_ds_invalid_args");
  mkdirSync(inboxDir, { recursive: true });
  const file = `${Date.now()}-${String(eventSeq++).padStart(6, "0")}-${Math.random().toString(16).slice(2, 8)}.json`;
  writeFileSync(join(inboxDir, file), JSON.stringify(event), "utf8");
}

async function rpc(tool: string, args: unknown): Promise<unknown> {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  mkdirSync(rpcDir, { recursive: true });
  writeFileSync(join(rpcDir, `${id}.req.json`), JSON.stringify({ id, tool, args }), "utf8");
  const responsePath = join(rpcDir, `${id}.resp.json`);
  const deadline = Date.now() + (tool === "dreamina_generate" ? 660_000 : 330_000);
  while (Date.now() < deadline) {
    await sleep(300);
    let raw: string;
    try {
      raw = readFileSync(responsePath, "utf8");
    } catch {
      continue;
    }
    try {
      unlinkSync(responsePath);
    } catch {
      // 桌面端重写前竞争删除，忽略
    }
    const response = JSON.parse(raw) as { ok?: boolean; result?: unknown; error?: string };
    if (response && response.ok) return response.result;
    throw new Error(response ? (response.error || "Bowerbird 返回失败") : "响应解析失败");
  }
  throw new Error(`等待 Bowerbird 响应超时（桌面端未运行？工具 ${tool}）`);
}

function loadSession(): AgentDsSession {
  try {
    const parsed = JSON.parse(readFileSync(sessionPath, "utf8")) as AgentDsSession;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.messages)) return parsed;
  } catch {
    // 会话文件缺失/损坏 → 新会话
  }
  return { version: 1, createdAt: new Date().toISOString(), messages: [] };
}

async function main(): Promise<void> {
  if (!sessionPath || !rpcDir || !inboxDir) throw new Error("agent_ds_invalid_args");
  const encoded = readFileSync(0, "utf8").replace(/^\uFEFF/, "");
  const input = JSON.parse(encoded) as { text?: string; images?: string[] };
  const text = (input.text ?? "").trim();
  const images = Array.isArray(input.images)
    ? input.images.filter((path): path is string => typeof path === "string")
    : [];
  if (!text) throw new Error("agent_ds_empty_text");
  const backend = new DeepSeekBackend({
    ...deepSeekConfigFromEnv(process.env),
    timeoutMs: 120_000,
  });
  // 失败不写回 session（回滚语义）：用户原样重发即可，避免留下「有 user 无答」的残轮。
  const updated = await runAgentDsTurn(
    { chat: (messages, tools, signal) => backend.chat(messages, tools, signal), rpc, emit },
    loadSession(),
    text,
    images,
  );
  writeFileSync(sessionPath, JSON.stringify(updated), "utf8");
  emit({ kind: "ds_status", phase: "done", text: "" });
}

main().catch((error: unknown) => {
  const safeCode = error instanceof Error ? error.message : "agent_ds_unknown_error";
  try {
    emit({ kind: "ds_status", phase: "error", text: safeCode });
  } catch {
    // inbox 不可写（参数缺失）时只剩 stderr（进 ds-harness.log）
  }
  console.error(safeCode);
  process.exitCode = 1;
});
