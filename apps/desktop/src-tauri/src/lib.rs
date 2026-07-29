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
                tracing_subscriber::EnvFilter::new("info,bowerbird_desktop_lib=debug")
            }),
        )
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_dir = app.path().app_data_dir()?;
            let paths = Arc::new(core::paths::LibraryPaths::init(app_dir)?);
            let db = Arc::new(db::Database::open(&paths.db)?);
            db.migrate()?;
            tracing::info!(
                "library at {} ; fts5_enabled={}",
                paths.root.display(),
                db.fts5_enabled()?
            );

            // collect WS server（接收浏览器扩展采集消息，开发计划 §5.2）。
            // extension_status 共享给 extension_status command + 后台心跳超时 tick。
            let extension_status = collect::ws_server::ExtensionStatus::new();
            let paths_ws = paths.clone();
            let db_ws = db.clone();
            let app_handle = app.handle().clone();
            let status_ws = extension_status.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = collect::ws_server::start(paths_ws, db_ws, app_handle, status_ws).await {
                    tracing::error!("collect ws server stopped: {e}");
                }
            });

            app.manage(extension_status);
            app.manage(paths);
            app.manage(db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::db_health,
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
            commands::codex::open_codex_session,
            commands::codex::openai_spike_generate_image,
            commands::codex::codex_install,
            commands::codex::codex_login,
            commands::codex::cancel_codex_setup,
            commands::collect::extension_status,
            commands::collect::extension_folder_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
