// Agent Z（dev-only）：创作板 → 唤起 Claude Code TUI 终端并注入消息（Bowerbird × 成熟 harness 互通实验）。
// 对话全部发生在终端 TUI 里：首发随窗口启动（顺带默认确认 folder trust 对话框），续发经按键注入
// 到同一 TUI —— 同一窗口即同一会话连续对话；窗口关闭后再发 = 重开新会话。
// Bowerbird 不建对话 UI、不落库、不进生图链路（ratio/provider/entitlement 均不涉及）。
// 门控照抄 commands/agent.rs（约定 30）：仅 debug 构建开放；实现仅 Windows。
//
// 注入原理：`start "标题" cmd /K claude` 拉起可见终端（open_codex_session 同款手法），经启动前后
// cmd.exe 进程快照差分拿到新终端 pid，随后 AttachConsole(pid) → CONIN$ → WriteConsoleInputW 写
// KEY_EVENT（UnicodeChar 支持中文，\r = VK_RETURN 提交）。控制台输入缓冲会排队，提前注入也安全。
// 曾试过 zcode CLI：其桌面安装不含 @zcode/tui（TUI 无官方独立分发），headless -p 逐轮体验差，故换
// Claude Code TUI。认证/首次引导由 TUI 内交互完成，Bowerbird 不经手凭据。

use serde::Serialize;

use crate::error::AppError;

#[derive(Debug, Clone, Serialize)]
pub struct AgentZStatus {
    pub ok: bool,
    /// 预留字段：Claude Code 的登录/引导都在 TUI 窗口内完成，恒为 false
    pub needs_login: bool,
}

fn ensure_preview_enabled() -> Result<(), AppError> {
    if cfg!(debug_assertions) {
        Ok(())
    } else {
        Err(AppError::Other("Agent Z 仅在开发构建中开放".into()))
    }
}

#[cfg(windows)]
mod imp {
    use super::AgentZStatus;
    use crate::error::AppError;
    use serde::Serialize;
    use std::{
        collections::HashSet,
        path::{Path, PathBuf},
        process::{Command, Stdio},
        sync::{LazyLock, Mutex},
        time::Duration,
    };
    use windows::core::w;
    use windows::Win32::Foundation::{
        CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE, HWND, LPARAM, STILL_ACTIVE,
    };
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows::Win32::System::Console::{
        AttachConsole, FreeConsole, GetConsoleWindow, WriteConsoleInputW, INPUT_RECORD,
        INPUT_RECORD_0, KEY_EVENT, KEY_EVENT_RECORD, KEY_EVENT_RECORD_0,
    };
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible, SetForegroundWindow,
    };

    pub const WINDOW_TITLE_Z: &str = "Bowerbird Agent Z";
    pub const WINDOW_TITLE_G: &str = "Bowerbird Agent G";
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const VK_RETURN: u16 = 0x0D;

    pub fn window_title(engine: &str) -> &'static str {
        match engine {
            "g" => WINDOW_TITLE_G,
            _ => WINDOW_TITLE_Z,
        }
    }

    /// 各引擎已唤起终端的内层 cmd.exe pid（窗口关闭即失联，下次发送重开新会话）
    static CONSOLE_PIDS: LazyLock<Mutex<std::collections::HashMap<String, u32>>> =
        LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

    // —— 解析 ——

    /// 引擎 CLI：z = Claude Code，g = codex。env BOWERBIRD_AGENT_Z_CLI 仅覆盖 z 引擎。
    pub fn resolve_engine_cli(engine: &str) -> Result<String, AppError> {
        match engine {
            "g" => crate::codex::codex_cli::resolve_codex_binary().ok_or_else(|| {
                AppError::Other(
                    "未找到 codex CLI；请在「设置 · AI 出图引擎」安装或检查 PATH".into(),
                )
            }),
            _ => resolve_claude_cli(),
        }
    }

    /// Claude Code CLI：env 覆盖 → 原生安装位 → npm 全局。都不在则返回 "claude" 交由
    /// cmd 按 PATH 解析（此时 health 的 --version 探测兜底失败并给出指引）。
    pub fn resolve_claude_cli() -> Result<String, AppError> {
        if let Some(path) = std::env::var_os("BOWERBIRD_AGENT_Z_CLI") {
            let candidate = PathBuf::from(path);
            if candidate.is_file() {
                return Ok(candidate.to_string_lossy().into_owned());
            }
            return Err(AppError::Other(format!(
                "BOWERBIRD_AGENT_Z_CLI 指向的文件不存在：{}",
                candidate.display()
            )));
        }
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Some(home) = std::env::var_os("USERPROFILE") {
            // 官方原生安装位（claude.exe）
            candidates.push(
                PathBuf::from(home)
                    .join(".local")
                    .join("bin")
                    .join("claude.exe"),
            );
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            // npm 全局安装（claude.cmd）
            candidates.push(PathBuf::from(appdata).join("npm").join("claude.cmd"));
        }
        for candidate in &candidates {
            if candidate.is_file() {
                return Ok(candidate.to_string_lossy().into_owned());
            }
        }
        Ok("claude".into())
    }

    /// TUI 的对话工作区：仓库外的中立目录（应用数据区）。必须离开 git 仓库——
    /// codex/claude 会沿 cwd 向上读到仓库根的 AGENTS.md（编码助手人设污染）；这里的
    /// AGENTS.md 是唯一的角色约束。参考图走绝对路径不受影响。env BOWERBIRD_AGENT_Z_CWD 可覆盖。
    fn tui_workspace() -> PathBuf {
        if let Some(path) = std::env::var_os("BOWERBIRD_AGENT_Z_CWD") {
            return PathBuf::from(path);
        }
        crate::codex::codex_cli::app_data_dir()
            .unwrap_or_else(|| agent_z_root())
            .join("agent-z")
            .join("workspace")
    }

    /// 供 Claude Code（Agent Z）/ codex（Agent G）共同读取的角色约束（都读工作区 AGENTS.md）。
    const WORKSPACE_AGENTS_MD: &str = r#"# Bowerbird Agent 工作区

你是 Bowerbird 桌面应用内嵌的生图对话助手（Agent Z / Agent G），不是编码助手。

