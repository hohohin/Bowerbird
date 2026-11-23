//! Closed-service fixture for revision-bound publication through the existing classification transaction.
use super::{
    cloud,
    data::{parse_prediction, Label},
};
use crate::{
    core::external_files::{fingerprint, preview_key},
    db::Database,
    error::{AppError, AppResult},
};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

#[derive(Debug, PartialEq, Eq)]
struct TextRevision {
    path: PathBuf,
    source_hash: String,
    registry_path: String,
    version: String,
    inputs: Vec<(String, [u8; 32])>,
}

impl TextRevision {
    fn capture(db: &Database, id: &str) -> AppResult<Option<Self>> {
        let Ok(path) = db.resolve_asset_original(id) else { return Ok(None) };
        if !db.connected_source_matches(id, &path)? {
            return Ok(None);
        }
        let version = preview_key(&path, &fs::metadata(&path)?)?;
        let source_hash = fingerprint(&path)?;
        if preview_key(&path, &fs::metadata(&path)?)? != version {
            return Ok(None);
        }
        let conn = db.conn.lock().unwrap();
        let Some(registry_path) = registered_path(&conn, id)? else {
            return Ok(None);
        };
        let inputs = revision_inputs(&conn, id, &source_hash)?;
        Ok((!inputs.is_empty()).then_some(Self {
            path,
            source_hash,
            registry_path,
            version,
            inputs,
        }))
    }

    fn publish(
        &self,
        db: &Database,
        id: &str,
        rule_revision: i64,
        allowed: &[Label],
        response: &str,
        discovery: Option<&str>,
    ) -> AppResult<bool> {
        if Self::capture(db, id)?.as_ref() != Some(self) {
            return Ok(false);
        }
        let mut prediction = parse_prediction(response, allowed, false)?;
        let mut definitions = Vec::new();
        if prediction.matches.is_empty() {
            if let Some(response) = discovery {
                let result = cloud::parse(response, allowed).map_err(AppError::Other)?;
                prediction.matches = result.matches;
                prediction.description = result.description;
                prediction.tags = result
                    .labels
                    .iter()
                    .map(|label| label.name.clone())
                    .collect();
                definitions = result.labels;
            }
        }
        let evaluated: Vec<String> = allowed.iter().map(|label| label.id.clone()).collect();
        db.apply_classification_with_guard(
            id,
            rule_revision,
            &prediction,
            false,
            &evaluated,
            "jev-video-text",
            &definitions,
            |tx| {
                if registered_path(tx, id)?.as_deref() != Some(self.registry_path.as_str())
                    || revision_inputs(tx, id, &self.source_hash)? != self.inputs
                {
                    return Ok(false);
                }
                Ok(fs::metadata(&self.path)
                    .ok()
                    .and_then(|meta| preview_key(&self.path, &meta).ok())
                    .as_deref()
                    == Some(self.version.as_str()))
            },
        )
    }
}

fn registered_path(db: &Connection, id: &str) -> AppResult<Option<String>> {
    Ok(db
        .query_row(
            "SELECT store_path FROM assets WHERE id=?1
         AND NOT EXISTS(SELECT 1 FROM trashed_asset_originals WHERE asset_id=?1)
         AND NOT EXISTS(SELECT 1 FROM removed_missing_asset_originals WHERE asset_id=?1)",
            [id],
            |row| row.get(0),
        )
        .optional()?)
}

