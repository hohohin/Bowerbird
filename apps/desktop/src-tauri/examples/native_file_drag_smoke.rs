//! Isolated native drag source. No production setup, library or credentials.
#[cfg(windows)]
#[path = "../src/external_drag.rs"]
mod native;
#[cfg(windows)]
pub use native::{Decision, Gesture};

#[cfg(windows)]
mod app {
    use std::{path::PathBuf, sync::Arc};
    use tauri::{State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
    struct Fixture {
        root: PathBuf,
        files: Vec<PathBuf>,
    }
    #[tauri::command]
    async fn test_drag(
        window: WebviewWindow,
        fixture: State<'_, Arc<Fixture>>,
        pickup: bool,
    ) -> Result<bool, String> {
        let paths = fixture.files.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                let result = super::native::windows::drag(&paths, pickup, || true)
                    .map(|(dropped, _)| dropped)
                    .map_err(|e| e.to_string());
                let _ = send.send(result);
            })
            .map_err(|e| e.to_string())?;
        receive.await.map_err(|e| e.to_string())?
    }
    #[tauri::command]
    fn test_report(fixture: State<'_, Arc<Fixture>>, event: serde_json::Value) {
        use std::io::Write;
        let mut log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(fixture.root.join("events.jsonl"))
            .unwrap();
        writeln!(log, "{event}").unwrap();
    }
    pub fn run() {
        assert!(cfg!(debug_assertions));
        let root = PathBuf::from(
            std::env::var_os("BOWERBIRD_DRAG_TEST_ROOT").expect("isolated fixture required"),
        );
        assert!(
            root.is_absolute()
                && root
                    .components()
                    .any(|p| p.as_os_str() == "native-file-drag")
        );
        std::fs::create_dir_all(&root).unwrap();
        let files = ["中文图.png", "audio.wav"]
            .iter()
            .map(|name| {
                let path = root.join(name);
                std::fs::write(&path, b"synthetic drag fixture only").unwrap();
                path.canonicalize().unwrap()
            })
            .collect();
        let fixture = Arc::new(Fixture {
            root: root.clone(),
            files,
        });
        let mut context = tauri::generate_context!("tests/fixtures/explorer/tauri.conf.json");
        context.config_mut().identifier = "com.bowerbird.native-drag-test".into();
        context.config_mut().app.windows.clear();
        context.config_mut().app.with_global_tauri = true;
        tauri::Builder::default()
            .manage(fixture)
            .invoke_handler(tauri::generate_handler![test_drag, test_report])
            .register_uri_scheme_protocol("drag-test", |_ctx, _request| {
                tauri::http::Response::builder()
                    .header("Content-Type", "text/html; charset=utf-8")
                    .body(
                        include_str!("../../../../spikes/native-file-drag/source.html")
                            .as_bytes()
                            .to_vec(),
                    )
                    .unwrap()
            })
            .setup(move |app| {
                WebviewWindowBuilder::new(
                    app,
                    "main",
                    WebviewUrl::CustomProtocol("drag-test://localhost".parse().unwrap()),
                )
                .title("Bowerbird Native Drag Test")
                .position(60., 100.)
                .inner_size(760., 600.)
                .data_directory(root.join("profile"))
                .disable_drag_drop_handler()
                .build()?;
                Ok(())
            })
            .run(context)
            .unwrap();
    }
}
#[cfg(windows)]
fn main() {
    app::run()
}
#[cfg(not(windows))]
fn main() {}