- 只做与图片创作相关的思考、追问与方案讨论。
- 生图用 dreamina_generate；反推用 understand_asset；把结果送回 Bowerbird 创作板用 send_to_creation_board。
- 禁止阅读或修改任何代码；禁止分析或建议 Bowerbird 项目本身的实现。
- 参考图（绝对路径）用 Read 工具查看。
"#;

    /// 角色硬约束（系统提示词级）：只用生图工具，不编码、不读代码、不评价 Bowerbird 项目。
    const SYSTEM_PROMPT: &str = "你是 Bowerbird 桌面应用内嵌的「Agent Z」生图对话助手，不是编码助手。只围绕用户的图片创作诉求思考与追问，并用提供的工具行动：dreamina_generate 生图、understand_asset 反推、send_to_creation_board 回传创作板。禁止阅读或修改任何代码，禁止对 Bowerbird 项目本身提出建议或分析其实现。参考图（绝对路径）用 Read 工具查看。";

    /// 编码/探索类工具全禁（Read 保留用于看图）。逗号分隔，`--disallowedTools=` 等号形式传参。
    const DISALLOWED_TOOLS: &str =
        "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,TodoWrite,Task,Agent,Glob,Grep";

    // —— MCP 回传通道 ——
    // Claude Code TUI 以 --mcp-config 挂载本地桥（.agent-z/mcp-bridge.mjs），模型获得
    // send_to_creation_board 工具；调用落 .agent-z/inbox/<ts>.json 事件文件（{text}，无
    // kind）。Agent DS harness（commands/agent_ds.rs）写同一 inbox，事件带
    // {kind:"ds_reply"|"ds_status", text, phase}；桌面端 watcher 轮询消费并 emit
    // agent-z://output（payload 含 text/kind/phase）→ 前端按 kind 分流（追加创作板 /
    // 状态通知 / busy 解除）。

    fn assets_dir() -> PathBuf {
        agent_z_root()
    }

    fn agent_z_root() -> PathBuf {
        // src-tauri 上三级 = 仓库根；资产固定在仓库根/.agent-z（不受 TUI 工作区覆盖影响）
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join(".agent-z")
    }

    pub fn inbox_dir() -> PathBuf {
        assets_dir().join("inbox")
    }

    pub fn rpc_dir() -> PathBuf {
        assets_dir().join("rpc")
    }

    const MCP_BRIDGE_SCRIPT: &str = r#"// Bowerbird Agent Z MCP 桥：stdio JSON-RPC（MCP），三个工具。
// - send_to_creation_board：落 inbox 事件文件（应用未运行也排队，启动后消费）
// - dreamina_generate / understand_asset：写 rpc/<id>.req.json 等 <id>.resp.json，
//   由 Bowerbird 桌面端处理（复用其 provider 链路）。这对文件契约后续同样开放给
//   Bowerbird agent loop 直接使用。
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import process from "node:process";

