//! 项目视觉设定 V1 命令层：project_id 由前端显式传入（快照语义，
//! 与 ActiveProjectContext 的「显式命令带参数」约定一致）。

use tauri::{Manager, State};

use crate::cloud::{AuthClient, CloudClient, EntitlementService};
use crate::core::visual_profile::{RuleEdit, VisualProfileDetail, VisualProfileSummary};
use crate::db::Database;
use crate::error::AppError;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationImageResult {
    pub image_path: String,
    pub prompt: String,
    pub service: String,
    pub credits: i32,
}

fn validation_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Other(format!("读取应用数据目录失败: {error}")))?
        .join("visual-validation");
    std::fs::create_dir_all(&dir)
        .map_err(|error| AppError::Other(format!("创建验证图目录失败: {error}")))?;
    Ok(dir)
}

/// 只允许操作 visual-validation 目录内的文件（防任意路径 ingest/删除）。
/// Windows 下 `fs::canonicalize` 返回 `\?\` 前缀的 verbatim 路径，与普通路径直接
/// `starts_with` 比较必然不匹配（曾把「采用验证图」误判为非法路径）。两侧都
/// canonicalize 后再比较。
fn path_within(child: &std::path::Path, dir: &std::path::Path) -> bool {
    let child_canonical = std::fs::canonicalize(child).unwrap_or_else(|_| child.to_path_buf());
    let dir_canonical = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    child_canonical.starts_with(&dir_canonical)
}

fn guard_validation_path(
    app: &tauri::AppHandle,
    image_path: &str,
) -> Result<std::path::PathBuf, AppError> {
    let dir = validation_dir(app)?;
    let candidate = std::path::Path::new(image_path);
    if !candidate.is_file() || !path_within(candidate, &dir) {
        return Err(AppError::Other("验证图文件不存在或路径非法".into()));
    }
    std::fs::canonicalize(candidate).map_err(|_| AppError::Other("验证图文件不存在".into()))
}

#[cfg(test)]
mod tests {
    use super::path_within;

    #[test]
    fn path_within_tolerates_windows_verbatim_prefix() {
        let dir = std::env::temp_dir().join("bowerbird-guard-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("img.png");
        std::fs::write(&file, b"x").unwrap();
        // child 用 canonicalize（Windows 上带 \?\ 前缀），dir 保持普通形态——修复前此组合判否。
        let child = std::fs::canonicalize(&file).unwrap();
        assert!(path_within(std::path::Path::new(&child), &dir));
        let other = std::env::temp_dir().join("other-dir");
        assert!(!path_within(std::path::Path::new(&child), &other));
        let _ = std::fs::remove_file(&file);
    }
}

#[tauri::command]
pub async fn visual_profile_preview(
    db: State<'_, std::sync::Arc<Database>>,
    project_id: String,
    folder_id: String,
) -> Result<crate::core::visual_profile::ScopePreview, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.visual_profile_preview(&project_id, &folder_id))
        .await
        .map_err(|error| AppError::Other(format!("读取覆盖率失败: {error}")))?
}

#[tauri::command]
pub async fn visual_profile_extract(
    db: State<'_, std::sync::Arc<Database>>,
    project_id: String,
    folder_id: String,
) -> Result<VisualProfileDetail, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.extract_visual_profile(&project_id, &folder_id))
        .await
        .map_err(|error| AppError::Other(format!("提炼失败: {error}")))?
}

#[tauri::command]
pub async fn visual_profile_confirm(
    db: State<'_, std::sync::Arc<Database>>,
    profile_id: String,
) -> Result<VisualProfileDetail, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.confirm_visual_profile(&profile_id))
        .await
        .map_err(|error| AppError::Other(format!("确认失败: {error}")))?
}

#[tauri::command]
pub async fn visual_profile_list(
    db: State<'_, std::sync::Arc<Database>>,
    project_id: String,
    folder_id: Option<String>,
) -> Result<Vec<VisualProfileSummary>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.list_visual_profiles(&project_id, folder_id.as_deref()))
        .await
        .map_err(|error| AppError::Other(format!("读取视觉设定列表失败: {error}")))?
}

#[tauri::command]
pub async fn visual_profile_cloud_extract(
    db: State<'_, std::sync::Arc<Database>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    entitlement: State<'_, EntitlementService>,
    project_id: String,
    folder_id: String,
) -> Result<VisualProfileDetail, AppError> {
    // 客户端门控仅为体验；服务端 create 会按 FeaturePolicy 独立复核。
    let policy = entitlement.current_or_sync(&auth).await.policy;
    if !policy.can_use_visual_profiles {
        return Err(AppError::Cloud("当前权益不支持视觉设定云端提炼".into()));
    }
    let db_freeze = db.inner().clone();
    let (freeze_project, freeze_folder) = (project_id.clone(), folder_id.clone());
    let (_, cards) = tokio::task::spawn_blocking(move || {
        db_freeze.visual_profile_freeze_cards(&freeze_project, &freeze_folder)
    })
    .await
    .map_err(|error| AppError::Other(format!("冻结快照失败: {error}")))??;
    let client = crate::cloud::visual_profile::VisualProfileCloudClient::new(
        cloud.inner().clone(),
        auth.inner().clone(),
    );
    let cards_value = serde_json::to_value(&cards)
        .map_err(|error| AppError::Other(format!("序列化证据卡失败: {error}")))?;
    let draft_json = client.extract(&cards_value).await?;
    let db_persist = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        db_persist.persist_cloud_visual_profile(&project_id, &folder_id, &cards, &draft_json)
    })
    .await
    .map_err(|error| AppError::Other(format!("落库失败: {error}")))?
}

