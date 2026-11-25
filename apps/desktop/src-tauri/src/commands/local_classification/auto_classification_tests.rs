use super::{local_classification_enable, local_classification_status};
use crate::commands::settings;
use crate::core::local_classification::LocalClassifier;
use crate::core::settings::{AppSettings, AppTheme, SettingsState};
use crate::db::Database;
use serde_json::{json, Value};
use std::{path::Path, sync::Arc, time::Duration};
use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test::{self, MockRuntime},
    webview::InvokeRequest,
    WebviewWindow, WebviewWindowBuilder,
};

fn backend(
    root: &Path,
) -> (
    tauri::App<MockRuntime>,
    WebviewWindow<MockRuntime>,
    Arc<Database>,
) {
    let settings = SettingsState::init(root.join("settings.json")).unwrap();
    let db = Arc::new(Database::open(&root.join("library.db")).unwrap());
    db.migrate().unwrap();
    let app = test::mock_builder()
        .manage(settings)
        .manage(db.clone())
        .manage(Arc::new(LocalClassifier::new(root.to_path_buf())))
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            local_classification_enable,
            local_classification_status
        ])
        .build(test::mock_context(test::noop_assets()))
        .unwrap();
    let window = WebviewWindowBuilder::new(&app, "classification", Default::default())
        .build()
        .unwrap();
    (app, window, db)
}

fn invoke(window: &WebviewWindow<MockRuntime>, command: &str, args: Value) -> Result<Value, Value> {
    test::get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: test::INVOKE_KEY.into(),
        },
    )
    .map(|response| response.deserialize().unwrap())
}

fn enable(window: &WebviewWindow<MockRuntime>, enabled: bool) -> Result<Value, Value> {
    invoke(
        window,
        "local_classification_enable",
        json!({ "enabled": enabled }),
    )
}

fn settings(window: &WebviewWindow<MockRuntime>) -> AppSettings {
    serde_json::from_value(invoke(window, "get_settings", json!({})).unwrap()).unwrap()
}

fn assert_disabled(window: &WebviewWindow<MockRuntime>, db: &Database) {
    assert!(!db.local_enabled().unwrap());
    assert!(!settings(window).jev_image_classification_enabled);
}

#[test]
fn first_enable_and_toggle_survive_reopening_through_tauri_ipc() {
    use tauri::Manager;
    for existing in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        if existing {
            std::fs::write(
                dir.path().join("settings.json"),
                r#"{"theme":"dark","hide_project_assets":true}"#,
            )
            .unwrap();
        }
        {
            let (app, window, db) = backend(dir.path());
            let stale = settings(&window);
            assert_disabled(&window, &db);
            assert_eq!(enable(&window, true), Ok(json!(true)));
            app.state::<SettingsState>().update(stale).unwrap();
            assert!(settings(&window).jev_image_classification_enabled);
            assert_eq!(settings(&window).hide_project_assets, existing);
            assert_eq!(
                settings(&window).theme,
                if existing {
                    AppTheme::Dark
                } else {
                    AppTheme::Light
                }
            );
            assert_eq!(
                invoke(&window, "local_classification_status", json!({})).unwrap()["enabled"],
                true
            );

            db.conn.lock().unwrap().execute(
                "INSERT INTO assets(id,name,ext,thumb_path) VALUES('new','new','png','new.png')", [],
            ).unwrap();
            assert_eq!(enable(&window, true), Ok(json!(true)));
            let pending = || {
                db.conn
                    .lock()
                    .unwrap()
                    .query_row(
                        "SELECT COUNT(*) FROM local_auto_classification_pending",
                        [],
                        |row| row.get::<_, usize>(0),
                    )
                    .unwrap()
            };
            assert_eq!(pending(), 1, "same-value save preserves the queue");
            assert_eq!(enable(&window, false), Ok(json!(false)));
            assert_eq!(pending(), 0);
            assert!(settings(&window).jev_image_classification_enabled);
            assert_eq!(enable(&window, true), Ok(json!(true)));
            assert_eq!(
                pending(),
                0,
                "re-enabling does not backfill previous assets"
            );
        }
        let (_app, window, db) = backend(dir.path());
        assert!(db.local_enabled().unwrap());
        assert!(settings(&window).jev_image_classification_enabled);
    }
}

