//! 本地引导示例项目，以及旧版文档目录预设图释放命令。

use tauri::{AppHandle, Manager};

use crate::core::preset::PRESET_SPECS;
use crate::core::samples;
use crate::error::AppError;

/// Dedicated local lesson import: never runs auto-analysis and never rewrites
/// deduplicated user assets. Reopening a lesson keeps its project and edits.
fn prepare_onboarding_project(
    paths: &crate::core::paths::LibraryPaths,
    db: &crate::db::Database,
    sample_dir: &std::path::Path,
    project_id: &str,
) -> Result<crate::core::projects::ProjectCreateResult, AppError> {
    if !project_id.starts_with("onboarding-") || project_id.len() > 80 {
        return Err(AppError::Other("无效的示例项目标识".into()));
    }
    let marker = format!("onboarding:v2:{project_id}");
    let specs = [
        (&PRESET_SPECS[0], "示例 · 护发产品"),
        (&PRESET_SPECS[1], "示例 · 蓝色配色参考"),
    ];
    for (spec, _) in specs {
        if !sample_dir.join(spec.filename).is_file() {
            return Err(AppError::Other(
                "示例素材缺失，请重新安装或使用自己的图片开始".into(),
            ));
        }
    }
    if let Some(project) = db.get_project(project_id)? {
        if project.workspace_path != marker {
            return Err(AppError::Other("此项目不是引导示例项目".into()));
        }
        return Ok(crate::core::projects::ProjectCreateResult {
            imported_count: 0,
            member_count: project.asset_count as usize,
            project,
        });
    }
    db.create_project(project_id, "我的第一次创作", &marker, &marker, "blank")?;
    db.ensure_project_canvas(project_id)?;
    let import = (|| -> Result<(), AppError> {
        for (spec, name) in specs {
            // This importer copies without dedup or preset recognition. The
            // sample's bundled analysis is attached only to this new asset.
            let asset = crate::core::ingest::ingest_generated(
                paths,
                db,
                &sample_dir.join(spec.filename),
                None,
                "imported",
            )?;
            db.add_assets_to_project(project_id, &[asset.id.clone()])?;
            db.conn.lock().unwrap().execute(
                "UPDATE assets SET name=?1, origin_path=NULL WHERE id=?2",
                rusqlite::params![name, asset.id],
            )?;
            if let Some(payload) = spec.caption_payload {
                db.insert_analysis(&crate::core::library::Analysis {
                    id: ulid::Ulid::new().to_string(),
                    asset_id: asset.id,
                    kind: "caption".into(),
                    payload: payload.into(),
                    provider: Some("bundled-example".into()),
                    created_at: None,
                })?;
            }
        }
        Ok(())
    })();
    if let Err(error) = import {
        // Preserve imported files; remove only the failed lesson project so a
        // retry cannot mistake a partially seeded project for a complete one.
        let _ = db.delete_project(project_id, crate::core::projects::ProjectDeleteMode::Keep);
        return Err(error);
    }
    Ok(crate::core::projects::ProjectCreateResult {
        project: db
            .get_project(project_id)?
            .ok_or_else(|| AppError::Other("示例项目未能保存".into()))?,
        imported_count: 2,
        member_count: 2,
    })
}

#[tauri::command]
pub async fn create_onboarding_project(
    app: AppHandle,
    paths: tauri::State<'_, std::sync::Arc<crate::core::paths::LibraryPaths>>,
    db: tauri::State<'_, std::sync::Arc<crate::db::Database>>,
    project_id: String,
) -> Result<crate::core::projects::ProjectCreateResult, AppError> {
    use tauri::Emitter;
    let sample_dir = samples::resolve_samples_dir(&app)
        .ok_or_else(|| AppError::Other("示例素材未找到".into()))?;
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    let result = tokio::task::spawn_blocking(move || {
        prepare_onboarding_project(&paths, &db, &sample_dir, &project_id)
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))??;
    let _ = app.emit("projects://changed", ());
    let _ = app.emit("library://assets-changed", ());
    Ok(result)
}

/// 释放 v0915 素材与画板快照。选择器打开父目录，旧文件夹原样备份。
#[tauri::command]
pub async fn release_preset_pack(app: AppHandle) -> Result<String, AppError> {
    let src_dir = if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/onboarding-v0915")
    } else {
        app.path().resource_dir().map_err(|e| AppError::Other(e.to_string()))?.join("onboarding-v0915")
    };
    let doc = app
        .path()
        .document_dir()
        .map_err(|e| AppError::Other(format!("无法解析文档目录: {e}")))?;
    let parent = doc.join("Bowerbird");
    let target = parent.join("初始引导");
    tokio::task::spawn_blocking(move || crate::core::onboarding_pack::release(&src_dir, &target))
        .await.map_err(|e| AppError::Other(e.to_string()))??;
    Ok(parent.to_string_lossy().to_string())
}

#[cfg(test)]
mod onboarding_tests {
    use super::*;
    use crate::{core::paths::LibraryPaths, db::Database};

    #[test]
    fn lesson_import_is_local_repeatable_and_preserves_edits() {
        let root = std::env::temp_dir().join(format!("bb-onboarding-{}", ulid::Ulid::new()));
        let paths = LibraryPaths::init(root.clone()).unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        let samples = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/samples");
        let result = prepare_onboarding_project(&paths, &db, &samples, "onboarding-test").unwrap();
        assert_eq!(result.imported_count, 2);
        assert_eq!(result.project.asset_count, 2);
        let assets = db
            .list_assets(None, Some("onboarding-test"), 10, 0)
            .unwrap();
        for asset in &assets {
            assert_eq!(asset.source.as_deref(), Some("imported"));
            assert_eq!(asset.generation_session_id, None);
            assert_eq!(asset.origin_path, None);
            let analyses = db.list_analyses_by_asset(&asset.id).unwrap();
            assert_eq!(analyses.len(), 1);
            assert_eq!(analyses[0].kind, "caption");
            assert_eq!(analyses[0].provider.as_deref(), Some("bundled-example"));
        }
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE assets SET name='用户修改' WHERE id=?1",
                [&assets[0].id],
            )
            .unwrap();
        let again = prepare_onboarding_project(&paths, &db, &samples, "onboarding-test").unwrap();
        assert_eq!(again.imported_count, 0);
        assert_eq!(db.count_assets(None).unwrap(), 2);
        assert!(db
            .list_assets(None, Some("onboarding-test"), 10, 0)
            .unwrap()
            .iter()
            .any(|a| a.name == "用户修改"));
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_samples_and_existing_user_project_are_not_modified() {
        let root = std::env::temp_dir().join(format!("bb-onboarding-{}", ulid::Ulid::new()));
        let paths = LibraryPaths::init(root.clone()).unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        assert!(prepare_onboarding_project(&paths, &db, &root, "onboarding-missing").is_err());
        assert!(db.list_projects().unwrap().is_empty());
        db.create_project("onboarding-user", "已有项目", "", "user", "blank")
            .unwrap();
        let samples = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/samples");
        assert!(prepare_onboarding_project(&paths, &db, &samples, "onboarding-user").is_err());
        assert_eq!(
            db.get_project("onboarding-user").unwrap().unwrap().name,
            "已有项目"
        );
        assert_eq!(db.count_assets(None).unwrap(), 0);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