fn revision_inputs(db: &Connection, id: &str, sha: &str) -> AppResult<Vec<(String, [u8; 32])>> {
    let mut stmt = db.prepare(
        "SELECT kind, json_extract(payload,'$.text') FROM analyses WHERE asset_id=?1 AND json_valid(payload)
         AND kind IN ('video_transcript','video_analysis') AND json_extract(payload,'$.sourceHash')=?2
         AND json_extract(payload,'$.status')='completed' AND json_extract(payload,'$.current')=1
         AND json_type(payload,'$.text')='text' ORDER BY kind,id",
    )?;
    let rows = stmt.query_map(params![id, sha], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut available = Vec::new();
    for row in rows {
        let (kind, text) = row?;
        if !text.trim().is_empty() {
            available.push((kind, Sha256::digest(text.as_bytes()).into()));
        }
    }
    Ok(available)
}

struct Fixture {
    db: Database,
    path: PathBuf,
    _dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.mp4");
        fs::write(&path, b"original video").unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.conn.lock().unwrap().execute(
            "INSERT INTO assets(id,name,ext,store_path,created_at) VALUES ('video','示例','mp4',?1,1)",
            [path.to_str().unwrap()],
        ).unwrap();
        Self {
            db,
            path,
            _dir: dir,
        }
    }

    fn set_text(&self, kind: &str, text: &str) {
        self.db.conn.lock().unwrap().execute(
            "INSERT OR REPLACE INTO analyses(id,asset_id,kind,payload,created_at) VALUES (?1,'video',?1,?2,1)",
            params![kind, serde_json::json!({
                "sourceHash": fingerprint(&self.path).unwrap(), "text": text,
                "status": "completed", "current": true,
            }).to_string()],
        ).unwrap();
    }

    fn revision(&self) -> TextRevision {
        TextRevision::capture(&self.db, "video")
            .unwrap()
            .unwrap()
    }
}

#[test]
fn publication_rechecks_text_source_and_rules_and_keeps_manual_exclusions() {
    let fixture = Fixture::new();
    let db = &fixture.db;
    let manual = db.save_local_label(None, "人工", "", true).unwrap();
    let excluded = db.save_local_label(None, "排除", "", true).unwrap();
    let automatic = db.save_local_label(None, "自动", "", true).unwrap();
    db.local_example(&manual, &["video".into()], true).unwrap();
    db.local_example(&excluded, &["video".into()], false)
        .unwrap();
    let text =
        serde_json::json!({ "description": "", "tags": [], "matches": [excluded, automatic] })
            .to_string();
    let labels = db.local_labels().unwrap();
    let rules = db.local_revision().unwrap();

    assert!(TextRevision::capture(db, "video")
        .unwrap()
        .is_none());
    fixture.set_text("video_transcript", "原始口播");
    let first = fixture.revision();
    fixture.set_text("video_analysis", "球员挥拍");
    assert!(!first
        .publish(db, "video", rules, &labels, &text, None)
        .unwrap());
    let second = fixture.revision();
    assert!(!second
        .publish(db, "video", rules - 1, &labels, &text, None)
        .unwrap());
    let unknown = r#"{"description":"","tags":[],"matches":["unapproved"]}"#;
    assert!(second
        .publish(db, "video", rules, &labels, unknown, None)
        .is_err());
    assert!(second
        .publish(db, "video", rules, &labels, &text, None)
        .unwrap());
    let origins = db.conn.lock().unwrap();
    let mut statement = origins
        .prepare("SELECT tag_id,origin FROM asset_tags WHERE asset_id='video' ORDER BY origin")
        .unwrap();
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        rows,
        [(automatic, "local".into()), (manual, "manual".into())]
    );
    drop(statement);
    drop(origins);

    fs::write(&fixture.path, b"swapped! video").unwrap();
    assert!(!second
        .publish(db, "video", rules, &labels, &text, None)
        .unwrap());
}

#[test]
fn discovery_reuses_existing_label_provenance_transaction() {
    let fixture = Fixture::new();
    let db = &fixture.db;
    fixture.set_text("video_analysis", "球员挥拍");
    let judge = r#"{"description":"","tags":[],"matches":[]}"#;
    let discover = r#"{"status":"new_label","label":{"name":"挥拍训练","definition":"训练中反复挥拍","exclusion":"球赛观众","reason":"未收录这类训练","english":{"name":"Swing training","description":"Repeated practice swings. Exclude spectators."}}}"#;
    let revision = fixture.revision();
    assert!(revision
        .publish(
            db,
            "video",
            db.local_revision().unwrap(),
            &[],
            judge,
            Some(discover)
        )
        .unwrap());
    let label = db
        .local_labels()
        .unwrap()
        .into_iter()
        .find(|label| label.name == "挥拍训练")
        .unwrap();
    let provenance = label.provenance.as_ref().unwrap();
    assert_eq!(provenance.kind, "cloud");
    assert_eq!(provenance.asset_id.as_deref(), Some("video"));
    assert_eq!(provenance.reason.as_deref(), Some("未收录这类训练"));
}
