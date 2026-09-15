//! Local layered-image workspaces and the existing authenticated Cloud job transport.
use crate::cloud::{AuthClient, CloudClient};
use crate::core::{ingest, library::Asset, paths::LibraryPaths};
use crate::db::Database;
use crate::error::AppError;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use ulid::Ulid;

const MAX_WORKSPACE: usize = 256 * 1024 * 1024;

fn invalid() -> AppError {
    AppError::Other("分层工程数据无效或超出大小限制".into())
}

pub(super) fn image_bytes(url: &str) -> Result<Vec<u8>, AppError> {
    let (head, encoded) = url.split_once(',').ok_or_else(invalid)?;
    if !matches!(head, "data:image/png;base64" | "data:image/jpeg;base64")
        || encoded.len() > 42 * 1024 * 1024
    {
        return Err(invalid());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| invalid())?;
    let format = image::guess_format(&bytes).map_err(|_| invalid())?;
    if !matches!(format, image::ImageFormat::Png | image::ImageFormat::Jpeg) {
        return Err(invalid());
    }
    let (width, height) =
        image::ImageReader::with_format(std::io::Cursor::new(&bytes), format).into_dimensions()?;
    if width == 0 || height == 0 || width as u64 * height as u64 > 36_000_000 {
        return Err(invalid());
    }
    Ok(bytes)
}

fn validate_document(doc: &Value, check_images: bool) -> Result<(), AppError> {
    if !doc.is_null() {
        let w = doc["width"].as_u64().ok_or_else(invalid)?;
        let h = doc["height"].as_u64().ok_or_else(invalid)?;
        let layers = doc["layers"].as_array().ok_or_else(invalid)?;
        if doc["schemaVersion"] != 1
            || w == 0
            || h == 0
            || w > 6000
            || h > 6000
            || w * h > 36_000_000
            || layers.is_empty()
            || layers.len() > 17
        {
            return Err(invalid());
        }
        let mut ids = std::collections::HashSet::new();
        for (index, layer) in layers.iter().enumerate() {
            let id = layer["id"].as_str().ok_or_else(invalid)?;
            if id.is_empty()
                || !ids.insert(id)
                || layer["background"].as_bool() != Some(index == 0)
                || !layer["visible"].is_boolean()
            {
                return Err(invalid());
            }
            for key in ["x", "y", "width", "height", "opacity"] {
                let number = layer[key].as_f64().ok_or_else(invalid)?;
                if !number.is_finite() || number.abs() > 100_000.0 {
                    return Err(invalid());
                }
                if matches!(key, "width" | "height") && number <= 0.0 {
                    return Err(invalid());
                }
                if key == "opacity" && !(0.0..=1.0).contains(&number) {
                    return Err(invalid());
                }
            }
            if check_images {
                image_bytes(layer["dataUrl"].as_str().ok_or_else(invalid)?)?;
            }
            for field in ["text", "textBackup"] {
                let text = &layer[field];
                if text.is_null() {
                    continue;
                }
                if index == 0
                    || !text.is_object()
                    || text["content"]
                        .as_str()
                        .is_none_or(|s| s.chars().count() > 5000)
                    || text["fontFamily"]
                        .as_str()
                        .is_none_or(|s| s.is_empty() || s.len() > 256)
                    || !text["bold"].is_boolean()
                    || !matches!(text["align"].as_str(), Some("left" | "center" | "right"))
                    || text["color"].as_str().is_none_or(|s| {
                        s.len() != 7
                            || !s.starts_with('#')
                            || !s[1..].bytes().all(|b| b.is_ascii_hexdigit())
                    })
                {
                    return Err(invalid());
                }
                for (key, min, max) in [
                    ("fontSize", 1.0, 2000.0),
                    ("lineHeight", 0.5, 5.0),
                    ("letterSpacing", -50.0, 200.0),
                    ("boxWidth", 1.0, 6000.0),
                    ("boxHeight", 1.0, 6000.0),
                ] {
                    if text[key]
                        .as_f64()
                        .is_none_or(|v| !v.is_finite() || v < min || v > max)
                    {
                        return Err(invalid());
                    }
                }
            }
        }
    }
    Ok(())
}

