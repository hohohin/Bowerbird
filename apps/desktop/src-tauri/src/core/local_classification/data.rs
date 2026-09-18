use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{AppError, AppResult};

pub const MODEL_ID: &str = "qwen3.5-0.8b-q4km-f16/b10809/v1";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Label {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub count: i64,
    pub has_examples: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Prediction {
    pub description: String,
    pub tags: Vec<String>,
    pub matches: Vec<String>,
}

pub fn clean_label(raw: &str) -> AppResult<String> {
    let name = raw.trim().trim_start_matches('#').trim();
    if name.is_empty() || name.chars().count() > 40 || name.chars().any(char::is_control) {
        return Err(AppError::Other("标签需为 1–40 个字符，不能包含换行".into()));
    }
    Ok(name.to_string())
}

pub fn parse_prediction(raw: &str, allowed: &[Label], discover: bool) -> AppResult<Prediction> {
    let raw = raw.trim();
    let raw = raw
        .strip_prefix("```json")
        .or_else(|| raw.strip_prefix("```"))
        .map(|s| s.trim().trim_end_matches("```").trim())
        .unwrap_or(raw);
    let mut value: Prediction = serde_json::from_str(raw)
        .map_err(|_| AppError::Other("本地模型未返回有效分类结果，此图未写入标签".into()))?;
    if value.description.chars().count() > 1200
        || value.tags.len() > 6
        || value.matches.len() > allowed.len()
    {
        return Err(AppError::Other(
            "本地分类结果超出限制，此图未写入标签".into(),
        ));
    }
    if !discover && !value.tags.is_empty() {
        return Err(AppError::Other("匹配已有标签时模型返回了新标签".into()));
    }
    value.tags = value
        .tags
        .iter()
        .map(|s| clean_label(s))
        .collect::<AppResult<Vec<_>>>()?;
    value.tags.sort();
    value.tags.dedup();
    value.matches.sort();
    value.matches.dedup();
    if value
        .matches
        .iter()
        .any(|id| !allowed.iter().any(|label| label.id == *id))
    {
        return Err(AppError::Other(
            "本地模型返回了未知标签，此图未写入标签".into(),
        ));
    }
    Ok(value)
}

impl Database {
    pub fn local_labels(&self) -> AppResult<Vec<Label>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT t.id,t.name,t.classification_description,t.classification_enabled,COUNT(a.asset_id), \
             EXISTS(SELECT 1 FROM asset_tags m WHERE m.tag_id=t.id AND m.origin='manual') \
             OR EXISTS(SELECT 1 FROM local_tag_rejections r WHERE r.tag_id=t.id) \
             FROM tags t LEFT JOIN asset_tags a ON a.tag_id=t.id GROUP BY t.id ORDER BY COUNT(a.asset_id) DESC,t.name")?;
        let rows = stmt.query_map([], |r| {
            Ok(Label {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                enabled: r.get(3)?,
                count: r.get(4)?,
                has_examples: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn local_revision(&self) -> AppResult<i64> {
        Ok(self.conn.lock().unwrap().query_row(
            "SELECT revision FROM local_classification_state WHERE id=1",
            [],
            |r| r.get(0),
        )?)
    }

    pub fn local_enabled(&self) -> AppResult<bool> {
        Ok(self.conn.lock().unwrap().query_row(
            "SELECT enabled FROM local_classification_state WHERE id=1",
            [],
            |r| r.get(0),
        )?)
    }

    pub fn set_local_enabled(&self, enabled: bool) -> AppResult<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE local_classification_state SET enabled=?1 WHERE id=1",
            [enabled],
        )?;
        Ok(())
    }

    pub fn save_local_label(
        &self,
        id: Option<&str>,
        name: &str,
        description: &str,
        enabled: bool,
    ) -> AppResult<String> {
        let name = clean_label(name)?;
        if description.chars().count() > 600 {
            return Err(AppError::Other("分类说明最多 600 字".into()));
        }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM tags WHERE name=?1 COLLATE NOCASE",
                [&name],
                |r| r.get(0),
            )
            .optional()?;
        if existing
            .as_deref()
            .is_some_and(|existing| Some(existing) != id)
        {
            return Err(AppError::Other("同名标签已存在，请编辑已有标签".into()));
        }
        let result = if let Some(id) = id {
            if tx.execute("UPDATE tags SET name=?2,classification_description=?3,classification_enabled=?4 WHERE id=?1",
                params![id, name, description.trim(), enabled])? != 1 {
                return Err(AppError::Other("标签已不存在".into()));
            }
            id.to_string()
        } else {
            let id = ulid::Ulid::new().to_string();
            tx.execute("INSERT INTO tags(id,name,source,classification_description,classification_enabled) VALUES(?1,?2,'manual',?3,?4)",
                params![id,name,description.trim(),enabled])?;
            id
        };
        tx.execute(
            "UPDATE local_classification_state SET revision=revision+1 WHERE id=1",
            [],
        )?;
        if enabled {
            tx.execute(
                "INSERT OR IGNORE INTO local_label_jobs VALUES(?1)",
                [&result],
            )?;
        }
        tx.commit()?;
        Ok(result)
    }

    /// Explicit edits are authoritative even if an inference is already in flight.
    pub fn edit_classification_tags(
        &self,
        asset_id: &str,
        names: &[String],
        source: &str,
    ) -> AppResult<()> {
        if source != "auto" && source != "manual" {
            return Err(AppError::Other("无效标签来源".into()));
        }
        let names = names
            .iter()
            .map(|n| clean_label(n))
            .collect::<AppResult<Vec<_>>>()?;
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let mut ids = Vec::new();
        for name in names {
            let id: Option<String> = tx
                .query_row(
                    "SELECT id FROM tags WHERE name=?1 COLLATE NOCASE",
                    [&name],
                    |r| r.get(0),
                )
                .optional()?;
            let id = match id {
                Some(id) => id,
                None => {
                    let id = ulid::Ulid::new().to_string();
                    tx.execute(
                        "INSERT INTO tags(id,name,source) VALUES(?1,?2,?3)",
                        params![id, name, source],
                    )?;
                    id
                }
            };
            ids.push(id);
        }
        let old: Vec<String> = {
            let mut stmt = tx.prepare("SELECT a.tag_id FROM asset_tags a JOIN tags t ON t.id=a.tag_id WHERE a.asset_id=?1 AND t.source=?2")?;
            let rows = stmt.query_map(params![asset_id, source], |r| r.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        for id in old.iter().filter(|id| !ids.contains(id)) {
            tx.execute(
                "INSERT OR IGNORE INTO local_tag_rejections VALUES(?1,?2)",
                params![asset_id, id],
            )?;
            tx.execute(
                "DELETE FROM asset_tags WHERE asset_id=?1 AND tag_id=?2",
                params![asset_id, id],
            )?;
        }
        for id in ids {
            tx.execute(
                "DELETE FROM local_tag_rejections WHERE asset_id=?1 AND tag_id=?2",
                params![asset_id, id],
            )?;
            // Do not mark every unchanged automatic association as a new positive example.
            tx.execute("INSERT INTO asset_tags(asset_id,tag_id,origin) VALUES(?1,?2,'manual') \
                ON CONFLICT(asset_id,tag_id) DO UPDATE SET origin=CASE WHEN ?3 THEN asset_tags.origin ELSE 'manual' END",
                params![asset_id,id,old.contains(&id)])?;
            if !old.contains(&id) {
                tx.execute("INSERT OR IGNORE INTO local_label_jobs VALUES(?1)", [&id])?;
            }
        }
        tx.execute(
            "UPDATE local_classification_state SET revision=revision+1 WHERE id=1",
            [],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn local_targets(&self, pending_only: bool) -> AppResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT a.id FROM assets a WHERE a.thumb_path IS NOT NULL \
            AND lower(COALESCE(a.ext,'')) IN ('jpg','jpeg','png','webp','gif','bmp') \
            AND (?1=0 OR NOT EXISTS(SELECT 1 FROM local_visual_observations o WHERE o.asset_id=a.id AND o.model=?2)) \
            ORDER BY a.created_at,a.id")?;
        let rows = stmt.query_map(params![pending_only, MODEL_ID], |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn pending_local_label(&self) -> AppResult<Option<String>> {
        Ok(self.conn.lock().unwrap().query_row("SELECT j.tag_id FROM local_label_jobs j JOIN tags t ON t.id=j.tag_id WHERE t.classification_enabled=1 ORDER BY j.rowid LIMIT 1", [], |r| r.get(0)).optional()?)
    }

    pub fn finish_local_label(&self, tag: &str, revision: i64) -> AppResult<()> {
        self.conn.lock().unwrap().execute("DELETE FROM local_label_jobs WHERE tag_id=?1 AND (SELECT revision FROM local_classification_state WHERE id=1)=?2", params![tag,revision])?;
        Ok(())
    }

    pub fn local_example(&self, tag: &str, assets: &[String], positive: bool) -> AppResult<()> {
        if assets.is_empty() || assets.len() > 100 {
            return Err(AppError::Other("请选择 1–100 张示例素材".into()));
        }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        for asset in assets {
            if positive {
                tx.execute(
                    "DELETE FROM local_tag_rejections WHERE asset_id=?1 AND tag_id=?2",
                    params![asset, tag],
                )?;
                tx.execute("INSERT INTO asset_tags(asset_id,tag_id,origin) VALUES(?1,?2,'manual') ON CONFLICT(asset_id,tag_id) DO UPDATE SET origin='manual'",params![asset,tag])?;
            } else {
                tx.execute(
                    "DELETE FROM asset_tags WHERE asset_id=?1 AND tag_id=?2",
                    params![asset, tag],
                )?;
                tx.execute(
                    "INSERT OR IGNORE INTO local_tag_rejections VALUES(?1,?2)",
                    params![asset, tag],
                )?;
            }
        }
        tx.execute(
            "UPDATE local_classification_state SET revision=revision+1 WHERE id=1",
            [],
        )?;
        tx.execute("INSERT OR IGNORE INTO local_label_jobs VALUES(?1)", [tag])?;
        tx.commit()?;
        Ok(())
    }

    pub fn local_image_path(&self, id: &str) -> AppResult<Option<String>> {
        Ok(self
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT thumb_path FROM assets WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()?
            .flatten())
    }

    /// User-added images and explicit rejections supply visual examples; auto labels never teach themselves.
    pub fn local_examples(&self, tag: &str, exclude: &str) -> AppResult<Vec<(String, bool)>> {
        let conn = self.conn.lock().unwrap();
        let mut result = Vec::new();
        for (sql, positive) in [
            ("SELECT a.asset_id FROM asset_tags a JOIN assets s ON s.id=a.asset_id WHERE a.tag_id=?1 AND a.origin='manual' AND a.asset_id<>?2 AND s.thumb_path IS NOT NULL ORDER BY a.asset_id LIMIT 2", true),
            ("SELECT a.asset_id FROM local_tag_rejections a JOIN assets s ON s.id=a.asset_id WHERE a.tag_id=?1 AND a.asset_id<>?2 AND s.thumb_path IS NOT NULL ORDER BY a.asset_id LIMIT 1", false),
        ] {
            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map(params![tag,exclude], |r| r.get::<_,String>(0))?;
            for row in rows { result.push((row?,positive)); }
        }
        Ok(result)
    }

    /// One image is committed atomically. A concurrent human edit invalidates the whole prediction.
    pub fn apply_local_prediction(
        &self,
        asset: &str,
        revision: i64,
        prediction: &Prediction,
        record_observation: bool,
        evaluated: &[String],
    ) -> AppResult<bool> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let current: i64 = tx.query_row(
            "SELECT revision FROM local_classification_state WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        if current != revision {
            return Ok(false);
        }
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1)",
            [asset],
            |r| r.get(0),
        )?;
        if !exists {
            return Ok(false);
        }
        // Re-evaluating a changed label may remove only our own previous automatic assignments.
        for id in evaluated
            .iter()
            .filter(|id| !prediction.matches.contains(id))
        {
            tx.execute(
                "DELETE FROM asset_tags WHERE asset_id=?1 AND tag_id=?2 AND origin='local'",
                params![asset, id],
            )?;
        }
        let mut ids = prediction.matches.clone();
        for raw in &prediction.tags {
            let name = clean_label(raw)?;
            let existing: Option<(String, bool)> = tx
                .query_row(
                    "SELECT id,classification_enabled FROM tags WHERE name=?1 COLLATE NOCASE",
                    [&name],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            match existing {
                Some((id, true)) => ids.push(id),
                Some((_, false)) => {}
                None => {
                    let id = ulid::Ulid::new().to_string();
                    tx.execute(
                        "INSERT INTO tags(id,name,source) VALUES(?1,?2,'auto')",
                        params![id, name],
                    )?;
                    ids.push(id);
                }
            }
        }
        for id in ids {
            tx.execute(
                "INSERT OR IGNORE INTO asset_tags(asset_id,tag_id,origin) \
                SELECT ?1,id,'local' FROM tags WHERE id=?2 AND classification_enabled=1 \
                AND NOT EXISTS(SELECT 1 FROM local_tag_rejections WHERE asset_id=?1 AND tag_id=?2)",
                params![asset, id],
            )?;
        }
        if record_observation {
            tx.execute("INSERT INTO local_visual_observations(asset_id,model,description,created_at) VALUES(?1,?2,?3,?4) \
                ON CONFLICT(asset_id) DO UPDATE SET model=excluded.model,description=excluded.description,created_at=excluded.created_at",
                params![asset,MODEL_ID,prediction.description,chrono::Utc::now().timestamp()])?;
        }
        tx.commit()?;
        Ok(true)
    }
}
