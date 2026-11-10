//! Bounded catalog reads. Counts and pages share exactly the same filter contract.
use super::{
    library::{asset_from_row, Asset},
    material_catalog::{catalog_prompts, CatalogTag, MaterialCatalog, AUDIO, IMAGE, VIDEO, TEXT, catalog_visibility},
};
use crate::{
    db::Database,
    error::{AppError, AppResult},
    media::color,
};
use rusqlite::{params_from_iter, types::Value};
use super::generation_gallery::WORKFLOW_GALLERY_CTE;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

// Use the durable conversation mapping, with legacy single-session fallback.
// Prefixes prevent a non-generated asset ID from colliding with a session ID.
pub(super) const GENERATED: &str = "(a.generation_session_id IS NOT NULL OR COALESCE(a.source='comfy-h3',0) OR a.id IN (SELECT asset_id FROM workflow_asset_groups) OR a.id IN (SELECT asset_id FROM other_generated_groups))";
pub(super) const GENERATION_GROUP: &str = "COALESCE((SELECT w.group_key FROM workflow_asset_groups w WHERE w.asset_id=a.id),CASE WHEN a.generation_session_id IS NOT NULL THEN 'generation:'||COALESCE((SELECT g.conversation_id FROM generation_conversations g WHERE g.session_id=a.generation_session_id),a.generation_session_id) END,(SELECT g.group_key FROM other_generated_groups g WHERE g.asset_id=a.id),'asset:'||a.id)";
pub(super) fn generation_display_group(individual: &str) -> String {
    format!("CASE WHEN {GENERATION_GROUP} IN (SELECT group_key FROM generation_gallery_separations) THEN {individual} ELSE {GENERATION_GROUP} END")
}
fn gallery_count() -> String {
    let group = generation_display_group("'asset:'||a.id");
    format!("COUNT(CASE WHEN NOT {GENERATED} THEN 1 END)+COUNT(DISTINCT CASE WHEN {GENERATED} THEN {group} END)")
}

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
pub struct CatalogGraphAsset {
    pub id: String,
    pub name: String,
    pub store_path: Option<String>,
    pub thumb_path: Option<String>,
    pub tag_ids: Vec<String>,
}

#[derive(Serialize)]
pub struct CatalogGraphPage {
    pub assets: Vec<CatalogGraphAsset>,
    pub after: Option<String>,
}

#[derive(Serialize)]
pub struct CatalogColorBatch {
    pub after: Option<String>,
    pub more: bool,
    pub failed: usize,
    pub updated: usize,
}

impl CatalogFilter {
    fn gallery_sql(&self, columns: &str) -> AppResult<(String, Vec<Value>)> {
        let group = generation_display_group("'asset:'||a.id");
        let (condition, values) = self.sql()?;
        let mut bindings = values.clone();
        bindings.extend(values);
        // Keep the main scan on the existing date index. Ordinary library items
        // do not participate in window sorting or materialize full asset rows.
        Ok((format!("WITH {WORKFLOW_GALLERY_CTE}, generated AS (SELECT a.id,ROW_NUMBER() OVER (PARTITION BY {group} ORDER BY a.created_at DESC,a.id DESC) AS generation_rank FROM assets a INDEXED BY idx_assets_generation_session_id WHERE {condition} AND {GENERATED}) SELECT {columns} FROM assets a INDEXED BY idx_assets_catalog_order WHERE {condition} AND (NOT {GENERATED} OR a.id IN (SELECT id FROM generated WHERE generation_rank=1)) ORDER BY a.created_at DESC,a.id LIMIT ? OFFSET ?"), bindings))
    }