pub(super) fn validate_workspace(value: &Value) -> Result<(), AppError> {
    let doc = &value["document"];
    validate_document(doc, true)?;
    if !value["history"].is_null() {
        let history = &value["history"];
        let images = history["images"].as_array().ok_or_else(invalid)?;
        let documents = history["documents"].as_array().ok_or_else(invalid)?;
        if images.len() > 510 || documents.len() > 30 {
            return Err(invalid());
        }
        for image in images {
            image_bytes(image.as_str().ok_or_else(invalid)?)?;
        }
        for snapshot in documents {
            if snapshot.is_null() {
                return Err(invalid());
            }
            validate_document(snapshot, false)?;
            for layer in snapshot["layers"].as_array().ok_or_else(invalid)? {
                let index = layer["image"].as_i64().ok_or_else(invalid)?;
                if index < 0 {
                    let current_index = index
                        .checked_neg()
                        .and_then(|v| v.checked_sub(1))
                        .ok_or_else(invalid)? as usize;
                    if !doc["layers"]
                        .as_array()
                        .is_some_and(|layers| current_index < layers.len())
                    {
                        return Err(invalid());
                    }
                } else if index as usize >= images.len() {
                    return Err(invalid());
                }
            }
        }
    }
    if !value["pending"].is_null()
        && (!value["pending"]["request"].is_object() || !value["pending"]["userId"].is_string())
    {
        return Err(invalid());
    }
    if !value["textPending"].is_null() {
        let pending = &value["textPending"];
        if (!pending["allowCreate"].is_null() && !pending["allowCreate"].is_boolean())
            || !value["pending"].is_null()
            || pending["idempotencyKey"]
                .as_str()
                .is_none_or(|s| s.is_empty() || s.len() > 200)
            || !pending["userId"].is_string()
            || !doc["layers"].as_array().is_some_and(|layers| {
                layers
                    .iter()
                    .any(|layer| layer["id"] == pending["layerId"] && layer["background"] == false)
            })
            || pending["image"]["mime"] != "image/jpeg"
            || pending["image"]["base64"]
                .as_str()
                .is_none_or(|s| s.len() > 1_398_100)
        {
            return Err(invalid());
        }
        image_bytes(&format!(
            "data:image/jpeg;base64,{}",
            pending["image"]["base64"].as_str().unwrap()
        ))?;
    }
    Ok(())
}

fn save_workspace(
    paths: &LibraryPaths,
    db: &Database,
    asset_id: &str,
    workspace: &Value,
) -> Result<(), AppError> {
    if db.get_asset(asset_id)?.is_none() {
        return Err(AppError::Other("原素材已不存在".into()));
    }
    let bytes = serde_json::to_vec(workspace)?;
    if bytes.len() > MAX_WORKSPACE {
        return Err(invalid());
    }
    validate_workspace(workspace)?;
    let directory = paths.root.join("layers");
    std::fs::create_dir_all(&directory)?;
    // Immutable file + transactional pointer swap: interruption never truncates the last save.
    let name = format!("{}.json", Ulid::new());
    let file = directory.join(&name);
    {
        use std::io::Write;
        let mut output = std::fs::File::create(&file)?;
        output.write_all(&bytes)?;
        output.sync_all()?;
    }
    let result = (|| -> Result<Vec<String>, AppError> {
        let mut conn = db.conn.lock().unwrap();
        let transaction = conn.transaction()?;
        let previous = {
            let mut statement = transaction.prepare(
                "SELECT payload FROM analyses WHERE asset_id=?1 AND kind='layer_workspace'",
            )?;
            let rows = statement.query_map([asset_id], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        transaction.execute(
            "DELETE FROM analyses WHERE asset_id=?1 AND kind='layer_workspace'",
            [asset_id],
        )?;
        transaction.execute("INSERT INTO analyses(id,asset_id,kind,payload,created_at) VALUES(?1,?2,'layer_workspace',?3,?4)", rusqlite::params![Ulid::new().to_string(), asset_id, name, chrono::Utc::now().timestamp()])?;
        transaction.commit()?;
        Ok(previous)
    })();
    match result {
        Ok(previous) => {
            for old in previous {
                if safe_name(&old) {
                    let _ = std::fs::remove_file(directory.join(old));
                }
            }
            Ok(())
        }
        Err(error) => {
            let _ = std::fs::remove_file(file);
            Err(error)
        }
    }
}

fn safe_name(name: &str) -> bool {
    name.strip_suffix(".json")
        .is_some_and(|id| id.parse::<Ulid>().is_ok())
}

#[tauri::command]
pub async fn layer_workspace_asset_ids(
    db: State<'_, Arc<Database>>,
) -> Result<Vec<String>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        let conn = db.conn.lock().unwrap();
        let mut statement =
            conn.prepare("SELECT DISTINCT asset_id FROM analyses WHERE kind='layer_workspace'")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))?
}

