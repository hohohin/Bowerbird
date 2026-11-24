//! Screenshot completion pipeline with synthetic pixels and a counting library sink.
#[path = "../src/error.rs"] mod error;
#[path = "../src/core/settings.rs"] pub mod settings;
#[path = "../src/core/file_workspace.rs"] mod file_workspace;
mod migrate { pub type PendingMove = serde_json::Value; }
mod core {
    pub use crate::settings;
    pub mod canvas_frequent_assets { pub type CanvasFrequentAssetsPreferences = serde_json::Value; }
}
#[path = "../src/commands/screenshot.rs"] pub mod screenshot;
mod commands { pub use crate::screenshot; }

fn main() {
    use std::sync::{Arc, atomic::{AtomicBool, AtomicUsize, AtomicI32, Ordering}};
    use base64::Engine;
    use tauri::{Listener, Manager};
    assert!(cfg!(debug_assertions));
    let dir = tempfile::tempdir().unwrap();
    let mut context = tauri::generate_context!("tests/fixtures/screenshot/tauri.conf.json");
    context.config_mut().identifier = format!("com.bowerbird.screenshot-persistence-{}", ulid::Ulid::new().to_string().to_lowercase());
    context.config_mut().app.windows[0].data_directory = Some(dir.path().join("webview"));
    let code = Arc::new(AtomicI32::new(1));
    let exit_code = code.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(move |app| {
            let settings = settings::SettingsState::init(dir.path().join("settings.json"))?;
            settings.update_with(|s| { s.screenshot_shortcuts.capture.clear(); s.screenshot_shortcuts.paste.clear(); })?;
            app.manage(settings);
            let calls = Arc::new(AtomicUsize::new(0));
            let fail = Arc::new(AtomicBool::new(true));
            let sink_calls = calls.clone();
            let sink_fail = fail.clone();
            app.manage(screenshot::ScreenshotLibrarySaver(Box::new(move |bytes| {
                assert_eq!(image::load_from_memory(bytes).unwrap().width(), 32);
                sink_calls.fetch_add(1, Ordering::SeqCst);
                if sink_fail.swap(false, Ordering::SeqCst) { Err("injected storage failure".into()) } else { Ok(()) }
            })));
            screenshot::initialize(app.handle());
            let app = app.handle().clone();
            let watchdog = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(45)).await;
                eprintln!("FAIL screenshot persistence timeout");
                watchdog.exit(1);
            });
            tauri::async_runtime::spawn(async move {
                let _temporary_settings = dir;
                let result: Result<(), String> = async {
                    let main = app.get_webview_window("main").unwrap();
                    screenshot::screenshot_cancel(main.clone(), app.clone(), None).await?;
                    let frame = image::RgbaImage::from_pixel(32, 24, image::Rgba([32, 128, 240, 255]));
                    let mut png = std::io::Cursor::new(Vec::new());
                    frame.write_to(&mut png, image::ImageFormat::Png).unwrap();
                    let data = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png.into_inner()));
                    let delivery = app.clone(); let pixels = frame.clone();
                    tauri::async_runtime::spawn_blocking(move || screenshot::deliver_capture_frames(&delivery, vec![(0, 0, 320, 240, pixels)])).await.unwrap()?;
                    let overlay = app.get_webview_window("snip-0").unwrap();
                    let session = screenshot::screenshot_session(overlay.clone(), app.clone())?.unwrap();
                    assert!(screenshot::screenshot_output(overlay.clone(), app.clone(), data.clone(), "pin".into(), Some(session.clone()), None, None).await.is_err());
                    let pin_count = || app.webview_windows().keys().filter(|label| label.starts_with("pin-")).count();
                    assert_eq!(pin_count(), 1);
                    assert_eq!(calls.load(Ordering::SeqCst), 1);
                    assert_eq!(screenshot::screenshot_history_list(main.clone(), app.clone()).await?.len(), 1);
                    assert!(screenshot::screenshot_output(overlay.clone(), app.clone(), data.clone(), "copy".into(), Some(session.clone()), None, None).await.is_err(), "partial output must not silently accept a different action");
                    assert_eq!(pin_count(), 1);
                    assert!(screenshot::screenshot_output(overlay.clone(), app.clone(), data.clone(), "pin".into(), Some(session.clone()), None, None).await?);
                    assert_eq!(pin_count(), 1, "retry must not repeat pin output");
                    assert_eq!(calls.load(Ordering::SeqCst), 2);
                    assert!(screenshot::screenshot_output(overlay.clone(), app.clone(), data.clone(), "pin".into(), Some(session), None, None).await.is_err());
                    let pin = app.webview_windows().into_iter().find(|(label, _)| label.starts_with("pin-")).unwrap().1;
                    let pin_session = screenshot::screenshot_session(pin.clone(), app.clone())?;
                    screenshot::screenshot_output(pin, app.clone(), data.clone(), "pin".into(), pin_session, None, None).await?;
                    let records = screenshot::screenshot_history_list(main.clone(), app.clone()).await?;
                    screenshot::screenshot_history_output(main.clone(), app.clone(), records[0].id.clone(), "pin".into(), None).await?;
                    assert_eq!(screenshot::screenshot_history_list(main.clone(), app.clone()).await?.len(), 1);
                    assert_eq!(calls.load(Ordering::SeqCst), 2, "pin and history outputs do not re-ingest");

                    let events = Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));
                    let received = events.clone();
                    let reply_app = app.clone();
                    let reply_window = main.clone();
                    main.listen("screenshot://canvas", move |event| {
                        let payload: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
                        let id = payload["requestId"].as_str().unwrap().to_string();
                        let mut events = received.lock().unwrap();
                        let error = events.is_empty().then(|| "injected canvas failure".to_string());
                        events.push(payload);
                        screenshot::screenshot_canvas_result(reply_window.clone(), reply_app.clone(), id, error, Some(false)).unwrap();
                    });
                    let delivery = app.clone(); let pixels = frame.clone();
                    tauri::async_runtime::spawn_blocking(move || screenshot::deliver_capture_frames(&delivery, vec![(0, 0, 320, 240, pixels)])).await.unwrap()?;
                    let session = screenshot::screenshot_session(overlay.clone(), app.clone())?;
                    let shapes = vec![serde_json::json!({"type":"rect","token":"<bbox>100 200 300 400</bbox>"})];
                    assert!(screenshot::screenshot_output(overlay.clone(), app.clone(), data.clone(), "canvas".into(), session.clone(), Some(shapes.clone()), None).await.is_err());
                    assert_eq!(screenshot::screenshot_history_list(main.clone(), app.clone()).await?.len(), 1);
                    screenshot::screenshot_output(overlay.clone(), app.clone(), data.clone(), "canvas".into(), session, Some(shapes.clone()), None).await?;
                    let records = screenshot::screenshot_history_list(main.clone(), app.clone()).await?;
                    assert_eq!(records.len(), 2);
                    screenshot::screenshot_history_output(main.clone(), app.clone(), records[0].id.clone(), "canvas".into(), None).await?;
                    screenshot::screenshot_history_output(main.clone(), app.clone(), records[0].id.clone(), "pin".into(), None).await?;
                    let pin = app.webview_windows().into_iter().filter(|(label, _)| label.starts_with("pin-")).max_by_key(|(label, _)| label.clone()).unwrap().1;
                    let pin_session = screenshot::screenshot_session(pin.clone(), app.clone())?;
                    screenshot::screenshot_output(pin, app.clone(), data.clone(), "canvas".into(), pin_session, None, None).await?;
                    {
                        let events = events.lock().unwrap();
                        assert_eq!(events.len(), 4);
                        assert_eq!(events[0]["requestId"], events[1]["requestId"]);
                        for payload in events.iter() {
                            assert_eq!(payload["meta"]["source_kind"], "screenshot");
                            assert_eq!(payload["meta"]["image"], serde_json::json!({"width":32,"height":24}));
                            assert_eq!(payload["meta"]["shapes"], serde_json::json!(shapes));
                        }
                    }
                    assert_eq!(calls.load(Ordering::SeqCst), 2, "canvas fallback or project save belongs to the acknowledged main receiver");

                    app.state::<settings::SettingsState>().update_with(|s| s.screenshot_auto_save = false).map_err(|e| e.to_string())?;
                    let delivery = app.clone(); let pixels = frame.clone();
                    tauri::async_runtime::spawn_blocking(move || screenshot::deliver_capture_frames(&delivery, vec![(0, 0, 320, 240, pixels)])).await.unwrap()?;
                    let session = screenshot::screenshot_session(overlay.clone(), app.clone())?;
                    screenshot::screenshot_output(overlay.clone(), app.clone(), data, "pin".into(), session, None, None).await?;
                    assert_eq!(calls.load(Ordering::SeqCst), 2);
                    assert_eq!(screenshot::screenshot_history_list(main.clone(), app.clone()).await?.len(), 3);
                    let delivery = app.clone();
                    tauri::async_runtime::spawn_blocking(move || screenshot::deliver_capture_frames(&delivery, vec![(0, 0, 320, 240, frame)])).await.unwrap()?;
                    let session = screenshot::screenshot_session(overlay.clone(), app.clone())?;
                    screenshot::screenshot_cancel(overlay, app.clone(), session).await?;
                    assert_eq!(screenshot::screenshot_history_list(main.clone(), app.clone()).await?.len(), 3, "cancel does not save full-screen pixels");
                    screenshot::screenshot_history_clear(main, app.clone()).await?;
                    println!("PASS: native capture persistence, canvas acknowledgement and stable retry, annotation delivery from capture/history/pin, opt-out, cancellation and clear");
                    Ok(())
                }.await;
                match result {
                    Ok(()) => { code.store(0, Ordering::SeqCst); app.exit(0); }
                    Err(error) => { eprintln!("FAIL {error}"); app.exit(1); }
                }
            });
            Ok(())
        }).run(context).unwrap();
    std::process::exit(exit_code.load(Ordering::SeqCst));
}