#[tauri::command]
pub async fn visual_profile_update_draft(
    db: State<'_, std::sync::Arc<Database>>,
    profile_id: String,
    rules: Vec<RuleEdit>,
) -> Result<VisualProfileDetail, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.update_visual_profile_rules(&profile_id, &rules))
        .await
        .map_err(|error| AppError::Other(format!("保存草稿编辑失败: {error}")))?
}

#[tauri::command]
pub async fn visual_profile_generate_validation(
    app: tauri::AppHandle,
    db: State<'_, std::sync::Arc<Database>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    entitlement: State<'_, EntitlementService>,
    profile_id: String,
    theme: String,
) -> Result<ValidationImageResult, AppError> {
    let theme = theme.trim().to_string();
    if theme.is_empty() || theme.chars().count() > 120 {
        return Err(AppError::Cloud("验证主题需在 1–120 字之间".into()));
    }
    let snapshot = entitlement.current_or_sync(&auth).await;
    if !snapshot.policy.can_use_cloud {
        return Err(AppError::Cloud("当前权益不支持 Cloud 生图".into()));
    }
    // 档位与积分从服务端派生的 generation_services 取（数据驱动，上新档位零改动）。
    let (service, credits) = snapshot
        .generation_services
        .first()
        .map(|row| (row.service.clone(), row.credits))
        .unwrap_or_else(|| ("image_hd".into(), 1));

    let db_rules = db.inner().clone();
    let pid = profile_id.clone();
    let detail = tokio::task::spawn_blocking(move || db_rules.visual_profile_get(&pid))
        .await
        .map_err(|error| AppError::Other(format!("读取视觉设定失败: {error}")))??;
    let prompt = crate::core::visual_profile::compile_validation_prompt(&detail.rules, &theme);

    let client = crate::cloud::visual_profile::VisualProfileCloudClient::new(
        cloud.inner().clone(),
        auth.inner().clone(),
    );
    let downloaded = client.generate_validation_image(&prompt, &service).await?;
    // 移入 app_data_dir/visual-validation（asset 协议默认放行 app data dir，前端可直接预览）。
    let dir = validation_dir(&app)?;
    let extension = downloaded
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("png");
    let target = dir.join(format!("{}.{}", ulid::Ulid::new(), extension));
    if tokio::fs::rename(&downloaded, &target).await.is_err() {
        tokio::fs::copy(&downloaded, &target)
            .await
            .map_err(|error| AppError::Other(format!("保存验证图失败: {error}")))?;
    }
    let _ = tokio::fs::remove_file(&downloaded).await;
    Ok(ValidationImageResult {
        image_path: target.to_string_lossy().into_owned(),
        prompt,
        service,
        credits,
    })
}

#[tauri::command]
pub async fn visual_profile_confirm_validation(
    app: tauri::AppHandle,
    db: State<'_, std::sync::Arc<Database>>,
    paths: State<'_, std::sync::Arc<crate::core::paths::LibraryPaths>>,
    profile_id: String,
    image_path: String,
) -> Result<serde_json::Value, AppError> {
    let canonical = guard_validation_path(&app, &image_path)?;
    let db_ingest = db.inner().clone();
    let source = canonical.clone();
    let paths_owned = paths.inner().clone();
    let asset = tokio::task::spawn_blocking(move || {
        crate::core::ingest::ingest_generated(
            &paths_owned,
            &db_ingest,
            &source,
            None,
            "visual-validation",
        )
    })
    .await
    .map_err(|error| AppError::Other(format!("验证图入库失败: {error}")))??;
    let asset_id = asset.id.clone();
    let db_link = db.inner().clone();
    tokio::task::spawn_blocking(move || db_link.link_validation_asset(&profile_id, &asset_id))
        .await
        .map_err(|error| AppError::Other(format!("关联验证图失败: {error}")))??;
    // 入库后删除验证缓存副本（库内已有正式文件）。
    let _ = tokio::fs::remove_file(&canonical).await;
    Ok(serde_json::json!({ "assetId": asset.id, "name": asset.name }))
}

#[tauri::command]
pub async fn visual_profile_discard_validation(
    app: tauri::AppHandle,
    image_path: String,
) -> Result<(), AppError> {
    let canonical = guard_validation_path(&app, &image_path)?;
    tokio::fs::remove_file(&canonical)
        .await
        .map_err(|error| AppError::Other(format!("删除验证图失败: {error}")))?;
    Ok(())
}
