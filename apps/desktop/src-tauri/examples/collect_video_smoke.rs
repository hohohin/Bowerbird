//! Real collection WS/SQLite acceptance with a disposable library and no production setup.
#![allow(dead_code, unused_imports)]
#[path = "../src/agent_generation_wait.rs"] mod agent_generation_wait;
#[path = "../src/cli_credentials.rs"] mod cli_credentials;
#[path = "../src/cloud/mod.rs"] mod cloud;
#[path = "../src/codex/mod.rs"] mod codex;
#[path = "../src/collect/mod.rs"] mod collect;
#[path = "../src/commands/mod.rs"] mod commands;
#[path = "../src/core/mod.rs"] mod core;
#[path = "../src/db/mod.rs"] mod db;
#[path = "../src/error.rs"] mod error;
#[path = "../src/installation.rs"] mod installation;
#[path = "../src/media/mod.rs"] mod media;
#[path = "../src/prompt/mod.rs"] mod prompt;
use std::{path::PathBuf, sync::Arc};

fn main() {
    if let Some(code) = media::thumb::video_thumbnail_worker() { std::process::exit(code); }
    if let Some(code) = media::probe::video_probe_worker() { std::process::exit(code); }
    assert!(cfg!(debug_assertions));
    let root = PathBuf::from(std::env::var_os("BOWERBIRD_COLLECT_TEST_ROOT").expect("isolated root required"));
    assert!(root.is_absolute() && root.join("isolated-fixture").is_file());
    assert!(!root.join("library.db").exists(), "fixture must use a fresh library");
    let paths = Arc::new(core::paths::LibraryPaths::init(root.clone()).unwrap());
    let db = Arc::new(db::Database::open(&paths.db).unwrap());
    db.migrate().unwrap();
    db.create_project("fixture-project", "Fixture", "fixture", "fixture", "canvas").unwrap();
    let settings = core::settings::SettingsState::init(root.join("settings.json")).unwrap();
    let mut value = settings.get();
    value.auto_analyze_on_ingest = false;
    settings.update(value).unwrap();
    let active = core::projects::ActiveProjectContext::new();
    active.set(Some("fixture-project".into()));
    let mut context = tauri::generate_context!("tests/fixtures/explorer/tauri.conf.json");
    context.config_mut().app.windows.clear();
    tauri::Builder::default().manage(settings).setup(move |app| {
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(collect::ws_server::serve_listener(listener, paths, db.clone(), handle.clone(), collect::ws_server::ExtensionStatus::new(), active));
            std::fs::write(root.join("ready.json"), serde_json::json!({"url": format!("ws://{address}/ws")}).to_string()).unwrap();
            let started = std::time::Instant::now();
            while !root.join("stop").exists() && started.elapsed().as_secs() < 90 {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            let assets = db.list_assets(None, None, 20, 0).unwrap();
            let members = db.list_assets(None, Some("fixture-project"), 20, 0).unwrap();
            std::fs::write(root.join("result.json"), serde_json::json!({"assets": assets, "members": members}).to_string()).unwrap();
            server.abort();
            handle.exit(if root.join("stop").exists() { 0 } else { 2 });
        });
        Ok(())
    }).run(context).expect("isolated collection server failed");
}
