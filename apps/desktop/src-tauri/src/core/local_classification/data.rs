use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{AppError, AppResult};

pub const MODEL_ID: &str = "qwen3.5-0.8b-q4km-f16/b10809/v1";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct EnglishLabel {
    pub name: String,
    pub description: String,
}

impl EnglishLabel {
    pub fn validate(&self, source_description: &str) -> AppResult<()> {
        static NON_ENGLISH: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            regex::Regex::new(r"[^\p{Latin}\p{M}\p{N}\p{P}\p{Z}\p{S}\t\r\n]")
                .expect("English classification validation regex must compile")
        });
        let valid_text = |text: &str, allow_empty: bool| {
            (allow_empty && text.trim().is_empty() || text.chars().any(|c| c.is_ascii_alphabetic()))
                && !NON_ENGLISH.is_match(text)
        };
        if self.name.trim().is_empty() || self.name.chars().count() > 160
            || self.name.chars().any(char::is_control)
            || self.description.chars().count() > 4000
            || (source_description.trim().is_empty() != self.description.trim().is_empty())
            || !valid_text(&self.name, false)
            || !valid_text(&self.description, source_description.trim().is_empty())
        {
            return Err(AppError::Other("分类规则翻译暂未完成，请稍后重试分类".into()));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct BundledEnglishLabel {
    name: String,
    description: String,
    name_en: String,
    description_en: String,
}

/// Exact text matching supplies translations without restoring deleted presets
/// or silently using an old translation after the user changes a rule.
pub fn bundled_label_english(name: &str, description: &str) -> Option<EnglishLabel> {
    static LABELS: std::sync::LazyLock<Vec<BundledEnglishLabel>> = std::sync::LazyLock::new(|| {
        serde_json::from_str(include_str!("../../../resources/classification-labels.en.json"))
            .expect("bundled classification translations must be valid JSON")
    });
    LABELS.iter().find(|label| label.name == name && label.description == description)
        .map(|label| EnglishLabel { name: label.name_en.clone(), description: label.description_en.clone() })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LabelProvenance {
    pub kind: String,
    pub asset_id: Option<String>,
    pub asset_name: Option<String>,
    pub reason: Option<String>,
    pub created_at: i64,
    #[serde(default)]
    pub preview_hash: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Label {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub count: i64,
    pub has_examples: bool,
    #[serde(default)]
    pub dimension: Option<String>,
    #[serde(default)]
    pub provenance: Option<LabelProvenance>,
    #[serde(default)]
    pub english: Option<EnglishLabel>,
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
    /// Translation metadata does not change user rules, classification results,
    /// revision guards, or scan queues. Late replies cannot overwrite an edit.
    pub fn cache_label_english(&self, label: &Label, english: &EnglishLabel) -> AppResult<bool> {
        english.validate(&label.description)?;
        let json = serde_json::to_string(english).map_err(|e| AppError::Other(e.to_string()))?;
        Ok(self.conn.lock().unwrap().execute(
            "UPDATE tags SET classification_english=?4 WHERE id=?1 AND name=?2 AND classification_description=?3 AND classification_english IS NULL",
            params![label.id, label.name, label.description, json],
        )? == 1)
    }

    /// Semantic metadata must never overwrite a concurrent human edit or another
    /// classification result. This does not change assignments or schedule scans.
    pub fn cache_label_dimensions(&self, revision: i64, labels: &[Label], dimensions: &[String]) -> AppResult<bool> {
        if labels.len() != dimensions.len() || dimensions.iter().any(|d| d != "other" && !matches!(d.as_str(), "subject" | "type" | "style" | "mood")) {
            return Err(AppError::Other("标签维度结果无效".into()));
        }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let current: i64 = tx.query_row("SELECT revision FROM local_classification_state WHERE id=1", [], |r| r.get(0))?;
        if current != revision { return Ok(false); }
        for (label, dimension) in labels.iter().zip(dimensions) {
            tx.execute("UPDATE tags SET classification_dimension=?2 WHERE id=?1 AND classification_dimension IS NULL AND name=?3 AND classification_description=?4",
                params![label.id, dimension, label.name, label.description])?;
        }
        tx.commit()?;
        Ok(true)
    }

    pub fn local_label_source(&self, tag_id: &str) -> AppResult<Option<String>> {
        let labels = self.local_labels()?;
        let label = labels.iter().find(|l| l.id == tag_id).ok_or_else(|| AppError::Other("标签已不存在".into()))?;
        let Some(id) = label.provenance.as_ref().and_then(|p| p.asset_id.as_ref()) else { return Ok(None); };
        let expected = label.provenance.as_ref().and_then(|p| p.preview_hash.as_ref());
        Ok(self.get_asset(id)?.and_then(|a| a.thumb_path)
            .filter(|path| expected.is_some() && crate::core::external_files::fingerprint(std::path::Path::new(path)).ok().as_ref() == expected))
    }

    pub fn local_labels(&self) -> AppResult<Vec<Label>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT t.id,t.name,t.classification_description,t.classification_enabled,COUNT(a.asset_id), \
             EXISTS(SELECT 1 FROM asset_tags m WHERE m.tag_id=t.id AND m.origin='manual') \
             OR EXISTS(SELECT 1 FROM local_tag_rejections r WHERE r.tag_id=t.id), t.classification_dimension, t.classification_provenance, t.classification_english \
             FROM tags t LEFT JOIN asset_tags a ON a.tag_id=t.id GROUP BY t.id ORDER BY COUNT(a.asset_id) DESC,t.name")?;
        let rows = stmt.query_map([], |r| {
            let name: String = r.get(1)?;
            let description: String = r.get(2)?;
            let english = r.get::<_, Option<String>>(8)?.map(|json| serde_json::from_str(&json)
                .map_err(|e| rusqlite::Error::FromSqlConversionFailure(8, rusqlite::types::Type::Text, Box::new(e)))).transpose()?
                .or_else(|| bundled_label_english(&name, &description));
            Ok(Label {
                id: r.get(0)?,
                name,
                description,
                enabled: r.get(3)?,
                count: r.get(4)?,
                has_examples: r.get(5)?,
                dimension: r.get(6)?,
                provenance: r.get::<_, Option<String>>(7)?.map(|json| serde_json::from_str(&json)
                    .map_err(|e| rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Text, Box::new(e)))).transpose()?,
                english,
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
            let fixed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM tags t JOIN asset_tags a ON a.tag_id=t.id JOIN analyses p ON p.asset_id=a.asset_id AND p.kind='replication_source' WHERE t.id=?1 AND t.name='#ai生成')", [id], |r| r.get(0))?;
            if fixed && name != "#ai生成" {
                return Err(AppError::Other("视频复刻的 #ai生成 标签不能改名".into()));
            }
            if tx.execute("UPDATE tags SET classification_dimension=CASE WHEN name<>?2 OR classification_description<>?3 THEN NULL ELSE classification_dimension END,classification_english=CASE WHEN name<>?2 OR classification_description<>?3 THEN NULL ELSE classification_english END,name=?2,classification_description=?3,classification_enabled=?4 WHERE id=?1",
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

    /// Foreign keys remove assignments, examples and queued jobs, never assets.
    pub fn delete_local_labels(&self, ids: &[String]) -> AppResult<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let mut deleted = 0;
        for id in ids {
            let fixed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM tags t JOIN asset_tags a ON a.tag_id=t.id JOIN analyses p ON p.asset_id=a.asset_id AND p.kind='replication_source' WHERE t.id=?1 AND t.name='#ai生成')", [id], |r| r.get(0))?;
            if fixed { return Err(AppError::Other("视频复刻的 #ai生成 标签不能删除".into())); }
            deleted += tx.execute("DELETE FROM tags WHERE id=?1", [id])?;
        }
        if deleted > 0 {
            tx.execute(
                "UPDATE local_classification_state SET revision=revision+1 WHERE id=1",
                [],
            )?;
        }
        tx.commit()?;
        Ok(())
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
            let mut stmt = tx.prepare("SELECT a.tag_id FROM asset_tags a JOIN tags t ON t.id=a.tag_id WHERE a.asset_id=?1 AND t.source=?2 \
                AND NOT (t.name='#ai生成' AND EXISTS(SELECT 1 FROM analyses WHERE asset_id=?1 AND kind='replication_source'))")?;
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
        self.local_targets_for_model(pending_only, MODEL_ID)
    }

    /// Explicit full rescan: reset automatic results only within the resolved image scope.
    /// Return only eligible targets; manually classified images remain entirely untouched.
    pub fn reset_classification_results(&self, assets: &[String], revision: i64) -> AppResult<(i64, Vec<String>)> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let current: i64 = tx.query_row("SELECT revision FROM local_classification_state WHERE id=1", [], |r| r.get(0))?;
        if current != revision {
            return Err(AppError::Other("分类已被人工修改，请重新发起扫描".into()));
        }
        let targets = {
            let mut stmt = tx.prepare("SELECT EXISTS(SELECT 1 FROM asset_tags WHERE asset_id=?1 AND origin='manual')")?;
            let mut targets = Vec::new();
            for asset in assets {
                if !stmt.query_row([asset], |r| r.get::<_, bool>(0))? {
                    targets.push(asset.clone());
                }
            }
            targets
        };
        if targets.is_empty() { return Ok((current, targets)); }
        for asset in &targets {
            tx.execute(
                "DELETE FROM asset_tags WHERE asset_id=?1 \
                 AND origin='local' \
                 AND NOT (tag_id IN (SELECT id FROM tags WHERE name='#ai生成') \
                   AND EXISTS(SELECT 1 FROM analyses WHERE asset_id=?1 AND kind='replication_source'))",
                [asset],
            )?;
            tx.execute("DELETE FROM local_visual_observations WHERE asset_id=?1", [asset])?;
        }
        tx.execute("UPDATE local_classification_state SET revision=revision+1 WHERE id=1", [])?;
        tx.commit()?;
        Ok((current + 1, targets))
    }

    pub fn local_targets_for_model(
        &self,
        pending_only: bool,
        model: &str,
    ) -> AppResult<Vec<String>> {
        self.classification_targets(pending_only, model, false)
    }

    pub fn local_auto_targets(&self, model: &str) -> AppResult<Vec<String>> {
        self.classification_targets(true, model, true)
    }

    /// Stopping a scan must not leave its images eligible for the automatic watcher.
    /// Future inserts still enter the queue while the opt-in switch remains enabled.
    pub fn stop_local_auto_pending(&self, project: Option<&str>) -> AppResult<()> {
        self.conn.lock().unwrap().execute(
            "DELETE FROM local_auto_classification_pending WHERE ?1 IS NULL OR asset_id IN \
             (SELECT asset_id FROM project_assets WHERE project_id=?1)", [project])?;
        Ok(())
    }

    fn classification_targets(&self, pending_only: bool, model: &str, automatic: bool) -> AppResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT a.id FROM assets a WHERE a.thumb_path IS NOT NULL \
            AND (?3=0 OR ((SELECT enabled FROM local_classification_state WHERE id=1)=1 \
              AND EXISTS(SELECT 1 FROM local_auto_classification_pending p WHERE p.asset_id=a.id) \
              AND NOT EXISTS(SELECT 1 FROM asset_tags t WHERE t.asset_id=a.id AND t.origin='manual'))) \
            AND lower(COALESCE(a.ext,'')) IN ('jpg','jpeg','png','webp','gif','bmp') \
            AND (?1=0 OR NOT EXISTS(SELECT 1 FROM local_visual_observations o WHERE o.asset_id=a.id AND (o.model=?2 OR (?2 IN ('jev-choice-dimensions/cloud-discovery-v6','jev-choice-flat-top4-30/cloud-discovery-v7','jev-choice-flat-top3-42/cloud-discovery-v8') AND o.model IN ('jev-choice-dimensions/cloud-discovery-v5','jev-choice-dimensions/cloud-discovery-v6','jev-choice-flat-top4-30/cloud-discovery-v7'))))) \
            ORDER BY a.created_at,a.id")?;
        let rows = stmt.query_map(params![pending_only, model, automatic], |r| r.get(0))?;
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
                let fixed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM tags WHERE id=?1 AND name='#ai生成') AND EXISTS(SELECT 1 FROM analyses WHERE asset_id=?2 AND kind='replication_source')", params![tag,asset], |r| r.get(0))?;
                if fixed { return Err(AppError::Other("视频复刻素材的 #ai生成 标签不能取消".into())); }
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
        self.apply_classification_with_definitions(
            asset,
            revision,
            prediction,
            record_observation,
            evaluated,
            MODEL_ID,
            &[],
        )
    }

    pub fn apply_classification_with_definitions(
        &self,
        asset: &str,
        revision: i64,
        prediction: &Prediction,
        record_observation: bool,
        evaluated: &[String],
        model: &str,
        definitions: &[super::cloud::NewLabel],
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
                Some((id, true)) => {
                    ids.push(id);
                },
                Some((_, false)) => {}
                None => {
                    let id = ulid::Ulid::new().to_string();
                    let definition = definitions.iter().find(|d| d.name == name);
                    let english = definition.and_then(|d| d.english.as_ref());
                    if let Some(english) = english {
                        english.validate(definition.map(|d| d.definition.as_str()).unwrap_or(""))?;
                    }
                    let provenance = LabelProvenance {
                        kind: if definition.is_some() { "cloud" } else { "local" }.into(),
                        asset_id: Some(asset.into()),
                        asset_name: Some(tx.query_row("SELECT name FROM assets WHERE id=?1", [asset], |r| r.get::<_, String>(0))?),
                        reason: definition.and_then(|_| serde_json::from_str::<serde_json::Value>(&prediction.description).ok())
                            .and_then(|value| value.get("reason").and_then(|reason| reason.as_str()).map(str::to_owned)),
                        created_at: chrono::Utc::now().timestamp(),
                        preview_hash: tx.query_row("SELECT thumb_path FROM assets WHERE id=?1", [asset], |r| r.get::<_, Option<String>>(0))?
                            .and_then(|path| crate::core::external_files::fingerprint(std::path::Path::new(&path)).ok()),
                    };
                    tx.execute(
                        "INSERT INTO tags(id,name,source,classification_description,classification_provenance,classification_english) VALUES(?1,?2,'auto',?3,?4,?5)",
                        params![id, name, definition.map(|d| d.definition.as_str()).unwrap_or(""), serde_json::to_string(&provenance).map_err(|e| AppError::Other(e.to_string()))?, english.map(serde_json::to_string).transpose().map_err(|e| AppError::Other(e.to_string()))?],
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
                params![asset,model,prediction.description,chrono::Utc::now().timestamp()])?;
        }
        tx.commit()?;
        Ok(true)
    }
}

#[cfg(test)]
mod english_tests {
    use super::*;

    fn database() -> Database {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db
    }

    fn english(name: &str, description: &str) -> EnglishLabel {
        EnglishLabel { name: name.into(), description: description.into() }
    }

    #[test]
    fn bundled_english_matches_all_original_rules_without_restoring_deleted_labels() {
        let db = database();
        db.conn.lock().unwrap().execute_batch(include_str!("../../../resources/classification-labels.sql")).unwrap();
        let original = db.local_labels().unwrap();
        assert_eq!(original.len(), 27);
        for label in &original {
            let translated = label.english.as_ref().unwrap();
            translated.validate(&label.description).unwrap();
            assert_eq!(Some(translated.clone()), bundled_label_english(&label.name, &label.description));
            assert!(bundled_label_english(&label.name, &(label.description.clone() + "修改")).is_none());
            assert!(bundled_label_english(&(label.name.clone() + "修改"), &label.description).is_none());
        }
        assert_eq!(db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM tags WHERE classification_english IS NOT NULL", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        let deleted = &original[0];
        db.delete_local_labels(&[deleted.id.clone()]).unwrap();
        assert_eq!(db.local_labels().unwrap().len(), 26);
        db.save_local_label(Some(&original[1].id), &original[1].name, "人工修改的说明", true).unwrap();
        assert!(db.local_labels().unwrap().iter().find(|l| l.id == original[1].id).unwrap().english.is_none());
    }

    #[test]
    fn english_cache_preserves_user_text_revision_and_queues_and_rejects_stale_replies() {
        let db = database();
        let id = db.save_local_label(None, "手工标签", "排除背景", true).unwrap();
        let label = db.local_labels().unwrap().remove(0);
        let translated = english("Manual Label", "Exclude backgrounds.");
        let revision = db.local_revision().unwrap();
        db.finish_local_label(&id, revision).unwrap();
        assert!(db.cache_label_english(&label, &translated).unwrap());
        assert_eq!(db.local_revision().unwrap(), revision);
        assert!(db.pending_local_label().unwrap().is_none());
        assert!(db.local_auto_targets(MODEL_ID).unwrap().is_empty());
        let saved = db.local_labels().unwrap().remove(0);
        assert_eq!((&saved.name, &saved.description), (&label.name, &label.description));
        assert_eq!(saved.english.as_ref(), Some(&translated));
        assert!(!db.cache_label_english(&label, &english("Late Reply", "Another translation.")).unwrap());

        db.save_local_label(Some(&id), &label.name, "  排除背景  ", false).unwrap();
        assert_eq!(db.local_labels().unwrap().remove(0).english.as_ref(), Some(&translated), "enable changes and normalized whitespace preserve translation");
        db.save_local_label(Some(&id), &label.name, "修改定义", true).unwrap();
        assert!(db.local_labels().unwrap().remove(0).english.is_none());
        assert!(!db.cache_label_english(&label, &translated).unwrap(), "late translations cannot overwrite edited definitions");
        let changed = db.local_labels().unwrap().remove(0);
        assert!(db.cache_label_english(&changed, &translated).unwrap());
        db.save_local_label(Some(&id), "改名标签", &changed.description, true).unwrap();
        assert!(db.local_labels().unwrap().remove(0).english.is_none());
        assert!(!db.cache_label_english(&changed, &translated).unwrap(), "late translations cannot overwrite renamed labels");
        let renamed = db.local_labels().unwrap().remove(0);
        db.delete_local_labels(&[id]).unwrap();
        assert!(!db.cache_label_english(&renamed, &translated).unwrap());
        assert!(db.local_labels().unwrap().is_empty());
    }

    #[test]
    fn english_validation_rejects_untranslated_or_truncated_rules() {
        english(&"a".repeat(160), &"b".repeat(4000)).validate("规则").unwrap();
        english("Cafe - Été", "A café sign; preserve its lettering.\nExclude interiors.").validate("规则").unwrap();
        english("Portrait", "").validate("").unwrap();
        english("Portrait", " \n\t ").validate("").unwrap();
        assert!(english("Portrait", "A newly invented definition.").validate("").is_err());
        assert!(english("Portrait", "A newly invented definition.").validate(" \n\t ").is_err());
        for invalid in [
            english("", "Description"), english("123", "Description"),
            english("海报 Poster", "Description"), english("Poster", "海报"),
            english("Poster", "Описание"), english("Poster", "中文 definition"),
            english("Post\ner", "Description"), english("Poster", "hidden\u{200b}character"),
            english(&"a".repeat(161), "Description"), english("Poster", &"b".repeat(4001)),
            english("Poster", ""),
        ] {
            assert!(invalid.validate("非空中文规则").is_err(), "unexpectedly accepted {invalid:?}");
        }
    }

    #[test]
    fn cloud_creation_stores_english_atomically_and_reuse_preserves_existing_translation() {
        let db = database();
        db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,ext) VALUES('a','source','png')", []).unwrap();
        let prediction = Prediction { description: "cloud result".into(), tags: vec!["新类别".into()], matches: vec![] };
        let translated = english("New Category", "A complete visual definition.");
        let definition = super::super::cloud::NewLabel {
            name: "新类别".into(), definition: "完整的视觉定义".into(), english: Some(translated.clone()),
        };
        assert!(db.apply_classification_with_definitions("a", db.local_revision().unwrap(), &prediction, true, &[], MODEL_ID, &[definition]).unwrap());
        let created = db.local_labels().unwrap().remove(0);
        assert_eq!(created.english.as_ref(), Some(&translated));
        assert_eq!(created.description, "完整的视觉定义");
        let reused = super::super::cloud::NewLabel {
            name: "新类别".into(), definition: "不同定义".into(), english: Some(english("Different", "Different definition.")),
        };
        assert!(db.apply_classification_with_definitions("a", db.local_revision().unwrap(), &prediction, true, &[], MODEL_ID, &[reused]).unwrap());
        assert_eq!(db.local_labels().unwrap().remove(0).english.as_ref(), Some(&translated));

        let invalid = super::super::cloud::NewLabel {
            name: "无效新类别".into(), definition: "必须保留".into(), english: Some(english("Invalid", "")),
        };
        let rejected = Prediction { description: "must not replace observation".into(), tags: vec![invalid.name.clone()], matches: vec![] };
        assert!(db.apply_classification_with_definitions("a", db.local_revision().unwrap(), &rejected, true, &[created.id.clone()], MODEL_ID, &[invalid]).is_err());
        assert_eq!(db.local_labels().unwrap().len(), 1);
        let conn = db.conn.lock().unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM asset_tags WHERE asset_id='a' AND tag_id=?1", [created.id], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(conn.query_row("SELECT description FROM local_visual_observations WHERE asset_id='a'", [], |r| r.get::<_, String>(0)).unwrap(), "cloud result");
    }
}
