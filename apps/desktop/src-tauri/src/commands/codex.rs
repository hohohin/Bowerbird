//! Codex 调用命令（单次 + 流式）。
//!
//! 流式：通过 event `codex://chunk` 推 Chunk（Delta / Done / Error）。
//! 默认走 MockProvider；`use_real=true` 时启用 ClaudeCodeProvider（需 claude CLI 登录）。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use ulid::Ulid;

use crate::codex::claude_code::ClaudeCodeProvider;
use crate::codex::mock::MockProvider;
use crate::codex::types::{Chunk, CodexRequest, CodexResult};
use crate::codex::CodexProvider;
use crate::db::Database;
use crate::error::AppError;

fn provider(use_real: bool) -> Box<dyn CodexProvider> {
    if use_real {
        let mut p = ClaudeCodeProvider::default();
        p.enabled = true;
        Box::new(p)
    } else {
        Box::new(MockProvider::default())
    }
}

#[tauri::command]
pub async fn codex_run(
    req: CodexRequest,
    use_real: Option<bool>,
) -> Result<CodexResult, AppError> {
    Ok(provider(use_real.unwrap_or(false)).run(req).await?)
}

#[tauri::command]
pub async fn codex_run_stream(
    app: AppHandle,
    req: CodexRequest,
    use_real: Option<bool>,
) -> Result<(), AppError> {
    let p = provider(use_real.unwrap_or(false));
    let (tx, mut rx) = mpsc::channel::<Chunk>(64);
    let app_clone = app.clone();
    tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            let _ = app_clone.emit("codex://chunk", &chunk);
        }
    });
    p.run_stream(req, tx).await?;
    Ok(())
}

/// 为单个资产生成提示词并写回 asset_prompts（批量调用由前端循环）。
/// 默认 Mock provider 走通数据链路；真实多模态（让 Claude 看图）依赖 Phase 5 spike，
/// 当前 build_prompt 仍是路径文本占位。
#[tauri::command]
pub async fn codex_generate_prompt_for_asset(
    db: State<'_, Arc<Database>>,
    asset_id: String,
    role: String,
    use_real: Option<bool>,
) -> Result<String, AppError> {
    // 1. 取 asset.store_path（spawn_blocking 走 DB）。
    let db_for_get = db.inner().clone();
    let aid_for_get = asset_id.clone();
    let asset = tokio::task::spawn_blocking(move || db_for_get.get_asset(&aid_for_get))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??
        .ok_or_else(|| AppError::NotFound(asset_id.clone()))?;
    let store_path = asset
        .store_path
        .ok_or_else(|| AppError::Media(format!("asset {asset_id} has no store_path")))?;

    // 2. 调 provider（默认 Mock）。
    let req = CodexRequest {
        instruction: "为这张图片生成一段适合 AI 绘画的提示词（描述主体、风格、构图、光影）".into(),
        reference_images: vec![PathBuf::from(store_path)],
        context_prompts: vec![],
        output_schema: None,
    };
    let p = provider(use_real.unwrap_or(false));
    let provider_name = p.name().to_string();
    let result = p.run(req).await?;

    // 3. 写 prompts + asset_prompts。
    let prompt_id = Ulid::new().to_string();
    let db_for_write = db.inner().clone();
    let (pid, aid, role_for_write) =
        (prompt_id.clone(), asset_id.clone(), role.clone());
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

/// 「反推」：让 codex 描述指定资产，结果落 analyses(kind=caption)。
/// 默认 Mock（回显占位）；use_real=true 走真实 Claude（多模态看图能力依赖 build_prompt，
/// 当前为路径文本占位 —— Phase 5 spike 待实测替换）。
#[tauri::command]
pub async fn codex_describe_asset(
    db: State<'_, Arc<Database>>,
    asset_id: String,
    use_real: Option<bool>,
) -> Result<String, AppError> {
    let db_for_get = db.inner().clone();
    let aid_for_get = asset_id.clone();
    let asset = tokio::task::spawn_blocking(move || db_for_get.get_asset(&aid_for_get))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??
        .ok_or_else(|| AppError::NotFound(asset_id.clone()))?;
    let store_path = asset
        .store_path
        .ok_or_else(|| AppError::Media(format!("asset {asset_id} has no store_path")))?;

    let req = CodexRequest {
        instruction: "请描述这张图片".into(),
        reference_images: vec![PathBuf::from(store_path)],
        context_prompts: vec![],
        output_schema: None,
    };
    let p = provider(use_real.unwrap_or(false));
    let provider_name = p.name().to_string();
    let result = p.run(req).await?;

    let id = Ulid::new().to_string();
    let payload = serde_json::json!({ "text": result.text }).to_string();
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
    Ok(id)
}
