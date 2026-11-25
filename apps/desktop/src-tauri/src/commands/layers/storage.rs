use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use super::{
    decode_image, invalid, validate_image, validate_workspace, validate_workspace_impl, AppError,
    Database, LibraryPaths, Value, HISTORY_DOCUMENTS, MAX_WORKSPACE,
};
use base64::Engine;
use serde_json::json;
use sha2::{Digest, Sha256};
use ulid::Ulid;

const MAX_MANIFEST: usize = 64 * 1024 * 1024;
const MAX_IMAGE: usize = 30 * 1024 * 1024;
// The IPC still materializes data URLs. Bound the reconstructed payload and keep the limit
// independent of the older JSON workspace and the Cloud artifact size.
const MAX_ENCODED_MEDIA: usize = 1024 * 1024 * 1024;
static WORKSPACES: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn media_type(mime: &str) -> Result<&'static str, AppError> {
    match mime {
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        _ => Err(invalid()),
    }
}

fn media_name(name: &str) -> Result<(&str, &'static str), AppError> {
    let (digest, extension) = name.split_once('.').ok_or_else(invalid)?;
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    let mime = match extension {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        _ => return Err(invalid()),
    };
    Ok((digest, mime))
}

fn read_limited(path: &Path, limit: usize) -> Result<Vec<u8>, AppError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return Err(invalid());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)?.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit { return Err(invalid()); }
    Ok(bytes)
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let mut output = OpenOptions::new().write(true).create_new(true).open(path)?;
    output.write_all(bytes)?;
    output.sync_all()?;
    Ok(())
}

fn same_media(path: &Path, mut expected: &[u8]) -> bool {
    let mut file = match fs::symlink_metadata(path).and_then(|metadata| {
        if metadata.is_file() && metadata.len() == expected.len() as u64 {
            File::open(path)
        } else {
            Err(std::io::Error::from(std::io::ErrorKind::InvalidData))
        }
    }) {
        Ok(file) => file,
        Err(_) => return false,
    };
    let mut buffer = [0; 64 * 1024];
    while !expected.is_empty() {
        let count = expected.len().min(buffer.len());
        if file.read_exact(&mut buffer[..count]).is_err() || buffer[..count] != expected[..count] {
            return false;
        }
        expected = &expected[count..];
    }
    true
}

fn visit_media(
    workspace: &mut Value,
    mut visit: impl FnMut(&mut Value, Option<&str>) -> Result<(), AppError>,
) -> Result<(), AppError> {
    if let Some(layers) = workspace.pointer_mut("/document/layers").and_then(Value::as_array_mut) {
        for layer in layers { visit(&mut layer["dataUrl"], None)?; }
    }
    if !workspace["history"].is_null() {
        let images = workspace["history"]["images"].as_array_mut().ok_or_else(invalid)?;
        for image in images { visit(image, None)?; }
    }
    if let Some(references) = workspace.pointer_mut("/pending/request/reference_images") {
        let references = references.as_array_mut().filter(|images| images.len() <= 10).ok_or_else(invalid)?;
        for reference in references {
            let mime = reference["mime"].as_str().ok_or_else(invalid)?.to_owned();
            visit(&mut reference["base64"], Some(&mime))?;
        }
    }
    if let Some(image) = workspace.pointer_mut("/textPending/image/base64") {
        visit(image, Some("image/jpeg"))?;
    }
    Ok(())
}

fn image_refs(workspace: &Value) -> Result<(Vec<String>, Vec<String>), AppError> {
    let file_name = |value: &Value| -> Result<String, AppError> {
        let name = value.as_str().ok_or_else(invalid)?;
        media_name(name)?;
        Ok(name.to_owned())
    };
    let current = workspace["document"]["layers"].as_array().into_iter().flatten()
        .map(|layer| file_name(&layer["dataUrl"]))
        .collect::<Result<Vec<_>, _>>()?;
    let history = workspace["history"]["images"].as_array().into_iter().flatten()
        .map(file_name)
        .collect::<Result<Vec<_>, _>>()?;
    Ok((current, history))
}

