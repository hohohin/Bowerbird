use super::manual_classification_use_jev;
use crate::core::settings::SettingsState;
use tauri::{test, Manager};

#[tokio::test]
async fn manual_classification_persists_cloud_only_with_explicit_opt_in() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(&path, r#"{"hide_project_assets":true}"#).unwrap();
    let app = test::mock_builder()
        .manage(SettingsState::init(path.clone()).unwrap())
        .build(test::mock_context(test::noop_assets()))
        .unwrap();

    assert!(!manual_classification_use_jev(app.handle(), None)
        .await
        .unwrap());
    assert!(manual_classification_use_jev(app.handle(), Some(true))
        .await
        .unwrap());
    assert!(manual_classification_use_jev(app.handle(), None)
        .await
        .unwrap());
    let reopened = SettingsState::init(path).unwrap().get();
    assert!(reopened.jev_image_classification_enabled);
    assert!(reopened.hide_project_assets);
}

#[tokio::test]
async fn manual_classification_reports_failed_cloud_settings_save() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let app = test::mock_builder()
        .manage(SettingsState::init(path.clone()).unwrap())
        .build(test::mock_context(test::noop_assets()))
        .unwrap();
    std::fs::create_dir(&path).unwrap();

    let error = manual_classification_use_jev(app.handle(), Some(true))
        .await
        .unwrap_err();
    assert!(error.starts_with("CLASSIFICATION_START_SETTINGS: io:"), "{error}");
    assert!(!app.state::<SettingsState>().get().jev_image_classification_enabled);
}
