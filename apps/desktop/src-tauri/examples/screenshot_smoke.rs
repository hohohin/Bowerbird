//! Hidden native smoke test: synthetic pixels, temporary settings, no screen capture,
//! clipboard writes, production database, credentials or application startup.
#[path = "../src/error.rs"]
mod error;
#[path = "../src/core/settings.rs"]
pub mod settings;
mod core {
    pub use crate::settings;
}
#[path = "../src/commands/screenshot.rs"]
pub mod screenshot;
mod commands {
    pub use crate::screenshot;
}

fn main() {
    use base64::Engine;
    use tauri::Manager;
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    assert!(cfg!(debug_assertions), "test fixture only");
    let mut context = tauri::generate_context!("tests/fixtures/explorer/tauri.conf.json");
    context.config_mut().app.windows[0].url =
        tauri::WebviewUrl::External("about:blank".parse().unwrap());
    let exit_code = std::sync::Arc::new(std::sync::atomic::AtomicI32::new(1));
    let result_code = exit_code.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(move |app| {
            let result_code = result_code.clone();
            let dir = std::env::temp_dir().join(format!("bb-screenshot-smoke-{}", ulid::Ulid::new()));
            let settings = settings::SettingsState::init(dir.join("settings.json"))?;
            settings.update_with(|s| { s.screenshot_shortcuts.capture.clear(); s.screenshot_shortcuts.paste.clear(); })?;
            app.manage(settings);
            screenshot::initialize(app.handle());
            let app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result: Result<(), String> = async {
                    let main = app.get_webview_window("main").unwrap();
                    let keys = screenshot::ScreenshotShortcuts { capture: "Control+Alt+KeyJ".into(), paste: "Control+Alt+KeyK".into() };
                    screenshot::screenshot_set_shortcuts(main.clone(), app.clone(), keys.clone()).await?;
                    assert!(app.global_shortcut().is_registered(keys.capture.as_str()));
                    assert!(app.global_shortcut().is_registered(keys.paste.as_str()));
                    let swapped = screenshot::ScreenshotShortcuts { capture: keys.paste.clone(), paste: keys.capture.clone() };
                    screenshot::screenshot_set_shortcuts(main.clone(), app.clone(), swapped.clone()).await?;
                    #[cfg(target_os = "macos")]
                    {
                        // Carbon rejects F23: the already-added first key must be rolled back.
                        let unsupported = screenshot::ScreenshotShortcuts { capture: "Control+Alt+KeyL".into(), paste: "Control+Alt+F23".into() };
                        assert!(screenshot::screenshot_set_shortcuts(main.clone(), app.clone(), unsupported).await.is_err());
                        assert!(!app.global_shortcut().is_registered("Control+Alt+KeyL"));
                        assert!(app.global_shortcut().is_registered(keys.capture.as_str()));
                    }
                    std::fs::create_dir(dir.join("settings.json.tmp")).unwrap();
                    let disk_failure = screenshot::ScreenshotShortcuts { capture: "Control+Alt+KeyL".into(), paste: String::new() };
                    assert!(screenshot::screenshot_set_shortcuts(main.clone(), app.clone(), disk_failure).await.is_err());
                    assert!(!app.global_shortcut().is_registered("Control+Alt+KeyL"));
                    assert!(app.global_shortcut().is_registered(keys.capture.as_str()));
                    std::fs::remove_dir(dir.join("settings.json.tmp")).unwrap();
                    let invalid = screenshot::ScreenshotShortcuts { capture: "Control+Alt+KeyJ".into(), paste: "Ctrl+Alt+J".into() };
                    assert!(screenshot::screenshot_set_shortcuts(main.clone(), app.clone(), invalid).await.is_err());
                    assert_eq!(app.state::<settings::SettingsState>().get().screenshot_shortcuts, swapped);
                    screenshot::screenshot_set_shortcuts(main.clone(), app.clone(), screenshot::ScreenshotShortcuts { capture: String::new(), paste: String::new() }).await?;
                    assert!(!app.global_shortcut().is_registered(keys.capture.as_str()));
                    assert!(!app.global_shortcut().is_registered(keys.paste.as_str()));
                    println!("PASS native global registration, swap, rejected duplicate, persistence, failed registration/write rollback and disable");
                    let image = image::RgbaImage::from_pixel(32, 24, image::Rgba([42, 127, 220, 255]));
                    let mut bytes = std::io::Cursor::new(Vec::new());
                    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
                    let data = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes.into_inner()));
                    screenshot::screenshot_output(main.clone(), app.clone(), data.clone(), "pin".into(), None).await?;
                    let pinned = app.webview_windows().into_iter().find(|(label, _)| label.starts_with("pin-")).unwrap().1;
                    assert!(!pinned.is_decorated().unwrap()); assert!(pinned.is_always_on_top().unwrap()); assert!(!pinned.is_visible().unwrap());
                    let session = screenshot::screenshot_session(pinned.clone(), app.clone())?.unwrap();
                    use tauri::ipc::IpcResponse;
                    let body = screenshot::screenshot_image(pinned.clone(), app.clone(), session.clone())?.body().unwrap();
                    match body {
                        tauri::ipc::InvokeResponseBody::Raw(bytes) => assert_eq!(image::load_from_memory(&bytes).unwrap().to_rgba8(), image),
                        _ => panic!("screenshot must use binary IPC"),
                    }
                    assert!(screenshot::screenshot_image(pinned.clone(), app.clone(), "stale".into()).is_err());
                    screenshot::screenshot_show(pinned.clone(), app.clone(), "stale".into())?;
                    assert!(!pinned.is_visible().unwrap());
                    assert!(screenshot::screenshot_image(main.clone(), app.clone(), "wrong-window".into()).is_err());
                    assert!(screenshot::screenshot_set_shortcuts(pinned.clone(), app.clone(), keys).await.is_err());
                    screenshot::screenshot_cancel(main.clone(), app.clone(), None).await?;
                    let overlays: Vec<_> = app.webview_windows().into_iter().filter(|(label, _)| label.starts_with("snip-")).collect();
                    assert!(!overlays.is_empty(), "prewarming creates empty hidden overlays");
                    for (_, overlay) in &overlays {
                        assert!(!overlay.is_visible().unwrap());
                        assert!(screenshot::screenshot_session(overlay.clone(), app.clone())?.is_none());
                    }
                    screenshot::screenshot_cancel(main.clone(), app.clone(), None).await?;
                    for (label, _) in &overlays {
                        assert!(app.get_webview_window(label).is_some(), "cancel reuses the warm window");
                    }
                    println!("PASS native hidden prewarm, cancel reuse, binary pixels and stale-session rejection");
                    main.destroy().map_err(|e| e.to_string())?;
                    for _ in 0..100 {
                        if !app.webview_windows().keys().any(|label| label.starts_with("snip-")) { break; }
                        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    }
                    assert!(!app.webview_windows().keys().any(|label| label.starts_with("snip-")), "warm windows must not keep a closed app alive");
                    println!("PASS native main-close cleanup, pinned flags, image ownership and settings guard");
                    Ok(())
                }.await;
                let _ = std::fs::remove_dir_all(dir);
                match result { Ok(()) => { result_code.store(0, std::sync::atomic::Ordering::SeqCst); app.exit(0) }, Err(error) => { eprintln!("FAIL {error}"); app.exit(1); } }
            });
            Ok(())
        })
        .run(context)
        .expect("native screenshot fixture failed");
    std::process::exit(exit_code.load(std::sync::atomic::Ordering::SeqCst));
}
