//! Codex 调用命令（单次 + 流式 + 反推 + 会话回看）。
//!
//! 全部走 [`CodexCliProvider`]（`codex exec --image`，ChatGPT 订阅认证，
//! 真正多模态看图；Mock / DeepSeek / OpenAI HTTP 路线已移除，详见 PROJECT.md）。
//! 流式：通过 event `codex://chunk` 推 Chunk（Delta / Done / Error）。

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use ulid::Ulid;

use crate::codex::codex_cli::CodexCliProvider;
use crate::codex::types::{Chunk, CodexRequest};
use crate::codex::CodexProvider;
use crate::core::caption;
use crate::core::paths::LibraryPaths;
use crate::db::Database;
use crate::error::AppError;

const DEFAULT_DESCRIBE_INSTRUCTION: &str = "请描述这张图片";

/// codex 可用性检测结果。`ok=false` 时 `reason` 给出置灰提示文案。
#[derive(Debug, Clone, Serialize)]
pub struct CodexHealth {
    pub ok: bool,
    pub reason: String,
}

/// 检测 codex 是否可用于反推：① `codex --version` 可执行；② `~/.codex/auth.json` 存在且非空（已登录）。
/// 任一不满足返回 `ok=false` + 中文 reason，前端据此置灰反推按钮（约定 7：离线/无账号降级置灰）。
/// 注：依赖 `$HOME`（macOS/Linux）；Windows 的 codex 凭证路径不同，暂未覆盖。
#[tauri::command]
pub async fn codex_health() -> Result<CodexHealth, AppError> {
    let binary_ok = tokio::process::Command::new("codex")
        .arg("--version")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !binary_ok {
        return Ok(CodexHealth {
            ok: false,
            reason: "未检测到 codex CLI（需 npm install -g @openai/codex 并在 PATH）".into(),
        });
    }
    let logged_in = std::env::var("HOME")
        .ok()
        .map(|h| {
            let p = std::path::PathBuf::from(h).join(".codex").join("auth.json");
            std::fs::metadata(&p).map(|m| m.len() > 0).unwrap_or(false)
        })
        .unwrap_or(false);
    if !logged_in {
        return Ok(CodexHealth {
            ok: false,
            reason: "codex 未登录（需运行 codex login）".into(),
        });
    }
    Ok(CodexHealth {
        ok: true,
        reason: String::new(),
    })
}

