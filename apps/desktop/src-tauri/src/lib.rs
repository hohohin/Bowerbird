//! Bowerbird 桌面应用入口。

mod codex;
mod collect;
mod commands;
mod core;
mod db;
mod error;
mod media;
mod prompt;

use std::sync::Arc;

use tauri::Manager;

pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new("info,bowerbird_desktop_lib=debug,bowerbird_desktop_lib::collect::ws_server=info")
            }),
        )
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_dir = app.path().app_data_dir()?;

            // 设置：从 <app_data>/settings.json 加载（文件不存在则用默认值）。
            let settings_path = app_dir.join("settings.json");
            let settings_state = core::settings::SettingsState::init(settings_path)?;

            // 素材库根：默认应用数据目录；迁移后走自定义根。
            let library_root = settings_state
                .get()
                .library_root
                .map(std::path::PathBuf::from)
                .filter(|root| root.is_dir());
            let paths = Arc::new(core::paths::LibraryPaths::init(
                library_root.clone().unwrap_or_else(|| app_dir.clone()),
            )?);
            // convertFileSrc 走 asset 协议，其 scope 默认只放行应用数据目录；
            // 自定义库根（迁移到非系统盘）必须显式加入，否则缩略图/原图全部被拒（见踩坑）。
            app.asset_protocol_scope().allow_directory(&paths.root, true)?;
            let db = Arc::new(db::Database::open(&paths.db)?);
            db.migrate()?;

            // 用自定义根打开成功后，清理应用数据目录里的旧库残留（迁移不删，留到此步释放系统盘）。
            if library_root.is_some() {
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

            // 启动恢复：扫 task_queue 未完成的即梦 job → dreamina query_result 续查入库（Task 5）。
            // codex job 不可恢复 → mark_failed；即梦 job + submit_id → 后台续查。异步不阻塞启动。
            core::generation_worker::spawn_recovery(
                app.handle().clone(),
                db.clone(),
                paths.clone(),
            );

            app.manage(extension_status);
            app.manage(active_project);
            app.manage(settings_state);
            app.manage(paths);
            app.manage(db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::db_health,
            commands::projects::create_project,
            commands::projects::list_projects,
            commands::projects::set_active_project,
            commands::projects::add_assets_to_project,
            commands::projects::remove_assets_from_project,
            commands::projects::delete_project,
            commands::library::import_files,
            commands::library::import_folder,
            commands::library::list_assets,
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
            commands::library::list_prompted_assets,
            commands::library::list_generation_group,
            commands::library::list_generation_groups,
            commands::library::generation_history,
            commands::library::list_tags,
            commands::library::list_asset_tags,
            commands::library::set_asset_tags,
            commands::library::reclassify_all,
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
            commands::jimeng::dreamina_health,
            commands::jimeng::dreamina_login,
            commands::jimeng::dreamina_check_login,
            commands::jimeng::open_dreamina_login,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
