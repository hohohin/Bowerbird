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
use rusqlite::OptionalExtension;

const MAX_WORKSPACE: usize = 256 * 1024 * 1024;
const MAX_LAYERS: usize = 100;
const MAX_HISTORY: usize = 30;
const HISTORY_DOCUMENTS: [&str; 2] = ["documents", "redoDocuments"];
static WORKFLOW_EXPORT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

mod storage;
use storage::{load_workspace, save_workspace};

fn workflow_export_key(source: &str, document: &Value) -> String {
    let mut hash = Sha256::new();
    hash.update(source.as_bytes());
    hash.update([0]);
    hash.update(document.to_string().as_bytes());
    format!("{:x}", hash.finalize())
}

fn cached_workflow_export(db: &Database, key: &str) -> Result<Option<Asset>, AppError> {
    let id: Option<String> = db.conn.lock().unwrap().query_row(
        "SELECT asset_id FROM analyses WHERE kind='workflow_layer_product' AND payload=?1 ORDER BY created_at DESC LIMIT 1",
        [key], |row| row.get(0),
    ).optional()?;
    Ok(id.map(|id| db.get_asset(&id)).transpose()?.flatten().filter(|asset|
        asset.store_path.as_ref().is_some_and(|path| std::path::Path::new(path).is_file())))
}

fn invalid() -> AppError {
    AppError::Other("分层工程数据无效或超出大小限制".into())
}

pub(super) fn image_bytes(url: &str) -> Result<Vec<u8>, AppError> {
    let (head, encoded) = url.split_once(',').ok_or_else(invalid)?;
    let mime = head.strip_prefix("data:").and_then(|head| head.strip_suffix(";base64")).ok_or_else(invalid)?;
    decode_image(mime, encoded)
}

fn decode_image(mime: &str, encoded: &str) -> Result<Vec<u8>, AppError> {
    if encoded.len() > (30_usize * 1024 * 1024).div_ceil(3) * 4 {
        return Err(invalid());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| invalid())?;
    validate_image(mime, &bytes)?;
    Ok(bytes)
}

fn validate_image(mime: &str, bytes: &[u8]) -> Result<(), AppError> {
    let format = image::guess_format(bytes).map_err(|_| invalid())?;
    if !matches!((mime, format), ("image/png", image::ImageFormat::Png) | ("image/jpeg", image::ImageFormat::Jpeg)) {
        return Err(invalid());
    }
    let (width, height) =
        image::ImageReader::with_format(std::io::Cursor::new(bytes), format).into_dimensions()?;
    if width == 0 || height == 0 || width as u64 * height as u64 > 36_000_000 {
        return Err(invalid());
    }
    Ok(())
}

