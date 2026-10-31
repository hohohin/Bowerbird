//! Isolated metadata transport check; no production setup, credentials or library.
use tauri::{WebviewUrl, WebviewWindowBuilder};
#[path = "../src/error.rs"]
mod error;
#[path = "../src/commands/source_browser_network.rs"]
pub mod source_browser_network;
mod commands {
    pub use crate::source_browser_network;
}
#[path = "../src/commands/video_replication/douyin_browser.rs"]
mod browser;
#[path = "../src/commands/video_replication/douyin_media.rs"]
mod media;
fn main() {
    assert!(cfg!(debug_assertions));
    let root = std::path::PathBuf::from(
        std::env::var_os("BOWERBIRD_REPLICATION_TEST_ROOT").expect("isolated test root required"),
    );
    let mut context = tauri::generate_context!("tests/fixtures/explorer/tauri.conf.json");
    let live_url = std::env::var("BOWERBIRD_REPLICATION_TEST_URL").ok();
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .setup(move |app| {
            let output = root.join("result.json");
            let script = include_str!("../src/commands/video_replication/douyin_capture.js")
                .replace("__EXPECTED_ID__", if live_url.is_some() { "null" } else { "\"1234567890123456\"" });
            let capture_output = output.clone();
            let download = live_url.is_some();
            let (tx, mut rx) = tokio::sync::mpsc::channel(4);
            let window = WebviewWindowBuilder::new(
                app,
                "replication-douyin-test",
                WebviewUrl::External("about:blank".parse().unwrap()),
            )
            .visible(false)
            .focused(false)
            .data_directory(root.join("profile"))
            .initialization_script(include_str!("../src/commands/video_replication/douyin_quiet.js"))
            .initialization_script(&script)
            .on_navigation(move |url| {
                if url.as_str() == "about:blank" { return true; }
                if url.scheme() == "bb-replication-capture" {
                    let data = url
                        .query_pairs()
                        .find(|(key, _)| key == "payload")
                        .unwrap()
                        .1
                        .into_owned();
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&data) { let _ = tx.try_send(value); }
                    return false;
                }
                url.host_str() == Some("127.0.0.1") || url.host_str().is_some_and(|host| host == "douyin.com" || host.ends_with(".douyin.com") || host == "iesdouyin.com" || host.ends_with(".iesdouyin.com"))
            })
            .build()?;
            let captured_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut responses = browser::observe(&window).await.expect("network observer");
                #[cfg(windows)]
                {
                    use windows::core::Interface;
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    window.with_webview(move |view| unsafe {
                        let core = view.controller().CoreWebView2().unwrap().cast::<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8>().unwrap();
                        let mut muted = windows::core::BOOL(0);
                        core.IsMuted(&mut muted).unwrap();
                        let _ = tx.send(muted.as_bool());
                    }).unwrap();
                    assert!(rx.await.unwrap(), "acquisition webview must be natively muted before navigation");
                }
                window.navigate(live_url.as_deref().unwrap_or("http://127.0.0.1:1660").parse().unwrap()).unwrap();
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(750)).await;
                    let value = rx.try_recv().ok().or(browser::captured(&window, &mut responses).await.ok().flatten());
                    if let Some(value) = value {
                        std::fs::write(&capture_output, value.to_string()).unwrap();
                        if download {
                            let target = capture_output.with_file_name("video.mp4");
                            let mut success = false;
                            for url in value["urls"].as_array().unwrap() {
                                if media::download(&window, url.as_str().unwrap(), &target,
                                    &format!("https://www.douyin.com/video/{}", value["videoId"].as_str().unwrap()), value["userAgent"].as_str().unwrap(), |_,_| {}).await.is_ok() { success = true; break; }
                            }
                            std::fs::write(capture_output.with_file_name("download.json"), serde_json::json!({"success":success,"bytes":std::fs::metadata(&target).map(|v|v.len()).unwrap_or(0)}).to_string()).unwrap();
                            #[cfg(windows)]
                            {
                                use tauri::Manager;
                                let view = window.get_webview(window.label()).unwrap();
                                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                                let state = source_browser_network::cdp(&view, "Runtime.evaluate", serde_json::json!({"expression":"JSON.stringify(Array.from(document.querySelectorAll('video,audio'), v => ({paused:v.paused,time:v.currentTime})))", "returnByValue":true})).await.unwrap();
                                std::fs::write(capture_output.with_file_name("media-state.json"), state["result"]["value"].as_str().unwrap()).unwrap();
                            }
                        }
                        captured_app.exit(0);
                        break;
                    }
                }
            });
            let timeout = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(if download { 180 } else { 45 }));
                timeout.exit(2);
            });
            Ok(())
        })
        .run(context)
        .expect("isolated replication browser failed");
}
