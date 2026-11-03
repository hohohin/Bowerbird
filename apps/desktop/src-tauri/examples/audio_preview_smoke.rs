//! Isolated audio/asset-protocol acceptance; never starts production setup or a library.
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

fn main() {
    assert!(cfg!(debug_assertions), "the smoke harness is debug-only");
    let root = std::path::PathBuf::from(
        std::env::var_os("BOWERBIRD_AUDIO_TEST_ROOT").expect("isolated test root required"),
    );
    let fixtures = std::path::PathBuf::from(
        std::env::var_os("BOWERBIRD_AUDIO_TEST_FIXTURES").expect("synthetic fixture root required"),
    );
    assert!(root.is_absolute() && root.is_dir());
    assert!(fixtures.is_absolute() && fixtures.is_dir());
    assert!(root.components().any(|part| part.as_os_str() == "audio-preview-native"));
    let sources = std::env::var("BOWERBIRD_AUDIO_TEST_SOURCES").unwrap_or_else(|_| "{}".into());
    let paths: std::collections::HashMap<String, String> = serde_json::from_str(&sources).unwrap();
    let fixture_path = fixtures.canonicalize().unwrap();
    for path in paths.values() {
        assert!(std::path::Path::new(path).canonicalize().unwrap().starts_with(&fixture_path));
    }
    let initialization = format!("window.__BOWERBIRD_AUDIO_NATIVE_SOURCES__ = {};", serde_json::to_string(&paths).unwrap());
    let url: tauri::Url = std::env::var("BOWERBIRD_AUDIO_TEST_URL")
        .expect("local fixture URL required")
        .parse()
        .unwrap();
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    let origin = url.origin();
    let mut context = tauri::generate_context!("tests/fixtures/explorer/tauri.conf.json");
    context.config_mut().identifier = "com.bowerbird.audio-preview-test".into();
    context.config_mut().app.windows.clear();
    context.config_mut().app.security.asset_protocol.enable = true;
    tauri::Builder::default()
        .setup(move |app| {
            app.asset_protocol_scope().allow_directory(&fixtures, true)?;
            let app_handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "isolated-audio-preview", WebviewUrl::External(url))
                .visible(false)
                .focused(false)
                .inner_size(1000.0, 800.0)
                .data_directory(root.join("profile"))
                .initialization_script(initialization)
                .on_navigation(move |url| {
                    if url.scheme() == "bb-audio-exit" {
                        app_handle.exit(0);
                        return false;
                    }
                    url.as_str() == "about:blank" || url.origin() == origin
                })
                .build()?;
            let timeout = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(120));
                timeout.exit(2);
            });
            Ok(())
        })
        .run(context)
        .expect("isolated audio preview failed");
}
