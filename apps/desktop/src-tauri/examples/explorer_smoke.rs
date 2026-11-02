//! Isolated native fixture. No production app setup, account, library or Worker.
#[path = "../src/error.rs"]
mod error;
#[path = "../src/commands/source_browser.rs"]
mod source_browser;
#[path = "../src/commands/source_browser_network.rs"]
mod source_browser_network;
#[path = "../src/commands/source_browser_jobs.rs"]
mod source_browser_jobs;
#[path = "../src/commands/source_browser_stream.rs"]
mod source_browser_stream;
#[path = "../src/media/tools.rs"]
pub(crate) mod tools;
#[path = "../src/media/probe.rs"]
pub(crate) mod probe;
#[path = "../src/media/audio.rs"]
mod audio;
mod media { pub(crate) use crate::{tools, probe}; }
use tauri::Manager;
#[derive(Default)]
struct DragNotices(std::sync::Mutex<Vec<serde_json::Value>>);

#[tauri::command]
fn smoke_drag_notices(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    app.state::<DragNotices>().0.lock().unwrap().clone()
}

#[tauri::command]
async fn smoke_exit(app: tauri::AppHandle) { app.exit(0); }

#[tauri::command]
async fn smoke_capture_resource(app: tauri::AppHandle, url: String, page_url: String, capture_id: String) -> Result<String, String> {
    use base64::Engine;
    let webview = app.get_webview("source-discovery").ok_or("missing browser")?;
    let control = source_browser_jobs::CaptureControl::begin(app, Some(capture_id)).map_err(|e| e.to_string())?;
    let bytes = source_browser_stream::capture_video(&webview, &url, &page_url, &control).await.map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
async fn smoke_capture(app: tauri::AppHandle, url: String, media_kind: Option<String>) -> Result<String, String> {
    use base64::Engine;
    let webview = app.get_webview("source-discovery").ok_or("missing browser")?;
    let bytes = if media_kind.as_deref() == Some("video") {
        source_browser_network::browser_video_bytes(&webview, &url).await
    } else { source_browser_network::browser_bytes(&webview, &url).await }.map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn main() {
    if let Some(code) = probe::video_probe_worker() { std::process::exit(code); }
    assert!(cfg!(debug_assertions), "test fixture only");
    let mut context = tauri::generate_context!("tests/fixtures/explorer/tauri.conf.json");
    context.config_mut().app.windows[0].decorations = false;
    context.config_mut().app.windows[0].visible = std::env::var_os("BOWERBIRD_EXPLORER_TEST_VISIBLE").is_some();
    context.config_mut().app.windows[0].data_directory = Some(std::path::PathBuf::from(
        std::env::var_os("BOWERBIRD_EXPLORER_TEST_MAIN_DATA_DIR").expect("isolated main profile required")
    ));
    context.config_mut().app.windows[0].additional_browser_args = Some("--remote-debugging-port=9557 --remote-debugging-address=127.0.0.1".into());
    tauri::Builder::default()
        .manage(DragNotices::default())
        .manage(source_browser::SourceDragHandler(|app, start, notice| {
            app.state::<DragNotices>().0.lock().unwrap().push(serde_json::json!({
                "start": start, "id": notice.id, "imageUrl": notice.image_url, "pageUrl": notice.page_url,
                "mediaKind": notice.media_kind
            }));
        }))
        .invoke_handler(tauri::generate_handler![
            source_browser::open_source_browser, source_browser::resize_source_browser,
            source_browser::navigate_source_browser, source_browser::hide_source_browser,
            source_browser::source_browser_back, source_browser::source_browser_forward,
            source_browser::reload_source_browser, smoke_capture, smoke_exit, smoke_drag_notices,
            smoke_capture_resource, source_browser_jobs::cancel_source_browser_capture,
        ])
        .run(context)
        .expect("native explorer fixture failed");
}