fn visit_history(
    workspace: &mut Value,
    mut visit: impl FnMut(&mut Value) -> Result<(), AppError>,
) -> Result<(), AppError> {
    if let Some(history) = workspace.get_mut("history") {
        for field in HISTORY_DOCUMENTS {
            let Some(stack) = history.get_mut(field) else { continue; };
            for document in stack.as_array_mut().ok_or_else(invalid)? {
                for layer in document["layers"].as_array_mut().ok_or_else(invalid)? {
                    visit(&mut layer["image"])?;
                }
            }
        }
    }
    Ok(())
}

fn encode_manifest(
    mut workspace: Value,
    directory: &Path,
    previous: Option<&Path>,
) -> Result<Vec<u8>, AppError> {
    let mut written = HashSet::new();
    let mut encoded_size = 0;
    visit_media(&mut workspace, |value, mime| {
        let source = value.take();
        let source = source.as_str().ok_or_else(invalid)?;
        let (mime, encoded) = match mime {
            Some(mime) => (mime, source),
            None => {
                let (head, encoded) = source.split_once(',').ok_or_else(invalid)?;
                let mime = head.strip_prefix("data:").and_then(|head| head.strip_suffix(";base64")).ok_or_else(invalid)?;
                (mime, encoded)
            }
        };
        encoded_size += encoded.len();
        if encoded_size > MAX_ENCODED_MEDIA { return Err(invalid()); }
        let bytes = decode_image(mime, encoded)?;
        let name = format!("{:x}.{}", Sha256::digest(&bytes), media_type(mime)?);
        if written.insert(name.clone()) {
            let destination = directory.join(&name);
            let reused = previous.is_some_and(|root| {
                let old = root.join(&name);
                same_media(&old, &bytes) && fs::hard_link(&old, &destination).is_ok()
            });
            if !reused { write_new(&destination, &bytes)?; }
        }
        *value = Value::String(name);
        Ok(())
    })?;
    let (current, history) = image_refs(&workspace)?;
    visit_history(&mut workspace, |value| {
        let index = value.as_i64().ok_or_else(invalid)?;
        let name = if index < 0 { current.get(index.unsigned_abs() as usize - 1) } else { history.get(index as usize) };
        *value = Value::String(name.ok_or_else(invalid)?.clone());
        Ok(())
    })?;
    let bytes = serde_json::to_vec(&json!({ "storageVersion": 2, "workspace": workspace }))?;
    if bytes.len() > MAX_MANIFEST { return Err(invalid()); }
    Ok(bytes)
}

fn decode_manifest(directory: &Path) -> Result<Value, AppError> {
    let mut manifest: Value = serde_json::from_slice(&read_limited(&directory.join("manifest.json"), MAX_MANIFEST)?)?;
    if manifest["storageVersion"] != 2 || !manifest["workspace"].is_object() { return Err(invalid()); }
    let mut workspace = manifest["workspace"].take();
    let (current, history) = image_refs(&workspace)?;
    let indices: HashMap<_, _> = current.iter().enumerate().map(|(index, name)| (name.as_str(), -1 - index as i64))
        .chain(history.iter().enumerate().map(|(index, name)| (name.as_str(), index as i64)))
        .collect();
    visit_history(&mut workspace, |value| {
        *value = json!(indices.get(value.as_str().ok_or_else(invalid)?).ok_or_else(invalid)?);
        Ok(())
    })?;
    validate_workspace_impl(&workspace, false)?;
    let mut encoded_size = 0;
    visit_media(&mut workspace, |value, supplied_mime| {
        let name = value.as_str().ok_or_else(invalid)?;
        let (digest, mime) = media_name(name)?;
        if supplied_mime.is_some_and(|supplied| supplied != mime) { return Err(invalid()); }
        let bytes = read_limited(&directory.join(name), MAX_IMAGE)?;
        if format!("{:x}", Sha256::digest(&bytes)) != digest { return Err(invalid()); }
        validate_image(mime, &bytes)?;
        encoded_size += bytes.len().div_ceil(3) * 4;
        if encoded_size > MAX_ENCODED_MEDIA { return Err(invalid()); }
        let mut encoded = if supplied_mime.is_some() { String::new() } else { format!("data:{mime};base64,") };
        base64::engine::general_purpose::STANDARD.encode_string(bytes, &mut encoded);
        *value = Value::String(encoded);
        Ok(())
    })?;
    validate_workspace_impl(&workspace, false)?;
    Ok(workspace)
}

