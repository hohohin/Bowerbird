//! Isolated metadata transport check; no production setup, credentials or library.
use tauri::{WebviewUrl, WebviewWindowBuilder};
fn main() {
    assert!(cfg!(debug_assertions));
    let root = std::path::PathBuf::from(
        std::env::var_os("BOWERBIRD_REPLICATION_TEST_ROOT").expect("isolated test root required"),
    );
    let mut context = tauri::generate_context!("tests/fixtures/explorer/tauri.conf.json");
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();
            let output = root.join("result.json");
            let script = include_str!("../src/commands/video_replication/douyin_capture.js")
                .replace("__EXPECTED_ID__", "\"1234567890123456\"");
            WebviewWindowBuilder::new(
                app,
                "replication-douyin-test",
                WebviewUrl::External("http://127.0.0.1:1660".parse().unwrap()),
            )
            .visible(false)
            .focused(false)
            .data_directory(root.join("profile"))
            .initialization_script(&script)
            .on_navigation(move |url| {
                if url.scheme() == "bb-replication-capture" {
                    let data = url
                        .query_pairs()
                        .find(|(key, _)| key == "payload")
                        .unwrap()
                        .1
                        .into_owned();
                    std::fs::write(&output, data).unwrap();
                    handle.exit(0);
                    return false;
                }
                url.host_str() == Some("127.0.0.1")
            })
            .build()?;
            let timeout = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(20));
                timeout.exit(2);
            });
            Ok(())
        })
        .run(context)
        .expect("isolated replication browser failed");
}