    pub(super) fn sql(&self) -> AppResult<(String, Vec<Value>)> {
        let mut clauses = vec![
            if self.kind == "connections" { "1".into() } else { catalog_visibility(self.project_id.is_some()) },
            match self.media.as_str() {
                "all" => format!("({IMAGE} OR {VIDEO} OR {AUDIO} OR {TEXT})"),
                "images" => IMAGE.to_string(),
                "videos" => VIDEO.to_string(),
                "audios" => AUDIO.to_string(),
                "texts" => TEXT.to_string(),
                _ => return Err(AppError::Other("未知素材类型".into())),
            },
        ];
        let mut values = Vec::new();
        if let Some(project) = &self.project_id {
            clauses.push(format!("{}EXISTS(SELECT 1 FROM project_assets pa WHERE pa.asset_id=a.id AND pa.project_id=?)", if self.kind == "connections" { "" } else { "a.library_hidden=0 AND " }));
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
            clauses.push(if generated { GENERATED.into() } else { format!("NOT {GENERATED}") });
        }
        if let Some(color) = &self.color {
            clauses.push(
                "EXISTS(SELECT 1 FROM asset_colors c WHERE c.asset_id=a.id AND c.bucket=?)".into(),
            );
            values.push(Value::Text(color.clone()));
        }
        match self.kind.as_str() {
            "all" => (),
            "connections" => {
                clauses.push("EXISTS(SELECT 1 FROM connected_entries ce WHERE ce.asset_id=a.id)".into());
            },
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
    /// Read topology and previews without full asset metadata or one query per tag.
    /// Limit assets before joining memberships, so a multi-tag asset is never split.
    pub fn catalog_graph_page(
        &self,
        filter: &CatalogFilter,
        after: Option<&str>,
        limit: i64,
    ) -> AppResult<CatalogGraphPage> {
        let (condition, mut values) = filter.sql()?;
        let limit = limit.clamp(1, 512);
        values.push(Value::Text(after.unwrap_or("").to_string()));
        values.push(Value::Integer(limit));
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "WITH {WORKFLOW_GALLERY_CTE}, page AS (SELECT a.id,a.name,a.store_path,a.thumb_path FROM assets a WHERE {condition} AND a.id>? ORDER BY a.id LIMIT ?) \
             SELECT a.id,a.name,a.store_path,a.thumb_path,t.tag_id FROM page a LEFT JOIN asset_tags t ON t.asset_id=a.id ORDER BY a.id,t.tag_id"
        ))?;
        let mut assets: Vec<CatalogGraphAsset> = Vec::new();
        let mut rows = stmt.query(params_from_iter(values))?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            if assets.last().map(|asset| asset.id.as_str()) != Some(id.as_str()) {
                assets.push(CatalogGraphAsset {
                    id,
                    name: row.get(1)?,
                    store_path: row.get(2)?,
                    thumb_path: row.get(3)?,
                    tag_ids: Vec::new(),
                });
            }
            if let Some(tag) = row.get::<_, Option<String>>(4)? {
                assets.last_mut().unwrap().tag_ids.push(tag);
            }
        }
        let after = if assets.len() == limit as usize {
            assets.last().map(|asset| asset.id.clone())
        } else {
            None
        };
        Ok(CatalogGraphPage { assets, after })
    }

    /// Repair only missing color indexes, in small user-requested batches. Existing
    /// managed colors are reused; old external references need their preview once.
    pub fn catalog_prepare_colors(
        &self,
        filter: &CatalogFilter,
        after: Option<&str>,
    ) -> AppResult<CatalogColorBatch> {
        if matches!(filter.media.as_str(), "audios" | "texts") { return Ok(CatalogColorBatch { after: None, more: false, failed: 0, updated: 0 }); }
        let mut filter = filter.clone();
        filter.color = None;
        let (condition, mut values) = filter.sql()?;
        values.push(Value::Text(after.unwrap_or("").to_string()));
        let rows = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(&format!("WITH {WORKFLOW_GALLERY_CTE} SELECT a.id,a.thumb_path,a.colors FROM assets a WHERE {condition} AND a.id>? AND (a.colors IS NULL OR a.colors<>'[]') AND NOT EXISTS(SELECT 1 FROM asset_colors c WHERE c.asset_id=a.id) ORDER BY a.id LIMIT 60"))?;
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
        let gallery_count = gallery_count();
        let (condition, values) = filter.sql()?;
        let conn = self.conn.lock().unwrap();
        let total = conn.query_row(
            &format!("WITH {WORKFLOW_GALLERY_CTE} SELECT {gallery_count} FROM assets a WHERE {condition}"),
            params_from_iter(&values),
            |r| r.get(0),
        )?;
        let untagged = if filter.media == "images" {
            conn.query_row(&format!("WITH {WORKFLOW_GALLERY_CTE} SELECT {gallery_count} FROM assets a WHERE {condition} AND NOT EXISTS(SELECT 1 FROM asset_tags t WHERE t.asset_id=a.id)"), params_from_iter(&values), |r| r.get(0))?
        } else {
            0
        };
        // Aggregate once, rather than scanning all memberships once per tag.
        let mut counts = BTreeMap::new();
        let mut stmt = conn.prepare(&format!("WITH {WORKFLOW_GALLERY_CTE} SELECT t.tag_id,{gallery_count} FROM assets a JOIN asset_tags t ON t.asset_id=a.id WHERE {condition} GROUP BY t.tag_id"))?;
        for row in stmt.query_map(params_from_iter(&values), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })? {
            let (id, count) = row?;
            counts.insert(id, count);
        }
        let mut project_counts = BTreeMap::new();
        if let Some(project) = context_project {
            let mut stmt = conn.prepare(&format!("SELECT t.tag_id,COUNT(*) FROM project_assets pa JOIN assets a ON a.id=pa.asset_id JOIN asset_tags t ON t.asset_id=a.id WHERE pa.project_id=? AND {IMAGE} AND NOT EXISTS(SELECT 1 FROM removed_missing_asset_originals m WHERE m.asset_id=a.id) GROUP BY t.tag_id"))?;
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
        let (sql, mut values) = filter.gallery_sql("a.*")?;
        values.push(Value::Integer(limit.clamp(1, 240)));
        values.push(Value::Integer(offset.max(0)));
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql)?;
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
        let (sql, mut values) = filter.gallery_sql("a.id")?;
        values.push(Value::Integer(limit.clamp(1, 2000)));
        values.push(Value::Integer(offset.max(0)));
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(values), |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Carousel members obey the exact same scope as the page (including tags,
    /// search, media and project visibility), not the unfiltered global group.
    pub fn catalog_generation_groups(&self, filter: &CatalogFilter, asset_ids: &[String]) -> AppResult<HashMap<String, Vec<Asset>>> {
        if asset_ids.is_empty() { return Ok(HashMap::new()); }
        let group = generation_display_group("'asset:'||a.id");
        let (condition, mut values) = filter.sql()?;
        let ids = &asset_ids[..asset_ids.len().min(240)];
        values.extend(ids.iter().cloned().map(Value::Text));
        let placeholders = vec!["?"; ids.len()].join(",");
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("WITH {WORKFLOW_GALLERY_CTE} SELECT a.*,{group} AS group_key FROM assets a WHERE {condition} AND {GENERATED} AND {group} IN (SELECT {group} FROM assets a WHERE a.id IN ({placeholders})) ORDER BY a.created_at,a.id"))?;
        let mut groups: HashMap<String, Vec<Asset>> = HashMap::new();
        for row in stmt.query_map(params_from_iter(values), |row| Ok((row.get::<_, String>("group_key")?, asset_from_row(row)?)))? {
            let (key, asset) = row?;
            groups.entry(key).or_default().push(asset);
        }
        let mut result = HashMap::new();
        for group in groups.into_values() {
            for id in ids.iter().filter(|id| group.iter().any(|asset| &asset.id == *id)) {
                result.insert(id.clone(), group.clone());
            }
        }
        Ok(result)
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
    fn all_media_includes_each_kind_and_keeps_visibility() {
        let db = fixture();
        db.conn.lock().unwrap().execute_batch("INSERT INTO assets(id,name,ext,created_at,library_hidden) VALUES('audio','sound','mp3',12,0),('text','note','md',13,0);").unwrap();
        let all = CatalogFilter { media: "all".into(), ..filter() };
        let ids = db.catalog_ids(&all, 0, 2000).unwrap();
        for id in ["a", "d", "audio", "text"] { assert!(ids.contains(&id.to_string()), "missing {id}"); }
        assert!(!ids.contains(&"e".to_string()));
        let project = CatalogFilter { project_id: Some("p".into()), ..all };
        assert!(!db.catalog_ids(&project, 0, 2000).unwrap().contains(&"audio".to_string()));
    }
    #[test]
    fn graph_batches_keep_all_memberships_without_duplicate_images() {
        let db = fixture();
        let first = db.catalog_graph_page(&filter(), None, 1).unwrap();
        assert_eq!(first.assets.len(), 1);
        assert_eq!(first.assets[0].id, "a");
        assert_eq!(first.assets[0].tag_ids, vec!["a", "b"]);
        assert_eq!(first.after.as_deref(), Some("a"));
        let rest = db
            .catalog_graph_page(&filter(), first.after.as_deref(), 512)
            .unwrap();
        assert_eq!(
            rest.assets
                .iter()
                .map(|a| a.id.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "c", "f"]
        );
        assert!(rest.assets[1].tag_ids.is_empty());
        assert!(rest.after.is_none());
        let mut expected = db.catalog_ids(&filter(), 0, 2000).unwrap();
        expected.sort();
        let all = db.catalog_graph_page(&filter(), None, 512).unwrap();
        assert_eq!(
            all.assets.iter().map(|a| a.id.clone()).collect::<Vec<_>>(),
            expected
        );
        let project = db
            .catalog_graph_page(
                &CatalogFilter {
                    project_id: Some("p".into()),
                    ..filter()
                },
                None,
                512,
            )
            .unwrap();
        assert_eq!(project.assets.len(), 1);
        assert_eq!(project.assets[0].id, "a");
        assert_eq!(project.assets[0].tag_ids, vec!["a", "b"]);
    }

    #[test]
    fn graph_filters_and_limit_match_catalog_visibility() {
        let db = fixture();
        for f in [
            CatalogFilter {
                query: Some("%_".into()),
                ..filter()
            },
            CatalogFilter {
                generated: Some(true),
                ..filter()
            },
            CatalogFilter {
                color: Some("red".into()),
                ..filter()
            },
            CatalogFilter {
                project_id: Some("missing".into()),
                ..filter()
            },
        ] {
            let mut expected = db.catalog_ids(&f, 0, 2000).unwrap();
            expected.sort();
            assert_eq!(
                db.catalog_graph_page(&f, None, 512)
                    .unwrap()
                    .assets
                    .into_iter()
                    .map(|a| a.id)
                    .collect::<Vec<_>>(),
                expected
            );
        }
        assert_eq!(
            db.catalog_graph_page(&filter(), None, -1)
                .unwrap()
                .assets
                .len(),
            1
        );
        {
            let mut conn = db.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            for i in 0..520 {
                tx.execute(
                    "INSERT INTO assets(id,name,ext) VALUES(?1,'graph','jpg')",
                    [format!("graph-{i:06}")],
                )
                .unwrap();
            }
            tx.commit().unwrap();
        }
        let first = db.catalog_graph_page(&filter(), None, i64::MAX).unwrap();
        assert_eq!(first.assets.len(), 512);
        let second = db
            .catalog_graph_page(&filter(), first.after.as_deref(), 512)
            .unwrap();
        assert_eq!(second.assets.len(), 12);
        assert!(second.after.is_none());
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
    fn conversation_gallery_collapses_before_paging_and_filters_every_member() {
        let db = fixture();
        db.record_generation_conversation("generated", "conversation").unwrap();
        db.record_generation_conversation("continuation", "conversation").unwrap();
        {
            let conn = db.conn.lock().unwrap();
            for index in 0..75 {
                conn.execute("INSERT INTO assets(id,name,ext,created_at,generation_session_id) VALUES(?1,?1,'png',10,'continuation')", [format!("g{index:03}")]).unwrap();
            }
            conn.execute_batch("INSERT INTO assets(id,name,ext,created_at,generation_session_id) VALUES('video','video','mp4',30,'continuation'),('other','other','png',9,'independent');
                INSERT INTO asset_tags(asset_id,tag_id) VALUES('g000','a');
                INSERT INTO project_assets(project_id,asset_id,created_at) VALUES('p','g000',1),('p','g001',1);
                INSERT INTO asset_colors(asset_id,bucket) VALUES('g000','blue');").unwrap();
        }
        let f = CatalogFilter { generated: Some(true), ..filter() };
        assert_eq!(db.catalog_overview(&f, None).unwrap().total, 2);
        assert_eq!(db.catalog_ids(&f, 0, 1).unwrap(), vec!["g074"]);
        assert_eq!(db.catalog_page(&f, 1, 1).unwrap()[0].id, "other");
        let group = db.catalog_generation_groups(&f, &["g074".into()]).unwrap();
        assert_eq!(group["g074"].len(), 76);
        assert_eq!(group["g074"].first().unwrap().id, "b");
        assert_eq!(group["g074"].last().unwrap().id, "g074");
        for (scope, expected) in [
            (CatalogFilter { project_id: Some("p".into()), ..f.clone() }, vec!["g000", "g001"]),
            (CatalogFilter { kind: "tags".into(), id: Some("a".into()), ..f.clone() }, vec!["b", "g000"]),
            (CatalogFilter { color: Some("blue".into()), ..f.clone() }, vec!["b", "g000"]),
            (CatalogFilter { query: Some("g07".into()), ..f.clone() }, vec!["g070", "g071", "g072", "g073", "g074"]),
            (CatalogFilter { media: "videos".into(), ..f.clone() }, vec!["video"]),
        ] {
            let head = db.catalog_ids(&scope, 0, 60).unwrap();
            assert_eq!(head, vec![expected.last().unwrap().to_string()]);
            assert_eq!(db.catalog_overview(&scope, None).unwrap().total, 1);
            let groups = db.catalog_generation_groups(&scope, &head).unwrap();
            assert_eq!(groups[&head[0]].iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), expected);
        }
        db.conn.lock().unwrap().execute("UPDATE assets SET library_hidden=1 WHERE id='g074'", []).unwrap();
        assert_eq!(db.catalog_ids(&f, 0, 1).unwrap(), vec!["g073"]);
        assert_eq!(db.catalog_generation_groups(&f, &["g073".into()]).unwrap()["g073"].len(), 75);
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