#[test]
fn failures_identify_the_store_and_keep_the_switch_off() {
    let dir = tempfile::tempdir().unwrap();
    let (_app, window, db) = backend(dir.path());
    let settings_path = dir.path().join("settings.json");
    std::fs::create_dir(&settings_path).unwrap();
    let error = enable(&window, true).unwrap_err();
    assert!(
        error
            .as_str()
            .unwrap()
            .starts_with("CLASSIFICATION_AUTO_SETTINGS:"),
        "{error}"
    );
    assert_disabled(&window, &db);
    std::fs::remove_dir(&settings_path).unwrap();

    db.conn
        .lock()
        .unwrap()
        .busy_timeout(Duration::ZERO)
        .unwrap();
    let competing = rusqlite::Connection::open(dir.path().join("library.db")).unwrap();
    competing.execute_batch("BEGIN IMMEDIATE").unwrap();
    let error = enable(&window, true).unwrap_err();
    assert!(
        error
            .as_str()
            .unwrap()
            .starts_with("CLASSIFICATION_AUTO_DATABASE:"),
        "{error}"
    );
    assert!(
        error.as_str().unwrap().contains("database is locked"),
        "{error}"
    );
    assert_disabled(&window, &db);
    assert!(!settings_path.exists());
    competing.execute_batch("ROLLBACK").unwrap();

    db.conn.lock().unwrap().commit_hook(Some(|| true));
    assert!(enable(&window, true)
        .unwrap_err()
        .as_str()
        .unwrap()
        .starts_with("CLASSIFICATION_AUTO_DATABASE:"));
    assert_disabled(&window, &db);
    assert!(
        !SettingsState::init(settings_path)
            .unwrap()
            .get()
            .jev_image_classification_enabled
    );
    db.conn.lock().unwrap().commit_hook(None::<fn() -> bool>);
    assert_eq!(enable(&window, true), Ok(json!(true)));
}

#[cfg(windows)]
#[test]
fn a_brief_windows_sharing_violation_retries_the_settings_replace() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(&path, "{}").unwrap();
    let (_app, window, db) = backend(dir.path());
    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0x0000_0001)
        .open(&path)
        .unwrap();
    let replacement = dir.path().join("test-replacement.json");
    std::fs::write(&replacement, "{}").unwrap();
    let error = std::fs::rename(&replacement, &path).unwrap_err();
    assert!(matches!(error.raw_os_error(), Some(5 | 32 | 33)), "{error}");
    let unlock = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(40));
        drop(held);
    });
    let result = enable(&window, true);
    unlock.join().unwrap();
    assert_eq!(result, Ok(json!(true)));
    assert!(db.local_enabled().unwrap());
    assert!(settings(&window).jev_image_classification_enabled);
}

#[cfg(windows)]
mod webview2 {
    use super::*;
    use crate::commands::local_classification;
    use crate::core::semantic_search::runtime::SemanticSearch;
    use std::os::windows::fs::OpenOptionsExt;
    use std::sync::mpsc::{self, Sender};
    use tauri::{AppHandle, State, WebviewUrl};

    #[tauri::command]
    async fn legacy_classification_enable(
        db: State<'_, Arc<Database>>,
        enabled: bool,
    ) -> Result<(), String> {
        db.set_local_enabled(enabled)
            .map_err(|error| error.to_string())
    }

    #[tauri::command]
    fn finish_native_check(app: AppHandle, output: State<'_, Sender<Value>>, report: Value) {
        output.send(report).unwrap();
        app.exit(0);
    }

