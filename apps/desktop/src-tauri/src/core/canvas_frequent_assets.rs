//! Two independent canvas shortcuts: frequently referenced and explicitly pinned assets.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::core::library::{asset_from_row, Asset};
use crate::core::material_catalog::VISIBLE;
use crate::core::settings::SettingsState;
use crate::db::Database;
use crate::error::{AppError, AppResult};

// Canvas insertion normally records project membership too. Include visible node identities
// for older member-removal paths which left the canvas instance in place.
const PROJECT_ASSET_IDS: &str = "SELECT asset_id FROM project_assets WHERE project_id=:project
    UNION SELECT asset_id FROM canvas_nodes WHERE project_id=:project AND hidden_at IS NULL AND asset_id IS NOT NULL";

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CanvasFrequentAssetsPreferences {
    pub threshold: i64,
    pub pinned_asset_ids: Vec<String>,
    pub excluded_asset_ids: Vec<String>,
}

impl Default for CanvasFrequentAssetsPreferences {
    fn default() -> Self {
        Self {
            threshold: 10,
            pinned_asset_ids: Vec::new(),
            excluded_asset_ids: Vec::new(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct CanvasFrequentAssetsResult {
    pub threshold: i64,
    pub frequent: Vec<Asset>,
    pub pinned: Vec<Asset>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CanvasFrequentAssetsRow {
    Frequent,
    Pinned,
}

impl Database {
    pub fn canvas_frequent_assets(
        &self,
        preferences: &CanvasFrequentAssetsPreferences,
        project_id: Option<&str>,
    ) -> AppResult<CanvasFrequentAssetsResult> {
        let conn = self.conn.lock().unwrap();
        // Scope only filters the shared lists. Reference counts remain global.
        // JSON parameters avoid a variable-count limit for large manual collections.
        let mut stmt = conn.prepare(&format!(
            "SELECT a.*, {VISIBLE} AS frequent_visible FROM assets a
             WHERE (:project IS NULL OR a.id IN ({PROJECT_ASSET_IDS})) AND (
                ({VISIBLE} AND a.reference_count>:threshold AND a.id NOT IN (SELECT value FROM json_each(:excluded)))
                OR a.id IN (SELECT value FROM json_each(:pinned))
             ) ORDER BY a.reference_count DESC, a.created_at DESC, a.id ASC",
        ))?;
        let assets = stmt
            .query_map(
                rusqlite::named_params![
                    ":excluded": serde_json::to_string(&preferences.excluded_asset_ids)?,
                    ":pinned": serde_json::to_string(&preferences.pinned_asset_ids)?,
                    ":project": project_id,
                    ":threshold": preferences.threshold,
                ],
                |row| {
                    Ok((
                        asset_from_row(row)?,
                        row.get::<_, bool>("frequent_visible")?,
                    ))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let excluded: HashSet<&str> = preferences
            .excluded_asset_ids
            .iter()
            .map(String::as_str)
            .collect();
        let frequent = assets
            .iter()
            .filter(|(asset, visible)| {
                *visible
                    && asset.reference_count > preferences.threshold
                    && !excluded.contains(asset.id.as_str())
            })
            .map(|(asset, _)| asset.clone())
            .collect();
        let mut by_id: HashMap<String, Asset> = assets
            .into_iter()
            .map(|(asset, _)| (asset.id.clone(), asset))
            .collect();
        let pinned = preferences
            .pinned_asset_ids
            .iter()
            .filter_map(|id| by_id.remove(id))
            .collect();
        Ok(CanvasFrequentAssetsResult {
            threshold: preferences.threshold,
            frequent,
            pinned,
        })
    }
}

pub fn list(
    db: &Database,
    settings: &SettingsState,
    project_id: Option<&str>,
) -> AppResult<CanvasFrequentAssetsResult> {
    db.canvas_frequent_assets(&settings.get().canvas_frequent_assets, project_id)
}

pub fn set_threshold(
    db: &Database,
    settings: &SettingsState,
    threshold: i64,
    project_id: Option<&str>,
) -> AppResult<CanvasFrequentAssetsResult> {
    if !(0..=MAX_SAFE_INTEGER).contains(&threshold) {
        return Err(AppError::Other(
            "引用次数门槛须为 0 到 9007199254740991 之间的整数".into(),
        ));
    }
    settings.update_with(|current| current.canvas_frequent_assets.threshold = threshold)?;
    list(db, settings, project_id)
}

pub fn refresh(
    db: &Database,
    settings: &SettingsState,
    project_id: Option<&str>,
) -> AppResult<CanvasFrequentAssetsResult> {
    let scope = if let Some(project_id) = project_id {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare(PROJECT_ASSET_IDS)?;
        let ids = stmt
            .query_map(rusqlite::named_params![":project": project_id], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<HashSet<_>, _>>()?;
        Some(ids)
    } else {
        None
    };
    settings.update_with(|current| {
        current
            .canvas_frequent_assets
            .excluded_asset_ids
            .retain(|id| scope.as_ref().is_some_and(|ids| !ids.contains(id)));
    })?;
    list(db, settings, project_id)
}

pub fn pin(
    db: &Database,
    settings: &SettingsState,
    asset_ids: Vec<String>,
    project_id: Option<&str>,
) -> AppResult<CanvasFrequentAssetsResult> {
    // Explicit pins may include canvas-only assets. Never change library/file ownership.
    let requested: HashSet<&str> = asset_ids.iter().map(String::as_str).collect();
    let available: usize = db.conn.lock().unwrap().query_row(
        "SELECT COUNT(*) FROM assets WHERE id IN (SELECT value FROM json_each(?1))",
        [serde_json::to_string(&asset_ids)?],
        |row| row.get(0),
    )?;
    if available != requested.len() {
        return Err(AppError::Other("部分素材已不存在，请重新选择".into()));
    }
    settings.update_with(|current| {
        let pinned = &mut current.canvas_frequent_assets.pinned_asset_ids;
        let mut known: HashSet<String> = pinned.iter().cloned().collect();
        for id in asset_ids {
            if known.insert(id.clone()) {
                pinned.push(id);
            }
        }
    })?;
    list(db, settings, project_id)
}

pub fn remove(
    db: &Database,
    settings: &SettingsState,
    asset_id: &str,
    row: CanvasFrequentAssetsRow,
    project_id: Option<&str>,
) -> AppResult<CanvasFrequentAssetsResult> {
    settings.update_with(|current| {
        let preferences = &mut current.canvas_frequent_assets;
        match row {
            CanvasFrequentAssetsRow::Frequent => {
                if !preferences
                    .excluded_asset_ids
                    .iter()
                    .any(|id| id == asset_id)
                {
                    preferences.excluded_asset_ids.push(asset_id.to_string());
                }
            }
            CanvasFrequentAssetsRow::Pinned => {
                preferences.pinned_asset_ids.retain(|id| id != asset_id)
            }
        }
    })?;
    list(db, settings, project_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::creative_session_contract::{CreativeNodeKind, CreativeNodeRole};
    use crate::core::project_canvas::NewCanvasNode;
    use std::path::PathBuf;
    use std::sync::Arc;

    struct Fixture {
        db: Database,
        settings: SettingsState,
        path: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let db = Database::open_in_memory().unwrap();
            db.migrate().unwrap();
            let path =
                std::env::temp_dir().join(format!("bb-frequent-assets-{}", ulid::Ulid::new()));
            let settings = SettingsState::init(path.join("settings.json")).unwrap();
            Self { db, settings, path }
        }

        fn asset(&self, id: &str, count: i64, created: i64, hidden: bool) {
            self.db.conn.lock().unwrap().execute(
                "INSERT INTO assets(id,name,store_path,reference_count,created_at,library_hidden)
                 VALUES(?1,?1,?2,?3,?4,?5)",
                rusqlite::params![id, format!("/synthetic/{id}.png"), count, created, hidden],
            ).unwrap();
        }

        fn project(&self, id: &str) {
            self.db.create_project(id, id, id, id, "blank").unwrap();
            self.db.ensure_project_canvas(id).unwrap();
        }

        fn member(&self, project: &str, asset: &str) {
            self.db
                .conn
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO project_assets(project_id,asset_id,created_at) VALUES(?1,?2,1)",
                    rusqlite::params![project, asset],
                )
                .unwrap();
        }

        fn canvas_asset(&self, project: &str, asset: &str) {
            self.db
                .create_canvas_node(&NewCanvasNode {
                    id: format!("node-{project}-{asset}"),
                    project_id: project.into(),
                    thread_id: None,
                    kind: CreativeNodeKind::Asset,
                    asset_id: Some(asset.into()),
                    role: Some(CreativeNodeRole::Reference),
                    payload_json: serde_json::json!({"schema_version":1,"snapshot":{"name":asset}})
                        .to_string(),
                    x: 0.0,
                    y: 0.0,
                    width: 200.0,
                    height: 200.0,
                    z_index: 1,
                    position_locked: false,
                })
                .unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            if self.path.exists() {
                let path = self.path.canonicalize().unwrap();
                let temp_root = std::env::temp_dir().canonicalize().unwrap();
                assert!(path.starts_with(&temp_root) && path != temp_root);
                std::fs::remove_dir_all(path).unwrap();
            }
        }
    }

    fn ids(assets: &[Asset]) -> Vec<&str> {
        assets.iter().map(|asset| asset.id.as_str()).collect()
    }

    #[test]
    fn default_threshold_strictly_excludes_ten_even_when_manually_pinned() {
        let fixture = Fixture::new();
        fixture.asset("ten", 10, 1, false);
        fixture.asset("eleven", 11, 1, false);
        fixture.asset("manual", 0, 1, false);
        let result = pin(
            &fixture.db,
            &fixture.settings,
            vec!["ten".into(), "manual".into()],
            None,
        )
        .unwrap();
        assert_eq!(result.threshold, 10);
        assert_eq!(ids(&result.frequent), ["eleven"]);
        assert_eq!(ids(&result.pinned), ["ten", "manual"]);
    }

    #[test]
    fn old_json_without_threshold_keeps_pins_and_exclusions_with_default_ten() {
        let fixture = Fixture::new();
        fixture.asset("manual", 0, 1, false);
        fixture.asset("eleven", 11, 1, false);
        std::fs::create_dir_all(&fixture.path).unwrap();
        let path = fixture.path.join("settings.json");
        std::fs::write(&path, r#"{"canvas_frequent_assets":{"pinned_asset_ids":["manual"],"excluded_asset_ids":["eleven"]}}"#).unwrap();
        let restored = SettingsState::init(path).unwrap();
        let result = list(&fixture.db, &restored, None).unwrap();
        assert_eq!(result.threshold, 10);
        assert!(result.frequent.is_empty());
        assert_eq!(ids(&result.pinned), ["manual"]);
        assert_eq!(
            restored.get().canvas_frequent_assets.excluded_asset_ids,
            ["eleven"]
        );
        let old: crate::core::settings::AppSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(old.canvas_frequent_assets.threshold, 10);
    }

    #[test]
    fn threshold_is_shared_persists_and_does_not_reset_exclusions_or_manual_pins() {
        let fixture = Fixture::new();
        fixture.project("p1");
        fixture.project("p2");
        for (id, count) in [("ten", 10), ("eleven", 11), ("twenty", 20), ("manual", 0)] {
            fixture.asset(id, count, 1, false);
        }
        for id in ["ten", "twenty", "manual"] {
            fixture.member("p1", id);
        }
        fixture.member("p2", "eleven");
        pin(
            &fixture.db,
            &fixture.settings,
            vec!["manual".into(), "eleven".into()],
            None,
        )
        .unwrap();
        remove(
            &fixture.db,
            &fixture.settings,
            "twenty",
            CanvasFrequentAssetsRow::Frequent,
            None,
        )
        .unwrap();
        let stale = fixture.settings.get();
        let result = set_threshold(&fixture.db, &fixture.settings, 9, Some("p1")).unwrap();
        assert_eq!(result.threshold, 9);
        assert_eq!(ids(&result.frequent), ["ten"]);
        assert_eq!(ids(&result.pinned), ["manual"]);
        let second = list(&fixture.db, &fixture.settings, Some("p2")).unwrap();
        assert_eq!(second.threshold, 9);
        assert_eq!(ids(&second.frequent), ["eleven"]);
        let restored = SettingsState::init(fixture.path.join("settings.json")).unwrap();
        let result = list(&fixture.db, &restored, None).unwrap();
        assert_eq!(result.threshold, 9);
        assert_eq!(ids(&result.frequent), ["eleven", "ten"]);
        assert_eq!(ids(&result.pinned), ["manual", "eleven"]);
        assert_eq!(
            restored.get().canvas_frequent_assets.excluded_asset_ids,
            ["twenty"]
        );
        let result = set_threshold(&fixture.db, &fixture.settings, 11, None).unwrap();
        assert!(
            result.frequent.is_empty(),
            "custom threshold also uses strict greater-than; suppressed assets stay excluded"
        );
        assert_eq!(ids(&result.pinned), ["manual", "eleven"]);
        fixture.settings.update(stale).unwrap();
        assert_eq!(fixture.settings.get().canvas_frequent_assets.threshold, 11);
        assert_eq!(
            fixture
                .settings
                .get()
                .canvas_frequent_assets
                .excluded_asset_ids,
            ["twenty"]
        );
    }

    #[test]
    fn threshold_validates_safe_integer_bounds_and_failed_save_keeps_prior_value() {
        let fixture = Fixture::new();
        fixture.asset("zero", 0, 1, false);
        fixture.asset("one", 1, 1, false);
        let result = set_threshold(&fixture.db, &fixture.settings, 0, None).unwrap();
        assert_eq!(ids(&result.frequent), ["one"]);
        assert_eq!(
            set_threshold(&fixture.db, &fixture.settings, MAX_SAFE_INTEGER, None)
                .unwrap()
                .threshold,
            MAX_SAFE_INTEGER
        );
        assert!(set_threshold(&fixture.db, &fixture.settings, -1, None).is_err());
        assert!(set_threshold(&fixture.db, &fixture.settings, MAX_SAFE_INTEGER + 1, None).is_err());
        assert_eq!(
            fixture.settings.get().canvas_frequent_assets.threshold,
            MAX_SAFE_INTEGER
        );
        assert_eq!(
            SettingsState::init(fixture.path.join("settings.json"))
                .unwrap()
                .get()
                .canvas_frequent_assets
                .threshold,
            MAX_SAFE_INTEGER
        );
        let path = fixture.path.join("settings.json");
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(set_threshold(&fixture.db, &fixture.settings, 3, None).is_err());
        assert_eq!(
            fixture.settings.get().canvas_frequent_assets.threshold,
            MAX_SAFE_INTEGER
        );
    }

    #[test]
    fn whole_library_threshold_sort_hidden_and_no_page_limit() {
        let fixture = Fixture::new();
        fixture.asset("under", 10, 999, false);
        fixture.asset("hidden", 100, 999, true);
        fixture.asset("first", 18, 1, false);
        fixture.asset("tie-b", 11, 3, false);
        fixture.asset("tie-a", 11, 3, false);
        for index in 0..550 {
            fixture.asset(&format!("older-{index:03}"), 11, 2, false);
        }
        let result = list(&fixture.db, &fixture.settings, None).unwrap();
        assert_eq!(result.frequent.len(), 553);
        assert_eq!(ids(&result.frequent[..3]), ["first", "tie-a", "tie-b"]);
        assert!(result.pinned.is_empty());
    }

    #[test]
    fn suppression_survives_reopen_and_count_growth_until_explicit_refresh() {
        let fixture = Fixture::new();
        fixture.asset("frequent", 11, 1, false);
        remove(
            &fixture.db,
            &fixture.settings,
            "frequent",
            CanvasFrequentAssetsRow::Frequent,
            None,
        )
        .unwrap();
        fixture
            .db
            .bump_asset_reference_counts(&["/synthetic/frequent.png".into()])
            .unwrap();
        let settings = SettingsState::init(fixture.path.join("settings.json")).unwrap();
        assert!(list(&fixture.db, &settings, None)
            .unwrap()
            .frequent
            .is_empty());
        let result = refresh(&fixture.db, &settings, None).unwrap();
        assert_eq!(ids(&result.frequent), ["frequent"]);
        assert_eq!(result.frequent[0].reference_count, 12);
        assert_eq!(
            fixture
                .db
                .get_asset("frequent")
                .unwrap()
                .unwrap()
                .reference_count,
            12
        );
    }

    #[test]
    fn manual_row_order_dedup_and_removal_are_independent() {
        let fixture = Fixture::new();
        fixture.asset("frequent", 14, 1, false);
        fixture.asset("manual", 0, 2, false);
        let result = pin(
            &fixture.db,
            &fixture.settings,
            vec!["manual".into(), "frequent".into(), "manual".into()],
            None,
        )
        .unwrap();
        assert_eq!(ids(&result.pinned), ["manual", "frequent"]);
        remove(
            &fixture.db,
            &fixture.settings,
            "frequent",
            CanvasFrequentAssetsRow::Frequent,
            None,
        )
        .unwrap();
        let reopened = SettingsState::init(fixture.path.join("settings.json")).unwrap();
        let result = list(&fixture.db, &reopened, None).unwrap();
        assert_eq!(ids(&result.pinned), ["manual", "frequent"]);
        assert!(result.frequent.is_empty());
        let result = refresh(&fixture.db, &fixture.settings, None).unwrap();
        assert_eq!(ids(&result.pinned), ["manual", "frequent"]);
        let result = remove(
            &fixture.db,
            &fixture.settings,
            "frequent",
            CanvasFrequentAssetsRow::Pinned,
            None,
        )
        .unwrap();
        assert_eq!(ids(&result.pinned), ["manual"]);
        assert_eq!(ids(&result.frequent), ["frequent"]);
    }

    #[test]
    fn deleted_assets_are_omitted_and_invalid_pins_do_not_change_preferences() {
        let fixture = Fixture::new();
        fixture.asset("manual", 0, 1, false);
        fixture.asset("hidden", 9, 2, true);
        pin(&fixture.db, &fixture.settings, vec!["manual".into()], None).unwrap();
        assert!(pin(
            &fixture.db,
            &fixture.settings,
            vec!["hidden".into(), "missing".into()],
            None,
        )
        .is_err());
        assert_eq!(
            fixture
                .settings
                .get()
                .canvas_frequent_assets
                .pinned_asset_ids,
            ["manual"]
        );
        fixture
            .db
            .conn
            .lock()
            .unwrap()
            .execute("DELETE FROM assets WHERE id='manual'", [])
            .unwrap();
        assert!(list(&fixture.db, &fixture.settings, None)
            .unwrap()
            .pinned
            .is_empty());
    }

    #[test]
    fn global_catalog_external_references_are_available_without_changing_membership() {
        let fixture = Fixture::new();
        fixture.asset("external-frequent", 15, 1, true);
        fixture.asset("external-manual", 0, 2, true);
        fixture.asset("canvas-only", 12, 3, true);
        fixture.db.conn.lock().unwrap().execute_batch(
            "INSERT INTO external_assets(asset_id,fingerprint) VALUES
             ('external-frequent','frequent-fingerprint'),('external-manual','manual-fingerprint');",
        ).unwrap();
        assert_eq!(
            ids(&list(&fixture.db, &fixture.settings, None).unwrap().frequent),
            ["external-frequent"]
        );
        let result = pin(
            &fixture.db,
            &fixture.settings,
            vec!["external-manual".into(), "external-frequent".into()],
            None,
        )
        .unwrap();
        assert_eq!(
            ids(&result.pinned),
            ["external-manual", "external-frequent"]
        );
        assert!(
            fixture
                .db
                .get_asset("external-manual")
                .unwrap()
                .unwrap()
                .library_hidden
        );
        let library_member: bool = fixture
            .db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT library_member FROM external_assets WHERE asset_id='external-manual'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!library_member);
    }

    #[test]
    fn project_filter_applies_to_both_shared_lists_and_keeps_global_counts() {
        let fixture = Fixture::new();
        fixture.project("p1");
        fixture.project("p2");
        for (id, count, hidden) in [
            ("one", 16, false),
            ("two", 17, false),
            ("global", 19, false),
            ("shared", 11, false),
            ("hidden", 20, true),
            ("manual", 0, false),
        ] {
            fixture.asset(id, count, 1, hidden);
        }
        for id in ["one", "shared", "hidden", "manual"] {
            fixture.member("p1", id);
        }
        for id in ["two", "shared"] {
            fixture.member("p2", id);
        }
        pin(
            &fixture.db,
            &fixture.settings,
            ["two", "manual", "one", "hidden", "global"]
                .map(str::to_string)
                .to_vec(),
            None,
        )
        .unwrap();
        let before = serde_json::to_value(fixture.settings.get().canvas_frequent_assets).unwrap();
        let first = list(&fixture.db, &fixture.settings, Some("p1")).unwrap();
        assert_eq!(ids(&first.frequent), ["one", "shared"]);
        assert_eq!(first.frequent[0].reference_count, 16);
        assert_eq!(ids(&first.pinned), ["manual", "one", "hidden"]);
        let second = list(&fixture.db, &fixture.settings, Some("p2")).unwrap();
        assert_eq!(ids(&second.frequent), ["two", "shared"]);
        assert_eq!(ids(&second.pinned), ["two"]);
        let global = list(&fixture.db, &fixture.settings, None).unwrap();
        assert_eq!(ids(&global.frequent), ["global", "two", "one", "shared"]);
        assert_eq!(
            ids(&global.pinned),
            ["two", "manual", "one", "hidden", "global"]
        );
        assert_eq!(
            serde_json::to_value(fixture.settings.get().canvas_frequent_assets).unwrap(),
            before
        );
        assert!(
            fixture
                .db
                .get_asset("hidden")
                .unwrap()
                .unwrap()
                .library_hidden
        );
    }

    #[test]
    fn project_refresh_only_restores_suppressed_assets_in_its_scope() {
        let fixture = Fixture::new();
        fixture.project("p1");
        fixture.project("p2");
        for id in ["one", "two", "shared", "global"] {
            fixture.asset(id, 12, 1, false);
        }
        for id in ["one", "shared"] {
            fixture.member("p1", id);
        }
        for id in ["two", "shared"] {
            fixture.member("p2", id);
        }
        for id in ["one", "two", "shared", "global"] {
            remove(
                &fixture.db,
                &fixture.settings,
                id,
                CanvasFrequentAssetsRow::Frequent,
                None,
            )
            .unwrap();
        }
        pin(
            &fixture.db,
            &fixture.settings,
            vec!["two".into(), "one".into()],
            Some("p1"),
        )
        .unwrap();
        let result = refresh(&fixture.db, &fixture.settings, Some("p1")).unwrap();
        assert_eq!(ids(&result.frequent), ["one", "shared"]);
        assert_eq!(ids(&result.pinned), ["one"]);
        let reopened = SettingsState::init(fixture.path.join("settings.json")).unwrap();
        assert_eq!(
            reopened.get().canvas_frequent_assets.excluded_asset_ids,
            ["two", "global"]
        );
        assert_eq!(
            ids(&list(&fixture.db, &reopened, Some("p2")).unwrap().frequent),
            ["shared"]
        );
        let result = refresh(&fixture.db, &fixture.settings, None).unwrap();
        assert_eq!(ids(&result.frequent), ["global", "one", "shared", "two"]);
        assert_eq!(ids(&result.pinned), ["two", "one"]);
    }

    #[test]
    fn canvas_only_pins_and_visible_legacy_nodes_keep_ownership_and_scope() {
        let fixture = Fixture::new();
        fixture.project("p1");
        fixture.project("p2");
        fixture.asset("canvas-only", 12, 1, true);
        fixture.asset("legacy", 12, 1, false);
        fixture.canvas_asset("p1", "canvas-only");
        fixture.canvas_asset("p1", "legacy");
        // The legacy unlink IPC can remove membership while leaving a visible node.
        fixture
            .db
            .remove_assets_from_project("p1", &["legacy".into()])
            .unwrap();
        let member_count = || {
            fixture
                .db
                .conn
                .lock()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM project_assets WHERE project_id='p1'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap()
        };
        assert_eq!(member_count(), 1);
        let result = pin(
            &fixture.db,
            &fixture.settings,
            vec!["canvas-only".into(), "legacy".into()],
            Some("p1"),
        )
        .unwrap();
        assert_eq!(ids(&result.pinned), ["canvas-only", "legacy"]);
        assert_eq!(ids(&result.frequent), ["legacy"]);
        assert_eq!(member_count(), 1);
        let asset = fixture.db.get_asset("canvas-only").unwrap().unwrap();
        assert!(asset.library_hidden);
        assert_eq!(
            asset.store_path.as_deref(),
            Some("/synthetic/canvas-only.png")
        );
        assert_eq!(asset.reference_count, 12);
        assert!(list(&fixture.db, &fixture.settings, Some("p2"))
            .unwrap()
            .pinned
            .is_empty());
        remove(
            &fixture.db,
            &fixture.settings,
            "legacy",
            CanvasFrequentAssetsRow::Frequent,
            Some("p1"),
        )
        .unwrap();
        assert_eq!(
            ids(&refresh(&fixture.db, &fixture.settings, Some("p1"))
                .unwrap()
                .frequent),
            ["legacy"]
        );
        let result = remove(
            &fixture.db,
            &fixture.settings,
            "canvas-only",
            CanvasFrequentAssetsRow::Pinned,
            Some("p1"),
        )
        .unwrap();
        assert_eq!(ids(&result.pinned), ["legacy"]);
        assert!(fixture
            .db
            .get_canvas_node("node-p1-canvas-only")
            .unwrap()
            .unwrap()
            .hidden_at
            .is_none());
        assert!(
            fixture
                .db
                .get_asset("canvas-only")
                .unwrap()
                .unwrap()
                .library_hidden
        );
        assert_eq!(member_count(), 1);
    }

    #[test]
    fn concurrent_pin_and_exclude_updates_are_not_lost() {
        let fixture = Arc::new(Fixture::new());
        for index in 0..12 {
            fixture.asset(&format!("asset-{index}"), 12, 1, false);
        }
        let handles: Vec<_> = (0..12)
            .map(|index| {
                let fixture = fixture.clone();
                std::thread::spawn(move || {
                    let id = format!("asset-{index}");
                    pin(&fixture.db, &fixture.settings, vec![id.clone()], None).unwrap();
                    remove(
                        &fixture.db,
                        &fixture.settings,
                        &id,
                        CanvasFrequentAssetsRow::Frequent,
                        None,
                    )
                    .unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        let reopened = SettingsState::init(fixture.path.join("settings.json")).unwrap();
        let result = list(&fixture.db, &reopened, None).unwrap();
        assert_eq!(result.pinned.len(), 12);
        assert!(result.frequent.is_empty());
    }

    #[test]
    fn failed_save_does_not_change_memory_and_stale_settings_do_not_undo_suppression() {
        let fixture = Fixture::new();
        fixture.asset("frequent", 12, 1, false);
        let stale = fixture.settings.get();
        remove(
            &fixture.db,
            &fixture.settings,
            "frequent",
            CanvasFrequentAssetsRow::Frequent,
            None,
        )
        .unwrap();
        fixture.settings.update(stale).unwrap();
        assert!(list(&fixture.db, &fixture.settings, None)
            .unwrap()
            .frequent
            .is_empty());
        let path = fixture.path.join("settings.json");
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(refresh(&fixture.db, &fixture.settings, None).is_err());
        assert!(list(&fixture.db, &fixture.settings, None)
            .unwrap()
            .frequent
            .is_empty());
    }
}
