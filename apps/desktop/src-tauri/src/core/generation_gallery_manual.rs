use std::collections::{BTreeMap, BTreeSet};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use crate::{db::Database, error::{AppError, AppResult}};
use super::WORKFLOW_GALLERY_CTE;
use crate::core::catalog_browser::generation_display_group;

#[cfg(test)]
#[path = "generation_gallery_manual_tests.rs"]
mod tests;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryMergeInput {
    #[serde(default)] pub asset_ids: Vec<String>,
    #[serde(default)] pub job_ids: Vec<String>,
    #[serde(default)] pub node_ids: Vec<String>,
    pub project_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryMerge {
    pub group_key: String,
    pub previous: BTreeMap<String, Option<String>>,
}

fn aliases(conn: &Connection) -> AppResult<BTreeMap<String, String>> {
    Ok(conn.prepare("SELECT source_key,group_key FROM generation_gallery_merges")?
        .query_map([], |row| Ok((row.get(0)?,row.get(1)?)))?.collect::<Result<_,_>>()?)
}

impl Database {
    /// Submission order, scoped to the project; neither completion order nor UI focus.
    pub fn previous_gallery_generation(&self, project_id: Option<&str>) -> AppResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.query_row(&format!("WITH {WORKFLOW_GALLERY_CTE} SELECT t.id FROM task_queue t
            WHERE t.kind='generation' AND t.project_id IS ?1 AND json_valid(t.payload)
            AND COALESCE(json_extract(t.payload,'$.media'),'image')='image'
            AND COALESCE(json_extract(t.payload,'$.internal_agent'),0)=0
            AND NOT EXISTS(SELECT 1 FROM workflow_jobs w WHERE w.job_id=t.id)
            ORDER BY COALESCE(json_extract(t.payload,'$.created_at'),t.created_at) DESC,t.rowid DESC LIMIT 1"), [project_id], |row| row.get(0)).optional()?)
    }

    pub fn merge_generation_galleries(&self, input: GalleryMergeInput) -> AppResult<GalleryMerge> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let before = aliases(&tx)?;
        let mut keys = BTreeSet::new();
        let group = generation_display_group("'asset:'||a.id");
        for id in input.asset_ids.iter().collect::<BTreeSet<_>>() {
            let row: Option<(String,String)> = tx.query_row(&format!("WITH {WORKFLOW_GALLERY_CTE}
                SELECT {group},lower(COALESCE(a.ext,'')) FROM assets a WHERE a.id=?1 AND a.store_path IS NOT NULL
                AND NOT EXISTS(SELECT 1 FROM removed_missing_asset_originals m WHERE m.asset_id=a.id)"), [id], |row| Ok((row.get(0)?,row.get(1)?))).optional()?;
            let Some((key, ext)) = row else { return Err(AppError::Other("所选图片已不可用，请刷新后重试".into())); };
            if !["png","jpg","jpeg","webp","gif","bmp","svg","avif","tif","tiff","ico"].contains(&ext.as_str()) {
                return Err(AppError::Other("请选择至少两张图片或图片组".into()));
            }
            keys.insert(key);
        }
        for id in input.job_ids.iter().collect::<BTreeSet<_>>() {
            let key: Option<String> = tx.query_row("SELECT 'generation:'||COALESCE(json_extract(payload,'$.conversation_id'),id)
                FROM task_queue WHERE id=?1 AND kind='generation' AND project_id IS ?2
                AND COALESCE(json_extract(payload,'$.media'),'image')='image'
                AND COALESCE(json_extract(payload,'$.internal_agent'),0)=0", params![id,input.project_id], |row| row.get(0)).optional()?;
            let key = key.ok_or_else(|| AppError::Other("上个生成已不可用，本次结果将独立保留".into()))?;
            let current = before.get(&key).cloned().unwrap_or_else(|| key.clone());
            let separated: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM generation_gallery_separations WHERE group_key=?1)", [&current], |row| row.get(0))?;
            keys.insert(if separated { key } else { current });
        }
        if keys.len()<2 { return Err(AppError::Other("所选图片已在同一组，请选择不同图片或图片组".into())); }
        // Flatten aliases so later results from member sources join the same gallery.
        let mut sources: BTreeSet<String> = keys.iter().filter(|key| !key.starts_with("manual:")).cloned()
            .chain(before.iter().filter(|(_,group)| keys.contains(*group)).map(|(source,_)| source.clone())).collect();
        for id in input.node_ids.iter().collect::<BTreeSet<_>>() {
            let asset: Option<String> = tx.query_row("SELECT asset_id FROM canvas_nodes WHERE id=?1 AND project_id IS ?2 AND kind='asset' AND hidden_at IS NULL",
                params![id,input.project_id],|r|r.get(0)).optional()?.flatten();
            if asset.is_some_and(|asset| input.asset_ids.contains(&asset)) { sources.insert(format!("node:{id}")); }
        }
        let group_key = format!("manual:{}",ulid::Ulid::new());
        let previous = sources.iter().map(|source| (source.clone(),before.get(source).cloned())).collect();
        for source in sources {
            tx.execute("INSERT INTO generation_gallery_merges(source_key,group_key) VALUES(?1,?2)
                ON CONFLICT(source_key) DO UPDATE SET group_key=excluded.group_key", params![source,group_key])?;
        }
        tx.commit()?;
        Ok(GalleryMerge { group_key, previous })
    }

    pub fn undo_generation_gallery_merge(&self, edit: GalleryMerge) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let current = aliases(&tx)?;
        // Toast and canvas shortcut share a receipt; repeated undo is harmless.
        if edit.previous.iter().all(|(key,value)| current.get(key)==value.as_ref()) { return Ok(()); }
        if edit.previous.is_empty() || !edit.group_key.starts_with("manual:") || edit.previous.keys().any(|key| current.get(key)!=Some(&edit.group_key)) {
            return Err(AppError::Other("这个组合已再次修改，请先撤销后续合组".into()));
        }
        for (source,group) in edit.previous {
            if let Some(group) = group { tx.execute("UPDATE generation_gallery_merges SET group_key=?2 WHERE source_key=?1",params![source,group])?; }
            else { tx.execute("DELETE FROM generation_gallery_merges WHERE source_key=?1",[source])?; }
        }
        tx.commit()?;
        Ok(())
    }
}
