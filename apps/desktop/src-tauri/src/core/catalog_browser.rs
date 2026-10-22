//! Bounded catalog reads. Counts and pages share exactly the same filter contract.
use super::{
    library::{asset_from_row, Asset},
    material_catalog::{catalog_prompts, CatalogTag, MaterialCatalog, IMAGE, VIDEO, VISIBLE},
};
use crate::{
    db::Database,
    error::{AppError, AppResult},
    media::color,
};
use rusqlite::{params_from_iter, types::Value};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogFilter {
    pub kind: String,
    pub id: Option<String>,
    pub project_id: Option<String>,
    pub media: String,
    pub query: Option<String>,
    pub generated: Option<bool>,
    pub color: Option<String>,
}

#[derive(Serialize)]
pub struct CatalogOverview {
    pub catalog: MaterialCatalog,
    pub total: i64,
    pub untagged: i64,
}

#[derive(Serialize)]
pub struct CatalogColorBatch {
    pub after: Option<String>,
    pub more: bool,
    pub failed: usize,
    pub updated: usize,
}

impl CatalogFilter {
    fn sql(&self) -> AppResult<(String, Vec<Value>)> {
        let mut clauses = vec![
            VISIBLE.to_string(),
            match self.media.as_str() {
                "images" => IMAGE.to_string(),
                "videos" => VIDEO.to_string(),
                _ => return Err(AppError::Other("未知素材类型".into())),
            },
        ];
        let mut values = Vec::new();
        if let Some(project) = &self.project_id {
            clauses.push("a.library_hidden=0 AND EXISTS(SELECT 1 FROM project_assets pa WHERE pa.asset_id=a.id AND pa.project_id=?)".into());
            values.push(Value::Text(project.clone()));
        }
        if let Some(query) = self.query.as_deref().filter(|q| !q.is_empty()) {
            clauses.push("a.name LIKE ? ESCAPE '\\'".into());
            values.push(Value::Text(format!(
                "%{}%",
                query
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            )));
        }
        if let Some(generated) = self.generated {
            clauses.push(
                if generated {
                    "a.generation_session_id IS NOT NULL"
                } else {
                    "a.generation_session_id IS NULL"
                }
                .into(),
            );
        }
        if let Some(color) = &self.color {
            clauses.push(
                "EXISTS(SELECT 1 FROM asset_colors c WHERE c.asset_id=a.id AND c.bucket=?)".into(),
            );
            values.push(Value::Text(color.clone()));
        }
        match self.kind.as_str() {
            "all" => (),
            "tags" => {
                if let Some(id) = &self.id {
                    if id == "__catalog_untagged__" {
                        clauses.push(
                            "NOT EXISTS(SELECT 1 FROM asset_tags t WHERE t.asset_id=a.id)".into(),
                        );
                    } else {
                        clauses.push("EXISTS(SELECT 1 FROM asset_tags t WHERE t.asset_id=a.id AND t.tag_id=?)".into());
                        values.push(Value::Text(id.clone()));
                    }
                }
            }
            "collections" => {
                if let Some(id) = &self.id {
                    clauses.push("EXISTS(WITH RECURSIVE scope(id) AS (SELECT id FROM folders WHERE id=? AND kind='collection' UNION SELECT f.id FROM folders f JOIN scope s ON f.parent_id=s.id WHERE f.kind='collection') SELECT 1 FROM asset_collections ac JOIN scope s ON s.id=ac.folder_id WHERE ac.asset_id=a.id)".into());
                    values.push(Value::Text(id.clone()));
                } else {
                    clauses.push("0".into());
                }
            }
            _ => return Err(AppError::Other("未知素材视图".into())),
        }
        Ok((clauses.join(" AND "), values))
    }
}

