// Agent DS 桌面端入口（dev-only；由 Rust agent_ds_chat detached spawn，无人在下游等 stdout）。
// argv = [sessionPath, rpcDir, inboxDir]；stdin = {"text","images"}（长度/数量校验在 Rust 侧）。
// 本轮拉起本地 DSH harness 作为 Agent loop（类 codex cli 定位）：模型多回合/上下文/工具
// 选择归 DSH；工具经 loopback 桥 → .agent-z/rpc 文件契约由桌面端执行（契约同 mcp-bridge.mjs）。
// 模型走 MeteredDeepSeekProxy（内存计量，phase=agent_ds_local，放开图片内容——deepseek-flash
// 多模态，参考图直接附给模型）；回复与阶段状态写 inbox 事件文件（桌面端 watcher 消费）。
// 每轮一个 fresh DSH session；跨轮历史以 transcript 注入 prompt。失败不写回 session（回滚语义）。
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { dirname, extname, join, resolve } from "node:path";
import { NodeDshAcpPort } from "../harness/node-dsh-acp-port.ts";
import { startLoopbackToolBridge } from "../harness/loopback-tool-bridge-server.ts";
import { startMeteredDeepSeekProxy } from "../harness/metered-deepseek-proxy.ts";
import { EvalMeteredProxyControl } from "../eval/memory-metered-proxy-control.ts";
import {
  createAgentDsToolDispatch,
  isAgentDsSession,
  newAgentDsSession,
  runAgentDsDshTurn,
  type AgentDsDshSession,
  type AgentDsEvent,
  type AgentDsSession,
} from "./agent-ds-dsh.ts";

const [sessionPath, rpcDir, inboxDir] = process.argv.slice(2);
const sleep = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(() => resolvePromise(), ms));
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
    const parsed = JSON.parse(readFileSync(sessionPath, "utf8")) as unknown;
    if (isAgentDsSession(parsed)) return parsed;
  } catch {
    // 会话文件缺失/损坏/旧 v1 → 新会话（v1 直连循环历史不迁移）
  }
  return newAgentDsSession();
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function readImageFile(path: string): { mimeType: string; base64: string } | null {
  const mimeType = IMAGE_MIME_BY_EXT[extname(path).toLowerCase()];
  if (!mimeType) return null;
  try {
    return { mimeType, base64: Buffer.from(readFileSync(path)).toString("base64") };
  } catch {
    return null;
  }
}

/** DSH profile 模板（spike 目录，node_modules 由 pnpm 单独安装）。 */
function profileTemplateDir(): string {
  if (process.env.BOWERBIRD_DSH_PROFILE_TEMPLATE) {
    return resolve(process.env.BOWERBIRD_DSH_PROFILE_TEMPLATE);
  }
  return resolve(import.meta.dirname, "../../../../spikes/unified-agent-harness-u1/profiles/bowerbird-u1");
}

/** 每轮 DSH 临时 home 的根目录：.agent-z/dsh-runtime（rpcDir 的父目录即 .agent-z）。 */
function dshRuntimeRoot(): string {
  if (process.env.BOWERBIRD_DSH_RUNTIME_ROOT) {
    return resolve(process.env.BOWERBIRD_DSH_RUNTIME_ROOT);
  }
  return join(dirname(resolve(rpcDir)), "dsh-runtime");
}

/** 与云端同式：DSH 独立模型环境变量，默认且仅接受 deepseek-flash；不共用 DEEPSEEK_MODEL。 */
const DSH_MODEL = "deepseek-flash";

function upstreamConfig(): { apiKey: string; baseUrl: string; model: string; timeoutMs: number } {
  const model = process.env.BOWERBIRD_DSH_MODEL ?? DSH_MODEL;
  if (model !== DSH_MODEL) throw new Error(`agent_ds_dsh_model_unsupported:${model}`);
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("agent_ds_deepseek_key_missing");
  return { apiKey, baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com", model, timeoutMs: 120_000 };
}

function ensureDshProfileInstalled(templateDir: string): string {
  const dshBin = join(templateDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  if (!existsSync(dshBin)) {
    throw new Error(
      `DSH profile 未安装（缺 ${dshBin}）；请先在 spikes/unified-agent-harness-u1/profiles/bowerbird-u1 ` +
      "执行 pnpm install --ignore-workspace --ignore-scripts",
    );
  }
  return dshBin;
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

  const templateDir = profileTemplateDir();
  ensureDshProfileInstalled(templateDir);
  const runtimeRoot = dshRuntimeRoot();
  const runId = "agent-ds-local";

  const control = new EvalMeteredProxyControl();
  const bridge = await startLoopbackToolBridge(createAgentDsToolDispatch({ rpc, emit }));
  let port: NodeDshAcpPort | undefined;
  try {
    const proxy = await startMeteredDeepSeekProxy({
      runId,
      leaseId: "local",
      phase: "agent_ds_local",
      control,
      upstream: upstreamConfig(),
      // deepseek-flash 多模态：本地 dev 路径放开图片内容（生产 runtimes 保持文本边界）
      allowImageContent: true,
    });
    try {
      port = await NodeDshAcpPort.create({
        profileTemplateDir: templateDir,
        runtimeRoot,
        childEnvironment: bridge.childEnvironment(),
        providerEnvironment: proxy.childEnvironment(),
        timeoutMs: 1_200_000,
        profileMode: "agent-ds",
      });
      await port.initialize();
      const { sessionId } = await port.newSession({ cwd: runtimeRoot });
      const dshSession: AgentDsDshSession = {
        prompt: (blocks, onText) =>
          port!.prompt({ sessionId, prompt: blocks }, (content) => {
            if (content.type === "text") onText(content.text);
          }),
        dispose: () => port!.dispose(),
      };
      // 失败不写回 session（回滚语义）：用户原样重发即可，避免留下「有 user 无答」的残轮。
      const updated = await runAgentDsDshTurn(
        { openSession: async () => dshSession, readImageFile, emit },
        loadSession(),
        text,
        images,
      );
      writeFileSync(sessionPath, JSON.stringify(updated), "utf8");
      emit({ kind: "ds_status", phase: "done", text: "" });
      const usage = control.usageForRun(runId);
      console.log(JSON.stringify({ agentDsUsage: usage }));
    } finally {
      await port?.dispose();
      await proxy.close();
    }
  } finally {
    await bridge.close();
  }
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
