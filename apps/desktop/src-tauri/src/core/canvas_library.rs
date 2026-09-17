//! Library visibility is independent of canvas/history identity and physical file ownership.
use crate::db::Database;
use crate::error::{AppError, AppResult};
use rusqlite::{params, OptionalExtension};

impl Database {
    pub fn set_canvas_asset_library_visibility(
        &self,
        project_id: &str,
        asset_id: &str,
        visible: bool,
    ) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let image: Option<(Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT ext,store_path FROM assets WHERE id=?1",
                [asset_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (ext, path) = image.ok_or_else(|| AppError::NotFound(format!("asset {asset_id}")))?;
        if !matches!(
            ext.as_deref().unwrap_or("").to_ascii_lowercase().as_str(),
            "png"
                | "jpg"
                | "jpeg"
                | "webp"
                | "gif"
                | "avif"
                | "svg"
                | "bmp"
                | "ico"
                | "tif"
                | "tiff"
        ) || path.as_deref().unwrap_or("").is_empty()
        {
            return Err(AppError::Other("仅支持已保存的图片".into()));
        }
        let on_canvas: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM canvas_nodes n JOIN project_assets pa
             ON pa.project_id=n.project_id AND pa.asset_id=n.asset_id
             WHERE n.project_id=?1 AND n.asset_id=?2 AND n.kind='asset' AND n.hidden_at IS NULL)",
            params![project_id, asset_id],
            |row| row.get(0),
        )?;
        if !on_canvas {
            return Err(AppError::Other(
                "请先将图片放到当前画布，再调整素材库归属".into(),
            ));
        }
        tx.execute(
            "UPDATE assets SET library_hidden=?2 WHERE id=?1",
            params![asset_id, !visible],
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::creative_session_contract::{CreativeNodeKind, CreativeNodeRole};
    use crate::core::library_view::LibraryViewFilter;
    use crate::core::project_canvas::NewCanvasNode;

    fn fixture(db: &Database, path: &str) {
        db.migrate().unwrap();
        db.conn.lock().unwrap().execute(
            "INSERT INTO assets(id,name,ext,store_path,generation_session_id) VALUES ('image','helper screenshot','png',?1,'generation')", [path],
        ).unwrap();
        for project in ["p", "q"] {
            db.create_project(project, project, project, project, "blank")
                .unwrap();
            db.ensure_project_canvas(project).unwrap();
            db.create_canvas_node(&NewCanvasNode {
                id: format!("node-{project}"),
                project_id: project.into(),
                thread_id: None,
                kind: CreativeNodeKind::Asset,
                asset_id: Some("image".into()),
                role: Some(CreativeNodeRole::Reference),
                payload_json: r#"{"schema_version":1,"snapshot":{"name":"helper screenshot"}}"#
                    .into(),
                x: 120.0,
                y: 80.0,
                width: 190.0,
                height: 180.0,
                z_index: 2,
                position_locked: false,
            })
            .unwrap();
        }
    }

    #[test]
    fn canvas_only_assets_leave_all_browse_queries_but_keep_identity_and_layout() {
        let db = Database::open_in_memory().unwrap();
        fixture(&db, "/synthetic/helper.png");
        db.conn.lock().unwrap().execute_batch(
            "INSERT INTO folders(id,name,kind) VALUES ('collection','collection','collection');
             INSERT INTO asset_collections(asset_id,folder_id,created_at) VALUES ('image','collection',1);
             INSERT INTO tags(id,name,source) VALUES ('tag','helper','manual');
             INSERT INTO asset_tags(asset_id,tag_id) VALUES ('image','tag');
             INSERT INTO asset_colors(asset_id,bucket) VALUES ('image','blue');
             INSERT INTO analyses(id,asset_id,kind,payload) VALUES ('caption','image','caption','{\"text\":\"helper\"}');"
        ).unwrap();
        let before_p = db.project_canvas_snapshot("p").unwrap();
        let before_q = db.project_canvas_snapshot("q").unwrap();
        db.set_canvas_asset_library_visibility("p", "image", false)
            .unwrap();
        db.set_canvas_asset_library_visibility("p", "image", false)
            .unwrap();
        for scope in [None, Some("p"), Some("q")] {
            assert!(db.list_assets(None, scope, 100, 0).unwrap().is_empty());
            assert_eq!(db.count_assets(scope).unwrap(), 0);
            assert!(db.search_assets("helper", scope, 100).unwrap().is_empty());
            for smart in [
                "tag:helper",
                "ext:png",
                "source:generated",
                "source:!generated",
            ] {
                assert!(db
                    .list_assets_smart(smart, scope, 100, 0)
                    .unwrap()
                    .is_empty());
            }
            assert!(db
                .list_assets_by_collection("collection", scope, 100, 0)
                .unwrap()
                .is_empty());
            assert!(db
                .list_assets_by_color(None, scope, "blue", 100, 0)
                .unwrap()
                .is_empty());
            assert!(db.palette_overview(scope).unwrap().is_empty());
            assert!(db.list_tags_with_count("manual", scope).unwrap().is_empty());
            assert_eq!(
                db.list_prompted_assets(scope).unwrap().len(),
                1,
                "canvas dimension data stays available"
            );
            assert!(db.list_generation_group("image", scope).unwrap().is_empty());
        }
        assert!(db
            .library_view(LibraryViewFilter::default())
            .unwrap()
            .assets
            .is_empty());
        assert!(db
            .list_projects()
            .unwrap()
            .iter()
            .all(|p| p.asset_count == 0));
        assert_eq!(db.get_project("p").unwrap().unwrap().asset_count, 0);
        let original = db.get_asset("image").unwrap().unwrap();
        assert!(original.library_hidden);
        assert_eq!(
            original.store_path.as_deref(),
            Some("/synthetic/helper.png")
        );
        assert_eq!(
            serde_json::to_value(before_p).unwrap(),
            serde_json::to_value(db.project_canvas_snapshot("p").unwrap()).unwrap()
        );
        assert_eq!(
            serde_json::to_value(before_q).unwrap(),
            serde_json::to_value(db.project_canvas_snapshot("q").unwrap()).unwrap()
        );
        assert!(db.get_prompted_asset("image").unwrap().is_some());
        db.set_canvas_asset_library_visibility("q", "image", true)
            .unwrap();
        assert_eq!(db.count_assets(None).unwrap(), 1);
        assert_eq!(db.count_assets(Some("p")).unwrap(), 1);
        assert_eq!(
            db.list_assets_by_collection("collection", None, 100, 0)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn canvas_only_assets_reject_missing_foreign_hidden_or_non_image_targets() {
        let db = Database::open_in_memory().unwrap();
        fixture(&db, "/synthetic/helper.png");
        assert!(db
            .set_canvas_asset_library_visibility("other", "image", false)
            .is_err());
        assert!(db
            .set_canvas_asset_library_visibility("p", "missing", false)
            .is_err());
        db.conn
            .lock()
            .unwrap()
            .execute("UPDATE assets SET ext='mp4' WHERE id='image'", [])
            .unwrap();
        assert!(db
            .set_canvas_asset_library_visibility("p", "image", false)
            .is_err());
        db.conn.lock().unwrap().execute_batch("UPDATE assets SET ext='png'; UPDATE canvas_nodes SET hidden_at=1 WHERE project_id='p';").unwrap();
        assert!(db
            .set_canvas_asset_library_visibility("p", "image", false)
            .is_err());
        assert!(!db.get_asset("image").unwrap().unwrap().library_hidden);
    }

    #[test]
    fn canvas_only_assets_survive_reopen_and_preserve_file_bytes() {
        let dir =
            std::env::temp_dir().join(format!("bowerbird-canvas-library-{}", ulid::Ulid::new()));
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("helper.png");
        let database = dir.join("library.db");
        std::fs::write(&file, b"unchanged original image").unwrap();
        {
            let db = Database::open(&database).unwrap();
            fixture(&db, file.to_str().unwrap());
            db.set_canvas_asset_library_visibility("p", "image", false)
                .unwrap();
        }
        let db = Database::open(&database).unwrap();
        db.migrate().unwrap();
        assert!(db.get_asset("image").unwrap().unwrap().library_hidden);
        assert_eq!(db.project_canvas_snapshot("p").unwrap().nodes.len(), 1);
        assert_eq!(std::fs::read(file).unwrap(), b"unchanged original image");
        // Shared images remain canvas-only until the final visible instance is removed.
        db.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM projects WHERE id='p'", [])
            .unwrap();
        assert!(db.get_asset("image").unwrap().unwrap().library_hidden);
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE canvas_nodes SET hidden_at=1 WHERE project_id='q'",
                [],
            )
            .unwrap();
        assert!(!db.get_asset("image").unwrap().unwrap().library_hidden);
        assert_eq!(db.count_assets(None).unwrap(), 1);
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn canvas_only_assets_migration_preserves_existing_library_visibility() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        let migrations = crate::db::migrations::migrations();
        migrations.to_version(&mut conn, 29).unwrap();
        conn.execute("INSERT INTO assets(id,name) VALUES ('legacy','legacy')", [])
            .unwrap();
        migrations.to_latest(&mut conn).unwrap();
        let hidden: bool = conn
            .query_row(
                "SELECT library_hidden FROM assets WHERE id='legacy'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!hidden);
        assert!(conn
            .execute("UPDATE assets SET library_hidden=2", [])
            .is_err());
    }
}
