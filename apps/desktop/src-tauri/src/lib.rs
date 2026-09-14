//! Bowerbird 桌面应用入口。

mod cloud;
mod cli_credentials;
mod installation;
mod codex;
mod collect;
mod commands;
mod core;
mod db;
mod error;
mod media;
mod prompt;

use std::sync::Arc;
use std::{path::Path, path::PathBuf};

use tauri::{Emitter, Manager};

/// Installer-only, before Tauri, session restoration or background workers.
pub fn reset_install_auth() -> i32 {
    let result = (|| -> error::AppResult<()> {
        let app_dir = codex::codex_cli::app_data_dir()
            .ok_or_else(|| error::AppError::Other("应用数据目录不可用".into()))?;
        std::fs::create_dir_all(&app_dir)?;
        std::fs::write(app_dir.join(installation::PENDING), b"1")?;
        installation::reset_pending(&app_dir)
    })();
    match result {
        Ok(()) => 0,
        Err(error) => { eprintln!("Bowerbird login reset: {error}"); 1 }
    }
}

fn checked_backfill_database_path(path: &Path) -> Result<PathBuf, String> {
    let path = std::fs::canonicalize(path)
        .map_err(|error| format!("无法定位数据库 {}: {error}", path.display()))?;
    if !path.is_file() {
        return Err(format!("数据库路径不是文件: {}", path.display()));
    }
    Ok(path)
}

/// PB5 开发工具：以 SQLite 只读模式预检原始历史，不执行 schema migration。
pub fn project_canvas_backfill_preview_file(path: &Path) -> Result<String, String> {
    let path = checked_backfill_database_path(path)?;
    let db = db::Database::open_read_only(&path).map_err(|error| error.to_string())?;
    let preview = db
        .preview_project_canvas_backfill()
        .map_err(|error| error.to_string())?;
    serde_json::to_string_pretty(&preview).map_err(|error| error.to_string())
}

/// PB5 开发工具：从运行中的正式库创建 SQLite 一致性快照；源连接严格只读。
pub fn project_canvas_backfill_backup_copy(
    source: &Path,
    destination: &Path,
) -> Result<String, String> {
    use std::time::Duration;

    let source = checked_backfill_database_path(source)?;
    if destination.exists() {
        return Err(format!("拒绝覆盖已有副本: {}", destination.display()));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "副本路径缺少父目录".to_string())?;
    let parent = std::fs::canonicalize(parent)
        .map_err(|error| format!("无法定位副本目录 {}: {error}", parent.display()))?;
    let is_drill_copy = parent.ancestors().any(|ancestor| {
        ancestor
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("project-canvas-backfill-copy-"))
    });
    if !is_drill_copy {
        return Err("拒绝备份：目标必须位于 project-canvas-backfill-copy-* 演练目录".to_string());
    }
    let destination = parent.join(
        destination
            .file_name()
            .ok_or_else(|| "副本路径缺少文件名".to_string())?,
    );
    let source_db = db::Database::open_read_only(&source).map_err(|error| error.to_string())?;
    let source_conn = source_db.conn.lock().unwrap();
    let mut destination_conn = rusqlite::Connection::open(&destination)
        .map_err(|error| format!("无法创建副本 {}: {error}", destination.display()))?;
    {
        let backup = rusqlite::backup::Backup::new(&source_conn, &mut destination_conn)
            .map_err(|error| format!("无法初始化 SQLite 在线备份: {error}"))?;
        backup
            .run_to_completion(64, Duration::from_millis(25), None)
            .map_err(|error| format!("SQLite 在线备份失败: {error}"))?;
    }
    let integrity: String = destination_conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("副本完整性检查失败: {error}"))?;
    if integrity != "ok" {
        return Err(format!("副本完整性检查未通过: {integrity}"));
    }
    Ok(destination.display().to_string())
}