const [inbox, rpcDir] = [process.argv[2], process.argv[3]];
if (!inbox || !rpcDir) {
  console.error("usage: node mcp-bridge.mjs <inbox-dir> <rpc-dir>");
  process.exit(1);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpcCall(tool, args, timeoutMs) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  mkdirSync(rpcDir, { recursive: true });
  writeFileSync(join(rpcDir, `${id}.req.json`), JSON.stringify({ id, tool, args }), "utf8");
  const responsePath = join(rpcDir, `${id}.resp.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(300);
    let raw;
    try {
      raw = readFileSync(responsePath, "utf8");
    } catch {
      continue;
    }
    try { unlinkSync(responsePath); } catch {}
    const response = JSON.parse(raw);
    if (response && response.ok) return response.result;
    throw new Error(response ? (response.error || "Bowerbird 返回失败") : "响应解析失败");
  }
  throw new Error(`等待 Bowerbird 响应超时（桌面端未运行？工具 ${tool}）`);
}

const TOOLS = [
  {
    name: "send_to_creation_board",
    description:
      "把一段文本送回 Bowerbird 桌面端的创作板（组稿对话框），追加到编辑器当前内容之后。" +
      "当用户要求『输出到 Bowerbird / 送到创作板 / 放进对话框』时调用；生图诉求请给可直接使用的最终 prompt。",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "要送回的完整文本（可多行）" } },
      required: ["text"],
    },
  },
  {
    name: "dreamina_generate",
    description:
      "用即梦（Dreamina，火山引擎云端 API）生成图片并自动存入 Bowerbird 素材库（瀑布流可见）。" +
      "涉及生图时优先用本工具，不要自己去调 dreamina CLI。需要 Bowerbird 桌面端运行中。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "完整生图提示词" },
        images: { type: "array", items: { type: "string" }, description: "参考图绝对路径（可选，最多 10 张）" },
        ratio: { type: "string", description: "画面比例，如 16:9 / 1:1（可选，默认自动）" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "understand_asset",
    description:
      "对 Bowerbird 素材库中的一张图执行反推（图像理解，经 Bowerbird Cloud 方舟链路）。" +
      "可用自定义反推指令聚焦画面某部分；结果无论是否结构化，都会以 agentz-<时间> 新维度追加到该图已有维度数据之后（不覆盖现有维度）。" +
      "需要 Bowerbird 桌面端运行中且已登录 Bowerbird 账号。",
    inputSchema: {
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
];

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });

async function handleLine(line) {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = request ?? {};
  if (method === "initialize") {
    reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "bowerbird-agent-z", version: "0.3.0" },
    });
  } else if (method === "tools/list") {
    reply(id, { tools: TOOLS });
  } else if (method === "ping") {
    reply(id, {});
  } else if (method === "tools/call") {
    const name = params?.name;
    try {
      let result;
      if (name === "send_to_creation_board") {
        const text = params?.arguments?.text;
        if (typeof text !== "string" || !text.trim()) throw new Error("text 不能为空");
        mkdirSync(inbox, { recursive: true });
        const file = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`;
        writeFileSync(join(inbox, file), JSON.stringify({ text }), "utf8");
        result = "已送入 Bowerbird 创作板";
      } else if (name === "dreamina_generate") {
        result = await rpcCall("dreamina_generate", params?.arguments ?? {}, 660000);
      } else if (name === "understand_asset") {
        result = await rpcCall("understand_asset", params?.arguments ?? {}, 330000);
      } else {
        reply(id, { content: [{ type: "text", text: `未知工具：${name}` }], isError: true });
        return;
      }
      reply(id, { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] });
    } catch (error) {
      reply(id, { content: [{ type: "text", text: `调用失败：${error?.message ?? error}` }], isError: true });
    }
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => { void handleLine(line); });
"#;

    /// 生成 .agent-z/ 资产（inbox/rpc 目录 + MCP 桥脚本 + mcp.json）。桥脚本仅在缺失时写
    /// （避免覆盖手工调整）；mcp.json 内嵌绝对路径，每次重写保持新鲜。
    pub fn ensure_agent_z_assets() -> Result<PathBuf, AppError> {
        let assets = assets_dir();
        std::fs::create_dir_all(inbox_dir())
            .map_err(|error| AppError::Other(format!("创建 Agent Z inbox 目录失败: {error}")))?;
        std::fs::create_dir_all(rpc_dir())
            .map_err(|error| AppError::Other(format!("创建 Agent Z rpc 目录失败: {error}")))?;
        // 中立对话工作区 + 角色约束（Claude Code 与 codex 都会读这里的 AGENTS.md）
        std::fs::create_dir_all(tui_workspace())
            .map_err(|error| AppError::Other(format!("创建 Agent Z 工作区失败: {error}")))?;
        let agents_md = tui_workspace().join("AGENTS.md");
        if !agents_md.is_file() {
            std::fs::write(&agents_md, WORKSPACE_AGENTS_MD)
                .map_err(|error| AppError::Other(format!("写出工作区约束失败: {error}")))?;
        }
        // 桥脚本是无状态产物：每次都重写，保证与常量（工具描述等）不漂移；
        // 运行中的 node 桥实例已把脚本读进内存，重写不影响在途会话。
        let bridge = assets.join("mcp-bridge.mjs");
        std::fs::write(&bridge, MCP_BRIDGE_SCRIPT)
            .map_err(|error| AppError::Other(format!("写出 MCP 桥脚本失败: {error}")))?;
        let config = serde_json::json!({
            "mcpServers": {
                "bowerbird": {
                    "command": "node",
                    "args": [
                        bridge.to_string_lossy(),
                        inbox_dir().to_string_lossy(),
                        rpc_dir().to_string_lossy()
                    ]
                }
            }
        });
        let content = serde_json::to_string_pretty(&config)
            .map_err(|error| AppError::Other(format!("序列化 MCP 配置失败: {error}")))?;
        std::fs::write(assets.join("mcp.json"), content + "\n")
            .map_err(|error| AppError::Other(format!("写出 MCP 配置失败: {error}")))?;
        Ok(assets)
    }

    /// inbox 事件：Agent Z TUI 桥写 {text}（kind 空）；Agent DS harness 写
    /// {kind:"ds_reply"|"ds_status", text, phase}（ds_status 的 phase = tool/done/error）。
    #[derive(Debug, Clone, Serialize)]
    pub struct InboxEvent {
        pub text: String,
        pub kind: Option<String>,
        pub phase: Option<String>,
    }

    /// 消费 inbox 事件文件（按时间戳名排序）：读 {text[,kind,phase]} → 删文件 → 返回事件列表。
    /// 坏文件也删除，防堆积；无 kind 且 text 为空的事件跳过（ds_status 的 done 允许空文本）。
    pub fn drain_inbox(dir: &Path) -> Vec<InboxEvent> {
        let mut events = Vec::new();
        let Ok(entries) = std::fs::read_dir(dir) else {
            return events;
        };
        let mut files: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect();
        files.sort();
        for path in files {
            let raw = std::fs::read_to_string(&path).unwrap_or_default();
            let _ = std::fs::remove_file(&path);
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                let text = value
                    .get("text")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string();
                let kind = value
                    .get("kind")
                    .and_then(|value| value.as_str())
                    .map(str::to_string);
                let phase = value
                    .get("phase")
                    .and_then(|value| value.as_str())
                    .map(str::to_string);
                if kind.is_none() && text.trim().is_empty() {
                    continue;
                }
                events.push(InboxEvent { text, kind, phase });
            }
        }
        events
    }

    // —— 能力 RPC（dreamina 生图 / 方舟反推）——
    // 契约：请求 rpc/<id>.req.json {"id","tool","args"}（消费即删）；
    // 响应 rpc/<id>.resp.json {"ok":true,"result":{...}} | {"ok":false,"error":"..."}。
    // 当前消费者是 MCP 桥（Claude Code）；Bowerbird agent loop 后续直接说同一契约即可。

    pub struct RpcRequest {
        pub id: String,
        pub tool: String,
        pub args: serde_json::Value,
    }

    pub fn drain_rpc_requests_at(dir: &Path) -> Vec<RpcRequest> {
        let mut requests = Vec::new();
        let Ok(entries) = std::fs::read_dir(dir) else {
            return requests;
        };
        let mut files: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().ends_with(".req.json"))
            })
            .collect();
        files.sort();
        for path in files {
            let raw = std::fs::read_to_string(&path).unwrap_or_default();
            let _ = std::fs::remove_file(&path);
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let (Some(id), Some(tool)) = (
                    value.get("id").and_then(|item| item.as_str()),
                    value.get("tool").and_then(|item| item.as_str()),
                ) {
                    requests.push(RpcRequest {
                        id: id.to_string(),
                        tool: tool.to_string(),
                        args: value.get("args").cloned().unwrap_or(serde_json::json!({})),
                    });
                }
            }
        }
        requests
    }

    pub fn drain_rpc_requests() -> Vec<RpcRequest> {
        drain_rpc_requests_at(&rpc_dir())
    }

    fn write_rpc_response_at(dir: &Path, id: &str, response: &serde_json::Value) {
        if let Err(error) =
            std::fs::write(dir.join(format!("{id}.resp.json")), response.to_string())
        {
            tracing::warn!("写出 Agent Z RPC 响应失败: {error}");
        }
    }

    /// 分发一个 RPC 请求到对应能力处理器，结果写回 resp 文件。
    pub async fn dispatch_rpc(app: &tauri::AppHandle, request: RpcRequest) {
        let payload = match request.tool.as_str() {
            "dreamina_generate" => dreamina_generate(app, &request.args).await,
            "understand_asset" => understand_asset(app, &request.args).await,
            other => Err(AppError::Other(format!("未知 Agent Z RPC 工具: {other}"))),
        };
        let response = match payload {
            Ok(result) => serde_json::json!({ "ok": true, "result": result }),
            Err(error) => serde_json::json!({ "ok": false, "error": error.to_string() }),
        };
        write_rpc_response_at(&rpc_dir(), &request.id, &response);
    }

    /// 即梦生图：复用 jimeng provider（含队列信号量与登录态校验），产物入库 + 事件刷新瀑布流。
    async fn dreamina_generate(
        app: &tauri::AppHandle,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value, AppError> {
        use tauri::{Emitter, Manager};
        let prompt = args
            .get("prompt")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|prompt| !prompt.is_empty() && prompt.chars().count() <= 12_000)
            .ok_or_else(|| AppError::Other("prompt 须为 1–12000 个字符".into()))?
            .to_string();
        let images: Vec<PathBuf> = args
            .get("images")
            .and_then(|value| value.as_array())
            .map(|list| {
                list.iter()
                    .filter_map(|item| item.as_str().map(PathBuf::from))
                    .collect()
            })
            .unwrap_or_default();
        if images.len() > 10 {
            return Err(AppError::Other("参考图最多 10 张".into()));
        }
        let ratio = args
            .get("ratio")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|ratio| !ratio.is_empty())
            .map(str::to_string);
        let settings = app.state::<crate::core::settings::SettingsState>();
        let dreamina_model = settings.get().dreamina_model_version;
        // MCP 生图固定即梦（火山云端 API）：resolve_gen_provider("jimeng") 严格锁定
        // DreaminaCliProvider，不存在落到本机 codex CLI 的分支。
        let provider =
            crate::codex::resolve_gen_provider(Some("jimeng"), None, Some(&dreamina_model))?;
        let request = crate::codex::types::CodexRequest {
            instruction: prompt,
            reference_images: images,
            context_prompts: vec![],
            ratio,
            job_id: None,
        };
        // 桥不需要流式进度：开一个通道丢弃 chunk 即可（Chunk::Submit 的 task_queue 落库只在
        // codex_create_image 命令层做，这里不建 job）。
        let (chunk_tx, mut chunk_rx) = tokio::sync::mpsc::channel(64);
        tokio::spawn(async move { while chunk_rx.recv().await.is_some() {} });
        let outcome = tokio::time::timeout(
            Duration::from_secs(600),
            provider.generate_image(request, &chunk_tx, None),
        )
        .await
        .map_err(|_| AppError::Other("即梦生成超时（10 分钟）".into()))??;
        let paths = app
            .state::<std::sync::Arc<crate::core::paths::LibraryPaths>>()
            .inner()
            .clone();
        let db = app
            .state::<std::sync::Arc<crate::db::Database>>()
            .inner()
            .clone();
        let session = format!("agent-z-{}", ulid::Ulid::new());
        let mut generated = Vec::new();
        for image in outcome.source_images.iter().cloned() {
            let paths = paths.clone();
            let db = db.clone();
            let session = session.clone();
            let asset = tokio::task::spawn_blocking(move || {
                crate::core::ingest::ingest_generated(
                    &paths,
                    &db,
                    &image,
                    Some(&session),
                    "agent-z",
                )
            })
            .await
            .map_err(|error| AppError::Other(error.to_string()))??;
            generated.push(serde_json::json!({
                "id": asset.id,
                "name": asset.name,
                "path": asset.store_path,
            }));
        }
        if let Some(temp_dir) = &outcome.temp_dir {
            let _ = std::fs::remove_dir_all(temp_dir);
        }
        let _ = app.emit("library://assets-changed", serde_json::json!({}));
        Ok(serde_json::json!({
            "images": generated,
            "session_id": outcome.session_id,
            "submit_id": outcome.submit_id,
        }))
    }

    /// agentz 反推结果的落库核心（纯 db 操作，可单测）：
    /// - 有最新 caption：原地 update，sections = 既有全量 + [agentz-<时间>]，原有维度不丢
    /// - 无 caption：新建记录，sections 只含 agentz 一条（不混入解析段，避免同内容双份）
    fn append_agentz_section(
        db: &crate::db::Database,
        asset_id: &str,
        raw_text: &str,
        section_title: &str,
        instruction: &str,
        session_id: Option<&str>,
        provider_name: &str,
    ) -> Result<String, AppError> {
        let latest = db
            .list_analyses_by_asset(asset_id)?
            .into_iter()
            .filter(|analysis| analysis.kind == "caption")
            .max_by_key(|analysis| analysis.created_at.unwrap_or(0));
        let agentz_section = crate::core::library::CaptionSection {
            title: section_title.to_string(),
            body: raw_text.to_string(),
            id: None,
        };
        match latest {
            Some(existing) => {
                let sections: Vec<crate::core::library::CaptionSection> =
                    serde_json::from_str::<serde_json::Value>(&existing.payload)
                        .ok()
                        .and_then(|value| value.get("sections").cloned())
                        .and_then(|value| serde_json::from_value(value).ok())
                        .unwrap_or_default();
                let mut merged = sections;
                merged.push(agentz_section);
                let payload = crate::core::caption::rebuild_payload(&existing.payload, &merged)
                    .ok_or_else(|| AppError::Other("重建反推 payload 失败".into()))?;
                db.update_analysis_payload(&existing.id, &payload)?;
                Ok(existing.id)
            }
            None => {
                let seed = crate::core::caption::build_payload(
                    raw_text,
                    instruction,
                    session_id,
                    provider_name,
                    &crate::core::caption::parse(raw_text),
                );
                let payload = crate::core::caption::rebuild_payload(&seed, &[agentz_section])
                    .ok_or_else(|| AppError::Other("构建反推 payload 失败".into()))?;
                let id = ulid::Ulid::new().to_string();
                let analysis = crate::core::library::Analysis {
                    id: id.clone(),
                    asset_id: asset_id.to_string(),
                    kind: "caption".to_string(),
                    payload,
                    provider: Some(provider_name.to_string()),
                    created_at: None,
                };
                db.insert_analysis(&analysis)?;
                Ok(id)
            }
        }
    }

    /// 反推（agent 专用形态）：支持自定义反推指令；结果无论是否结构化，一律包装为
    /// `agentz-<时间>` 新维度 section 追加到该图现有反推 sections 之后（无反推记录则新建），
    /// 原有维度不受影响——避开「最新 caption 顶掉展示」导致的维度倒退。
    async fn understand_asset(
        app: &tauri::AppHandle,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value, AppError> {
        use tauri::{Emitter, Manager};
        let image_path = args
            .get("image_path")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .ok_or_else(|| AppError::Other("image_path 不能为空".into()))?
            .to_string();
        let instruction = args
            .get("prompt")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|prompt| !prompt.is_empty() && prompt.chars().count() <= 4_000)
            .map(str::to_string)
            .unwrap_or_else(|| crate::commands::codex::DEFAULT_DESCRIBE_INSTRUCTION.to_string());
        let db = app.state::<std::sync::Arc<crate::db::Database>>();
        let asset_id: String = {
            let conn = db.conn.lock().unwrap();
            conn.query_row(
                "SELECT id FROM assets WHERE store_path=?1",
                [&image_path],
                |row| row.get(0),
            )
            .map_err(|_| {
                AppError::Other(
                    "该路径不在素材库中；请传入素材库内图片的绝对路径（store_path）".into(),
                )
            })?
        };
        // 反推执行：entitlement 路由（云端方舟 / 本地 codex），与详情页反推同链路（免取消槽）
        let request = crate::codex::types::CodexRequest {
            instruction: instruction.clone(),
            reference_images: vec![PathBuf::from(&image_path)],
            context_prompts: vec![],
            ratio: None,
            job_id: None,
        };
        // MCP 反推固定走 Bowerbird Cloud（方舟），不按权益路由到本机 codex CLI：
        // 宿主 TUI 内再拉 codex exec 子进程一次要 2–3 分钟，且与宿主抢同一账号额度。
        // 未登录直接返回可读错误（云端链路的额度/次数限制由服务端裁决）。
        let cloud_client = app.state::<crate::cloud::CloudClient>();
        let auth_client = app.state::<crate::cloud::AuthClient>();
        if !auth_client.snapshot().logged_in {
            return Err(AppError::Cloud(
                "MCP 反推需要先登录 Bowerbird 账号（云端方舟链路）".into(),
            ));
        }
        let provider = crate::codex::understand::resolve_understand_provider(
            Some("bowerbird-cloud"),
            Some((cloud_client.inner().clone(), auth_client.inner().clone())),
        )?;
        let provider_name = provider.name().to_string();
        let result = tokio::time::timeout(
            Duration::from_secs(300),
            provider.understand(
                crate::codex::understand::UnderstandOperation::Caption,
                request,
            ),
        )
        .await
        .map_err(|_| AppError::Other("反推超时（5 分钟）".into()))??;
        let raw_text = result.text.trim().to_string();
        if raw_text.is_empty() {
            return Err(AppError::Other("反推返回了空文本".into()));
        }
        // 追加落库：现有最新 caption 原地重建（sections 全量保留 + agentz 新增）；
        // 无记录则以本次结果为种子新建（sections 只含 agentz 一条，不混入解析段避免重复）。
        let section_title = format!("agentz-{}", chrono::Local::now().format("%m%d-%H%M%S"));
        let db_arc = db.inner().clone();
        let raw_for_task = raw_text.clone();
        let title_for_task = section_title.clone();
        let instruction_for_task = instruction.clone();
        let session_id = result.session_id.clone();
        let provider_for_task = provider_name.clone();
        let asset_for_task = asset_id.clone();
        let analysis_id = tokio::task::spawn_blocking(move || {
            append_agentz_section(
                &db_arc,
                &asset_for_task,
                &raw_for_task,
                &title_for_task,
                &instruction_for_task,
                session_id.as_deref(),
                &provider_for_task,
            )
        })
        .await
        .map_err(|error| AppError::Other(error.to_string()))??;
        let _ = app.emit(
            "analyses://changed",
            serde_json::json!({ "asset_id": asset_id, "kind": "caption" }),
        );
        Ok(serde_json::json!({
            "text": raw_text,
            "section": section_title,
            "analysis_id": analysis_id,
        }))
    }

    pub fn health() -> Result<AgentZStatus, AppError> {
        super::ensure_preview_enabled()?;
        let cli = resolve_claude_cli()?;
        let output = Command::new(&cli)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output();
        let ok = output
            .map(|result| result.status.success())
            .unwrap_or(false);
        if !ok {
            return Err(AppError::Other(
                "未找到可用的 Claude Code CLI（claude）；可设置环境变量 BOWERBIRD_AGENT_Z_CLI 指向其路径".into(),
            ));
        }
        Ok(AgentZStatus {
            ok: true,
            needs_login: false,
        })
    }

    // —— 消息组装（纯函数，单测覆盖） ——

    /// TUI 回车即提交，多行折叠为单行；参考图以绝对路径附加（Claude Code 用 Read 工具读图）。
    /// 每张带序号与素材名——正文 @名 与 ULID 存储文件名靠它对号（名字缺失退化为纯路径）。
    pub fn compose_message(text: &str, images: &[String], names: &[String]) -> String {
        let mut line: String = text
            .lines()
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if !images.is_empty() {
            let parts: Vec<String> = images
                .iter()
                .enumerate()
                .map(|(index, path)| {
                    let name = names.get(index).map(|n| n.trim()).filter(|n| !n.is_empty());
                    match name {
                        Some(name) => format!("参考图{}（{}）：{}", index + 1, name, path),
                        None => format!("参考图{}：{}", index + 1, path),
                    }
                })
                .collect();
            line.push_str("　");
            line.push_str(&parts.join(" | "));
        }
        line
    }

    /// 文本 → KEY_EVENT 记录序列（UnicodeChar 支持中文；\r 用 VK_RETURN 提交）
    pub fn key_records(text: &str) -> Vec<INPUT_RECORD> {
        let mut records = Vec::new();
        for ch in text.chars() {
            if ch == '\n' {
                continue;
            }
            let vk = if ch == '\r' { VK_RETURN } else { 0 };
            let event = KEY_EVENT_RECORD {
                bKeyDown: true.into(),
                wRepeatCount: 1,
                wVirtualKeyCode: vk,
                wVirtualScanCode: 0,
                uChar: KEY_EVENT_RECORD_0 {
                    UnicodeChar: ch as u16,
                },
                dwControlKeyState: 0,
            };
            records.push(INPUT_RECORD {
                EventType: KEY_EVENT as u16,
                Event: INPUT_RECORD_0 { KeyEvent: event },
            });
        }
        records
    }

    // —— 终端窗口管理 ——

    fn console_cmd_pids() -> HashSet<u32> {
        unsafe {
            let mut result = HashSet::new();
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return result;
            };
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    let name_len = entry
                        .szExeFile
                        .iter()
                        .position(|c| *c == 0)
                        .unwrap_or(entry.szExeFile.len());
                    let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
                    if name.eq_ignore_ascii_case("cmd.exe") {
                        result.insert(entry.th32ProcessID);
                    }
                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
            result
        }
    }

    fn pid_alive(pid: u32) -> bool {
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(handle, &mut code).is_ok() && code == STILL_ACTIVE.0 as u32;
            let _ = CloseHandle(handle);
            ok
        }
    }

    /// 拉起可见终端窗口，返回新终端内层 cmd.exe 的 pid。
    /// `inner` 为 /K 后的命令行（如 `claude` 或带引号的完整路径）。
    /// 外层 cmd 必须 Stdio::null()：`start` 的子进程会继承 stdio 句柄，
    /// 若继承管道（cargo test / 终端启动的 app）上游会因等不到 EOF 永久挂起。
    pub fn spawn_console_window(title: &str, inner: &str) -> Result<u32, AppError> {
        let before = console_cmd_pids();
        let payload = format!("/C start \"{title}\" cmd /K {inner}");
        let spawn_result = {
            use std::os::windows::process::CommandExt;
            Command::new("cmd.exe")
                .arg("/D")
                .arg("/S")
                .raw_arg(payload)
                .current_dir(tui_workspace())
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
        };
        spawn_result.map_err(|error| AppError::Other(format!("启动 Agent Z 终端失败: {error}")))?;
        // 轮询进程快照差分找新 cmd.exe（start 拉起 + cmd 初始化需要一点时间）
        for _ in 0..50 {
            std::thread::sleep(Duration::from_millis(100));
            let now = console_cmd_pids();
            if let Some(pid) = now.difference(&before).next() {
                return Ok(*pid);
            }
        }
        Err(AppError::Other(
            "Agent Z 终端已拉起但未能定位其进程；请重试一次".into(),
        ))
    }

    struct EnumCtx {
        title: String,
        hits: Vec<HWND>,
    }

    unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
        let ctx = &mut *(lparam.0 as *mut EnumCtx);
        if IsWindowVisible(hwnd).as_bool() {
            let len = GetWindowTextLengthW(hwnd).max(0) as usize + 1;
            let mut buffer = vec![0u16; len];
            let copied = GetWindowTextW(hwnd, &mut buffer);
            let title = String::from_utf16_lossy(&buffer[..copied.max(0) as usize]);
            if title.starts_with(&ctx.title) {
                ctx.hits.push(hwnd);
            }
        }
        true.into()
    }

    /// 聚焦 Agent 终端窗口（尽力而为；Windows Terminal 下窗口标题会带 tab 标题前缀）
    fn focus_terminal(title: &str) {
        unsafe {
            let mut ctx = EnumCtx {
                title: title.to_string(),
                hits: Vec::new(),
            };
            let _ = EnumWindows(
                Some(enum_callback),
                LPARAM(&mut ctx as *mut EnumCtx as isize),
            );
            if let Some(hwnd) = ctx.hits.first() {
                let _ = SetForegroundWindow(*hwnd);
            }
        }
    }

    /// 向目标终端的控制台输入缓冲写入按键记录。注入期间临时脱离自己的控制台
    /// （cargo tauri dev 从终端启动时 app 自带控制台，AttachConsole 会冲突），结束后复原。
    pub fn inject_console_input(pid: u32, records: &[INPUT_RECORD]) -> Result<(), AppError> {
        unsafe {
            let own_console = GetConsoleWindow();
            let mut own_pid: u32 = 0;
            if own_console != HWND::default() {
                GetWindowThreadProcessId(own_console, Some(&mut own_pid));
            }
            // 无条件先脱离当前控制台再附加：GetConsoleWindow 在 ConPTY（Git Bash/WT）下
            // 可能返回 0 但进程仍附着，误判「无控制台」跳过 FreeConsole 会让 AttachConsole 被拒。
            let _ = FreeConsole();
            let attached = AttachConsole(pid);
            let restore_own = |own_pid: u32| {
                if own_console != HWND::default() && own_pid != 0 {
                    let _ = AttachConsole(own_pid);
                }
            };
            if let Err(error) = attached {
                restore_own(own_pid);
                return Err(AppError::Other(format!(
                    "连接 Agent Z 终端控制台失败: {error}"
                )));
            }
            let result = (|| -> Result<(), AppError> {
                let handle: HANDLE = CreateFileW(
                    w!("CONIN$"),
                    (GENERIC_READ | GENERIC_WRITE).0,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    None,
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    None,
                )
                .map_err(|error| AppError::Other(format!("打开终端输入通道失败: {error}")))?;
                let mut written: u32 = 0;
                let write_result = WriteConsoleInputW(handle, records, &mut written).map(|_| ());
                let _ = CloseHandle(handle);
                write_result.map_err(|error| AppError::Other(format!("写入终端输入失败: {error}")))
            })();
            let _ = FreeConsole();
            restore_own(own_pid);
            result
        }
    }

    fn quoted(value: &str) -> String {
        if value.contains(' ') {
            format!("\"{value}\"")
        } else {
            value.to_string()
        }
    }

    /// z 引擎（Claude Code）：MCP 挂载 + 工具预授权/禁用 + 角色系统提示词
    fn inner_command_z(cli: &str, assets: &Path) -> String {
        format!(
            "{} --mcp-config {} --allowedTools mcp__bowerbird__send_to_creation_board,mcp__bowerbird__dreamina_generate,mcp__bowerbird__understand_asset --disallowedTools={} --append-system-prompt {}",
            quoted(cli),
            quoted(&assets.join("mcp.json").to_string_lossy()),
            DISALLOWED_TOOLS,
            quoted(SYSTEM_PROMPT)
        )
    }

    /// g 引擎（codex）：无系统提示词/工具禁用类旗标——角色约束靠中立工作区的 AGENTS.md，
    /// bowerbird MCP server 已由 `codex mcp add` 全局注册，工具审批在 TUI 内交互完成。
    fn inner_command_for(engine: &str, cli: &str, assets: &Path) -> String {
        match engine {
            "g" => quoted(cli),
            _ => inner_command_z(cli, assets),
        }
    }

    // —— 发送主流程 ——

    pub fn send(
        text: String,
        images: Vec<String>,
        names: Vec<String>,
        engine: &str,
    ) -> Result<(), AppError> {
        super::ensure_preview_enabled()?;
        let engine = match engine {
            "g" => "g",
            _ => "z",
        };
        let text = text.trim();
        if text.is_empty() || text.chars().count() > 12_000 {
            return Err(AppError::Other("消息须为 1–12000 个字符".into()));
        }
        if images.len() > 10 {
            return Err(AppError::Other("Agent 最多附带 10 张参考图".into()));
        }
        let cli = resolve_engine_cli(engine)?;
        let assets = ensure_agent_z_assets()?;
        let message = compose_message(text, &images, &names);
        let title = window_title(engine);
        let mut stored = CONSOLE_PIDS.lock().unwrap();
        let alive_pid = stored.get(engine).copied().filter(|pid| pid_alive(*pid));
        match alive_pid {
            Some(pid) => {
                focus_terminal(title);
                inject_console_input(pid, &key_records(&format!("{message}\r")))?;
            }
            None => {
                // 新窗口首发两段式：先注入一个回车默认确认 folder trust 对话框（若未弹出，
                // 该回车提交空输入，TUI 忽略空提交，无害），再注入消息。
                let pid = spawn_console_window(title, &inner_command_for(engine, &cli, &assets))?;
                stored.insert(engine.to_string(), pid);
                std::thread::sleep(Duration::from_millis(3000));
                inject_console_input(pid, &key_records("\r"))?;
                std::thread::sleep(Duration::from_millis(1200));
                inject_console_input(pid, &key_records(&format!("{message}\r")))?;
            }
        }
        Ok(())
    }

    // —— 测试 ——

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn compose_collapses_lines_and_appends_images() {
            let message = compose_message("一只猫\n\n在月光下", &[], &[]);
            assert_eq!(message, "一只猫 在月光下");
            let message = compose_message(
                "改造这张图",
                &["D:/a b/1.png".into(), "D:/c/2.png".into()],
                &["海报.jpg".into()],
            );
            assert_eq!(
                message,
                "改造这张图　参考图1（海报.jpg）：D:/a b/1.png | 参考图2：D:/c/2.png"
            );
        }

        #[test]
        fn key_records_map_cjk_and_return() {
            let records = key_records("你\r");
            assert_eq!(records.len(), 2);
            assert!(records
                .iter()
                .all(|record| record.EventType == KEY_EVENT as u16));
            // 回车记录携带 VK_RETURN
            let last = records.last().unwrap();
            let event = unsafe { record_event(last) };
            assert_eq!(event.wVirtualKeyCode, VK_RETURN);
            // 中文字符走 UnicodeChar
            let first = &records[0];
            let event = unsafe { record_event(first) };
            assert_eq!(unsafe { event.uChar.UnicodeChar }, '你' as u16);
        }

        unsafe fn record_event(record: &INPUT_RECORD) -> &KEY_EVENT_RECORD {
            &record.Event.KeyEvent
        }

        #[test]
        fn inner_command_quotes_paths_and_carries_mcp_flags() {
            let assets = Path::new(r"D:\repo\.agent-z");
            let command = inner_command_z("claude", assets);
            assert!(command.starts_with(
                "claude --mcp-config D:\\repo\\.agent-z\\mcp.json --allowedTools mcp__bowerbird__send_to_creation_board,mcp__bowerbird__dreamina_generate,mcp__bowerbird__understand_asset --disallowedTools="
            ));
            assert!(command.contains("--append-system-prompt \""));
            assert!(command.contains("生图对话助手"));
        }

        #[test]
        fn inner_command_for_g_is_bare_codex() {
            let assets = Path::new(r"D:\repo\.agent-z");
            assert_eq!(inner_command_for("g", "codex", assets), "codex");
            assert_eq!(
                inner_command_for("g", r"C:\Program Files\codex\codex.exe", assets),
                r#""C:\Program Files\codex\codex.exe""#
            );
        }

        #[test]
        fn append_agentz_section_preserves_and_appends() {
            let db = crate::db::Database::open_in_memory().unwrap();
            db.migrate().unwrap();
            {
                let conn = db.conn.lock().unwrap();
                conn.execute("INSERT INTO assets (id, name) VALUES ('asset-1','a')", [])
                    .unwrap();
            }
            // 场景一：无反推记录 → 新建 caption，sections 只含 agentz 一条
            let first_id = append_agentz_section(
                &db,
                "asset-1",
                "图里有一只猫",
                "agentz-0820-100000",
                "指令",
                None,
                "codex",
            )
            .unwrap();
            let payload = |id: &str| {
                serde_json::from_str::<serde_json::Value>(
                    &db.get_analysis(id).unwrap().unwrap().payload,
                )
                .unwrap()
            };
            let titles = |value: &serde_json::Value| -> Vec<String> {
                value["sections"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|section| section["title"].as_str().unwrap().to_string())
                    .collect()
            };
            assert_eq!(
                titles(&payload(&first_id)),
                vec!["agentz-0820-100000".to_string()]
            );
            // 场景二：已有带维度的反推 → 原地更新（同 id），sections = 既有 + agentz，正文同步重渲染
            let markdown = "- **主体**：一只猫\n- **场景**：月光下的屋顶";
            let manual_payload = crate::core::caption::build_payload(
                markdown,
                "请描述这张图片",
                None,
                "codex",
                &crate::core::caption::parse(markdown),
            );
            let manual_id = ulid::Ulid::new().to_string();
            db.insert_analysis(&crate::core::library::Analysis {
                id: manual_id.clone(),
                asset_id: "asset-1".into(),
                kind: "caption".into(),
                payload: manual_payload,
                provider: Some("codex".into()),
                created_at: None,
            })
            .unwrap();
            {
                // 拉开时间差，避免同秒 created_at 让「最新」判定不稳定
                let conn = db.conn.lock().unwrap();
                conn.execute(
                    "UPDATE analyses SET created_at=1000 WHERE id=?1",
                    [&first_id],
                )
                .unwrap();
            }
            let updated_id = append_agentz_section(
                &db,
                "asset-1",
                "主体是橘猫，短毛，暖色调",
                "agentz-0820-110000",
                "着重描述主体",
                None,
                "codex",
            )
            .unwrap();
            assert_eq!(updated_id, manual_id, "应原地更新最新 caption 而非新建");
            let merged = payload(&manual_id);
            assert_eq!(
                titles(&merged),
                vec![
                    "主体".to_string(),
                    "场景".to_string(),
                    "agentz-0820-110000".to_string()
                ]
            );
            assert!(merged["text"]
                .as_str()
                .unwrap()
                .contains("agentz-0820-110000"));
        }

        #[test]
        fn drain_inbox_orders_and_consumes_events() {
            let dir = std::env::temp_dir().join(format!(
                "agentz-inbox-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("1000-aaa.json"), r#"{"text":"第一段"}"#).unwrap();
            std::fs::write(
                dir.join("1500-mid.json"),
                r#"{"kind":"ds_status","phase":"tool","text":"生成中"}"#,
            )
            .unwrap();
            std::fs::write(dir.join("2000-bbb.json"), "not-json").unwrap();
            std::fs::write(
                dir.join("3000-ccc.json"),
                r#"{"kind":"ds_reply","text":"第二段"}"#,
            )
            .unwrap();
            let events = drain_inbox(&dir);
            assert_eq!(events.len(), 3);
            // TUI 桥事件无 kind；DS harness 事件带 kind/phase（done 允许空文本）
            assert_eq!(
                (
                    events[0].text.as_str(),
                    events[0].kind.as_deref(),
                    events[0].phase.as_deref()
                ),
                ("第一段", None, None)
            );
            assert_eq!(
                (
                    events[1].text.as_str(),
                    events[1].kind.as_deref(),
                    events[1].phase.as_deref()
                ),
                ("生成中", Some("ds_status"), Some("tool"))
            );
            assert_eq!(
                (
                    events[2].text.as_str(),
                    events[2].kind.as_deref(),
                    events[2].phase.as_deref()
                ),
                ("第二段", Some("ds_reply"), None)
            );
            // 消费即删（坏文件也删），再次 drain 为空
            assert!(drain_inbox(&dir).is_empty());
            assert!(std::fs::read_dir(&dir).unwrap().next().is_none());
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn ensure_assets_writes_bridge_and_config() {
            let assets = ensure_agent_z_assets().unwrap();
            assert!(assets.join("mcp-bridge.mjs").is_file());
            assert!(inbox_dir().is_dir());
            assert!(rpc_dir().is_dir());
            let config: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(assets.join("mcp.json")).unwrap())
                    .unwrap();
            assert_eq!(
                config
                    .pointer("/mcpServers/bowerbird/command")
                    .and_then(|v| v.as_str()),
                Some("node")
            );
            let args = config
                .pointer("/mcpServers/bowerbird/args")
                .and_then(|v| v.as_array())
                .unwrap();
            assert!(args.len() == 3 && args[0].as_str().unwrap().ends_with("mcp-bridge.mjs"));
        }

        #[test]
        fn rpc_requests_drain_and_respond_roundtrip() {
            let dir = std::env::temp_dir().join(format!(
                "agentz-rpc-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("100-a.req.json"),
                r#"{"id":"100-a","tool":"dreamina_generate","args":{"prompt":"x"}}"#,
            )
            .unwrap();
            std::fs::write(dir.join("200-b.req.json"), "broken").unwrap();
            let requests = drain_rpc_requests_at(&dir);
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].tool, "dreamina_generate");
            assert!(drain_rpc_requests_at(&dir).is_empty());
            // 响应文件按 id 写回，调用方（桥/agent loop）取走
            let response = serde_json::json!({ "ok": true, "result": { "images": [] } });
            write_rpc_response_at(&dir, &requests[0].id, &response);
            let raw = std::fs::read_to_string(dir.join("100-a.resp.json")).unwrap();
            assert!(
                serde_json::from_str::<serde_json::Value>(&raw).unwrap()["ok"]
                    .as_bool()
                    .unwrap()
            );
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn env_override_reports_missing_file() {
            // 显式设置 env 指向不存在文件时应给出可读错误（不影响其他用例：先保存还原）
            let key = "BOWERBIRD_AGENT_Z_CLI";
            let original = std::env::var_os(key);
            unsafe { std::env::set_var(key, r"C:\definitely\missing\claude.exe") };
            let result = resolve_claude_cli();
            match original {
                Some(value) => unsafe { std::env::set_var(key, value) },
                None => unsafe { std::env::remove_var(key) },
            }
            match result {
                Err(AppError::Other(message)) => assert!(message.contains("BOWERBIRD_AGENT_Z_CLI")),
                other => panic!("期望错误，得到 {other:?}"),
            }
        }

        // Claude Code TUI 全链路：真实拉窗 + 两段式注入一条消息，以 ~/.claude/projects
        // 新增会话 jsonl 佐证消息确实进入了 TUI 并开启对话。
        // 手动运行：cargo test claude_tui_e2e -- --ignored --nocapture
        #[test]
        #[ignore = "需要交互式桌面会话与已登录的 Claude Code（弹真实终端窗口并消耗一次调用）"]
        fn claude_tui_e2e() {
            let projects_dir = std::env::var_os("USERPROFILE")
                .map(|home| PathBuf::from(home).join(".claude").join("projects"))
                .unwrap();
            let snapshot = |dir: &PathBuf| -> HashSet<String> {
                std::fs::read_dir(dir)
                    .map(|entries| {
                        entries
                            .filter_map(|entry| entry.ok())
                            .flat_map(|entry| {
                                let mut nested = entry.path();
                                nested.push("*.jsonl");
                                std::fs::read_dir(entry.path())
                                    .map(|files| {
                                        files
                                            .filter_map(|file| file.ok())
                                            .map(|file| {
                                                file.file_name().to_string_lossy().into_owned()
                                            })
                                            .collect::<Vec<_>>()
                                    })
                                    .unwrap_or_default()
                            })
                            .collect()
                    })
                    .unwrap_or_default()
            };
            let before = snapshot(&projects_dir);
            send("请只回复两个字：已通".into(), vec![], vec![], "z").unwrap();
            let mut appeared = false;
            for _ in 0..60 {
                std::thread::sleep(Duration::from_millis(1000));
                let now = snapshot(&projects_dir);
                if now.difference(&before).next().is_some() {
                    appeared = true;
                    break;
                }
            }
            assert!(
                appeared,
                "一分钟内未见新的 Claude Code 会话文件（消息可能未进入 TUI）"
            );
            eprintln!("[claude-e2e] 消息已进入 TUI 并开启会话");
        }

        // 注入链路探针：真实拉起一个标题唯一的 cmd 窗口，注入 echo 落盘并断言文件出现。
        // 手动运行：cargo test agent_z -- --ignored --nocapture
        #[test]
        #[ignore = "需要交互式桌面会话（会弹一个 cmd 窗口）"]
        fn console_injection_probe() {
            let unique = format!(
                "{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
            );
            let title = format!("AgentZ Probe {unique}");
            let marker = std::env::temp_dir().join(format!("agentz_probe_{unique}.txt"));
            let _ = std::fs::remove_file(&marker);
            let pid = spawn_console_window(&title, "rem agentz probe").unwrap();
            std::thread::sleep(Duration::from_millis(1200));
            let line = format!("echo AGENTZ_OK> \"{}\"\r", marker.display());
            inject_console_input(pid, &key_records(&line)).unwrap();
            let mut appeared = false;
            for _ in 0..100 {
                std::thread::sleep(Duration::from_millis(100));
                if marker.is_file() {
                    appeared = true;
                    break;
                }
            }
            let _ = inject_console_input(pid, &key_records("exit\r"));
            assert!(appeared, "注入的命令未落盘：{}", marker.display());
            let content = std::fs::read_to_string(&marker).unwrap_or_default();
            assert!(content.contains("AGENTZ_OK"), "落盘内容异常：{content}");
        }
    }
}