/// 为单个资产生成提示词并写回 asset_prompts（批量由前端循环）。
#[tauri::command]
pub async fn codex_generate_prompt_for_asset(
    db: State<'_, Arc<Database>>,
    asset_id: String,
    role: String,
) -> Result<String, AppError> {
    let store_path = get_asset_store_path(&db, &asset_id).await?;

    let req = CodexRequest {
        instruction: "为这张图片生成一段适合 AI 绘画的提示词（描述主体、风格、构图、光影）".into(),
        reference_images: vec![PathBuf::from(store_path)],
        context_prompts: vec![],
    };
    let p = CodexCliProvider::default();
    let provider_name = p.name().to_string();
    let result = p.run(req).await?;

    let prompt_id = Ulid::new().to_string();
    let db_for_write = db.inner().clone();
    let (pid, aid, role_for_write) = (prompt_id.clone(), asset_id.clone(), role.clone());
    let (text, pname) = (result.text, provider_name);
    tokio::task::spawn_blocking(move || {
        db_for_write.create_prompt(&pid, None, &text, Some("generated"), Some(&pname))?;
        db_for_write.link_prompt(&aid, &pid, &role_for_write)?;
        Ok::<_, AppError>(())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;

    Ok(prompt_id)
}

/// 当前反推任务的取消信号。同一时刻只支持一个反推任务（前端反推按钮 disabled 保证）；
/// 取消时往 sender 发信号，select 命中后 run future 被 drop，codex 子进程靠
/// `kill_on_drop` 自动终止（见 codex_cli.rs）。
static DESCRIBE_CANCEL: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>> =
    std::sync::Mutex::new(None);

/// 「反推」：让 codex 描述指定资产，结果落 analyses(kind=caption)。
/// payload 同时存 session_id，前端「在 codex 中打开」按钮据此唤起 `codex resume`。
/// 可取消：前端调 `cancel_codex_describe` 即中断本次 codex 执行（子进程被 kill）。
#[tauri::command]
pub async fn codex_describe_asset(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    asset_id: String,
    instruction: Option<String>,
) -> Result<String, AppError> {
    let store_path = get_asset_store_path(&db, &asset_id).await?;
    let instruction = instruction
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_DESCRIBE_INSTRUCTION.to_string());

    let req = CodexRequest {
        instruction: instruction.clone(),
        reference_images: vec![PathBuf::from(store_path)],
        context_prompts: vec![],
    };
    let p = CodexCliProvider::default();
    let provider_name = p.name().to_string();

    // 可取消：select codex 执行 与 取消信号。取消时 run future 被 drop，
    // codex 子进程靠 kill_on_drop 自动 kill。
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    DESCRIBE_CANCEL
        .lock()
        .unwrap()
        .replace(cancel_tx);
    let run_fut = p.run(req);
    tokio::pin!(run_fut);
    let result = tokio::select! {
        r = &mut run_fut => r,
        _ = &mut cancel_rx => {
            return Err(AppError::Codex("已取消".into()));
        }
    };
    DESCRIBE_CANCEL.lock().unwrap().take();
    let result = result?;
    let analysis_parsed = caption::parse(&result.text);
    let payload = caption::build_payload(
        &result.text,
        &instruction,
        result.session_id.as_deref(),
        &provider_name,
        &analysis_parsed,
    );

    let id = Ulid::new().to_string();
    let analysis = crate::core::library::Analysis {
        id: id.clone(),
        asset_id: asset_id.clone(),
        kind: "caption".to_string(),
        payload,
        provider: Some(provider_name),
        created_at: None,
    };
    let db_for_write = db.inner().clone();
    tokio::task::spawn_blocking(move || db_for_write.insert_analysis(&analysis))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    // 通知前端数据变更：触发反推后台化后，触发反推的组件可能早已卸载，
    // 由 App / AssetDetail 监听此事件按需刷新（创作板的 promptedAssets、详情页 analyses）。
    let _ = app.emit(
        "analyses://changed",
        serde_json::json!({ "asset_id": asset_id, "kind": "caption" }),
    );
    Ok(id)
}

/// 取消正在进行的反推（`codex_describe_asset`）。无任务在跑则空操作。
#[tauri::command]
pub async fn cancel_codex_describe() -> Result<(), AppError> {
    if let Some(tx) = DESCRIBE_CANCEL.lock().unwrap().take() {
        let _ = tx.send(());
    }
    Ok(())
}

/// 当前图像生成任务的取消信号（与反推 `DESCRIBE_CANCEL` 独立，互不影响）。
static GENERATE_CANCEL: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>> =
    std::sync::Mutex::new(None);

/// 创作板「生成」：把最终 prompt + 参考图发 codex（`codex exec --image`，与反推同机制），
/// 让 codex 调内置 imagegen 技能出图。
///
/// - 流式：codex 的逐条 `agent_message` 经 event `codex://chunk`（Delta）回前端；
/// - 取图：跑完扫 `~/.codex/generated_images/` 本次新增图，copy 进 `library/generations/`，
///   随 `Done.images`（库内路径）回前端 convertFileSrc 渲染；
/// - 不写 `analyses`（生成 ≠ 分析）；`generations` 表落库是后续（见 PROJECT.md 约定 2）。
/// 可取消：前端调 `cancel_codex_create`，select 命中后 future 被 drop，codex 子进程靠
/// `kill_on_drop` 自动终止。
#[tauri::command]
pub async fn codex_create_image(
    app: AppHandle,
    paths: State<'_, Arc<LibraryPaths>>,
    prompt: String,
    reference_images: Vec<String>,
    session_id: Option<String>,
) -> Result<(), AppError> {
    // 首轮（无 session_id）：包一句明确要 codex 出图，触发 imagegen；
    // 续轮（有 session_id = resume）：codex 已在画图上下文里，用户修改意见原样发。
    let instruction = match &session_id {
        Some(_) => prompt,
        None => format!(
            "请使用图像生成工具，根据以下提示词和参考图生成一张新图片。\n\n{prompt}"
        ),
    };
    let req = CodexRequest {
        instruction,
        reference_images: reference_images.into_iter().map(PathBuf::from).collect(),
        context_prompts: vec![],
    };

    let (tx, mut rx) = mpsc::channel::<Chunk>(64);
    let app_clone = app.clone();
    tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            let _ = app_clone.emit("codex://chunk", &chunk);
        }
    });

    let generations_dir = paths.generations.clone();
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    GENERATE_CANCEL.lock().unwrap().replace(cancel_tx);

    let p = CodexCliProvider::default();
    let gen_fut = p.generate_image(req, generations_dir, tx, session_id);
    tokio::pin!(gen_fut);
    let result = tokio::select! {
        r = &mut gen_fut => r,
        _ = &mut cancel_rx => return Err(AppError::Codex("已取消".into())),
    };
    GENERATE_CANCEL.lock().unwrap().take();
    result
}

/// 取消正在进行的图像生成（`codex_create_image`）。无任务在跑则空操作。
#[tauri::command]
pub async fn cancel_codex_create() -> Result<(), AppError> {
    if let Some(tx) = GENERATE_CANCEL.lock().unwrap().take() {
        let _ = tx.send(());
    }
    Ok(())
}

/// 「在 codex 中打开会话」：唤起系统终端跑 `codex resume <session_id>`，
/// 让用户在 codex TUI 里翻看本次反推的完整对话（含图）。macOS 用 Terminal.app。
#[tauri::command]
pub async fn open_codex_session(session_id: String) -> Result<(), AppError> {
    let sid = session_id.trim();
    if sid.is_empty() {
        return Err(AppError::Codex("session_id 为空".into()));
    }
    #[cfg(target_os = "macos")]
    {
        // session_id 是 codex 输出的 UUID（我们落库的值），非用户自由输入；
        // osascript 的 do script 把它作为单参传给 `codex resume`，无注入风险。
        let script = format!(
            "tell application \"Terminal\"\nactivate\ndo script \"codex resume {sid}\"\nend tell"
        );
        tokio::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .spawn()
            .map_err(|e| AppError::Codex(format!("启动 Terminal 失败: {e}")))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = sid;
        Err(AppError::Codex("open_codex_session 仅支持 macOS".into()))
    }
}

/// 取资产的 store_path（spawn_blocking 读 DB），不存在或无 store_path 报错。
async fn get_asset_store_path(
    db: &State<'_, Arc<Database>>,
    asset_id: &str,
) -> Result<String, AppError> {
    let db_for_get = db.inner().clone();
    let aid_for_get = asset_id.to_string();
    let asset = tokio::task::spawn_blocking(move || db_for_get.get_asset(&aid_for_get))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??
        .ok_or_else(|| AppError::NotFound(asset_id.to_string()))?;
    asset
        .store_path
        .ok_or_else(|| AppError::Media(format!("asset {asset_id} has no store_path")))
}
