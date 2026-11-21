use super::video_asset_revision::{source, FileStamp};
use crate::{
    db::Database,
    error::{AppError, AppResult},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDescription {
    text: String,
    stamp: FileStamp,
}

#[derive(Serialize)]
pub struct VideoAnalysis {
    text: String,
}

fn current_description(db: &Database, asset_id: &str) -> AppResult<Option<VideoAnalysis>> {
    let Some(payload) = db.current_video_analysis_payload(asset_id)? else {
        return Ok(None);
    };
    let record: StoredDescription = serde_json::from_str(&payload)?;
    let Ok(original) = source(db, asset_id) else {
        return Ok(None);
    };
    if FileStamp::read(&original).as_ref().ok() != Some(&record.stamp)
        || record.text.trim().is_empty()
    {
        return Ok(None);
    }
    // An index change or a newly committed result may have arrived while checking the original.
    if db.current_video_analysis_payload(asset_id)?.as_deref() != Some(payload.as_str()) {
        return Ok(None);
    }
    Ok(Some(VideoAnalysis { text: record.text }))
}

#[tauri::command]
pub async fn video_analysis_get(
    db: State<'_, Arc<Database>>,
    asset_id: String,
) -> AppResult<Option<VideoAnalysis>> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || current_description(&db, &asset_id))
        .await
        .map_err(|_| AppError::Other("暂时无法读取视频画面描述".into()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        commands::video_asset_revision::{registration, save_revision, snapshot_source},
        core::{catalog_browser::CatalogFilter, library::Analysis},
    };
    use serde_json::{json, Value};
    use std::{fs, path::Path};

    fn description_fixture(db: &Database, asset_id: &str, text: &str) -> Value {
        let (_, source_hash, stamp) = snapshot_source(db, asset_id).unwrap();
        let mut payload = serde_json::to_value(registration(db, asset_id).unwrap()).unwrap();
        payload["schemaVersion"] = json!(1);
        payload["sourceHash"] = json!(source_hash);
        payload["stamp"] = json!(stamp);
        payload["current"] = json!(true);
        payload["status"] = json!("completed");
        payload["text"] = json!(text);
        payload
    }

    fn save_fixture(db: &Database, asset_id: &str, payload: &Value) -> String {
        let id = format!(
            "video-analysis:{asset_id}:{}",
            payload["sourceHash"].as_str().unwrap()
        );
        save_revision(
            db,
            &Analysis {
                id: id.clone(),
                asset_id: asset_id.into(),
                kind: "video_analysis".into(),
                payload: payload.to_string(),
                provider: Some("fixture-vision".into()),
                created_at: None,
            },
            true,
        )
        .unwrap();
        id
    }

    fn update_index(db: &Database, path: &Path, mtime: i64) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE assets SET size=?1,file_mtime=?2 WHERE id='video'",
                (fs::metadata(path).unwrap().len() as i64, mtime),
            )
            .unwrap();
    }

    fn assert_search(db: &Database, query: &str, expected: &[&str]) {
        let filter = CatalogFilter {
            kind: "all".into(),
            media: "videos".into(),
            query: Some(query.into()),
            ..Default::default()
        };
        let legacy: Vec<String> = db
            .search_assets(query, None, 10)
            .unwrap()
            .into_iter()
            .map(|asset| asset.id)
            .collect();
        assert_eq!(legacy, expected);
        assert_eq!(db.catalog_ids(&filter, 0, 10).unwrap(), expected);
    }

    #[test]
    fn video_description_search_and_read_follow_saved_original_revision() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("test.mp4");
        fs::write(&path, b"original").unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.conn.lock().unwrap().execute(
            "INSERT INTO assets(id,name,ext,store_path,created_at) VALUES('video','fixture','mp4',?1,1),('image','other','jpg',?1,1)",
            [path.to_str().unwrap()],
        ).unwrap();
        update_index(&db, &path, 1);

        let first = description_fixture(&db, "video", "暖色城市 100%_构图");
        let original_id = save_fixture(&db, "video", &first);
        save_fixture(&db, "image", &first);
        assert_search(&db, "100%_ 暖色", &["video"]);
        assert_search(&db, "暖色 -城市", &[]);
        assert!(current_description(&db, "image").unwrap().is_none());
        assert_eq!(
            current_description(&db, "video").unwrap().unwrap().text,
            "暖色城市 100%_构图"
        );

        // Direct reads detect an original change before the folder watcher updates the catalog.
        fs::write(&path, b"replacement").unwrap();
        assert!(current_description(&db, "video").unwrap().is_none());
        update_index(&db, &path, 2);
        assert_search(&db, "暖色", &[]);
        let second = description_fixture(&db, "video", "雪山倒影");
        let second_id = save_fixture(&db, "video", &second);
        assert_ne!(original_id, second_id);
        assert_search(&db, "雪山", &["video"]);
        let mut incomplete = second;
        incomplete.as_object_mut().unwrap().remove("indexedHash");
        save_fixture(&db, "video", &incomplete);
        assert_search(&db, "雪山", &[]);
        assert!(current_description(&db, "video").unwrap().is_none());

        fs::write(&path, b"original").unwrap();
        update_index(&db, &path, 3);
        let restored = description_fixture(&db, "video", "暖色城市 100%_构图");
        assert_eq!(save_fixture(&db, "video", &restored), original_id);
        assert_search(&db, "暖色", &["video"]);
        assert_eq!(db.list_analyses_by_asset("video").unwrap().len(), 2);
    }
}
