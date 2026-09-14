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

fn image_bytes(url: &str) -> Result<Vec<u8>, AppError> {
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

fn validate_workspace(value: &Value) -> Result<(), AppError> {
    let doc = &value["document"];
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
            image_bytes(layer["dataUrl"].as_str().ok_or_else(invalid)?)?;
        }
    }
    if !value["pending"].is_null()
        && (!value["pending"]["request"].is_object() || !value["pending"]["userId"].is_string())
    {
        return Err(invalid());
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
