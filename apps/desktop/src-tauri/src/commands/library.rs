//! 库相关命令（前端 invoke 入口）。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};
use ulid::Ulid;

use crate::core::autoname;
use crate::core::ingest;
use crate::core::library::{Analysis, Asset, AssetTag, Folder, PromptedAsset, TagCount};
use crate::core::paths::LibraryPaths;
use crate::db::Database;
use crate::error::AppError;

#[tauri::command]
pub async fn import_files(
    app: AppHandle,
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    sources: Vec<String>,
) -> Result<Vec<Asset>, AppError> {
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    let db_for_ingest = db.clone();
    let assets = tokio::task::spawn_blocking(move || {
        let mut assets = Vec::with_capacity(sources.len());
        for s in sources {
            match ingest::ingest_file(&paths, &db_for_ingest, &PathBuf::from(&s)) {
                Ok(a) => assets.push(a),
                Err(e) => tracing::warn!("ingest failed for {s}: {e}"),
            }
        }
        Ok::<_, AppError>(assets)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    // 后台命名 + 反推（非阻塞，约定 7 离线降级）。
    for a in &assets {
        crate::core::autoname::spawn_auto_analyze(app.clone(), db.clone(), a.clone());
    }
    Ok(assets)
}

#[tauri::command]
pub async fn import_folder(
    app: AppHandle,
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    path: String,
) -> Result<usize, AppError> {
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    let db_for_ingest = db.clone();
    let assets = tokio::task::spawn_blocking(move || {
        ingest::ingest_dir(&paths, &db_for_ingest, &PathBuf::from(path))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    for a in &assets {
        crate::core::autoname::spawn_auto_analyze(app.clone(), db.clone(), a.clone());
    }
    Ok(assets.len())
}

#[tauri::command]
pub async fn list_assets(
    db: State<'_, Arc<Database>>,
    folder_id: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<Asset>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        db.list_assets(folder_id.as_deref(), limit.unwrap_or(500), offset.unwrap_or(0))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

/// 按 smart_query 直接查资产（`source:codex` 等），供侧栏「✨ 生成图」一键入口用
/// （无需先建一个智能文件夹）。
#[tauri::command]
pub async fn list_assets_smart(
    db: State<'_, Arc<Database>>,
    query: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<Asset>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        db.list_assets_smart(&query, limit.unwrap_or(500), offset.unwrap_or(0))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn count_assets(db: State<'_, Arc<Database>>) -> Result<i64, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.count_assets())
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn list_folders(db: State<'_, Arc<Database>>) -> Result<Vec<Folder>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.list_folders())
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn create_folder(
    db: State<'_, Arc<Database>>,
    name: String,
    parent_id: Option<String>,
) -> Result<String, AppError> {
    let id = Ulid::new().to_string();
    let db = db.inner().clone();
    let parent_ref = parent_id.clone();
    let name_clone = name.clone();
    let id_clone = id.clone();
    tokio::task::spawn_blocking(move || {
        db.create_folder(&id_clone, &name_clone, parent_ref.as_deref())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    Ok(id)
}

#[tauri::command]
pub async fn delete_asset(
    db: State<'_, Arc<Database>>,
    id: String,
) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.delete_asset(&id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn move_assets_to_folder(
    db: State<'_, Arc<Database>>,
    asset_ids: Vec<String>,
    folder_id: String,
) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.set_assets_folder(&asset_ids, &folder_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn create_smart_folder(
    db: State<'_, Arc<Database>>,
    name: String,
    smart_query: String,
) -> Result<String, AppError> {
    let id = Ulid::new().to_string();
    let db = db.inner().clone();
    let (id_clone, name_clone, q_clone) = (id.clone(), name, smart_query);
    tokio::task::spawn_blocking(move || db.create_smart_folder(&id_clone, &name_clone, &q_clone))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    Ok(id)
}

#[tauri::command]
pub async fn rename_folder(
    db: State<'_, Arc<Database>>,
    id: String,
    name: String,
) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.rename_folder(&id, &name))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn delete_folder(db: State<'_, Arc<Database>>, id: String) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.delete_folder(&id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn search_assets(
    db: State<'_, Arc<Database>>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<Asset>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.search_assets(&query, limit.unwrap_or(500)))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn list_analyses_by_asset(
    db: State<'_, Arc<Database>>,
    asset_id: String,
) -> Result<Vec<Analysis>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.list_analyses_by_asset(&asset_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

/// 删除单条分析结果（如旧的 caption）。DB 方法已存在，此处仅 Tauri 命令包装。
#[tauri::command]
pub async fn delete_analysis(db: State<'_, Arc<Database>>, id: String) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.delete_analysis(&id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

/// 创作板用：有 caption（反推）的资产 + 最新 caption 正文（§5.4）。
#[tauri::command]
pub async fn list_prompted_assets(
    db: State<'_, Arc<Database>>,
) -> Result<Vec<PromptedAsset>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.list_prompted_assets())
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

// ============ 标签 / 自动归类（P2）============

/// 侧栏「自动归类」分区：某 source（默认 auto）的 tag + 资产计数（count>0）。
#[tauri::command]
pub async fn list_tags(
    db: State<'_, Arc<Database>>,
    source: Option<String>,
) -> Result<Vec<TagCount>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.list_tags_with_count(source.as_deref().unwrap_or("auto")))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

/// 详情页：某资产的全部 tag（name + source，区分 auto/manual）。
#[tauri::command]
pub async fn list_asset_tags(
    db: State<'_, Arc<Database>>,
    asset_id: String,
) -> Result<Vec<AssetTag>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.list_asset_tags(&asset_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

/// 全量替换某资产在指定 source 下的 tag（按 name，get_or_create 转 id）。
/// source='auto'（codex）/ 'manual'（用户），按 source 隔离互不误伤。
#[tauri::command]
pub async fn set_asset_tags(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    asset_id: String,
    names: Vec<String>,
    source: String,
) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        let ids: Vec<String> = names
            .iter()
            .filter_map(|n| {
                let n = n.trim();
                if n.is_empty() {
                    None
                } else {
                    db.get_or_create_tag(n, &source).ok()
                }
            })
            .collect();
        db.set_asset_tags(&asset_id, &ids, &source)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    // 类别归属变了 → 刷侧栏 autoTags 计数（App 监听 library://assets-changed → reloadAutoTags）。
    let _ = app.emit("library://assets-changed", ());
    Ok(())
}

/// 批量重归类：对所有「无 auto tag 且有 caption」的资产喂 caption 文本让 codex 分类。
/// 立即返回，后台逐张跑并 emit `classify://progress {done,total,ended?}`。
#[tauri::command]
pub async fn reclassify_all(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
) -> Result<(), AppError> {
    autoname::spawn_reclassify_all(app, db.inner().clone());
    Ok(())
}
