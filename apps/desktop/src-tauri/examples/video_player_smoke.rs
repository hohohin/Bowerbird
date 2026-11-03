//! Isolated local React player acceptance: no production setup, plugins, credentials or library.
use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
    assert!(cfg!(debug_assertions));
    let root = std::path::PathBuf::from(
        std::env::var_os("BOWERBIRD_PLAYER_TEST_ROOT").expect("isolated test root required"),
    );
    assert!(root.is_absolute() && root.is_dir());
    let url: tauri::Url = std::env::var("BOWERBIRD_PLAYER_TEST_URL")
        .expect("local fixture URL required").parse().unwrap();
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    let origin = url.origin();
    let mut context = tauri::generate_context!("tests/fixtures/explorer/tauri.conf.json");
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .setup(move |app| {
            let output = root.join("result.json");
            let app_handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "isolated-video-player", WebviewUrl::External(url))
                .visible(false).focused(false).inner_size(1280.0, 900.0)
                .data_directory(root.join("profile"))
                .on_navigation(move |url| {
                    if url.scheme() == "bb-player-result" {
                        if let Some((_, payload)) = url.query_pairs().find(|(key, _)| key == "payload") {
                            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&payload) {
                                std::fs::write(&output, value.to_string()).unwrap();
                                app_handle.exit(if value["success"] == true { 0 } else { 1 });
                            }
                        }
                        return false;
                    }
                    url.as_str() == "about:blank" || url.origin() == origin
                })
                .build()?;
            let timeout = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(70));
                timeout.exit(2);
            });
            Ok(())
        })
        .run(context)
        .expect("isolated video player failed");
}
