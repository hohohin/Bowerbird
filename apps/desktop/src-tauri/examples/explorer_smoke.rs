//! Isolated native fixture. No production app setup, account, library or Worker.
#[path = "../src/error.rs"]
mod error;
#[path = "../src/commands/source_browser.rs"]
mod source_browser;
#[path = "../src/commands/source_browser_network.rs"]
mod source_browser_network;
use tauri::Manager;

#[tauri::command]
async fn smoke_exit(app: tauri::AppHandle) { app.exit(0); }

#[tauri::command]
async fn smoke_capture(app: tauri::AppHandle, url: String) -> Result<String, String> {
    use base64::Engine;
    let webview = app.get_webview("source-discovery").ok_or("missing browser")?;
    let bytes = source_browser_network::browser_bytes(&webview, &url).await.map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn main() {
    assert!(cfg!(debug_assertions), "test fixture only");
    let mut context = tauri::generate_context!("tests/fixtures/explorer/tauri.conf.json");
    context.config_mut().app.windows[0].decorations = false;
    context.config_mut().app.windows[0].visible = std::env::var_os("BOWERBIRD_EXPLORER_TEST_VISIBLE").is_some();
    context.config_mut().app.windows[0].data_directory = Some(std::path::PathBuf::from(
        std::env::var_os("BOWERBIRD_EXPLORER_TEST_MAIN_DATA_DIR").expect("isolated main profile required")
    ));
    context.config_mut().app.windows[0].additional_browser_args = Some("--remote-debugging-port=9557 --remote-debugging-address=127.0.0.1".into());
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            source_browser::open_source_browser, source_browser::resize_source_browser,
            source_browser::navigate_source_browser, source_browser::hide_source_browser,
            source_browser::source_browser_back, source_browser::source_browser_forward,
            source_browser::reload_source_browser, smoke_capture, smoke_exit,
        ])
        .run(context)
        .expect("native explorer fixture failed");
}
