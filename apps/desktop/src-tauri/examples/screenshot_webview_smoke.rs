//! Real screenshot frontend in an isolated WebView2 profile, synthetic pixels only.
#[path = "../src/error.rs"] mod error;
#[path = "../src/core/settings.rs"] pub mod settings;
mod core {
    pub use crate::settings;
    // Unrelated shelf settings are opaque in this screenshot-only fixture.
    pub mod canvas_frequent_assets { pub type CanvasFrequentAssetsPreferences = serde_json::Value; }
}
#[path = "../src/commands/screenshot.rs"] pub mod screenshot;
mod commands { pub use crate::screenshot; }

fn main() {
    use base64::Engine;
    use tauri::Manager;
    assert!(cfg!(debug_assertions), "test fixture only");
    let dir = std::env::temp_dir().join(format!("bb-screenshot-webview-{}", ulid::Ulid::new()));
    let mut context = tauri::generate_context!("tests/fixtures/screenshot/tauri.conf.json");
    context.config_mut().identifier = format!("com.bowerbird.screenshot-test-{}", ulid::Ulid::new().to_string().to_lowercase());
    context.config_mut().app.windows[0].data_directory = Some(dir.join("webview"));
    let result_code = std::sync::Arc::new(std::sync::atomic::AtomicI32::new(1));
    let exit_code = result_code.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            screenshot::screenshot_session, screenshot::screenshot_image,
            screenshot::screenshot_show, screenshot::screenshot_output,
            screenshot::screenshot_cancel,
        ])
        .setup(move |app| {
            let settings = settings::SettingsState::init(dir.join("settings.json"))?;
            settings.update_with(|s| { s.screenshot_shortcuts.capture.clear(); s.screenshot_shortcuts.paste.clear(); })?;
            app.manage(settings);
            screenshot::initialize(app.handle());
            let app = app.handle().clone();
            let watchdog = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(40)).await;
                eprintln!("FAIL: screenshot frontend test timed out");
                watchdog.exit(1);
            });
            let result_code = result_code.clone();
            tauri::async_runtime::spawn(async move {
                let result: Result<(), String> = async {
                    let main = app.get_webview_window("main").unwrap();
                    assert!(!main.is_visible().unwrap());
                    let image = image::RgbaImage::from_pixel(240, 160, image::Rgba([32, 128, 240, 255]));
                    let mut png = std::io::Cursor::new(Vec::new());
                    image.write_to(&mut png, image::ImageFormat::Png).unwrap();
                    let data = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png.into_inner()));
                    let started = std::time::Instant::now();
                    screenshot::screenshot_output(main.clone(), app.clone(), data, "pin".into(), None).await?;
                    let pin = app.webview_windows().into_iter().find(|(label, _)| label.starts_with("pin-")).unwrap().1;
                    for _ in 0..400 {
                        if pin.is_visible().unwrap() { break; }
                        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                    }
                    assert!(pin.is_visible().unwrap(), "real frontend must show pin while main stays hidden");
                    println!("PIN_READY_MS={}", started.elapsed().as_millis());
                    assert!(!main.is_visible().unwrap());
                    assert!(!pin.is_decorated().unwrap());
                    assert!(pin.is_always_on_top().unwrap());
                    let size = pin.inner_size().unwrap();
                    let scale = pin.scale_factor().unwrap();
                    assert!((size.width as f64 / scale - 240.0).abs() <= 1.0);
                    assert!((size.height as f64 / scale - 160.0).abs() <= 1.0, "no toolbar or frame allowance");
                    #[cfg(windows)]
                    {
                        use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetCursorPos, SetCursorPos};
                        use windows::Win32::Foundation::POINT;
                        #[link(name = "user32")]
                        extern "system" { fn mouse_event(flags: u32, dx: u32, dy: u32, data: u32, extra: usize); }
                        let hwnd = pin.hwnd().unwrap();
                        assert_eq!(unsafe { GetForegroundWindow() }, hwnd, "only click the focused test window");
                        let pos = pin.inner_position().unwrap();
                        let mut old = POINT::default();
                        unsafe {
                            GetCursorPos(&mut old).unwrap();
                            SetCursorPos(pos.x + 30, pos.y + 30).unwrap();
                            for _ in 0..2 {
                                mouse_event(0x0002, 0, 0, 0, 0);
                                mouse_event(0x0004, 0, 0, 0, 0);
                                std::thread::sleep(std::time::Duration::from_millis(70));
                            }
                            SetCursorPos(old.x, old.y).unwrap();
                        }
                    }
                    #[cfg(not(windows))]
                    pin.eval("document.querySelector('.snip-pin img').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))").map_err(|e| e.to_string())?;
                    for _ in 0..200 {
                        if app.get_webview_window(pin.label()).is_none() { break; }
                        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                    }
                    assert!(app.get_webview_window(pin.label()).is_none(), "double click must destroy native pin");
                    println!("PASS: hidden-main real frontend, topmost frameless exact-size pin, double-click native close");
                    screenshot::screenshot_cancel(main.clone(), app.clone(), None).await?;
                    // Reuse the production delivery path without ever capturing the real screen.
                    for round in 1..=2 {
                        let frame = image::RgbaImage::from_fn(3840, 2160, |x, y| {
                            image::Rgba([(x / 8) as u8, (y / 8) as u8, ((x + y) / 16) as u8, 255])
                        });
                        let started = std::time::Instant::now();
                        let delivery_app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || screenshot::deliver_capture_frames(&delivery_app,
                            vec![(40, 40, 800, 450, frame)])).await.unwrap()?;
                        let overlay = app.get_webview_window("snip-0").unwrap();
                        for _ in 0..400 {
                            if overlay.is_visible().unwrap() { break; }
                            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                        }
                        assert!(overlay.is_visible().unwrap(), "hidden warm frontend must show the fresh capture");
                        println!("CAPTURE_4K_READY_MS_ROUND_{round}={}", started.elapsed().as_millis());
                        assert!(!main.is_visible().unwrap());
                        let _session = screenshot::screenshot_session(overlay.clone(), app.clone())?.unwrap();
                        #[cfg(windows)]
                        {
                            #[link(name = "user32")]
                            extern "system" { fn keybd_event(key: u8, scan: u8, flags: u32, extra: usize); }
                            // No pointer click: keyboard focus must arrive with the visible capture.
                            unsafe { keybd_event(0x1b, 0, 0, 0); keybd_event(0x1b, 0, 2, 0); }
                            for _ in 0..200 {
                                if !overlay.is_visible().unwrap() { break; }
                                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                            }
                        }
                        #[cfg(not(windows))]
                        screenshot::screenshot_cancel(overlay.clone(), app.clone(), Some(_session)).await?;
                        assert!(!overlay.is_visible().unwrap());
                        assert!(screenshot::screenshot_session(overlay, app.clone())?.is_none());
                    }
                    println!("PASS: hidden-main warm capture reuse, fresh 4K frame delivery and cancel cleanup");
                    Ok(())
                }.await;
                match result {
                    Ok(()) => { result_code.store(0, std::sync::atomic::Ordering::SeqCst); app.exit(0); }
                    Err(error) => { eprintln!("FAIL {error}"); app.exit(1); }
                }
            });
            Ok(())
        })
        .run(context).expect("isolated screenshot frontend fixture failed");
    std::process::exit(exit_code.load(std::sync::atomic::Ordering::SeqCst));
}
