//! Opaque local attachments for rich documents. Files are never executed or indexed as images.
use crate::{core::paths::LibraryPaths, error::{AppError, AppResult}};
use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path, sync::Arc};
use tauri::{AppHandle, Manager, State};

const LIMIT: usize = 50 * 1024 * 1024;
#[derive(Serialize)]
pub struct Attachment { id: String, path: String }
fn invalid() -> AppError { AppError::Media("附件无法读取，请重新选择原文件".into()) }
fn extension(name: &str) -> &str {
    name.rsplit('.').next().filter(|s| s.len() <= 16 && !s.is_empty() && s.bytes().all(|c| c.is_ascii_alphanumeric())).unwrap_or("bin")
}
fn resolve(root: &Path, id: &str) -> AppResult<Attachment> {
    let (hash, ext) = id.split_once('.').ok_or_else(invalid)?;
    if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) || extension(ext) != ext { return Err(invalid()); }
    let root = root.join("document-attachments").canonicalize()?;
    let path = root.join(id).canonicalize()?;
    if !path.starts_with(root) || !path.is_file() { return Err(invalid()); }
    Ok(Attachment { id: id.into(), path: path.to_string_lossy().into() })
}
fn save(root: &Path, name: &str, bytes: &[u8]) -> AppResult<Attachment> {
    if bytes.len() > LIMIT { return Err(AppError::Media("文档附件不能超过 50 MB".into())); }
    let id = format!("{:x}.{}", Sha256::digest(bytes), extension(name).to_ascii_lowercase());
    let directory = root.join("document-attachments");
    fs::create_dir_all(&directory)?;
    let target = directory.join(&id);
    if !target.exists() {
        let mut file = tempfile::NamedTempFile::new_in(&directory)?;
        file.write_all(bytes)?; file.flush()?; file.as_file().sync_all()?;
        if let Err(error) = file.persist_noclobber(&target) {
            if error.error.kind() != std::io::ErrorKind::AlreadyExists { return Err(AppError::Io(error.error)); }
        }
    }
    let attachment = resolve(root, &id)?;
    if fs::read(&attachment.path)? != bytes { return Err(invalid()); }
    Ok(attachment)
}

#[tauri::command]
pub async fn save_document_attachment(app: AppHandle, paths: State<'_, Arc<LibraryPaths>>, name: String, data: String) -> AppResult<Attachment> {
    let root = paths.root.clone();
    let attachment = tauri::async_runtime::spawn_blocking(move || {
        if data.len() > LIMIT.div_ceil(3) * 4 { return Err(AppError::Media("文档附件不能超过 50 MB".into())); }
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| invalid())?;
        save(&root, &name, &bytes)
    }).await.map_err(|e| AppError::Other(e.to_string()))??;
    app.asset_protocol_scope().allow_file(&attachment.path).map_err(|e| AppError::Other(e.to_string()))?;
    Ok(attachment)
}

#[tauri::command]
pub fn resolve_document_attachment(app: AppHandle, paths: State<'_, Arc<LibraryPaths>>, id: String) -> AppResult<Attachment> {
    let attachment = resolve(&paths.root, &id)?;
    app.asset_protocol_scope().allow_file(&attachment.path).map_err(|e| AppError::Other(e.to_string()))?;
    Ok(attachment)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn attachments_survive_reopening_and_deduplicate_without_overwriting() {
        let root = tempfile::tempdir().unwrap();
        let bytes = b"%PDF-1.7\nfixture";
        let first = save(root.path(), "../brief.PDF", bytes).unwrap();
        let same = save(root.path(), "renamed.pdf", bytes).unwrap();
        assert_eq!(first.id, same.id);
        assert_eq!(fs::read(resolve(root.path(), &first.id).unwrap().path).unwrap(), bytes);
        assert_eq!(fs::read_dir(root.path().join("document-attachments")).unwrap().count(), 1);
        fs::write(&first.path, "changed externally").unwrap();
        assert!(save(root.path(), "brief.pdf", bytes).is_err());
        assert_eq!(fs::read(first.path).unwrap(), b"changed externally");
    }
    #[test]
    fn invalid_paths_and_oversized_uploads_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        for id in ["../secret", "abc.pdf", "/etc/passwd", &format!("{}.../file", "a".repeat(64))] { assert!(resolve(root.path(), id).is_err()); }
        assert!(save(root.path(), "large.pdf", &vec![0; LIMIT + 1]).is_err());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        assert!(save(root.path(), "empty.txt", b"").is_ok());
    }
}