#[tauri::command]
pub async fn layer_workspace_load(
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    asset_id: String,
) -> Result<Option<Value>, AppError> {
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        let row = db
            .list_analyses_by_asset(&asset_id)?
            .into_iter()
            .find(|row| row.kind == "layer_workspace");
        let Some(row) = row else {
            return Ok(None);
        };
        if !safe_name(&row.payload) {
            return Err(invalid());
        }
        let file = paths.root.join("layers").join(row.payload);
        if std::fs::metadata(&file)?.len() > MAX_WORKSPACE as u64 {
            return Err(invalid());
        }
        let value = serde_json::from_slice(&std::fs::read(file)?)?;
        validate_workspace(&value)?;
        Ok(Some(value))
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))?
}

#[tauri::command]
pub async fn layer_workspace_save(
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    asset_id: String,
    workspace: Value,
) -> Result<(), AppError> {
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || save_workspace(&paths, &db, &asset_id, &workspace))
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
}

#[tauri::command]
pub async fn layer_export(
    app: AppHandle,
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    asset_id: String,
    document: Value,
    data_url: String,
    project_id: Option<String>,
) -> Result<Asset, AppError> {
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    let asset = tokio::task::spawn_blocking(move || {
        let source = db
            .get_asset(&asset_id)?
            .ok_or_else(|| AppError::Other("原素材已不存在".into()))?;
        if let Some(id) = &project_id {
            if db.get_project(id)?.is_none() {
                return Err(AppError::Other("目标项目已不存在".into()));
            }
        }
        let workspace = json!({ "document": document, "pending": null });
        validate_workspace(&workspace)?;
        let bytes = image_bytes(&data_url)?;
        let name = format!("{}-分层编辑", source.name);
        let temporary = paths
            .root
            .join("layers")
            .join(format!("{}.png", Ulid::new()));
        std::fs::create_dir_all(temporary.parent().unwrap())?;
        std::fs::write(&temporary, &bytes)?;
        // Always produce a new result, even when the composite pixels equal the source.
        let result = ingest::ingest_generated(&paths, &db, &temporary, None, "layer-edit");
        let _ = std::fs::remove_file(&temporary);
        let mut asset = result?;
        db.conn.lock().unwrap().execute(
            "UPDATE assets SET name=?1,origin_path=NULL WHERE id=?2",
            rusqlite::params![name, asset.id],
        )?;
        asset.name = name;
        asset.origin_path = None;
        save_workspace(&paths, &db, &asset.id, &workspace)?;
        if let Some(id) = project_id {
            db.add_assets_to_project(&id, std::slice::from_ref(&asset.id))?;
        }
        Ok::<_, AppError>(asset)
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))??;
    let _ = app.emit("library://assets-changed", ());
    Ok(asset)
}