impl Database {
    /// Repair only missing color indexes, in small user-requested batches. Existing
    /// managed colors are reused; old external references need their preview once.
    pub fn catalog_prepare_colors(
        &self,
        filter: &CatalogFilter,
        after: Option<&str>,
    ) -> AppResult<CatalogColorBatch> {
        let mut filter = filter.clone();
        filter.color = None;
        let (condition, mut values) = filter.sql()?;
        values.push(Value::Text(after.unwrap_or("").to_string()));
        let rows = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(&format!("SELECT a.id,a.thumb_path,a.colors FROM assets a WHERE {condition} AND a.id>? AND (a.colors IS NULL OR a.colors<>'[]') AND NOT EXISTS(SELECT 1 FROM asset_colors c WHERE c.asset_id=a.id) ORDER BY a.id LIMIT 60"))?;
            let rows = stmt
                .query_map(params_from_iter(values), |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut result = CatalogColorBatch {
            after: rows.last().map(|r| r.0.clone()),
            more: rows.len() == 60,
            failed: 0,
            updated: 0,
        };
        for (id, path, saved) in rows {
            let colors = if let Some(saved) = saved {
                Ok(saved)
            } else {
                // Use the indexed thumbnail, never silently accept changed external bytes.
                path.as_deref()
                    .ok_or_else(|| AppError::Other("素材缩略图缺失".into()))
                    .and_then(|preview| color::extract(std::path::Path::new(preview), 5))
                    .and_then(|colors| {
                        serde_json::to_string(&colors).map_err(|e| AppError::Other(e.to_string()))
                    })
            };
            let Ok(colors) = colors else {
                result.failed += 1;
                continue;
            };
            let buckets = color::colors_to_buckets(&colors);
            let mut conn = self.conn.lock().unwrap();
            let tx = conn.transaction()?;
            // A deleted/moved asset must not receive a stale color result.
            if tx.execute(
                "UPDATE assets SET colors=?2 WHERE id=?1 AND thumb_path IS ?3",
                rusqlite::params![id, colors, path],
            )? > 0
            {
                for bucket in buckets {
                    tx.execute(
                        "INSERT OR IGNORE INTO asset_colors(asset_id,bucket) VALUES(?1,?2)",
                        rusqlite::params![id, bucket],
                    )?;
                }
                result.updated += 1;
            }
            tx.commit()?;
        }
        Ok(result)
    }

    pub fn catalog_overview(
        &self,
        filter: &CatalogFilter,
        context_project: Option<&str>,
    ) -> AppResult<CatalogOverview> {
        let collections = self.list_collections()?;
        let (condition, values) = filter.sql()?;
        let conn = self.conn.lock().unwrap();
        let total = conn.query_row(
            &format!("SELECT COUNT(*) FROM assets a WHERE {condition}"),
            params_from_iter(&values),
            |r| r.get(0),
        )?;
        let untagged = if filter.media == "images" {
            conn.query_row(&format!("SELECT COUNT(*) FROM assets a WHERE {condition} AND NOT EXISTS(SELECT 1 FROM asset_tags t WHERE t.asset_id=a.id)"), params_from_iter(&values), |r| r.get(0))?
        } else {
            0
        };
        // Aggregate once, rather than scanning all memberships once per tag.
        let mut counts = BTreeMap::new();
        let mut stmt = conn.prepare(&format!("SELECT t.tag_id,COUNT(*) FROM assets a JOIN asset_tags t ON t.asset_id=a.id WHERE {condition} GROUP BY t.tag_id"))?;
        for row in stmt.query_map(params_from_iter(&values), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })? {
            let (id, count) = row?;
            counts.insert(id, count);
        }
        let mut project_counts = BTreeMap::new();
        if let Some(project) = context_project {
            let mut stmt = conn.prepare(&format!("SELECT t.tag_id,COUNT(*) FROM project_assets pa JOIN assets a ON a.id=pa.asset_id JOIN asset_tags t ON t.asset_id=a.id WHERE pa.project_id=? AND {IMAGE} GROUP BY t.tag_id"))?;
            for row in stmt.query_map([project], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })? {
                let (id, count) = row?;
                project_counts.insert(id, count);
            }
        }
        let mut stmt = conn.prepare("SELECT id,name,classification_description FROM tags")?;
        let tags = stmt
            .query_map([], |r| {
                let id: String = r.get(0)?;
                Ok(CatalogTag {
                    count: *counts.get(&id).unwrap_or(&0),
                    project_count: *project_counts.get(&id).unwrap_or(&0),
                    id,
                    name: r.get(1)?,
                    description: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(CatalogOverview {
            total,
            untagged,
            catalog: MaterialCatalog {
                tags,
                collections,
                prompts: catalog_prompts(&conn, context_project)?,
                tag_asset_ids: BTreeMap::new(),
            },
        })
    }

    pub fn catalog_page(
        &self,
        filter: &CatalogFilter,
        offset: i64,
        limit: i64,
    ) -> AppResult<Vec<Asset>> {
        let (condition, mut values) = filter.sql()?;
        values.push(Value::Integer(limit.clamp(1, 240)));
        values.push(Value::Integer(offset.max(0)));
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("SELECT a.* FROM assets a WHERE {condition} ORDER BY a.created_at DESC,a.id LIMIT ? OFFSET ?"))?;
        let rows = stmt
            .query_map(params_from_iter(values), asset_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Explicit selection only. IDs stay lightweight and use the same order as the gallery.
    pub fn catalog_ids(
        &self,
        filter: &CatalogFilter,
        offset: i64,
        limit: i64,
    ) -> AppResult<Vec<String>> {
        let (condition, mut values) = filter.sql()?;
        values.push(Value::Integer(limit.clamp(1, 2000)));
        values.push(Value::Integer(offset.max(0)));
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("SELECT a.id FROM assets a WHERE {condition} ORDER BY a.created_at DESC,a.id LIMIT ? OFFSET ?"))?;
        let rows = stmt
            .query_map(params_from_iter(values), |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Database {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.create_project("p", "Project", "/p", "/p", "user")
            .unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch("DELETE FROM tags;
                INSERT INTO tags(id,name) VALUES('a','Alpha'),('b','Beta');
                INSERT INTO assets(id,name,ext,created_at,generation_session_id,library_hidden) VALUES
                ('a','100%_海报','png',10,NULL,0),('b','poster','JPG',10,'generated',0),
                ('c','untagged','webp',NULL,NULL,0),('d','movie','mp4',9,NULL,0),
                ('e','hidden','png',20,NULL,1),('f','external','png',11,NULL,1);
                INSERT INTO external_assets(asset_id,fingerprint) VALUES('f','test');
                INSERT INTO asset_tags(asset_id,tag_id) VALUES('a','a'),('a','b'),('b','a'),('e','b');
                INSERT INTO project_assets(project_id,asset_id,created_at) VALUES('p','a',1),('p','e',1),('p','f',1);
                INSERT INTO asset_colors(asset_id,bucket) VALUES('a','red'),('b','blue');").unwrap();
        }
        db
    }
    fn filter() -> CatalogFilter {
        CatalogFilter {
            kind: "all".into(),
            media: "images".into(),
            ..Default::default()
        }
    }
    #[test]
    fn bounded_pages_have_stable_ties_null_dates_and_unique_ids() {
        let db = fixture();
        let f = filter();
        let ids = db.catalog_ids(&f, 0, 2000).unwrap();
        assert_eq!(ids, vec!["f", "a", "b", "c"]);
        let paged = (0..4)
            .flat_map(|offset| {
                db.catalog_page(&f, offset, 1)
                    .unwrap()
                    .into_iter()
                    .map(|a| a.id)
            })
            .collect::<Vec<_>>();
        assert_eq!(paged, ids);
        assert!(db.catalog_page(&f, 4, 60).unwrap().is_empty());
        assert_eq!(db.catalog_page(&f, -4, -1).unwrap().len(), 1);
        let overview = db.catalog_overview(&f, None).unwrap();
        assert_eq!(overview.total, 4);
        assert_eq!(overview.untagged, 2);
        assert!(overview.catalog.tag_asset_ids.is_empty());
        assert_eq!(
            overview
                .catalog
                .tags
                .iter()
                .find(|t| t.id == "a")
                .unwrap()
                .count,
            2
        );
    }
    #[test]
    fn counts_ids_and_pages_share_filters_and_project_visibility() {
        let db = fixture();
        for (f, expected) in [
            (
                CatalogFilter {
                    query: Some("%_".into()),
                    ..filter()
                },
                vec!["a"],
            ),
            (
                CatalogFilter {
                    generated: Some(true),
                    ..filter()
                },
                vec!["b"],
            ),
            (
                CatalogFilter {
                    generated: Some(false),
                    color: Some("red".into()),
                    ..filter()
                },
                vec!["a"],
            ),
            (
                CatalogFilter {
                    project_id: Some("p".into()),
                    ..filter()
                },
                vec!["a"],
            ),
            (
                CatalogFilter {
                    project_id: Some("missing".into()),
                    ..filter()
                },
                vec![],
            ),
            (
                CatalogFilter {
                    media: "videos".into(),
                    ..filter()
                },
                vec!["d"],
            ),
            (
                CatalogFilter {
                    kind: "tags".into(),
                    id: Some("b".into()),
                    ..filter()
                },
                vec!["a"],
            ),
            (
                CatalogFilter {
                    kind: "tags".into(),
                    id: Some("__catalog_untagged__".into()),
                    ..filter()
                },
                vec!["f", "c"],
            ),
        ] {
            assert_eq!(db.catalog_ids(&f, 0, 2000).unwrap(), expected);
            assert_eq!(
                db.catalog_overview(&f, Some("p")).unwrap().total,
                expected.len() as i64
            );
            assert_eq!(
                db.catalog_page(&f, 0, 60)
                    .unwrap()
                    .into_iter()
                    .map(|a| a.id)
                    .collect::<Vec<_>>(),
                expected
            );
        }
        assert!(db
            .catalog_page(
                &CatalogFilter {
                    media: "bogus".into(),
                    ..filter()
                },
                0,
                60
            )
            .is_err());
    }
    #[test]
    fn nested_collections_dedupe_and_empty_scope_does_not_read_whole_library() {
        let db = fixture();
        let root = db.save_collection_node(None, "Root", None).unwrap();
        let child = db.save_collection_node(None, "Child", Some(&root)).unwrap();
        db.set_collection_members(&root, &["a".into()], true)
            .unwrap();
        db.set_collection_members(&child, &["a".into(), "b".into()], true)
            .unwrap();
        let mut f = CatalogFilter {
            kind: "collections".into(),
            id: Some(root),
            ..filter()
        };
        assert_eq!(db.catalog_ids(&f, 0, 2000).unwrap(), vec!["a", "b"]);
        f.id = None;
        assert_eq!(db.catalog_overview(&f, None).unwrap().total, 0);
    }
    #[test]
    fn page_size_is_capped_even_for_an_untrusted_caller() {
        let db = fixture();
        {
            let mut conn = db.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            for i in 0..250 {
                tx.execute(
                    "INSERT INTO assets(id,name,ext) VALUES(?1,'extra','jpg')",
                    [format!("x{i:06}")],
                )
                .unwrap();
            }
            tx.commit().unwrap();
        }
        assert_eq!(db.catalog_page(&filter(), 0, i64::MAX).unwrap().len(), 240);
    }
    #[test]
    fn missing_colors_reuse_saved_values_and_failed_thumbnails_do_not_stop_batch() {
        let db = fixture();
        db.conn
            .lock()
            .unwrap()
            .execute("UPDATE assets SET colors='[\"#D92424\"]' WHERE id='c'", [])
            .unwrap();
        let f = CatalogFilter {
            color: Some("red".into()),
            ..filter()
        };
        assert_eq!(db.catalog_ids(&f, 0, 60).unwrap(), vec!["a"]);
        let batch = db.catalog_prepare_colors(&f, None).unwrap();
        assert_eq!(batch.updated, 1);
        assert_eq!(batch.failed, 1);
        assert!(!batch.more);
        assert_eq!(db.catalog_ids(&f, 0, 60).unwrap(), vec!["a", "c"]);
        assert_eq!(db.catalog_prepare_colors(&f, None).unwrap().updated, 0);
        assert_eq!(
            db.catalog_prepare_colors(&f, batch.after.as_deref())
                .unwrap()
                .failed,
            0
        );
    }
    #[test]
    #[ignore = "explicit synthetic 300k benchmark; no real files or model calls"]
    fn benchmark_300k_catalog() {
        let db = fixture();
        {
            let mut conn = db.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            for i in 0..300_000 {
                let id = format!("bench-{i:026}");
                tx.execute("INSERT INTO assets(id,name,ext,created_at,width,height,store_path,thumb_path) VALUES(?1,?1,'jpg',?2,1200,800,'/synthetic.jpg','/synthetic-thumb.jpg')",rusqlite::params![id,i]).unwrap();
                tx.execute(
                    "INSERT INTO asset_tags(asset_id,tag_id) VALUES(?1,'a'),(?1,'b')",
                    [id],
                )
                .unwrap();
            }
            tx.commit().unwrap();
        }
        for offset in [0, 150_000, 299_940] {
            let start = std::time::Instant::now();
            let page = db.catalog_page(&filter(), offset, 60).unwrap();
            assert_eq!(page.len(), 60);
            eprintln!("300k page offset={offset}: {:?}", start.elapsed());
        }
        let start = std::time::Instant::now();
        let summary = db.catalog_overview(&filter(), None).unwrap();
        assert_eq!(summary.total, 300_004);
        assert!(summary.catalog.tag_asset_ids.is_empty());
        eprintln!(
            "300k summary: {:?}; response bytes={}",
            start.elapsed(),
            serde_json::to_vec(&summary).unwrap().len()
        );
    }
}
