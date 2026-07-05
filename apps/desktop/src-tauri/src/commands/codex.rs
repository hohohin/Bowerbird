//! Codex 调用命令（单次 + 流式 + 反推）。
//!
//! 全部走 [`CodexCliProvider`]（`codex exec --image`，ChatGPT 订阅认证，
//! 真正多模态看图；Mock / DeepSeek / OpenAI HTTP 路线已移除，详见 PROJECT.md）。
//! 流式：通过 event `codex://chunk` 推 Chunk（Delta / Done / Error）。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use ulid::Ulid;

use crate::codex::codex_cli::CodexCliProvider;
use crate::codex::types::{Chunk, CodexRequest, CodexResult};
use crate::codex::CodexProvider;
use crate::db::Database;
use crate::error::AppError;

#[tauri::command]
pub async fn codex_run(req: CodexRequest) -> Result<CodexResult, AppError> {
    Ok(CodexCliProvider::default().run(req).await?)
}

#[tauri::command]
pub async fn codex_run_stream(
    app: AppHandle,
    req: CodexRequest,
) -> Result<(), AppError> {
    let p = CodexCliProvider::default();
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
        output_schema: None,
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

/// 「反推」：让 codex 描述指定资产，结果落 analyses(kind=caption)。
#[tauri::command]
pub async fn codex_describe_asset(
    db: State<'_, Arc<Database>>,
    asset_id: String,
) -> Result<String, AppError> {
    let store_path = get_asset_store_path(&db, &asset_id).await?;

    let req = CodexRequest {
        instruction: "请描述这张图片".into(),
        reference_images: vec![PathBuf::from(store_path)],
        context_prompts: vec![],
        output_schema: None,
    };
    let p = CodexCliProvider::default();
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
