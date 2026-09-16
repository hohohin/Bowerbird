//! Frozen, local-only starter project. Import media and the graph in one transaction.
use std::{collections::HashMap, path::Path};

use rusqlite::{params, types::Value as SqlValue};
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{
    core::paths::LibraryPaths,
    db::Database,
    error::{AppError, AppResult},
};

pub const MANIFEST: &str = "bowerbird-onboarding.json";
const BUNDLED: &str = include_str!("../../resources/onboarding-v0917/bowerbird-onboarding.json");

#[derive(Deserialize)]
struct Pack {
    version: String,
    files: HashMap<String, String>,
    tables: HashMap<String, Vec<Map<String, Value>>>,
}

fn verify(dir: &Path) -> AppResult<Pack> {
    // Only the exact manifest shipped with this application is executable input.
    // Never accept user-provided table names, columns, paths or canvas payloads.
    if std::fs::read(dir.join(MANIFEST))? != BUNDLED.as_bytes() {
        return Err(AppError::Other(
            "初始引导版本不匹配，请重新从入门引导释放文件夹".into(),
        ));
    }
    let pack: Pack = serde_json::from_str(BUNDLED)?;
    for (name, hash) in &pack.files {
        let bytes = std::fs::read(dir.join(name))?;
        if format!("{:x}", Sha256::digest(&bytes)) != *hash {
            return Err(AppError::Other(format!("初始引导文件损坏或被修改：{name}")));
        }
    }
    Ok(pack)
}

/// Stage a complete pack before replacing the old directory. Preserve the old
/// directory as a sibling backup, including any files the user added to it.
pub fn release(source: &Path, target: &Path) -> AppResult<()> {
    let pack = verify(source)?;
    if verify(target).is_ok() {
        return Ok(());
    }
    let parent = target
        .parent()
        .ok_or_else(|| AppError::Other("引导目录无效".into()))?;
    std::fs::create_dir_all(parent)?;
    let stage = parent.join(format!(".onboarding-{}", ulid::Ulid::new()));
    std::fs::create_dir(&stage)?;
    let result = (|| -> AppResult<()> {
        for name in pack
            .files
            .keys()
            .chain(std::iter::once(&MANIFEST.to_string()))
        {
            std::fs::copy(source.join(name), stage.join(name))?;
        }
        verify(&stage)?;
        let backup = parent.join(format!("初始引导-备份-{}", ulid::Ulid::new()));
        let had_target = target.exists();
        if had_target {
            std::fs::rename(target, &backup)?;
        }
        if let Err(error) = std::fs::rename(&stage, target) {
            if had_target {
                let _ = std::fs::rename(&backup, target);
            }
            return Err(error.into());
        }
        Ok(())
    })();
    // stage is a freshly generated directory owned only by this operation.
    if stage.exists() {
        let _ = std::fs::remove_dir_all(&stage);
    }
    result
}