fn is_color(value: &Value) -> bool {
    value.as_str().is_some_and(|color| color.len() == 7
        && color.starts_with('#')
        && color[1..].bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn is_font(value: &Value, maximum: usize) -> bool {
    value.as_str().is_some_and(|font| !font.is_empty() && font.len() <= maximum)
}

const TEXT_STYLES: [&str; 5] = ["bold", "italic", "underline", "strikethrough", "shadow"];

fn optional_text_flags(value: &Value, fields: &[&str]) -> bool {
    fields.iter().all(|field| value.get(field).is_none_or(Value::is_boolean))
}

fn valid_text_runs(text: &Value) -> bool {
    let Some(runs) = text.get("runs") else { return true; };
    let Some(runs) = runs.as_array() else { return false; };
    let length = text["content"].as_str().unwrap_or_default().encode_utf16().count() as u64;
    if runs.len() as u64 > length { return false; }
    let mut previous_end = 0;
    runs.iter().all(|run| {
        let Some(start) = run["start"].as_u64() else { return false; };
        let Some(end) = run["end"].as_u64() else { return false; };
        let ordered = start >= previous_end && end > start && end <= length;
        previous_end = end;
        ordered && run.get("fontFamily").is_none_or(|font| is_font(font, 256))
            && run.get("color").is_none_or(is_color)
            && optional_text_flags(run, &TEXT_STYLES)
    })
}

fn valid_ocr_bounds(value: &Value, width: u64, height: u64) -> bool {
    let rectangle = |bounds: &Value, max_x: u64, max_y: u64| {
        let Some(points) = bounds.as_array().filter(|points| points.len() == 4) else { return false; };
        match (points[0].as_u64(), points[1].as_u64(), points[2].as_u64(), points[3].as_u64()) {
            (Some(left), Some(top), Some(right), Some(bottom)) => {
                left < right && top < bottom && right <= max_x && bottom <= max_y
            }
            _ => false,
        }
    };
    let absolute = value.get("absolute");
    let normalized = value.get("normalized");
    (absolute.is_some() || normalized.is_some())
        && absolute.is_none_or(|item| rectangle(item, width, height))
        && normalized.is_none_or(|item| rectangle(item, 1000, 1000))
}

fn valid_recognition(value: &Value, width: u64, height: u64) -> bool {
    let valid_text = |value: &Value| value.as_str().is_some_and(|text| !text.trim().is_empty() && text.encode_utf16().count() <= 5000);
    if !valid_text(&value["text"]) { return false; }
    let Some(lines) = value["lines"].as_array().filter(|lines| !lines.is_empty() && lines.len() <= 200) else { return false; };
    let mut run_count = 0;
    let mut text_length = 0;
    lines.iter().all(|line| {
        let Some(runs) = line["runs"].as_array().filter(|runs| !runs.is_empty()) else { return false; };
        run_count += runs.len();
        run_count <= 1000 && valid_ocr_bounds(&line["bounding_box"], width, height) && runs.iter().all(|run| {
            let style = &run["style"];
            run["text"].as_str().is_some_and(|text| {
                text_length += text.encode_utf16().count();
                !text.is_empty() && !text.contains(['\r', '\n']) && text_length <= 5000
            })
                && style.is_object()
                && style.get("similar_font_family").is_none_or(|font| font.as_str().is_some_and(|name| !name.trim().is_empty() && name.encode_utf16().count() <= 200))
                && style.get("foreground_color").is_none_or(is_color)
                && optional_text_flags(style, &TEXT_STYLES)
                && optional_text_flags(style, &["translucent"])
        })
    })
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
            || layers.len() > MAX_LAYERS
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
            if !layer["textRecognition"].is_null()
                && (index == 0 || !valid_recognition(&layer["textRecognition"], w, h))
            {
                return Err(invalid());
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
                    || !is_font(&text["fontFamily"], 256)
                    || !text["bold"].is_boolean()
                    || !matches!(text["align"].as_str(), Some("left" | "center" | "right"))
                    || !is_color(&text["color"])
                    || !optional_text_flags(text, &TEXT_STYLES)
                    || !valid_text_runs(text)
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
    validate_workspace_impl(value, true)
}

fn validate_workspace_impl(value: &Value, check_images: bool) -> Result<(), AppError> {
    if !value.is_object() { return Err(invalid()); }
    let doc = &value["document"];
    validate_document(doc, check_images)?;
    if !value["history"].is_null() {
        let history = &value["history"];
        let images = history["images"].as_array().ok_or_else(invalid)?;
        if images.len() > HISTORY_DOCUMENTS.len() * MAX_HISTORY * MAX_LAYERS {
            return Err(invalid());
        }
        if check_images {
            for image in images {
                image_bytes(image.as_str().ok_or_else(invalid)?)?;
            }
        }
        let current_count = doc["layers"].as_array().map_or(0, Vec::len);
        for field in HISTORY_DOCUMENTS {
            let Some(stack) = history.get(field) else {
                if field == "documents" { return Err(invalid()); }
                continue;
            };
            let documents = stack.as_array().filter(|docs| docs.len() <= MAX_HISTORY).ok_or_else(invalid)?;
            for snapshot in documents {
                validate_document(snapshot, false)?;
                for layer in snapshot["layers"].as_array().ok_or_else(invalid)? {
                    let index = layer["image"].as_i64().ok_or_else(invalid)?;
                    let valid = if index < 0 { index.unsigned_abs() <= current_count as u64 } else { (index as usize) < images.len() };
                    if !valid {
                        return Err(invalid());
                    }
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
        if check_images {
            decode_image("image/jpeg", pending["image"]["base64"].as_str().unwrap())?;
        }
    }
    Ok(())
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
    tokio::task::spawn_blocking(move || load_workspace(&paths, &db, &asset_id))
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
    tokio::task::spawn_blocking(move || save_workspace(&paths, &db, &asset_id, workspace))
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
    workflow: Option<bool>,
) -> Result<Asset, AppError> {
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    let asset = tokio::task::spawn_blocking(move || export_layer_asset(&paths, &db, asset_id, document, data_url, project_id, workflow.unwrap_or(false)))
        .await.map_err(|error| AppError::Other(error.to_string()))??;
    let _ = app.emit("library://assets-changed", ());
    Ok(asset)
}

fn export_layer_asset(paths: &LibraryPaths, db: &Database, asset_id: String, document: Value, data_url: String, project_id: Option<String>, workflow: bool) -> Result<Asset, AppError> {
        let _export_lock = if workflow { Some(WORKFLOW_EXPORT_LOCK.lock().unwrap()) } else { None };
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
        let export_key = workflow.then(|| workflow_export_key(&asset_id, &workspace["document"]));
        if let Some(key) = &export_key {
            let project = project_id.as_ref().ok_or_else(|| AppError::Other("工作流产物必须归属画板".into()))?;
            if let Some(asset) = cached_workflow_export(&db, key)? {
                db.add_assets_to_project(project, std::slice::from_ref(&asset.id))?;
                return Ok(asset);
            }
        }
        let bytes = image_bytes(&data_url)?;
        let suffix = if workflow { workspace["document"]["layers"].as_array().and_then(|layers| layers.iter().find(|layer| layer["visible"] == true)).and_then(|layer| layer["name"].as_str()).unwrap_or("分层产物") } else { "分层编辑" };
        let name = format!("{}-{}", source.name, suffix);
        let temporary = paths
            .root
            .join("layers")
            .join(format!("{}.png", Ulid::new()));
        std::fs::create_dir_all(temporary.parent().unwrap())?;
        std::fs::write(&temporary, &bytes)?;
        // Manual exports remain independent; workflow exports are keyed above.
        let destination = paths.for_project(db, project_id.as_deref())?;
        let result = ingest::ingest_generated_with_visibility(&destination, &db, &temporary, None, "layer-edit", workflow);
        let _ = std::fs::remove_file(&temporary);
        let mut asset = result?;
        db.conn.lock().unwrap().execute(
            "UPDATE assets SET name=?1,origin_path=NULL WHERE id=?2",
            rusqlite::params![name, asset.id],
        )?;
        asset.name = name;
        asset.origin_path = None;
        save_workspace(&paths, &db, &asset.id, workspace)?;
        if let Some(key) = export_key {
            db.insert_analysis(&crate::core::library::Analysis { id: Ulid::new().to_string(), asset_id: asset.id.clone(), kind: "workflow_layer_product".into(), payload: key, provider: None, created_at: None })?;
        }
        if let Some(id) = project_id {
            db.add_assets_to_project(&id, std::slice::from_ref(&asset.id))?;
        }
        Ok::<_, AppError>(asset)
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
        let download_url = cloud.config().generation_transfer_url(url, false).ok_or_else(invalid)?;
        let mut response = cloud
            .http()
            .get(download_url)
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
        layer["text"]["runs"] = json!([{"start":0,"end":3,"italic":true,"underline":true,"strikethrough":false,"shadow":true}]);
        layer["textRecognition"] = json!({"text":"可编辑","lines":[{"bounding_box":{"absolute":[0,0,34,12],"normalized":[0,0,340,120]},"runs":[{"text":"可编辑","style":{"similar_font_family":"SimSun","foreground_color":"#FF0000","bold":false,"italic":true,"underline":true,"strikethrough":false,"shadow":true,"translucent":false}}]}]});
        let workspace = json!({"document":{"schemaVersion":1,"width":100,"height":100,"layers":[base,layer]},"pending":null});
        assert!(validate_workspace(&workspace).is_ok());
        // Workflow layer export must keep a background in slot zero, even when hidden.
        let mut foreground_export = workspace.clone();
        foreground_export["document"]["layers"][0]["visible"] = json!(false);
        assert!(validate_workspace(&foreground_export).is_ok());
        let mut broken_export = foreground_export.clone();
        broken_export["document"]["layers"] = json!([workspace["document"]["layers"][1]]);
        assert!(validate_workspace(&broken_export).is_err());
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
        empty_text["document"]["layers"][1]["text"].as_object_mut().unwrap().remove("runs");
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
            ("italic", json!("yes")),
            ("runs", json!([{"start":0,"end":4},{"start":3,"end":5}])),
        ] {
            let mut invalid_text = workspace.clone();
            invalid_text["document"]["layers"][1]["text"][key] = value;
            assert!(validate_workspace(&invalid_text).is_err());
        }
        let mut bad_ocr = workspace;
        bad_ocr["document"]["layers"][1]["textRecognition"]["lines"][0]["bounding_box"]["absolute"] = json!([0,0,101,10]);
        assert!(validate_workspace(&bad_ocr).is_err());
    }
    #[test]
    fn rejects_escaping_and_invalid_workspaces() {
        assert!(validate_workspace(
            &json!({"document":{"schemaVersion":1,"width":999999,"height":10,"layers":[]}})
        )
        .is_err());
        assert!(validate_workspace(&json!({"document":null,"pending":null})).is_ok());
        assert!(image_bytes("data:image/svg+xml;base64,AAAA").is_err());
    }
    #[test]
    fn workflow_exports_reuse_assets_and_stay_out_of_central_library() {
        let root = std::env::temp_dir().join(format!("bowerbird-product-test-{}", Ulid::new()));
        let paths = LibraryPaths::init(root.clone()).unwrap();
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO assets(id,name) VALUES('source','source')", []).unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at,updated_at,last_opened_at) VALUES('p','p','p','p',1,1,1)", []).unwrap();
        // Catch even temporary visibility during insertion, before export finalization.
        db.conn.lock().unwrap().execute_batch(
            "CREATE TABLE inserted_layer_visibility(hidden INTEGER);
             CREATE TRIGGER record_layer_visibility AFTER INSERT ON assets WHEN NEW.source='layer-edit'
             BEGIN INSERT INTO inserted_layer_visibility VALUES(NEW.library_hidden); END;"
        ).unwrap();
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(8,8).write_to(&mut png, image::ImageFormat::Png).unwrap();
        let url = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png.into_inner()));
        let doc = json!({"schemaVersion":1,"width":8,"height":8,"layers":[{"id":"base","name":"底图","description":"","dataUrl":url,"background":true,"visible":true,"opacity":1,"x":0,"y":0,"width":8,"height":8}]});
        let first = export_layer_asset(&paths,&db,"source".into(),doc.clone(),url.clone(),Some("p".into()),true).unwrap();
        let second = export_layer_asset(&paths,&db,"source".into(),doc.clone(),url.clone(),Some("p".into()),true).unwrap();
        assert_eq!(first.id,second.id); assert!(second.library_hidden);
        assert_eq!(db.conn.lock().unwrap().query_row("SELECT count(*) FROM assets",[],|r|r.get::<_,i64>(0)).unwrap(),2);
        let mut changed=doc.clone();changed["layers"][0]["opacity"]=json!(0.5);
        let edited=export_layer_asset(&paths,&db,"source".into(),changed,url.clone(),Some("p".into()),true).unwrap();
        assert_ne!(edited.id,first.id);
        let manual=export_layer_asset(&paths,&db,"source".into(),doc,url,Some("p".into()),false).unwrap();
        assert_ne!(manual.id,first.id);assert!(!manual.library_hidden);
        let inserted: Vec<bool> = db.conn.lock().unwrap().prepare("SELECT hidden FROM inserted_layer_visibility ORDER BY rowid")
            .unwrap().query_map([], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(inserted, vec![true, true, false]);
        let collection = db.save_collection_node(None, "分层产物", None).unwrap();
        db.set_collection_members(&collection, &[first.id.clone(), edited.id.clone(), manual.id.clone()], true).unwrap();
        for project in [None, Some("p")] {
            for kind in ["tags", "collections"] {
                let assets = db.material_catalog_assets(kind, None, project).unwrap();
                assert_eq!(assets.iter().map(|asset| &asset.id).collect::<Vec<_>>(), vec![&manual.id]);
            }
        }
        for asset in [&first, &edited] {
            assert!(db.get_asset(&asset.id).unwrap().unwrap().library_hidden);
            assert!(std::path::Path::new(asset.store_path.as_ref().unwrap()).is_file());
            assert!(db.list_analyses_by_asset(&asset.id).unwrap().iter().any(|analysis| analysis.kind == "layer_workspace"));
        }
        drop(db);std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn saves_revisions_and_preserves_last_good_workspace() {
        let root = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::init(root.path().to_path_buf()).unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute("INSERT INTO assets(id,name) VALUES('source','source')", [])
            .unwrap();
        let first = json!({"document":null,"pending":{"request":{"idempotency_key":"one"},"userId":"owner"}});
        let old_name = format!("{}.json", Ulid::new());
        let workspace_root = paths.root.join("layers");
        std::fs::create_dir_all(&workspace_root).unwrap();
        std::fs::write(workspace_root.join(&old_name), serde_json::to_vec(&first).unwrap()).unwrap();
        db.conn.lock().unwrap().execute(
            "INSERT INTO analyses(id, asset_id, kind, payload) VALUES('old', 'source', 'layer_workspace', ?1)",
            [&old_name],
        ).unwrap();
        assert_eq!(load_workspace(&paths, &db, "source").unwrap(), Some(first.clone()));
        assert!(save_workspace(&paths, &db, "source", json!({"document":{"width":0}})).is_err());
        assert_eq!(load_workspace(&paths, &db, "source").unwrap(), Some(first.clone()));
        let second = json!({"document":null,"pending":null});
        db.conn.lock().unwrap().execute_batch(
            "CREATE TRIGGER fail_layer_save BEFORE INSERT ON analyses WHEN NEW.kind='layer_workspace'
             BEGIN SELECT RAISE(ABORT, 'fixture'); END;"
        ).unwrap();
        assert!(save_workspace(&paths, &db, "source", second.clone()).is_err());
        assert_eq!(load_workspace(&paths, &db, "source").unwrap(), Some(first));
        assert_eq!(std::fs::read_dir(&workspace_root).unwrap().count(), 1);
        db.conn.lock().unwrap().execute_batch("DROP TRIGGER fail_layer_save").unwrap();

        save_workspace(&paths, &db, "source", second.clone()).unwrap();
        assert_eq!(load_workspace(&paths, &db, "source").unwrap(), Some(second));
        assert_eq!(db.list_analyses_by_asset("source").unwrap().len(), 1);
        assert_eq!(std::fs::read_dir(&workspace_root).unwrap().count(), 1);
        assert!(!workspace_root.join(old_name).exists());
        assert!(save_workspace(&paths, &db, "missing", json!({"document":null})).is_err());
    }

    fn raster(size: u32, marker: u8) -> String {
        let mut pixels = image::RgbaImage::new(size, size);
        pixels.put_pixel(0, 0, image::Rgba([marker, 0, 0, 255]));
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(pixels).write_to(&mut png, image::ImageFormat::Png).unwrap();
        format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png.into_inner()))
    }

    fn document_with_images(size: u32, images: Vec<String>) -> Value {
        let layers: Vec<_> = images.into_iter().enumerate().map(|(index, data_url)| {
            let mut layer = json!({
                "id":format!("layer-{index}"),"name":"图层","description":"",
                "background":index==0,"visible":true,"opacity":1,"x":0,"y":0,"width":size,"height":size,
            });
            layer["dataUrl"] = Value::String(data_url);
            layer
        }).collect();
        let mut document = json!({"schemaVersion":1,"width":size,"height":size});
        document["layers"] = Value::Array(layers);
        document
    }

    #[test]
    fn directory_persists_large_layer_history_and_frozen_cloud_references() {
        let root = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::init(root.path().to_path_buf()).unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO assets(id,name) VALUES('source','source')", []).unwrap();
        let document = document_with_images(128, (0..100).map(|marker| raster(128, marker)).collect());
        let mut snapshot = document.clone();
        for (index, layer) in snapshot["layers"].as_array_mut().unwrap().iter_mut().enumerate() {
            layer.as_object_mut().unwrap().remove("dataUrl");
            layer["image"] = json!(-1 - index as i64);
        }
        snapshot["layers"][2]["image"] = json!(0);
        let cloud_ref = document["layers"][0]["dataUrl"].as_str().unwrap().split_once(',').unwrap().1;
        let workspace = json!({
            "document":document,"pending":{"request":{"reference_images":[{"mime":"image/png","base64":cloud_ref}]},"userId":"u"},
            "history":{"images":[raster(128, 101)],"documents":[snapshot],"redoDocuments":[snapshot]}
        });
        let mut too_many = workspace.clone();
        let mut extra = too_many["document"]["layers"][1].clone();
        extra["id"] = json!("layer-100");
        too_many["document"]["layers"].as_array_mut().unwrap().push(extra);
        assert!(validate_workspace(&too_many).is_err());
        save_workspace(&paths, &db, "source", workspace.clone()).unwrap();
        assert_eq!(load_workspace(&paths, &db, "source").unwrap(), Some(workspace.clone()));
        let row = db.list_analyses_by_asset("source").unwrap().pop().unwrap();
        let directory = paths.root.join("layers").join(row.payload);
        let manifest = std::fs::read_to_string(directory.join("manifest.json")).unwrap();
        assert!(!manifest.contains("data:image/png"));
        assert!(!manifest.contains(cloud_ref));
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 102);

        let manifest: Value = serde_json::from_str(&manifest).unwrap();
        let media = directory.join(manifest["workspace"]["document"]["layers"][0]["dataUrl"].as_str().unwrap());
        std::fs::write(media, b"tampered").unwrap();
        assert!(load_workspace(&paths, &db, "source").is_err());
        save_workspace(&paths, &db, "source", workspace).unwrap();
        assert!(load_workspace(&paths, &db, "source").unwrap().is_some());
        assert!(!directory.exists());
    }

    #[cfg(windows)]
    fn memory_working_set() -> (usize, usize) {
        #[repr(C)]
        struct Counters {
            size: u32,
            page_faults: u32,
            peak: usize,
            resident: usize,
            rest: [usize; 6],
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn K32GetProcessMemoryInfo(handle: windows::Win32::Foundation::HANDLE, counters: *mut Counters, size: u32) -> i32;
        }
        let size = std::mem::size_of::<Counters>() as u32;
        let mut counters = Counters { size, page_faults: 0, peak: 0, resident: 0, rest: [0; 6] };
        unsafe {
            assert_ne!(K32GetProcessMemoryInfo(windows::Win32::System::Threading::GetCurrentProcess(), &mut counters, size), 0);
        }
        (counters.resident, counters.peak)
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "manual isolated benchmark, run each BOWERBIRD_LAYER_BENCH_FORMAT in a separate process"]
    fn benchmark_fifty_2k_layer_save() {
        let mode = std::env::var("BOWERBIRD_LAYER_BENCH_FORMAT").unwrap();
        let root = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::init(root.path().to_path_buf()).unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO assets(id,name) VALUES('source','source')", []).unwrap();

        let images: Vec<_> = (1..=50_u32).map(|seed| {
            let mut pixels = image::RgbaImage::new(2048, 2048);
            let mut state = seed;
            // Partly transparent full-size frames with a deterministic high-detail region.
            for y in 0..512 {
                for x in 0..512 {
                    state ^= state << 13;
                    state ^= state >> 17;
                    state ^= state << 5;
                    pixels.put_pixel(x, y, image::Rgba(state.to_le_bytes()));
                }
            }
            let mut png = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(pixels).write_to(&mut png, image::ImageFormat::Png).unwrap();
            format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png.into_inner()))
        }).collect();
        let mut workspace = json!({"pending":null});
        workspace["document"] = document_with_images(2048, images);
        let mut snapshot = workspace["document"].as_object().unwrap().iter().filter(|(key, _)| *key != "layers")
            .map(|(key, value)| (key.clone(), value.clone())).collect::<serde_json::Map<_, _>>();
        let snapshots: Vec<Value> = workspace["document"]["layers"].as_array().unwrap().iter().enumerate().map(|(index, layer)| {
            let mut properties: serde_json::Map<_, _> = layer.as_object().unwrap().iter().filter(|(key, _)| *key != "dataUrl")
                .map(|(key, value)| (key.clone(), value.clone())).collect();
            properties.insert("image".into(), json!(-1 - index as i64));
            Value::Object(properties)
        }).collect();
        snapshot.insert("layers".into(), json!(snapshots));
        workspace["history"] = json!({ "images": [], "documents": vec![Value::Object(snapshot); 30] });

        let (before, before_peak) = memory_working_set();
        let output = paths.root.join("layers");
        let start = std::time::Instant::now();
        match mode.as_str() {
            "legacy" => {
                use std::io::Write;
                std::fs::create_dir_all(&output).unwrap();
                // Historical JSON write path after lifting its layer-count cap for the comparison.
                let bytes = serde_json::to_vec(&workspace).unwrap();
                assert!(bytes.len() <= MAX_WORKSPACE);
                validate_workspace(&workspace).unwrap();
                let mut output = std::fs::File::create(output.join("legacy.json")).unwrap();
                output.write_all(&bytes).unwrap();
                output.sync_all().unwrap();
            }
            "directory" => save_workspace(&paths, &db, "source", workspace).unwrap(),
            _ => panic!("use legacy or directory"),
        }
        let elapsed = start.elapsed();
        let (_, peak) = memory_working_set();
        fn directory_bytes(path: &std::path::Path) -> u64 {
            std::fs::read_dir(path).unwrap().map(|entry| {
                let entry = entry.unwrap();
                let metadata = entry.metadata().unwrap();
                if metadata.is_dir() { directory_bytes(&entry.path()) } else { metadata.len() }
            }).sum()
        }
        println!("{mode}: elapsed_ms={}, baseline_rss={}, baseline_peak_rss={}, peak_rss={}, disk_bytes={}", elapsed.as_millis(), before, before_peak, peak, directory_bytes(&output));
    }
}