fn workspace_path(directory: &Path, name: &str) -> Option<PathBuf> {
    let id = name.strip_suffix(".json").unwrap_or(name);
    (id.len() == 26 && id.parse::<Ulid>().is_ok()).then(|| directory.join(name))
}

fn is_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir())
}

pub(super) fn load_workspace(paths: &LibraryPaths, db: &Database, asset_id: &str) -> Result<Option<Value>, AppError> {
    let _lock = WORKSPACES.lock().unwrap();
    let Some(row) = db.list_analyses_by_asset(asset_id)?.into_iter().find(|row| row.kind == "layer_workspace") else {
        return Ok(None);
    };
    let directory = paths.root.join("layers");
    let path = workspace_path(&directory, &row.payload).filter(|_| is_directory(&directory)).ok_or_else(invalid)?;
    if row.payload.ends_with(".json") {
        let value: Value = serde_json::from_slice(&read_limited(&path, MAX_WORKSPACE)?)?;
        validate_workspace(&value)?;
        return Ok(Some(value));
    }
    if !is_directory(&path) { return Err(invalid()); }
    decode_manifest(&path).map(Some)
}

fn replace_pointer(db: &Database, asset_id: &str, name: &str) -> Result<(), AppError> {
    let mut conn = db.conn.lock().unwrap();
    let transaction = conn.transaction()?;
    transaction.execute("DELETE FROM analyses WHERE asset_id=?1 AND kind='layer_workspace'", [asset_id])?;
    transaction.execute(
        "INSERT INTO analyses(id,asset_id,kind,payload,created_at) VALUES(?1,?2,'layer_workspace',?3,?4)",
        rusqlite::params![Ulid::new().to_string(), asset_id, name, chrono::Utc::now().timestamp()],
    )?;
    transaction.commit()?;
    Ok(())
}

pub(super) fn save_workspace(paths: &LibraryPaths, db: &Database, asset_id: &str, workspace: Value) -> Result<(), AppError> {
    let _lock = WORKSPACES.lock().unwrap();
    if db.get_asset(asset_id)?.is_none() { return Err(AppError::Other("原素材已不存在".into())); }
    validate_workspace_impl(&workspace, false)?;
    let directory = paths.root.join("layers");
    fs::create_dir_all(&directory)?;
    if !is_directory(&directory) { return Err(invalid()); }
    let previous: Vec<_> = db.list_analyses_by_asset(asset_id)?.into_iter()
        .filter(|row| row.kind == "layer_workspace")
        .filter_map(|row| workspace_path(&directory, &row.payload))
        .collect();
    let reusable = previous.iter().find(|path| is_directory(path)).map(PathBuf::as_path);
    let staging = tempfile::Builder::new().prefix(".saving-layer-").tempdir_in(&directory)?;
    let manifest = encode_manifest(workspace, staging.path(), reusable)?;
    write_new(&staging.path().join("manifest.json"), &manifest)?;
    #[cfg(unix)]
    File::open(staging.path())?.sync_all()?;

    // Publish an intact revision before swapping the SQLite pointer. The previous revision
    // remains readable if either the file write or SQLite transaction fails.
    let name = Ulid::new().to_string();
    let published = directory.join(&name);
    fs::rename(staging.path(), &published)?;
    let result = (|| {
        #[cfg(unix)]
        File::open(&directory)?.sync_all()?;
        replace_pointer(db, asset_id, &name)
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&published);
        return Err(error);
    }
    for path in previous {
        if is_directory(&path) { let _ = fs::remove_dir_all(path); }
        else { let _ = fs::remove_file(path); }
    }
    Ok(())
}