#[cfg(all(windows, debug_assertions))]
pub fn spawn_inbox_watcher(app: tauri::AppHandle) {
    use tauri::Emitter;
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
            for event in imp::drain_inbox(&imp::inbox_dir()) {
                let _ = app.emit("agent-z://output", event);
            }
            // 能力 RPC：逐请求起独立任务（生成类耗时数分钟，不阻塞轮询循环）
            for request in imp::drain_rpc_requests() {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    imp::dispatch_rpc(&app, request).await;
                });
            }
        }
    });
}

#[tauri::command]
pub fn agent_z_health() -> Result<AgentZStatus, AppError> {
    #[cfg(windows)]
    {
        imp::health()
    }
    #[cfg(not(windows))]
    {
        ensure_preview_enabled()?;
        Err(AppError::Other("Agent Z 仅支持 Windows".into()))
    }
}

#[tauri::command]
pub fn agent_z_send(
    text: String,
    images: Vec<String>,
    // 与 images 同序的素材名（正文 @名 与路径对号）；缺省 / 长度不齐退化为纯路径。
    image_names: Option<Vec<String>>,
    engine: Option<String>,
) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        let names = image_names.unwrap_or_default();
        imp::send(text, images, names, engine.as_deref().unwrap_or("z"))
    }
    #[cfg(not(windows))]
    {
        let _ = (text, images, image_names, engine);
        ensure_preview_enabled()?;
        Err(AppError::Other("Agent 仅支持 Windows".into()))
    }
}
