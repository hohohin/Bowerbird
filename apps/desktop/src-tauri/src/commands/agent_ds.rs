// Agent DS（dev-only）：创作板 → DeepSeek 对话 harness。与 Agent Z（Claude Code TUI）互为
// 姊妹实验（约定 36）：Z 的对话发生在终端 TUI 里；DS 的对话发生在创作板本身——每轮发送
// detached 拉起 agent-worker 的 agent-ds-chat-cli（Node，loop 在子进程内：DeepSeek 多回合
// tool-calling，工具 dreamina_generate / understand_asset 经 .agent-z/rpc 文件契约回桌面端
// 执行，与 MCP 桥同一契约），最终回复经 .agent-z/inbox 事件 → agent-z://output → 追加进
// 创作板编辑器。不建对话 UI、不落库、不占生成 job/ratio/provider/entitlement。
// 会话正史在 .agent-z/ds-session.json（持久，跨 app 重启续聊；TUI 版窗口关即失联的语义
// 不适用）。DeepSeek key 仍只在 Node 侧经 --env-file 加载（React/Rust 不持 key，约定 27）。
// 门控同 commands/agent.rs（约定 30）仅 debug 构建；rpc/inbox watcher 现仅 Windows+debug
// 常驻（agent_z::spawn_inbox_watcher），故实际可用面同为 Windows dev。

use crate::error::AppError;

fn ensure_preview_enabled() -> Result<(), AppError> {
    if cfg!(debug_assertions) {
        Ok(())
    } else {
        Err(AppError::Other("Agent DS 仅在开发构建中开放".into()))
    }
}

/// Agent 互通实验资产目录（与 agent_z.rs 的 agent_z_root 同式：rpc/inbox 基础设施共用，
/// 目录名 .agent-z 为历史，语义 = Agent 互通实验资产）。
fn agent_root() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(".agent-z")
}

#[tauri::command]
pub async fn agent_ds_chat(text: String, images: Vec<String>) -> Result<(), AppError> {
    use tokio::io::AsyncWriteExt;
    ensure_preview_enabled()?;
    let text = text.trim().to_string();
    if text.is_empty() || text.chars().count() > 12_000 {
        return Err(AppError::Other("消息须为 1–12000 个字符".into()));
    }
    if images.len() > 10 {
        return Err(AppError::Other("Agent DS 最多附带 10 张参考图".into()));
    }
    let dir = crate::commands::agent::worker_dir()?;
    let env_file = dir.join("../cloud/.env");
    if !env_file.is_file() {
        return Err(AppError::Other(
            "缺少 apps/cloud/.env，无法读取本机 DeepSeek 配置".into(),
        ));
    }
    let root = agent_root();
    let inbox = root.join("inbox");
    let rpc = root.join("rpc");
    std::fs::create_dir_all(&inbox)
        .map_err(|error| AppError::Other(format!("创建 Agent DS inbox 目录失败: {error}")))?;
    std::fs::create_dir_all(&rpc)
        .map_err(|error| AppError::Other(format!("创建 Agent DS rpc 目录失败: {error}")))?;
    // detached 运行无人接收 stdio：stdout/stderr 落盘（dev 排障用）
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("ds-harness.log"))
        .map_err(|error| AppError::Other(format!("打开 Agent DS 日志失败: {error}")))?;
    let log_err = log
        .try_clone()
        .map_err(|error| AppError::Other(format!("复制 Agent DS 日志句柄失败: {error}")))?;
    let mut child = tokio::process::Command::new("node")
        .arg(format!("--env-file={}", env_file.display()))
        .arg("src/local/agent-ds-chat-cli.ts")
        .arg(root.join("ds-session.json"))
        .arg(&rpc)
        .arg(&inbox)
        .current_dir(&dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::from(log))
        .stderr(std::process::Stdio::from(log_err))
        .spawn()
        .map_err(|error| AppError::Other(format!("启动 Agent DS harness 失败: {error}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        let payload = serde_json::json!({ "text": text, "images": images });
        let bytes = serde_json::to_vec(&payload)
            .map_err(|error| AppError::Other(format!("序列化 Agent DS 消息失败: {error}")))?;
        stdin
            .write_all(&bytes)
            .await
            .map_err(|error| AppError::Other(format!("写入 Agent DS harness 失败: {error}")))?;
        // stdin 随下方 drop 关闭 → 子进程 readFileSync(0) 读到 EOF 开始处理
    }
    // 不等待（kill_on_drop 默认 false，drop 后子进程继续跑）：一轮对话含即梦生图可长达
    // 数分钟，进度与回复全走 inbox 事件链路。
    drop(child);
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn harness_entrypoint_exists_next_to_worker_dir() {
        // 防 rename 漂移：CLI 文件名变了这里先红
        let worker = crate::commands::agent::worker_dir().expect("dev 仓库内应能定位 agent-worker");
        assert!(worker.join("src/local/agent-ds-chat-cli.ts").is_file());
    }
}
