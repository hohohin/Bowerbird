//! Read-only tag browsing and application-only collection trees.
use super::library::{asset_from_row, Asset, Folder};
use crate::{
    db::Database,
    error::{AppError, AppResult},
};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

pub(super) const IMAGE: &str = "lower(COALESCE(a.ext,'')) IN ('png','jpg','jpeg','webp','gif','bmp','svg','avif','tif','tiff')";
pub(super) const VIDEO: &str = "lower(COALESCE(a.ext,'')) IN ('mp4','mov','webm','m4v','avi','mkv')";
pub(super) const VISIBLE: &str =
    "(a.library_hidden=0 OR EXISTS(SELECT 1 FROM external_assets e WHERE e.asset_id=a.id))";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogTag {
    pub id: String,
    pub name: String,
    pub description: String,
    pub count: i64,
    pub project_count: i64,
}
#[derive(Serialize)]
pub struct MaterialCatalog {
    pub tags: Vec<CatalogTag>,
    pub collections: Vec<Folder>,
    pub prompts: Vec<String>,
    pub tag_asset_ids: BTreeMap<String, Vec<String>>,
}

impl Database {
    pub fn material_catalog(&self, project: Option<&str>) -> AppResult<MaterialCatalog> {
        let collections = self.list_collections()?;
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("SELECT t.id,t.name,t.classification_description,
            (SELECT COUNT(*) FROM asset_tags at JOIN assets a ON a.id=at.asset_id WHERE at.tag_id=t.id AND {IMAGE} AND {VISIBLE}),
            (SELECT COUNT(*) FROM asset_tags at JOIN assets a ON a.id=at.asset_id JOIN project_assets pa ON pa.asset_id=a.id
             WHERE at.tag_id=t.id AND pa.project_id=?1 AND {IMAGE}) FROM tags t"))?;
        let tags = stmt
            .query_map([project], |r| {
                Ok(CatalogTag {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    description: r.get(2)?,
                    count: r.get(3)?,
                    project_count: r.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut tag_asset_ids = BTreeMap::<String, Vec<String>>::new();
        let mut stmt = conn.prepare(&format!(
            "SELECT at.tag_id,a.id FROM asset_tags at JOIN assets a ON a.id=at.asset_id
            WHERE {IMAGE} AND {VISIBLE} ORDER BY a.created_at DESC,a.id"
        ))?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (tag, asset) = row?;
            tag_asset_ids.entry(tag).or_default().push(asset);
        }
        let prompts = catalog_prompts(&conn, project)?;
        Ok(MaterialCatalog {
            tags,
            collections,
            prompts,
            tag_asset_ids,
        })
    }

    pub fn material_catalog_assets(&self, kind: &str, id: Option<&str>, project: Option<&str>) -> AppResult<Vec<Asset>> {
        let conn = self.conn.lock().unwrap();
        // Project browsing uses visible project membership, never unrelated canvas references.
        let project_scope = "(?2 IS NULL OR (a.library_hidden=0 AND EXISTS(
            SELECT 1 FROM project_assets pa WHERE pa.asset_id=a.id AND pa.project_id=?2)))";
        let sql = match kind {
            // Videos are a separate UI section, not tag members or relevance signals.
            "tags" => format!("SELECT a.* FROM assets a WHERE ({IMAGE} OR (?1 IS NULL AND {VIDEO})) AND {VISIBLE}
                AND (?1 IS NULL OR EXISTS(SELECT 1 FROM asset_tags at WHERE at.asset_id=a.id AND at.tag_id=?1))
                AND {project_scope}
                ORDER BY a.created_at DESC,a.id"),
            "collections" => format!("WITH RECURSIVE scope(id) AS (
                SELECT id FROM folders WHERE kind='collection' AND (?1 IS NULL OR id=?1)
                UNION SELECT f.id FROM folders f JOIN scope s ON f.parent_id=s.id WHERE f.kind='collection')
                SELECT a.* FROM assets a WHERE {VISIBLE}
                AND EXISTS(SELECT 1 FROM asset_collections ac JOIN scope s ON s.id=ac.folder_id WHERE ac.asset_id=a.id)
                AND {project_scope}
                ORDER BY a.created_at DESC,a.id"),
            _ => return Err(AppError::Other("未知素材视图".into())),
        };
        let mut stmt = conn.prepare(&sql)?;
        let result = stmt
            .query_map(params![id, project], asset_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(result)
    }

    pub fn save_collection_node(
        &self,
        id: Option<&str>,
        name: &str,
        parent: Option<&str>,
    ) -> AppResult<String> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 100 {
            return Err(AppError::Other("集合名称须为 1–100 个字符".into()));
        }
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let generated = ulid::Ulid::new().to_string();
        let target = id.unwrap_or(&generated);
        if let Some(id) = id {
            require_collection(&tx, id)?;
        }
        if let Some(parent) = parent {
            require_collection(&tx, parent)?;
            let cycle: bool = tx.query_row("WITH RECURSIVE ancestors(id,parent_id) AS (
                SELECT id,parent_id FROM folders WHERE id=?1 UNION SELECT f.id,f.parent_id FROM folders f JOIN ancestors a ON f.id=a.parent_id)
                SELECT EXISTS(SELECT 1 FROM ancestors WHERE id=?2)", params![parent,target], |r| r.get(0))?;
            if cycle {
                return Err(AppError::Other("集合不能放入自身或其子集合".into()));
            }
        }
        if id.is_some() {
            tx.execute(
                "UPDATE folders SET name=?2,parent_id=?3 WHERE id=?1",
                params![target, name, parent],
            )?;
        } else {
            tx.execute("INSERT INTO folders(id,name,parent_id,kind,created_at) VALUES(?1,?2,?3,'collection',strftime('%s','now'))", params![target,name,parent])?;
        }
        tx.commit()?;
        Ok(target.to_owned())
    }

    pub fn delete_collection_node(&self, id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        require_collection(&tx, id)?;
        tx.execute("DELETE FROM folders WHERE id=?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn set_collection_members(
        &self,
        id: &str,
        assets: &[String],
        added: bool,
    ) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        require_collection(&tx, id)?;
        for asset in assets {
            if added {
                tx.execute("INSERT OR IGNORE INTO asset_collections(asset_id,folder_id,created_at) VALUES(?1,?2,strftime('%s','now'))", params![asset,id])?;
            } else {
                // The parent view includes descendants; removal must match what that view shows.
                tx.execute("WITH RECURSIVE scope(id) AS (SELECT ?2 UNION SELECT f.id FROM folders f JOIN scope s ON f.parent_id=s.id WHERE f.kind='collection')
                    DELETE FROM asset_collections WHERE asset_id=?1 AND folder_id IN (SELECT id FROM scope)", params![asset,id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}

fn require_collection(conn: &rusqlite::Connection, id: &str) -> AppResult<()> {
    let found = conn
        .query_row(
            "SELECT 1 FROM folders WHERE id=?1 AND kind='collection'",
            [id],
            |_| Ok(()),
        )
        .optional()?;
    found.ok_or_else(|| AppError::Other("集合已不存在".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Database {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        for id in ["p", "q"] {
            db.create_project(id, id, &format!("blank:{id}"), id, "user")
                .unwrap();
        }
        let conn = db.conn.lock().unwrap();
        for (id, ext, hidden) in [
            ("image", "png", 0),
            ("private", "jpg", 1),
            ("external", "webp", 1),
            ("video", "mp4", 0),
        ] {
            conn.execute("INSERT INTO assets(id,name,ext,source,store_path,library_hidden) VALUES(?1,?1,?2,'imported',?1,?3)", params![id,ext,hidden]).unwrap();
        }
        conn.execute(
            "INSERT INTO external_assets(asset_id,fingerprint) VALUES('external','test')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tags(id,name) VALUES('test-tag','测试标签')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO asset_tags(asset_id,tag_id) SELECT id,'test-tag' FROM assets",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_assets(project_id,asset_id,created_at) VALUES('p','private',1)",
            [],
        )
        .unwrap();
        drop(conn);
        db
    }
    fn ids(assets: Vec<Asset>) -> BTreeSet<String> {
        assets.into_iter().map(|a| a.id).collect()
    }

    #[test]
    fn tags_include_global_and_external_images_but_project_signals_do_not_filter_the_gallery() {
        let db = db();
        let expected = BTreeSet::from(["image".into(), "external".into()]);
        assert_eq!(
            ids(db
                .material_catalog_assets("tags", Some("test-tag"), None)
                .unwrap()),
            expected
        );
        let home = db.material_catalog(None).unwrap();
        let project = db.material_catalog(Some("p")).unwrap();
        let home_tag = home.tags.iter().find(|t| t.id == "test-tag").unwrap();
        let project_tag = project.tags.iter().find(|t| t.id == "test-tag").unwrap();
        assert_eq!((home_tag.count, home_tag.project_count), (2, 0));
        assert_eq!((project_tag.count, project_tag.project_count), (2, 1));
        assert_eq!(home.tag_asset_ids, project.tag_asset_ids);
        assert_eq!(
            home.tag_asset_ids["test-tag"]
                .iter()
                .cloned()
                .collect::<BTreeSet<_>>(),
            expected
        );
        assert_eq!(
            ids(db.material_catalog_assets("tags", None, None).unwrap()),
            BTreeSet::from(["image".into(), "external".into(), "video".into()])
        );
    }

    #[test]
    fn video_sections_respect_visibility_and_project_membership_without_creating_tags() {
        let db = db();
        {
            let conn = db.conn.lock().unwrap();
            for (id, ext) in [("private-video", "mov"), ("external-video", "WEBM")] {
                conn.execute("INSERT INTO assets(id,name,ext,source,store_path,library_hidden) VALUES(?1,?1,?2,'imported',?1,1)", params![id, ext]).unwrap();
            }
            conn.execute("INSERT INTO external_assets(asset_id,fingerprint) VALUES('external-video','video-test')", []).unwrap();
            conn.execute("INSERT INTO project_assets(project_id,asset_id,created_at) VALUES('p','video',1),('p','private-video',1),('p','external-video',1)", []).unwrap();
        }
        assert_eq!(
            ids(db.material_catalog_assets("tags", None, None).unwrap()),
            BTreeSet::from(["image".into(), "external".into(), "video".into(), "external-video".into()])
        );
        assert_eq!(
            ids(db.material_catalog_assets("tags", None, Some("p")).unwrap()),
            BTreeSet::from(["video".into()])
        );
        assert!(db.material_catalog_assets("tags", None, Some("q")).unwrap().is_empty());
        assert!(db.material_catalog_assets("tags", Some("test-tag"), Some("p")).unwrap().is_empty());
        let catalog = db.material_catalog(Some("p")).unwrap();
        assert_eq!(catalog.tags.len(), 1);
        assert_eq!(catalog.tags[0].id, "test-tag");
        assert!(!catalog.tag_asset_ids["test-tag"].contains(&"video".into()));
    }

    #[test]
    fn project_views_intersect_visible_membership_and_never_fall_back_to_global() {
        let db = db();
        let collection = db.save_collection_node(None, "Mixed", None).unwrap();
        db.set_collection_members(&collection, &["image".into(), "private".into(), "external".into()], true).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("INSERT INTO project_assets(project_id,asset_id,created_at) VALUES('p','image',2),('p','external',3)", []).unwrap();
        }
        for kind in ["tags", "collections"] {
            assert_eq!(ids(db.material_catalog_assets(kind, None, Some("p")).unwrap()), BTreeSet::from(["image".into()]));
            assert!(db.material_catalog_assets(kind, None, Some("q")).unwrap().is_empty());
            assert!(db.material_catalog_assets(kind, None, Some("missing")).unwrap().is_empty());
        }
        assert_eq!(ids(db.material_catalog_assets("collections", Some(&collection), Some("p")).unwrap()), BTreeSet::from(["image".into()]));
    }

    #[test]
    fn prompt_relevance_uses_execution_owner_and_image_turns_only() {
        let db = db();
        {
            let conn = db.conn.lock().unwrap();
            for (id, project, payload) in [
                (
                    "mine",
                    "p",
                    r#"{"media":"video","prompt":"video ignored","turns":[{"media":"image","prompt":"my illustration"},{"media":"video","prompt":"also ignored"}]}"#,
                ),
                ("other", "q", r#"{"prompt":"other project"}"#),
                ("broken", "p", "invalid json"),
            ] {
                conn.execute("INSERT INTO task_queue(id,kind,payload,created_at,project_id) VALUES(?1,'generation',?2,1,?3)", params![id,payload,project]).unwrap();
            }
            // Output belongs to p, but the foreign generation was executed in q.
            conn.execute("INSERT INTO analyses(id,asset_id,kind,payload) VALUES('foreign','private','generation_meta',?1)", [r#"{"project_id":"q","prompt":"do not leak"}"#]).unwrap();
            conn.execute("INSERT INTO analyses(id,asset_id,kind,payload) VALUES('own','image','generation_meta',?1)", [r#"{"project_id":"p","prompt_raw":"my illustration","applied_prompt":"my full illustration"}"#]).unwrap();
        }
        assert_eq!(
            db.material_catalog(Some("p")).unwrap().prompts,
            vec!["my full illustration", "my illustration"]
        );
        assert!(db.material_catalog(None).unwrap().prompts.is_empty());
    }

    #[test]
    fn collections_preserve_assets_support_multiple_parents_membership_and_reject_tree_cycles() {
        let db = db();
        let root = db.save_collection_node(None, "Root", None).unwrap();
        let child = db.save_collection_node(None, "Child", Some(&root)).unwrap();
        let sibling = db.save_collection_node(None, "Other", None).unwrap();
        assert!(db
            .save_collection_node(Some(&root), "Invalid", Some(&child))
            .is_err());
        assert!(db
            .save_collection_node(Some(&child), "Invalid", Some(&child))
            .is_err());
        assert!(db
            .save_collection_node(None, "Bad parent", Some("root"))
            .is_err());
        assert!(db.save_collection_node(None, "  ", None).is_err());
        db.set_collection_members(&root, &["image".into()], true)
            .unwrap();
        db.set_collection_members(&child, &["image".into(), "external".into(), "private".into()], true)
            .unwrap();
        db.set_collection_members(&sibling, &["image".into()], true)
            .unwrap();
        assert_eq!(
            db.material_catalog_assets("collections", Some(&root), None)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            db.material_catalog_assets("collections", None, None)
                .unwrap()
                .len(),
            2
        );
        db.set_collection_members(&root, &["image".into()], false)
            .unwrap();
        assert_eq!(
            ids(db
                .material_catalog_assets("collections", Some(&root), None)
                .unwrap()),
            BTreeSet::from(["external".into()])
        );
        assert_eq!(
            db.material_catalog_assets("collections", Some(&sibling), None)
                .unwrap()
                .len(),
            1
        );
        // A failed batch must not leave partial membership behind.
        assert!(db
            .set_collection_members(&root, &["external".into(), "missing".into()], true)
            .is_err());
        assert_eq!(
            db.material_catalog_assets("collections", Some(&root), None)
                .unwrap()
                .len(),
            1
        );
        db.save_collection_node(Some(&child), "Renamed", Some(&sibling))
            .unwrap();
        assert!(db
            .material_catalog_assets("collections", Some(&root), None)
            .unwrap()
            .is_empty());
        db.delete_collection_node(&sibling).unwrap();
        assert!(!db.list_collections().unwrap().iter().any(|c| c.id == child));
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            4
        );
        assert_eq!(
            conn.query_row(
                "SELECT store_path FROM assets WHERE id='private'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "private"
        );
    }
}

// Shared read-only project relevance context; never fetches asset membership lists.
pub(super) fn catalog_prompts(conn: &rusqlite::Connection, project: Option<&str>) -> AppResult<Vec<String>> {
    let mut prompts = BTreeSet::new();
    if let Some(project) = project {
        // Execution ownership, not current output membership, determines prompt provenance.
        let mut stmt = conn.prepare("SELECT payload FROM task_queue WHERE project_id=?1 AND kind='generation'
            UNION ALL SELECT payload FROM analyses WHERE kind='generation_meta' AND json_valid(payload)
            AND json_extract(payload,'$.project_id')=?1")?;
        for row in stmt.query_map([project], |r| r.get::<_, String>(0))? {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&row?) else {
                continue;
            };
            for turn in std::iter::once(&value).chain(
                value
                    .get("turns")
                    .and_then(|v| v.as_array())
                    .into_iter()
                    .flatten(),
            ) {
                if turn
                    .get("media")
                    .and_then(|v| v.as_str())
                    .unwrap_or("image")
                    != "image"
                {
                    continue;
                }
                for key in ["prompt_raw", "prompt", "applied_prompt", "appliedPrompt"] {
                    if let Some(text) = turn
                        .get(key)
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.trim().is_empty())
                    {
                        prompts.insert(text.to_owned());
                    }
                }
            }
        }
    }
    Ok(prompts.into_iter().collect())
}