    #[test]
    #[ignore = "requires a Windows interactive session and WebView2"]
    fn native_webview2_toggle_uses_real_ipc() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let scenario = std::env::var("BOWERBIRD_CLASSIFICATION_NATIVE_SCENARIO")
            .unwrap_or_else(|_| "fixed".into());
        let settings_path = root.join("settings.json");
        let db_path = root.join("library.db");
        if scenario == "legacy-settings-lock" {
            std::fs::write(&settings_path, "{}").unwrap();
        } else if scenario == "legacy-database-lock" {
            std::fs::write(
                &settings_path,
                r#"{"jev_image_classification_enabled":true}"#,
            )
            .unwrap();
        }
        let settings = SettingsState::init(settings_path.clone()).unwrap();
        let db = Arc::new(Database::open(&db_path).unwrap());
        db.migrate().unwrap();
        let _settings_lock = (scenario == "legacy-settings-lock").then(|| {
            std::fs::OpenOptions::new()
                .read(true)
                .share_mode(1)
                .open(&settings_path)
                .unwrap()
        });
        let _database_lock = (scenario == "legacy-database-lock").then(|| {
            db.conn
                .lock()
                .unwrap()
                .busy_timeout(Duration::ZERO)
                .unwrap();
            let conn = rusqlite::Connection::open(db_path).unwrap();
            conn.execute_batch("BEGIN IMMEDIATE").unwrap();
            conn
        });
        let (sender, receiver) = mpsc::channel::<Value>();
        let mut context = test::mock_context(test::noop_assets());
        context.config_mut().identifier = "com.bowerbird.classification-test".into();
        let profile = root.join("profile");
        let scenario_script = format!("window.classificationScenario = {};", json!(scenario));
        let app = tauri::Builder::default()
            .any_thread()
            .manage(settings)
            .manage(db.clone())
            .manage(Arc::new(LocalClassifier::new(root.to_path_buf())))
            .manage(Arc::new(SemanticSearch::new(root)))
            .manage(sender)
            .register_uri_scheme_protocol("classification-test", |_, _| {
                tauri::http::Response::builder().header("Content-Type", "text/html")
                    .body(b"<!doctype html><title>Isolated classification check</title>".to_vec()).unwrap()
            })
            .invoke_handler(tauri::generate_handler![
                settings::get_settings, settings::update_settings, legacy_classification_enable,
                local_classification_enable, local_classification_status, local_classification::local_classification_labels,
                finish_native_check,
            ])
            .setup(move |app| {
                WebviewWindowBuilder::new(app, "classification", WebviewUrl::CustomProtocol("classification-test://localhost".parse()?))
                    .visible(false)
                    .data_directory(profile)
                    .initialization_script(scenario_script)
                    .initialization_script(r#"
                        window.addEventListener('DOMContentLoaded', async () => {
                            const invoke = window.__TAURI_INTERNALS__.invoke;
                            let step;
                            const call = (name, args) => { step = name; return invoke(name, args); };
                            try {
                                const initial = await call('get_settings');
                                if (window.classificationScenario === 'fixed') {
                                    const on = await call('local_classification_enable', { enabled: true });
                                    const off = await call('local_classification_enable', { enabled: false });
                                    const again = await call('local_classification_enable', { enabled: true });
                                    await invoke('finish_native_check', { report: { initial: initial.jev_image_classification_enabled, on, off, again } });
                                } else {
                                    if (!initial.jev_image_classification_enabled) {
                                        await call('update_settings', { settings: { ...initial, jev_image_classification_enabled: true }, applyScreenshotShortcuts: false });
                                    }
                                    await call('legacy_classification_enable', { enabled: true });
                                    step = 'refresh';
                                    const [status] = await Promise.all([invoke('local_classification_status'), invoke('local_classification_labels')]);
                                    await invoke('finish_native_check', { report: { initial: initial.jev_image_classification_enabled, legacy: status.enabled } });
                                }
                            } catch (error) {
                                await invoke('finish_native_check', { report: { step, error: String(error) } });
                            }
                        });
                    "#)
                    .build()?;
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(20));
                    handle.exit(2);
                });
                Ok(())
            })
            .build(context).unwrap();
        assert_eq!(
            app.run_return(|_, _| {}),
            0,
            "classification WebView did not return a result"
        );
        let report = receiver.try_recv().unwrap();
        println!("{scenario}: {report}");
        match scenario.as_str() {
            "fixed" => assert_eq!(
                report,
                json!({"initial": false, "on": true, "off": false, "again": true})
            ),
            "legacy-clean" => assert_eq!(report, json!({"initial": false, "legacy": true})),
            "legacy-settings-lock" => {
                assert_eq!(report["step"], "update_settings");
                let error = report["error"].as_str().unwrap();
                assert!(
                    [5, 32, 33]
                        .iter()
                        .any(|code| error.contains(&format!("(os error {code})"))),
                    "{report}"
                );
            }
            "legacy-database-lock" => {
                assert_eq!(report["step"], "legacy_classification_enable");
                assert_eq!(report["error"], "db: database is locked");
            }
            _ => panic!("unexpected scenario: {scenario}"),
        }
        let succeeded = matches!(scenario.as_str(), "fixed" | "legacy-clean");
        assert_eq!(db.local_enabled().unwrap(), succeeded);
        assert_eq!(
            SettingsState::init(settings_path)
                .unwrap()
                .get()
                .jev_image_classification_enabled,
            succeeded || scenario == "legacy-database-lock"
        );
    }
}
