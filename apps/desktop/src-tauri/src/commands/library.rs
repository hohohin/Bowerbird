//! 库相关命令（前端 invoke 入口）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use rusqlite::OptionalExtension;
use tauri::{AppHandle, Emitter, State};
use ulid::Ulid;

use crate::core::autoname;
use crate::core::ingest;
use crate::core::library::{
    collapse_generation_groups, Analysis, Asset, AssetTag, ColorBucket, Folder, GenerationHistory,
    Preset, PromptedAsset, TagCount,
};
use crate::core::paths::LibraryPaths;
use crate::core::projects::{AssetDeleteMode, AssetDeleteResult};
use crate::db::Database;
use crate::error::AppError;

#[tauri::command]
pub async fn import_files(
    app: AppHandle,
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    sources: Vec<String>,
    project_id: Option<String>,
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
    if let Some(project_id) = project_id.as_deref() {
        let ids: Vec<String> = assets.iter().map(|asset| asset.id.clone()).collect();
        if let Err(e) = db.add_assets_to_project(project_id, &ids) {
            tracing::warn!("failed to link imported assets to project {project_id}: {e}");
        }
    }
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
    project_id: Option<String>,
) -> Result<usize, AppError> {
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    let db_for_ingest = db.clone();
    let assets = tokio::task::spawn_blocking(move || {
        ingest::ingest_dir(&paths, &db_for_ingest, &PathBuf::from(path))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    if let Some(project_id) = project_id.as_deref() {
        let ids: Vec<String> = assets.iter().map(|asset| asset.id.clone()).collect();
        if let Err(e) = db.add_assets_to_project(project_id, &ids) {
            tracing::warn!("failed to link imported assets to project {project_id}: {e}");
        }
    }
    for a in &assets {
        crate::core::autoname::spawn_auto_analyze(app.clone(), db.clone(), a.clone());
    }
    Ok(assets.len())
}

/// 解析 data URL（`data:image/png;base64,xxxx`，兼容裸 base64）为原始字节。
fn decode_data_url_bytes(data_url: &str) -> Result<Vec<u8>, AppError> {
    use base64::Engine;
    let payload = data_url
        .split_once(',')
        .map(|(_, tail)| tail)
        .unwrap_or(data_url);
    base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| AppError::Media(format!("data URL base64 解码失败: {e}")))
}

/// 拖拽 / 剪切板粘贴入库：前端把图片字节以 data URL（base64）传入，复用 `ingest_from_bytes`。
/// source = "imported"（拖拽）/ "clipboard"（粘贴）；project_id 非空时关联当前项目。
#[tauri::command]
pub async fn import_image_bytes(
    app: AppHandle,
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    data_url: String,
    file_name: Option<String>,
    project_id: Option<String>,
    source: String,
) -> Result<Asset, AppError> {
    let bytes = decode_data_url_bytes(&data_url)?;
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    let db_for_ingest = db.clone();
    let asset = tokio::task::spawn_blocking(move || {
        ingest::ingest_from_bytes(
            &paths,
            &db_for_ingest,
            &bytes,
            "",
            file_name.as_deref(),
            None,
            &source,
        )
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    if let Some(pid) = project_id.as_deref() {
        if let Err(e) = db.add_assets_to_project(pid, std::slice::from_ref(&asset.id)) {
            tracing::warn!("link pasted/dropped asset {} to project failed: {e}", asset.id);
        }
    }
    crate::core::autoname::spawn_auto_analyze(app.clone(), db.clone(), asset.clone());
    let _ = app.emit("library://assets-changed", ());
    Ok(asset)
}

#[tauri::command]
pub async fn list_assets(
    db: State<'_, Arc<Database>>,
    folder_id: Option<String>,
    project_id: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<Asset>, AppError> {
    let db = db.inner().clone();
    let v = tokio::task::spawn_blocking(move || {
        db.list_assets(
            folder_id.as_deref(),
            project_id.as_deref(),
            limit.unwrap_or(500),
            offset.unwrap_or(0),
        )
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    // 同流程生成图合并：每组只留最新一张（列表已 created_at DESC，首见即最新）。
    Ok(collapse_generation_groups(v, |a: &Asset| a.generation_session_id.as_deref()))
}

/// 按 smart_query 直接查资产（`source:codex` 等），供侧栏「✨ 生成图」一键入口用
/// （无需先建一个智能文件夹）。
#[tauri::command]
pub async fn list_assets_smart(
    db: State<'_, Arc<Database>>,
    query: String,
    project_id: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<Asset>, AppError> {
    let db = db.inner().clone();
    let v = tokio::task::spawn_blocking(move || {
        db.list_assets_smart(
            &query,
            project_id.as_deref(),
            limit.unwrap_or(500),
            offset.unwrap_or(0),
        )
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    Ok(collapse_generation_groups(v, |a: &Asset| a.generation_session_id.as_deref()))
}

#[tauri::command]
pub async fn count_assets(
    db: State<'_, Arc<Database>>,
    project_id: Option<String>,
) -> Result<i64, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.count_assets(project_id.as_deref()))
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
pub async fn create_collection(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    name: String,
) -> Result<String, AppError> {
    let id = Ulid::new().to_string();
    let db = db.inner().clone();
    let id_clone = id.clone();
    tokio::task::spawn_blocking(move || db.create_collection(&id_clone, &name))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    let _ = app.emit("library://assets-changed", ());
    Ok(id)
}

#[tauri::command]
pub async fn list_collections(db: State<'_, Arc<Database>>) -> Result<Vec<Folder>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.list_collections())
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn list_asset_collections(
    db: State<'_, Arc<Database>>,
    asset_id: String,
) -> Result<Vec<Folder>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.list_collections_for_asset(&asset_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn add_asset_to_collection(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    asset_id: String,
    collection_id: String,
) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.add_asset_to_collection(&asset_id, &collection_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    let _ = app.emit("library://assets-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn remove_asset_from_collection(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    asset_id: String,
    collection_id: String,
) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.remove_asset_from_collection(&asset_id, &collection_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    let _ = app.emit("library://assets-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn list_assets_by_collection(
    db: State<'_, Arc<Database>>,
    collection_id: String,
    project_id: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<Asset>, AppError> {
    let db = db.inner().clone();
    let v = tokio::task::spawn_blocking(move || {
        db.list_assets_by_collection(
            &collection_id,
            project_id.as_deref(),
            limit.unwrap_or(500),
            offset.unwrap_or(0),
        )
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    Ok(collapse_generation_groups(v, |a: &Asset| a.generation_session_id.as_deref()))
}

/// 创作板「用途」：命名的预设 prompt 片段，发送 codex 时作为基底注入（不进编辑器）。
/// 写命令 emit `presets://changed`，创作板下拉据此即时刷新。
#[tauri::command]
pub async fn create_preset(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    name: String,
    body: String,
) -> Result<String, AppError> {
    let id = Ulid::new().to_string();
    let db = db.inner().clone();
    let (id_clone, name_clone, body_clone) = (id.clone(), name, body);
    tokio::task::spawn_blocking(move || db.create_preset(&id_clone, &name_clone, &body_clone))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    let _ = app.emit("presets://changed", ());
    Ok(id)
}

#[tauri::command]
pub async fn list_presets(db: State<'_, Arc<Database>>) -> Result<Vec<Preset>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.list_presets())
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn update_preset(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    id: String,
    name: String,
    body: String,
) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.update_preset(&id, &name, &body))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    let _ = app.emit("presets://changed", ());
    Ok(())
}

#[tauri::command]
pub async fn delete_preset(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    id: String,
) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.delete_preset(&id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    let _ = app.emit("presets://changed", ());
    Ok(())
}

#[tauri::command]
pub async fn delete_asset(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    id: String,
) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.delete_asset(&id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    let _ = app.emit("projects://changed", ());
    let _ = app.emit("library://assets-changed", ());
    Ok(())
}

/// 单素材删除（右键菜单）：与「删除项目」三选项一致的语义——
/// `keep`=仅移出当前项目（素材留全局）；`move_out`=文件移回原始位置并删资产行（同项目的独占素材直接删除）；
/// `delete`=从全局及所有项目物理删除。`project_id` 只在 `keep` 且当前处于项目时使用。
#[tauri::command]
pub async fn delete_asset_with_mode(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    id: String,
    mode: String,
    project_id: Option<String>,
) -> Result<AssetDeleteResult, AppError> {
    let mode = match mode.as_str() {
        "keep" => AssetDeleteMode::Keep,
        "move_out" => AssetDeleteMode::MoveOut,
        "delete" => AssetDeleteMode::Delete,
        other => return Err(AppError::Other(format!("未知删除模式: {other}"))),
    };
    let db = db.inner().clone();
    let result = tokio::task::spawn_blocking(move || {
        db.delete_asset_with_mode(&id, mode, project_id.as_deref())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    // 项目成员/素材均可能变化：两个事件都发，前端刷新计数与视图。
    let _ = app.emit("projects://changed", ());
    let _ = app.emit("library://assets-changed", ());
    Ok(result)
}

#[tauri::command]
pub async fn move_assets_to_folder(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    asset_ids: Vec<String>,
    folder_id: String,
) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.set_assets_folder(&asset_ids, &folder_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    // 移动后 emit 刷新：拖拽整理不改 currentFolderId，当前视图靠此事件重拉才会让移走的图消失。
    let _ = app.emit("library://assets-changed", ());
    Ok(())
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
    project_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<Asset>, AppError> {
    let db = db.inner().clone();
    let v = tokio::task::spawn_blocking(move || {
        db.search_assets(&query, project_id.as_deref(), limit.unwrap_or(500))
    })
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    Ok(collapse_generation_groups(v, |a: &Asset| a.generation_session_id.as_deref()))
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
    project_id: Option<String>,
) -> Result<Vec<PromptedAsset>, AppError> {
    let db = db.inner().clone();
    let v = tokio::task::spawn_blocking(move || db.list_prompted_assets(project_id.as_deref()))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    Ok(collapse_generation_groups(v, |p: &PromptedAsset| {
        p.asset.generation_session_id.as_deref()
    }))
}

/// 右键「打开所在文件夹」：原始位置（origin_path）优先，不存在则回退素材库内位置（store_path）。
/// 平台分支：Windows 打开资源管理器并选中该文件（`explorer /select,"..."`）；macOS/Linux 打开所在目录。
#[tauri::command]
pub async fn reveal_asset_folder(
    db: State<'_, Arc<Database>>,
    id: String,
) -> Result<(), AppError> {
    let db = db.inner().clone();
    let id_for_query = id.clone();
    let (origin, store) = tokio::task::spawn_blocking(move || {
        let conn = db.conn.lock().unwrap();
        let (origin, store): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT origin_path, store_path FROM assets WHERE id = ?1",
                rusqlite::params![id_for_query],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .unwrap_or((None, None));
        Ok::<_, AppError>((origin, store))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;

    // 原始位置优先；原始文件不在时（扩展临时目录/生成图缓存已删）回退素材库内文件。
    let target = [origin.as_deref(), store.as_deref()]
        .into_iter()
        .flatten()
        .map(Path::new)
        .find(|p| p.exists());

    let Some(target) = target else {
        return Err(AppError::NotFound(format!("asset 文件: {id}")));
    };
    reveal_in_file_manager(target);
    Ok(())
}

/// 在系统文件管理器中显示/打开目标。Windows 用 `explorer /select,` 选中文件（并打开所在文件夹）；
/// 其它平台打开所在目录（macOS `open`、Linux `xdg-open`）。
fn reveal_in_file_manager(target: &Path) {
    #[cfg(target_os = "windows")]
    {
        let path = target.to_string_lossy();
        // explorer /select 无法定位目标时（罕见）会自动打开所在文件夹；参数按单个 arg 传入避免引号歧义。
        if let Err(error) = Command::new("explorer").arg(format!("/select,{path}")).spawn() {
            tracing::warn!("explorer reveal failed: {error}");
        }
    }
    #[cfg(target_os = "macos")]
    {
        let dir = target.parent().unwrap_or(target);
        if let Err(error) = Command::new("open").arg(dir).spawn() {
            tracing::warn!("open reveal failed: {error}");
        }
    }
    #[cfg(target_os = "linux")]
    {
        let dir = target.parent().unwrap_or(target);
        if let Err(error) = Command::new("xdg-open").arg(dir).spawn() {
            tracing::warn!("xdg-open reveal failed: {error}");
        }
    }
}

/// 取某资产所属生成会话的全部图（含自己），按 id ASC（过程顺序）。详情页轮播用。
/// 非生成图（无 generation_session_id）返回空。
#[tauri::command]
pub async fn list_generation_group(
    db: State<'_, Arc<Database>>,
    asset_id: String,
    project_id: Option<String>,
) -> Result<Vec<Asset>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        db.list_generation_group(&asset_id, project_id.as_deref())
    })
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

/// 批量取多资产的生成组：key=输入 asset_id，value=该资产所在组的全部图（仅生成图、且组存在）。
/// 瀑布流缩略图轮播用：一次 invoke 拿到所有可见 codex 组，免每缩略图各发一次。
#[tauri::command]
pub async fn list_generation_groups(
    db: State<'_, Arc<Database>>,
    asset_ids: Vec<String>,
    project_id: Option<String>,
) -> Result<HashMap<String, Vec<Asset>>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<HashMap<String, Vec<Asset>>, AppError> {
        let mut out = HashMap::new();
        for id in &asset_ids {
            let group = db.list_generation_group(id, project_id.as_deref())?;
            if !group.is_empty() {
                out.insert(id.clone(), group);
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

/// 「回看生成对话」：取某生成图所在 codex 会话的完整生成时间线（各轮 prompt + 产出图 store_path）。
/// 前端把它 load 进 genTurns，复用 GenerationPanel 的时间线展示 + 「继续修改」resume 续接。
/// 非生成图（无 generation_session_id）返回空 turns。
#[tauri::command]
pub async fn generation_history(
    db: State<'_, Arc<Database>>,
    asset_id: String,
    project_id: Option<String>,
) -> Result<GenerationHistory, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.generation_history(&asset_id, project_id.as_deref()))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

// ============ 标签 / 自动归类（P2）============

/// 侧栏「自动归类」分区：某 source（默认 auto）的 tag + 资产计数（count>0）。
#[tauri::command]
pub async fn list_tags(
    db: State<'_, Arc<Database>>,
    source: Option<String>,
    project_id: Option<String>,
) -> Result<Vec<TagCount>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        db.list_tags_with_count(source.as_deref().unwrap_or("auto"), project_id.as_deref())
    })
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

// ============ 颜色量化（P3）============

/// 全库色板：每个桶 + 资产数 + 桶代表 hex（侧栏色板渲染）。
#[tauri::command]
pub async fn palette_overview(
    db: State<'_, Arc<Database>>,
    project_id: Option<String>,
) -> Result<Vec<ColorBucket>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.palette_overview(project_id.as_deref()))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

/// 按颜色桶筛选资产，带 folder 上下文（folder+color 叠加）。folder_id=None 全库。
#[tauri::command]
pub async fn list_assets_by_color(
    db: State<'_, Arc<Database>>,
    folder_id: Option<String>,
    project_id: Option<String>,
    bucket: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<Asset>, AppError> {
    let db = db.inner().clone();
    let v = tokio::task::spawn_blocking(move || {
        db.list_assets_by_color(
            folder_id.as_deref(),
            project_id.as_deref(),
            &bucket,
            limit.unwrap_or(500),
            offset.unwrap_or(0),
        )
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    Ok(collapse_generation_groups(v, |a: &Asset| a.generation_session_id.as_deref()))
}

/// 重建色板：扫所有 colors 非空的图，重新量化写 asset_colors（幂等）。
/// 立即返回，后台逐张跑并 emit `color://rebuild-progress {done,total,ended?}`。
#[tauri::command]
pub async fn recompute_colors(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        let rows = match db.list_colors_for_recompute() {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("recompute_colors list: {e}");
                return;
            }
        };
        let total = rows.len();
        let _ = app.emit(
            "color://rebuild-progress",
            serde_json::json!({ "done": 0, "total": total }),
        );
        for (i, (id, colors)) in rows.iter().enumerate() {
            let buckets = crate::media::color::colors_to_buckets(colors);
            let _ = db.set_asset_colors(id, &buckets);
            let _ = app.emit(
                "color://rebuild-progress",
                serde_json::json!({ "done": i + 1, "total": total }),
            );
        }
        let _ = app.emit(
            "color://rebuild-progress",
            serde_json::json!({ "done": total, "total": total, "ended": true }),
        );
    });
    Ok(())
}

// --- 系统交互：在资源管理器中定位 / 用默认程序打开 ---
// 右键图片菜单的后端。前端把 asset.store_path 传来（Thumb 已持有，不必查 DB）；
// 后端 Rust 直接 spawn 子进程，不经 shell plugin scope，故 capabilities 无需改动。

/// 校验文件存在并返回 PathBuf（路径失效时给前端明确报错，而非让 explorer 弹系统对话框）。
fn require_existing_file(path: &str) -> Result<PathBuf, AppError> {
    let p = PathBuf::from(path);
    if !p.is_file() {
        return Err(AppError::Other(format!("文件不存在: {path}")));
    }
    Ok(p)
}

/// 在系统文件资源管理器中定位并选中该文件（reveal in folder）。
#[tauri::command]
pub async fn reveal_path_in_explorer(path: String) -> Result<(), AppError> {
    let p = require_existing_file(&path)?;
    spawn_locate_or_open(&p, true).await
}

/// 用系统默认程序打开该文件（等价于双击）。
#[tauri::command]
pub async fn open_path_with_system(path: String) -> Result<(), AppError> {
    let p = require_existing_file(&path)?;
    spawn_locate_or_open(&p, false).await
}

/// 跨平台启动资源管理器定位 / 默认程序打开。spawn 后立即返回（fire-and-forget，不 wait）。
///   Windows  reveal → explorer.exe /select,<path>（在资源管理器里选中）
///   Windows  open   → cmd /C start "" <path>（ShellExecute 用关联程序打开，CREATE_NO_WINDOW 防闪黑窗）
///   macOS    reveal → open -R；open → open <path>
///   Linux    reveal → xdg-open 父目录（无统一「定位选中」协议，退化为打开所在目录）；open → xdg-open <path>
async fn spawn_locate_or_open(path: &PathBuf, reveal: bool) -> Result<(), AppError> {
    let path_str = path.to_string_lossy().into_owned();
    let action = if reveal { "定位文件" } else { "打开文件" };
    #[cfg(target_os = "windows")]
    {
        if reveal {
            tokio::process::Command::new("explorer.exe")
                .arg(format!("/select,{path_str}"))
                .spawn()
                .map_err(|e| AppError::Other(format!("{action}失败: {e}")))?;
        } else {
            tokio::process::Command::new("cmd.exe")
                .args(["/D", "/C", "start", "", &path_str])
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .spawn()
                .map_err(|e| AppError::Other(format!("{action}失败: {e}")))?;
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = tokio::process::Command::new("open");
        if reveal {
            cmd.arg("-R").arg(&path_str);
        } else {
            cmd.arg(&path_str);
        }
        cmd.spawn()
            .map_err(|e| AppError::Other(format!("{action}失败: {e}")))?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        let target = if reveal {
            path.parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or(path_str)
        } else {
            path_str
        };
        tokio::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| AppError::Other(format!("{action}失败: {e}")))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = path_str;
        Err(AppError::Other(format!("当前系统不支持{action}")))
    }
}