#[tauri::command]
pub async fn layer_cloud_request(
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    request: Value,
) -> Result<Value, AppError> {
    let action = request["action"].as_str();
    if !matches!(
        action,
        Some("get_by_key") | Some("cancel") | Some("layer_quote")
    ) && (action.is_some()
        || !matches!(
            request["service"].as_str(),
            Some("image_layer_decompose") | Some("image_layer_edit")
        ))
    {
        return Err(invalid());
    }
    let endpoint = cloud
        .config()
        .endpoint("generate-proxy")
        .ok_or_else(|| AppError::Cloud("当前构建未配置 Bowerbird Cloud".into()))?;
    let response = auth
        .send_authorized(
            cloud.http().post(endpoint).json(&request),
            "分层任务请求失败",
        )
        .await?;
    let status_code = response.status().as_u16();
    let success = response.status().is_success();
    let mut result: Value = response
        .json()
        .await
        .map_err(|_| AppError::Cloud("云端分层响应无效".into()))?;
    if !success {
        if status_code == 404 && action == Some("get_by_key") {
            return Ok(json!({"status":"not_found"}));
        }
        if [400, 401, 402, 403, 413, 422].contains(&status_code) && action.is_none() {
            result["status"] = json!("rejected");
            return Ok(result);
        }
        return Err(AppError::Cloud(
            result["error"]["message"]
                .as_str()
                .unwrap_or("分层服务暂不可用，请检查登录、积分与服务配置")
                .into(),
        ));
    }
    if result["status"] == "succeeded" {
        let artifact = &result["artifact"];
        let url = artifact["url"].as_str().ok_or_else(invalid)?;
        let size = artifact["bytes"].as_u64().ok_or_else(invalid)?;
        if artifact["mime"] != "application/json" || size == 0 || size > MAX_WORKSPACE as u64 {
            return Err(invalid());
        }
        let parsed = reqwest::Url::parse(url).map_err(|_| invalid())?;
        let endpoint = reqwest::Url::parse(&cloud.config().endpoint("generate-proxy").unwrap())
            .map_err(|_| invalid())?;
        if parsed.origin() != endpoint.origin() {
            return Err(invalid());
        }
        let mut response = cloud
            .http()
            .get(url)
            .send()
            .await
            .map_err(|_| AppError::Cloud("图层包下载失败，可继续取回原任务".into()))?;
        if !response.status().is_success() {
            return Err(AppError::Cloud("图层包下载失败，可继续取回原任务".into()));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| invalid())? {
            if bytes.len() + chunk.len() > MAX_WORKSPACE {
                return Err(invalid());
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.len() as u64 != size
            || format!("{:x}", Sha256::digest(&bytes)) != artifact["sha256"].as_str().unwrap_or("")
        {
            return Err(AppError::Cloud("图层包完整性校验失败，可重试下载".into()));
        }
        result["layer_result"] = serde_json::from_slice(&bytes)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn text_layers_round_trip_and_reject_invalid_style() {
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(2, 2)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let data_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png.into_inner())
        );
        let base = json!({"id":"base","name":"底图","description":"","dataUrl":data_url,"background":true,"visible":true,"opacity":1,"x":0,"y":0,"width":100,"height":100});
        let mut layer = base.clone();
        layer["id"] = json!("text");
        layer["background"] = json!(false);
        layer["text"] = json!({"content":"可编辑\nBowerbird","fontFamily":"SimSun","fontSize":20,"color":"#ff0000","bold":false,"align":"left","lineHeight":1.2,"letterSpacing":0,"boxWidth":100,"boxHeight":100});
        let workspace = json!({"document":{"schemaVersion":1,"width":100,"height":100,"layers":[base,layer]},"pending":null});
        assert!(validate_workspace(&workspace).is_ok());
        let encoded = serde_json::to_vec(&workspace).unwrap();
        let decoded: Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded, workspace);
        let mut with_history = workspace.clone();
        let mut snapshot = workspace["document"].clone();
        for layer in snapshot["layers"].as_array_mut().unwrap() {
            layer.as_object_mut().unwrap().remove("dataUrl");
            layer["image"] = json!(-1);
        }
        with_history["history"] = json!({"images":[],"documents":[snapshot.clone()]});
        assert!(validate_workspace(&with_history).is_ok());
        with_history["history"]["images"] = json!([workspace["document"]["layers"][0]["dataUrl"]]);
        with_history["history"]["documents"][0]["layers"][0]["image"] = json!(0);
        assert!(validate_workspace(&with_history).is_ok());
        for reference in [json!(-3), json!(1), json!(0.5), json!(i64::MIN)] {
            let mut broken = with_history.clone();
            broken["history"]["documents"][0]["layers"][0]["image"] = reference;
            assert!(validate_workspace(&broken).is_err());
        }
        let mut broken = with_history.clone();
        broken["history"]["documents"][0]["layers"][1]["text"]["fontSize"] = json!(0);
        assert!(validate_workspace(&broken).is_err());
        broken["history"]["documents"] = json!(vec![snapshot; 31]);
        assert!(validate_workspace(&broken).is_err());
        let mut empty_text = workspace.clone();
        empty_text["document"]["layers"][1]["text"]["content"] = json!("");
        assert!(validate_workspace(&empty_text).is_ok());
        let mut image_mode = workspace.clone();
        image_mode["document"]["layers"][1]["textBackup"] =
            image_mode["document"]["layers"][1]["text"].take();
        assert!(validate_workspace(&image_mode).is_ok());
        let decoded: Value =
            serde_json::from_slice(&serde_json::to_vec(&image_mode).unwrap()).unwrap();
        assert_eq!(decoded, image_mode);
        image_mode["document"]["layers"][1]["textBackup"]["fontSize"] = json!(0);
        assert!(validate_workspace(&image_mode).is_err());
        for (key, value) in [
            ("fontSize", json!(0)),
            ("color", json!("red")),
            ("boxWidth", json!(100000)),
            ("content", json!(false)),
        ] {
            let mut invalid_text = workspace.clone();
            invalid_text["document"]["layers"][1]["text"][key] = value;
            assert!(validate_workspace(&invalid_text).is_err());
        }
    }
    #[test]
    fn rejects_escaping_and_invalid_workspaces() {
        assert!(!safe_name("../secret.json"));
        assert!(safe_name(&format!("{}.json", Ulid::new())));
        assert!(validate_workspace(
            &json!({"document":{"schemaVersion":1,"width":999999,"height":10,"layers":[]}})
        )
        .is_err());
        assert!(validate_workspace(&json!({"document":null,"pending":null})).is_ok());
        assert!(image_bytes("data:image/svg+xml;base64,AAAA").is_err());
    }
    #[test]
    fn saves_revisions_and_preserves_last_good_workspace() {
        let root = std::env::temp_dir().join(format!("bowerbird-layers-test-{}", Ulid::new()));
        let paths = LibraryPaths::init(root.clone()).unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute("INSERT INTO assets(id,name) VALUES('source','source')", [])
            .unwrap();
        let first = json!({"document":null,"pending":{"request":{"idempotency_key":"one"},"userId":"owner"}});
        save_workspace(&paths, &db, "source", &first).unwrap();
        let row = db.list_analyses_by_asset("source").unwrap().pop().unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(
                &std::fs::read(paths.root.join("layers").join(row.payload)).unwrap()
            )
            .unwrap(),
            first
        );
        assert!(save_workspace(&paths, &db, "source", &json!({"document":{"width":0}})).is_err());
        let second = json!({"document":null,"pending":null});
        save_workspace(&paths, &db, "source", &second).unwrap();
        assert_eq!(db.list_analyses_by_asset("source").unwrap().len(), 1);
        assert_eq!(
            std::fs::read_dir(paths.root.join("layers"))
                .unwrap()
                .count(),
            1
        );
        assert!(save_workspace(&paths, &db, "missing", &first).is_err());
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