fn remap(value: &mut Value, ids: &HashMap<String, String>) {
    match value {
        Value::String(text) => {
            if let Some(id) = ids.get(text) {
                *text = id.clone();
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| remap(item, ids)),
        Value::Object(items) => items.values_mut().for_each(|item| remap(item, ids)),
        _ => {}
    }
}

fn insert_row(
    tx: &rusqlite::Transaction<'_>,
    table: &str,
    row: &Map<String, Value>,
) -> AppResult<()> {
    // Identifiers originate exclusively from the compile-time bundled manifest.
    let columns = row.keys().cloned().collect::<Vec<_>>().join(",");
    let placeholders = vec!["?"; row.len()].join(",");
    let values = row
        .values()
        .map(|value| match value {
            Value::Null => Ok(SqlValue::Null),
            Value::String(text) => Ok(SqlValue::Text(text.clone())),
            Value::Number(number) => Ok(number
                .as_i64()
                .map(SqlValue::Integer)
                .unwrap_or_else(|| SqlValue::Real(number.as_f64().unwrap()))),
            _ => Err(AppError::Other("引导数据字段无效".into())),
        })
        .collect::<AppResult<Vec<_>>>()?;
    tx.execute(
        &format!("INSERT INTO {table} ({columns}) VALUES ({placeholders})"),
        rusqlite::params_from_iter(values),
    )?;
    Ok(())
}

/// Returns (member count, newly imported). Reimport never replays over user edits.
pub fn import(
    paths: &LibraryPaths,
    db: &Database,
    dir: &Path,
    project_id: &str,
) -> AppResult<(usize, bool)> {
    let mut pack = verify(dir)?;
    let count = pack.tables["assets"].len();
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction()?;
    let project_exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1 AND archived_at IS NULL)",
        [project_id],
        |r| r.get(0),
    )?;
    if !project_exists {
        return Err(AppError::Other(
            "请先新建创作，再导入包含画板的初始引导".into(),
        ));
    }
    let imported: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM onboarding_imports WHERE project_id=?1 AND pack_version=?2)",
        params![project_id, pack.version],
        |r| r.get(0),
    )?;
    if imported {
        return Ok((count, false));
    }
    let mut ids = HashMap::from([("pack:project".to_string(), project_id.to_string())]);
    for row in pack.tables.values().flatten() {
        if let Some(id) = row.get("id").and_then(Value::as_str) {
            ids.insert(id.to_string(), ulid::Ulid::new().to_string());
        }
    }
    for row in pack.tables.values_mut().flatten() {
        for (key, value) in row.iter_mut() {
            if key == "payload_json" || key == "draft_json" {
                let mut payload: Value = serde_json::from_str(value.as_str().unwrap())?;
                remap(&mut payload, &ids);
                *value = Value::String(serde_json::to_string(&payload)?);
            } else {
                remap(value, &ids);
            }
        }
    }
    let mut copied = Vec::new();
    let result = (|| -> AppResult<()> {
        for asset in pack.tables.get_mut("assets").unwrap() {
            let id = asset["id"].as_str().unwrap().to_string();
            let store = paths.asset_store_path(&id, asset["ext"].as_str().unwrap());
            let thumb = paths.thumb_path(&id);
            asset["origin_path"] = dir
                .join(asset["origin_path"].as_str().unwrap())
                .to_string_lossy()
                .to_string()
                .into();
            for (key, target) in [("store_path", store), ("thumb_path", thumb)] {
                if let Some(name) = asset[key].as_str() {
                    std::fs::create_dir_all(target.parent().unwrap())?;
                    copied.push(target.clone());
                    std::fs::copy(dir.join(name), &target)?;
                    asset[key] = target.to_string_lossy().to_string().into();
                }
            }
        }
        for table in [
            "project_canvases",
            "assets",
            "project_assets",
            "asset_colors",
            "analyses",
            "creative_threads",
            "canvas_nodes",
            "canvas_groups",
            "canvas_group_items",
            "canvas_edges",
            "canvas_views",
        ] {
            if table == "project_canvases" {
                // Keep an existing live composer draft; the pack's draft is empty.
                let exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM project_canvases WHERE project_id=?1)",
                    [project_id],
                    |r| r.get(0),
                )?;
                if exists {
                    continue;
                }
            }
            if table == "canvas_views" {
                tx.execute("DELETE FROM canvas_views WHERE project_id=?1", [project_id])?;
            }
            for row in &pack.tables[table] {
                insert_row(&tx, table, row)?;
            }
        }
        tx.execute("INSERT INTO onboarding_imports(project_id,pack_version,imported_at) VALUES (?1,?2,unixepoch())", params![project_id, pack.version])?;
        tx.commit()?;
        Ok(())
    })();
    if result.is_err() {
        for file in copied {
            let _ = std::fs::remove_file(file);
        }
    }
    result.map(|_| (count, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/onboarding-v0917")
    }

    fn setup() -> (LibraryPaths, Database) {
        let paths = LibraryPaths::init(
            std::env::temp_dir().join(format!("bb-pack-test-{}", ulid::Ulid::new())),
        )
        .unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        for id in ["lesson", "other"] {
            db.create_project(
                id,
                id,
                &format!("blank:{id}"),
                &format!("blank:{id}"),
                "blank",
            )
            .unwrap();
            db.ensure_project_canvas(id).unwrap();
        }
        (paths, db)
    }

    #[test]
    fn onboarding_pack_restores_exact_graph_and_reimport_preserves_edits() {
        let (paths, db) = setup();
        assert_eq!(
            import(&paths, &db, &source(), "lesson").unwrap(),
            (21, true)
        );
        let pack = verify(&source()).unwrap();
        let nodes = db.list_canvas_nodes("lesson").unwrap();
        assert_eq!(nodes.len(), 103);
        assert_eq!(nodes.iter().filter(|n| n.hidden_at.is_none()).count(), 39);
        for expected in &pack.tables["canvas_nodes"] {
            // Positions and complete payloads survive; identifiers are freshly scoped.
            let node = nodes
                .iter()
                .find(|n| {
                    n.x == expected["x"].as_f64().unwrap()
                        && n.y == expected["y"].as_f64().unwrap()
                        && n.created_at == expected["created_at"].as_i64().unwrap()
                })
                .unwrap();
            assert_eq!(node.width, expected["width"].as_f64().unwrap());
            assert_eq!(node.height, expected["height"].as_f64().unwrap());
            assert_eq!(node.z_index, expected["z_index"].as_i64().unwrap());
            assert_eq!(node.hidden_at, expected["hidden_at"].as_i64());
            let payload: Value = serde_json::from_str(&node.payload_json).unwrap();
            if let Some(members) = payload["member_ids"].as_array() {
                for member in members {
                    assert!(nodes.iter().any(|n| Some(n.id.as_str()) == member.as_str()));
                }
            }
            assert!(payload["job_id"].is_null());
            assert!(payload["provider_session_id"].is_null());
        }
        let edges = db.list_canvas_edges("lesson").unwrap();
        assert_eq!(edges.len(), 81);
        for edge in edges {
            assert!(nodes.iter().any(|n| n.id == edge.from_node_id));
            assert!(nodes.iter().any(|n| n.id == edge.to_node_id));
        }
        let assets = db.get_assets_by_ids(&nodes.iter().filter_map(|node| node.asset_id.clone()).collect::<Vec<_>>()).unwrap();
        assert_eq!(assets.len(), 21);
        assert_eq!(assets.iter().filter(|asset| asset.library_hidden).count(), 3);
        assert_eq!(db.list_assets(None, Some("lesson"), 100, 0).unwrap().len(), 18);
        assert!(assets.iter().all(|asset| {
            let origin = asset.origin_path.as_deref().unwrap_or("");
            !origin.contains("preset-") && !origin.ends_with("asset-024.png") && !origin.ends_with("asset-027.png")
        }));
        for asset in &assets {
            let filename = Path::new(asset.origin_path.as_ref().unwrap())
                .file_name()
                .unwrap()
                .to_str()
                .unwrap();
            assert_eq!(
                format!(
                    "{:x}",
                    Sha256::digest(std::fs::read(asset.store_path.as_ref().unwrap()).unwrap())
                ),
                pack.files[filename]
            );
            assert!(asset.generation_session_id.is_none());
        }
        {
            let conn = db.conn.lock().unwrap();
            let view: (f64, f64, f64) = conn
                .query_row(
                    "SELECT pan_x,pan_y,zoom FROM canvas_views WHERE project_id='lesson'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap();
            let original = &pack.tables["canvas_views"][0];
            assert_eq!(
                view,
                (
                    original["pan_x"].as_f64().unwrap(),
                    original["pan_y"].as_f64().unwrap(),
                    original["zoom"].as_f64().unwrap()
                )
            );
            let captions: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM analyses WHERE kind='caption'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(captions, 2);
            conn.execute("UPDATE canvas_nodes SET x=9999 WHERE id=?1", [&nodes[0].id])
                .unwrap();
            conn.execute(
                "UPDATE canvas_views SET zoom=1.1 WHERE project_id='lesson'",
                [],
            )
            .unwrap();
            conn.execute("DELETE FROM canvas_nodes WHERE id=?1", [&nodes[1].id])
                .unwrap();
        }
        assert_eq!(
            import(&paths, &db, &source(), "lesson").unwrap(),
            (21, false)
        );
        assert_eq!(db.get_canvas_node(&nodes[0].id).unwrap().unwrap().x, 9999.0);
        assert!(db.get_canvas_node(&nodes[1].id).unwrap().is_none());
        assert_eq!(import(&paths, &db, &source(), "other").unwrap(), (21, true));
        assert!(db
            .list_assets(None, Some("other"), 100, 0)
            .unwrap()
            .iter()
            .all(|a| !assets.iter().any(|original| original.id == a.id)));
        std::fs::remove_dir_all(paths.root).unwrap();
    }

    #[test]
    fn onboarding_pack_release_backs_up_old_folder_and_rejects_corruption() {
        let (paths, db) = setup();
        let target = paths.root.join("初始引导");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("my-notes.txt"), "keep me").unwrap();
        release(&source(), &target).unwrap();
        assert!(!target.join("my-notes.txt").exists());
        let backups = || {
            std::fs::read_dir(&paths.root)
                .unwrap()
                .flatten()
                .filter(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .starts_with("初始引导-备份-")
                })
                .map(|e| e.path())
                .collect::<Vec<_>>()
        };
        assert_eq!(backups().len(), 1);
        assert_eq!(
            std::fs::read_to_string(backups()[0].join("my-notes.txt")).unwrap(),
            "keep me"
        );
        release(&source(), &target).unwrap();
        assert_eq!(backups().len(), 1);
        std::fs::write(target.join("sample-dimensions.webp"), "corrupt").unwrap();
        assert!(import(&paths, &db, &target, "lesson").is_err());
        assert!(db
            .list_assets(None, Some("lesson"), 100, 0)
            .unwrap()
            .is_empty());
        assert!(db.list_canvas_nodes("lesson").unwrap().is_empty());
        std::fs::remove_dir_all(paths.root).unwrap();
    }

    #[test]
    fn onboarding_pack_database_failure_rolls_back_media_and_graph() {
        let (paths, db) = setup();
        db.conn.lock().unwrap().execute_batch("CREATE TRIGGER fail_import BEFORE INSERT ON canvas_edges BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
        assert!(import(&paths, &db, &source(), "lesson").is_err());
        assert!(db
            .list_assets(None, Some("lesson"), 100, 0)
            .unwrap()
            .is_empty());
        assert!(db.list_canvas_nodes("lesson").unwrap().is_empty());
        fn assert_no_files(dir: &Path) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                assert!(entry.path().is_dir());
                assert_no_files(&entry.path());
            }
        }
        assert_no_files(&paths.images);
        assert_no_files(&paths.thumbnails);
        db.conn
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER fail_import")
            .unwrap();
        assert_eq!(
            import(&paths, &db, &source(), "lesson").unwrap(),
            (21, true)
        );
        std::fs::remove_dir_all(paths.root).unwrap();
    }
}
