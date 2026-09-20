//! Hidden native window fixture; no production setup, accounts or user library.
#[cfg(target_os = "macos")]
fn main() {
    use std::ffi::{c_char, c_void, CStr};
    use tauri::Manager;
    #[link(name = "objc")]
    extern "C" {
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    unsafe fn flag(object: *mut c_void, selector: &CStr) -> bool {
        let send: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i8 =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        send(object, sel_registerName(selector.as_ptr())) != 0
    }
    assert!(cfg!(debug_assertions), "test fixture only");
    let mut context = tauri::generate_context!("tests/fixtures/explorer/tauri.conf.json");
    let mac: serde_json::Value = serde_json::from_str(include_str!("../tauri.macos.conf.json")).unwrap();
    let mut config: tauri::utils::config::WindowConfig =
        serde_json::from_value(mac["app"]["windows"][0].clone()).unwrap();
    config.visible = false;
    config.incognito = true;
    config.title = "Bowerbird isolated title bar test".into();
    context.config_mut().app.windows = vec![config];
    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            assert!(window.is_decorated()?);
            assert!(window.is_resizable()?);
            assert!(!window.is_visible()?);
            let native = window.ns_window()?;
            unsafe {
                let button: unsafe extern "C" fn(*mut c_void, *mut c_void, usize) -> *mut c_void =
                    std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
                for (kind, name) in [(0, "close"), (1, "minimize"), (2, "zoom/fullscreen")] {
                    let control = button(native, sel_registerName(c"standardWindowButton:".as_ptr()), kind);
                    assert!(!control.is_null(), "native {name} button missing");
                    assert!(!flag(control, c"isHidden"), "native {name} button hidden");
                    assert!(flag(control, c"isEnabled"), "native {name} button disabled");
                    println!("PASS native {name} button exists and is enabled");
                }
            }
            app.set_theme(Some(tauri::Theme::Dark));
            app.set_theme(Some(tauri::Theme::Light));
            println!("PASS macOS configuration creates decorated native window and accepts both themes");
            app.handle().exit(0);
            Ok(())
        })
        .run(context)
        .expect("native title bar fixture failed");
}
#[cfg(not(target_os = "macos"))]
fn main() { panic!("native title bar fixture requires macOS"); }