/// PB5 开发工具：只允许在命名明确的演练目录中迁移数据库副本。
pub fn project_canvas_backfill_run_copy(path: &Path) -> Result<String, String> {
    let path = checked_backfill_database_path(path)?;
    let is_drill_copy = path.ancestors().any(|ancestor| {
        ancestor
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("project-canvas-backfill-copy-"))
    });
    if !is_drill_copy {
        return Err(
            "拒绝迁移：run-copy 只接受 project-canvas-backfill-copy-* 演练目录中的数据库副本"
                .to_string(),
        );
    }
    let db = db::Database::open(&path).map_err(|error| error.to_string())?;
    db.migrate().map_err(|error| error.to_string())?;
    let report = db
        .run_project_canvas_backfill()
        .map_err(|error| error.to_string())?;
    serde_json::to_string_pretty(&report).map_err(|error| error.to_string())
}

fn forward_auth_callback(app: &tauri::AppHandle, value: &str) {
    let wechat = value.starts_with("bowerbird://wechat/callback");
    let email = value.starts_with("bowerbird://auth/callback");
    if !wechat && !email {
        return;
    }
    let handle = app.clone();
    let callback = value.to_string();
    tauri::async_runtime::spawn(async move {
        let result = match handle.try_state::<cloud::AuthClient>() {
            Some(auth) => {
                if wechat {
                    auth.handle_wechat_callback(&callback).await
                } else {
                    auth.handle_callback(&callback).await
                }
            }
            .map_err(|error| error.to_string()),
            None => Err("账号服务尚未初始化".to_string()),
        };
        match result {
            Ok(snapshot) => {
                let _ = handle.emit("cloud://auth-changed", snapshot);
            }
            Err(error) => {
                let _ = handle.emit("cloud://auth-error", error);
            }
        }
    });
}

pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new("info,bowerbird_desktop_lib=debug,bowerbird_desktop_lib::collect::ws_server=info")
            }),
        )
        .try_init();

    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            for value in argv {
                forward_auth_callback(app, &value);
            }
        }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Windows/Linux 开发态不会像安装包那样自动注册自定义协议。
            // 仅在这些环境运行时注册 tauri.conf.json 中已有的 bowerbird scheme。
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }

            let app_dir = app.path().app_data_dir()?;
            // Before loading credentials/rights or starting any background workers.
            installation::reset_pending(&app_dir)?;
            cli_credentials::initialize()?;

            // 设置：从 <app_data>/settings.json 加载（文件不存在则用默认值）。
            let settings_path = app_dir.join("settings.json");
            let settings_state = core::settings::SettingsState::init(settings_path)?;
            let settings_snapshot = settings_state.get();
            // P9-T5：官方公开连接配置在构建时内置，不能由用户 settings.json 覆盖。
            // Mock/真实 adapter 只由 Edge Function 的 BOWERBIRD_CLOUD_MOCK Secret 决定。
            let cloud_client = cloud::CloudClient::new(cloud::config::CloudConfig::official())?;
            let auth_client = cloud::AuthClient::new(cloud_client.clone());
            let entitlement_service = cloud::EntitlementService::new(
                cloud_client.clone(),
                app_dir.join("entitlement.json"),
            );

            // 素材库根：默认应用数据目录；迁移后走自定义根。
            let configured_library_root = settings_snapshot
                .library_root
                .as_deref()
                .map(std::path::PathBuf::from)
                .filter(|root| root.is_dir());
            #[cfg(debug_assertions)]
            let debug_library_root_override = std::env::var_os("BOWERBIRD_LIBRARY_ROOT_OVERRIDE")
                .map(std::path::PathBuf::from)
                .filter(|root| root.is_dir());
            #[cfg(not(debug_assertions))]
            let debug_library_root_override: Option<std::path::PathBuf> = None;
            let library_root = debug_library_root_override
                .clone()
                .or_else(|| configured_library_root.clone());
            if let Some(root) = &debug_library_root_override {
                tracing::warn!(
                    "debug library override active; production settings remain unchanged: {}",
                    root.display()
                );
            }
            let paths = Arc::new(core::paths::LibraryPaths::init(
                library_root.clone().unwrap_or_else(|| app_dir.clone()),
            )?);
            // convertFileSrc 走 asset 协议，其 scope 默认只放行应用数据目录；
            // 自定义库根（迁移到非系统盘）必须显式加入，否则缩略图/原图全部被拒（见踩坑）。
            app.asset_protocol_scope()
                .allow_directory(&paths.root, true)?;
            // CS7 副本演练：DB 位于隔离目录，但历史资产仍保存正式库根下的绝对媒体路径。
            // 仅 debug override 激活时额外放行原配置根供 WebView 读取图片；数据库继续只打开副本。
            if debug_library_root_override.is_some() {
                if let Some(configured_root) = &configured_library_root {
                    if configured_root != &paths.root {
                        app.asset_protocol_scope()
                            .allow_directory(configured_root, true)?;
                    }
                }
            }
            let db = Arc::new(db::Database::open(&paths.db)?);
            db.migrate()?;
            db.recover_project_deletions(&paths)?;

            // 用自定义根打开成功后，清理应用数据目录里的旧库残留（迁移不删，留到此步释放系统盘）。
            if configured_library_root.is_some() && debug_library_root_override.is_none() {
                // 旧版迁移直接在 JSON 文本里替换未转义的 Windows 路径，无法命中 payload
                // 中的 `C:\\...`。在清理旧媒体前补偿改写一次；操作幂等，后续启动为 0 行。
                let repaired =
                    core::migrate::repair_migrated_library_paths(&db, &app_dir, &paths.root)?;
                if repaired > 0 {
                    tracing::info!("repaired {repaired} migrated library path records");
                }
                let _ = std::fs::create_dir_all(&app_dir);
                core::migrate::cleanup_legacy_root(&app_dir);
            }

            tracing::info!(
                "library at {} ; fts5_enabled={}",
                paths.root.display(),
                db.fts5_enabled()?
            );

            // collect WS server（接收浏览器扩展采集消息，开发计划 §5.2）。
            // extension_status 共享给 extension_status command + 后台心跳超时 tick。
            let extension_status = collect::ws_server::ExtensionStatus::new();
            let active_project = core::projects::ActiveProjectContext::new();
            let paths_ws = paths.clone();
            let db_ws = db.clone();
            let app_handle = app.handle().clone();
            let status_ws = extension_status.clone();
            let active_project_ws = active_project.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = collect::ws_server::start(
                    paths_ws,
                    db_ws,
                    app_handle,
                    status_ws,
                    active_project_ws,
                )
                .await
                {
                    tracing::error!("collect ws server stopped: {e}");
                }
            });

            let recovery_db = db.clone();
            let recovery_paths = paths.clone();
            let orphan_scan_db = db.clone();

            app.manage(Arc::new(core::local_classification::LocalClassifier::new(
                app.path().app_data_dir()?.join("local-classification").join(core::local_classification::runtime::PACK_ID),
            )));
            core::local_classification::watch(app.handle().clone(), db.clone(), paths.clone());

            app.manage(extension_status);
            app.manage(active_project);
            app.manage(settings_state);
            app.manage(cloud_client);
            app.manage(auth_client);
            app.manage(entitlement_service);
            app.manage(paths);
            app.manage(db);

            // 权益状态注册后再恢复任务，确保降级账号不能续跑历史 BYO job。
            core::generation_worker::spawn_recovery(
                app.handle().clone(),
                recovery_db,
                recovery_paths,
            );

            // 即梦远端孤儿扫描（约定 23 阶段 3）：内部延迟 15s，不与启动恢复抢 IO。
            core::generation_worker::spawn_orphan_scan(app.handle().clone(), orphan_scan_db);

            // Agent Z（dev-only）回传：轮询 .agent-z/inbox，模型经 MCP 工具送回的文本
            // 转发 agent-z://output → 前端追加进创作板。函数内部仅 Windows + debug 生效。
            #[cfg(all(windows, debug_assertions))]
            commands::agent_z::spawn_inbox_watcher(app.handle().clone());

            // 阶段 B：首启自动注入已废弃，改用 preset 模块（ingest 识别）+ 新手引导 tour
            // （用户主动「导入文件夹」选预设图目录建项目）。samples.rs 保留供 release_preset_pack 复用。
            // core::samples::seed_if_first_launch(app.handle().clone(), samples_db, samples_paths);

            for value in std::env::args() {
                forward_auth_callback(app.handle(), &value);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::db_health,
            commands::project_canvas::project_canvas_materialize,
            commands::project_canvas::project_canvas_ensure,
            commands::project_canvas::project_canvas_get,
            commands::project_canvas::project_canvas_rename,
            commands::project_canvas::project_canvas_title_from_first_prompt,
            commands::project_canvas::project_canvas_update_draft,
            commands::project_canvas::project_canvas_touch,
            commands::project_canvas::project_thread_create,
            commands::project_canvas::project_thread_archive,
            commands::project_canvas::project_thread_restore,
            commands::project_canvas::project_canvas_node_create,
            commands::project_canvas::project_canvas_node_update,
            commands::project_canvas::project_canvas_node_remove,
            commands::project_canvas::project_canvas_node_restore,
            commands::project_canvas::project_canvas_group_create,
            commands::project_canvas::project_canvas_group_set_items,
            commands::project_canvas::project_canvas_group_update,
            commands::project_canvas::project_canvas_group_delete,
            commands::project_canvas::project_canvas_edge_create,
            commands::project_canvas::project_canvas_edge_delete,
            commands::project_canvas::project_canvas_view_upsert,
            commands::project_canvas::project_canvas_view_flush,
            commands::project_canvas::project_canvas_for_asset,
            commands::project_canvas::project_canvas_for_node,
            commands::agent::local_agent_health,
            commands::agent::local_agent_start,
            commands::agent::local_agent_compile_prompt,
            commands::agent::local_agent_resume,
            commands::agent::local_agent_latest,
            commands::agent::local_agent_find_asset_id,
            commands::agent_z::agent_z_health,
            commands::agent_z::agent_z_send,
            commands::agent_ds::agent_ds_chat,
            commands::cloud::cloud_auth_snapshot,
            commands::cloud::cloud_start_email_login,
            commands::cloud::cloud_start_wechat_login,
            commands::cloud::cloud_restore_session,
            commands::cloud::cloud_logout,
            commands::cloud::cloud_entitlement,
            commands::cloud::cloud_sync_entitlement,
            commands::cloud::cloud_redeem_code,
            commands::cloud_agent::cloud_agent_start,
            commands::cloud_agent::cloud_agent_latest,
            commands::cloud_agent::cloud_agent_list,
            commands::cloud_agent::cloud_agent_get,
            commands::cloud_agent::cloud_agent_decide_approval,
            commands::cloud_agent::cloud_agent_answer_clarification,
            commands::cloud_agent::cloud_agent_cancel,
            commands::cloud_agent::cloud_agent_feedback,
            commands::cloud_agent::cloud_agent_preview_final,
            commands::cloud_agent::cloud_agent_preview_artifact,
            commands::cloud_agent::cloud_agent_ingest_final,
            commands::cloud_agent::cloud_agent_ingest_artifacts,
            commands::cloud_agent::cloud_agent_execute_local_task,
            commands::projects::create_project,
            commands::projects::create_blank_project,
            commands::preset::release_preset_pack,
            commands::preset::create_onboarding_project,
            commands::projects::list_projects,
            commands::projects::refresh_project,
            commands::projects::set_active_project,
            commands::projects::add_assets_to_project,
            commands::projects::remove_assets_from_project,
            commands::projects::project_delete_impact,
            commands::projects::delete_project,
            commands::visual_profile::visual_profile_preview,
            commands::visual_profile::visual_profile_extract,
            commands::visual_profile::visual_profile_confirm,
            commands::visual_profile::visual_profile_list,
            commands::visual_profile::visual_profile_get,
            commands::visual_profile::visual_profile_delete,
            commands::visual_profile::visual_profile_cloud_extract,
            commands::visual_profile::visual_profile_update_draft,
            commands::visual_profile::visual_profile_generate_validation,
            commands::visual_profile::visual_profile_confirm_validation,
            commands::visual_profile::visual_profile_discard_validation,
            commands::library::import_files,
            commands::library::import_folder,
            commands::library::import_image_bytes,
            commands::library::save_annotated_image,
            commands::layers::layer_workspace_asset_ids,
            commands::layers::layer_workspace_load,
            commands::layers::layer_workspace_save,
            commands::layers::layer_export,
            commands::layers::layer_cloud_request,
            commands::layer_text::layer_text_request,
            commands::layer_text::layer_fonts,
            commands::layer_export::layer_export_psd,
            commands::layer_export::layer_export_font_names,
            commands::layer_export::layer_export_ai,
            commands::library::save_annotation_temp,
            commands::library::read_image_data_url,
            commands::library::list_assets,
            commands::library::list_library_view,
            commands::library::get_assets_by_ids,
            commands::library::count_assets,
            commands::library::list_folders,
            commands::library::create_folder,
            commands::library::create_smart_folder,
            commands::library::create_collection,
            commands::library::list_collections,
            commands::library::list_asset_collections,
            commands::library::add_asset_to_collection,
            commands::library::remove_asset_from_collection,
            commands::library::list_assets_by_collection,
            commands::library::create_preset,
            commands::library::list_presets,
            commands::library::update_preset,
            commands::library::delete_preset,
            commands::library::rename_folder,
            commands::library::delete_folder,
            commands::library::delete_asset,
            commands::library::delete_asset_with_mode,
            commands::library::reveal_asset_folder,
            commands::library::move_assets_to_folder,
            commands::library::search_assets,
            commands::library::list_assets_smart,
            commands::library::list_analyses_by_asset,
            commands::library::delete_analysis,
            commands::library::update_caption_sections,
            commands::library::list_prompted_assets,
            commands::library::get_prompted_asset,
            commands::library::list_captioned_asset_ids,
            commands::library::rename_asset,
            commands::library::list_generation_group,
            commands::library::list_generation_groups,
            commands::library::generation_history,
            commands::library::list_tags,
            commands::library::list_asset_tags,
            commands::library::set_asset_tags,
            commands::library::reclassify_all,
            commands::local_classification::local_classification_status,
            commands::local_classification::local_classification_start,
            commands::local_classification::local_classification_stop,
            commands::local_classification::local_classification_enable,
            commands::local_classification::local_classification_labels,
            commands::local_classification::local_classification_save_label,
            commands::local_classification::local_classification_example,
            commands::library::palette_overview,
            commands::library::list_assets_by_color,
            commands::library::recompute_colors,
            commands::library::reveal_path_in_explorer,
            commands::library::open_path_with_system,
            commands::prompt::create_prompt,
            commands::prompt::update_prompt,
            commands::prompt::delete_prompt,
            commands::prompt::link_prompt,
            commands::prompt::unlink_prompt,
            commands::prompt::list_prompts_by_asset,
            commands::prompt::assemble_pack,
            commands::codex::codex_health,
            commands::codex::codex_generate_prompt_for_asset,
            commands::codex::codex_describe_asset,
            commands::codex::cancel_codex_describe,
            commands::codex::codex_create_image,
            commands::codex::cancel_codex_create,
            commands::codex::list_gen_jobs,
            commands::codex::jimeng_retrieve_orphan,
            commands::codex::recover_cloud_video,
            commands::codex::recent_gen_sessions,
            commands::codex::dismiss_gen_job,
            commands::codex::open_codex_session,
            commands::codex::openai_spike_generate_image,
            commands::codex::codex_install,
            commands::codex::codex_login,
            commands::codex::cancel_codex_setup,
            commands::collect::extension_status,
            commands::collect::extension_folder_path,
            commands::settings::get_settings,
            commands::settings::update_settings,
            commands::settings::library_root,
            commands::settings::migrate_library_root,
            commands::settings::restart_app,
            commands::source_browser::open_source_browser,
            commands::source_browser::resize_source_browser,
            commands::source_browser::navigate_source_browser,
            commands::source_browser::source_browser_back,
            commands::source_browser::source_browser_forward,
            commands::source_browser::reload_source_browser,
            commands::source_browser::hide_source_browser,
            commands::source_browser_capture::capture_source_browser_image,
            commands::jimeng::dreamina_health,
            commands::jimeng::dreamina_login,
            commands::jimeng::dreamina_check_login,
            commands::jimeng::open_dreamina_login,
            commands::jimeng::dreamina_install,
            commands::jimeng::cancel_dreamina_setup,
            commands::jimeng::dreamina_logout,
            commands::jimeng::dreamina_login_headless,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
