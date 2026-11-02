//! Registered UTF-8 originals; derived UI state never becomes a second writable file.
use crate::{
    core::paths::LibraryPaths,
    db::Database,
    error::{AppError, AppResult},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex, Weak},
};

const MAX_BYTES: usize = 2 * 1024 * 1024;
#[path = "text_document_create.rs"]
mod creation;
pub use creation::{create, CreateTextDocument, CreatedTextDocument};
static WRITERS: LazyLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
pub fn is_text(ext: &str) -> bool {
    matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown" | "txt")
}
pub fn text_path(path: &Path) -> bool {
    is_text(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or(""),
    )
}
fn invalid(message: &str) -> AppError {
    AppError::Other(message.into())
}
fn changed() -> AppError {
    invalid("文件已被其他程序修改或移动，请重新打开后再保存；当前编辑内容已保留")
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn source(db: &Database, id: &str) -> AppResult<PathBuf> {
    let asset = db
        .get_asset(id)?
        .ok_or_else(|| invalid("文本素材已不存在，请刷新素材库"))?;
    let path = PathBuf::from(
        asset
            .store_path
            .ok_or_else(|| invalid("原文本文件未连接"))?,
    );
    if !text_path(&path) {
        return Err(invalid("请选择 Markdown 或纯文本文件"));
    }
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| invalid("原文本文件无法读取，请检查连接及权限"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(invalid("原文本位置已变化，请重新建立连接"));
    }
    Ok(path)
}
fn bytes(path: &Path) -> AppResult<Vec<u8>> {
    let mut result = Vec::new();
    fs::File::open(path)?
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut result)?;
    if result.len() > MAX_BYTES {
        return Err(invalid("此文件超过 2 MB，请使用外部编辑器打开"));
    }
    Ok(result)
}
fn decode(bytes: &[u8]) -> AppResult<&str> {
    let body = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    let text = std::str::from_utf8(body)
        .map_err(|_| invalid("此文件的编码暂不支持，请先在外部编辑器另存为 UTF-8"))?;
    if text.contains('\0') {
        return Err(invalid(
            "此文件的编码暂不支持，请先在外部编辑器另存为 UTF-8",
        ));
    }
    Ok(text)
}
fn snapshot(id: &str, path: &Path, bytes: &[u8]) -> AppResult<TextDocument> {
    Ok(TextDocument {
        asset_id: id.into(),
        path: path.to_string_lossy().into_owned(),
        text: decode(bytes)?.into(),
        version: hash(bytes),
        format: if path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("txt"))
        {
            "text"
        } else {
            "markdown"
        }
        .into(),
    })
}
fn source_lock(path: &Path) -> Arc<Mutex<()>> {
    let mut writers = WRITERS.lock().unwrap();
    writers.retain(|_, writer| writer.strong_count() > 0);
    if let Some(writer) = writers.get(path).and_then(Weak::upgrade) {
        return writer;
    }
    let writer = Arc::new(Mutex::new(()));
    writers.insert(path.to_path_buf(), Arc::downgrade(&writer));
    writer
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDocument {
    pub asset_id: String,
    pub path: String,
    pub text: String,
    pub version: String,
    pub format: String,
}

pub fn read(db: &Database, id: &str) -> AppResult<TextDocument> {
    let path = source(db, id)?;
    let contents = bytes(&path)?;
    if bytes(&path)? != contents || source(db, id)? != path {
        return Err(changed());
    }
    snapshot(id, &path, &contents)
}
pub fn save(
    paths: &LibraryPaths,
    db: &Database,
    id: &str,
    expected: &str,
    text: &str,
) -> AppResult<TextDocument> {
    if text.len() > MAX_BYTES {
        return Err(invalid("此文档超过 2 MB，请缩减内容后保存"));
    }
    let path = source(db, id)?;
    let writer = source_lock(&path);
    let _guard = writer.lock().unwrap();
    let original = bytes(&path)?;
    if source(db, id)? != path || hash(&original) != expected {
        return Err(changed());
    }
    let old = decode(&original)?;
    let metadata = fs::metadata(&path)?;
    if metadata.permissions().readonly() {
        return Err(invalid("原文本文件为只读，请在系统中修改权限后重试"));
    }
    if text == old {
        return snapshot(id, &path, &original);
    }
    let normalized = text.replace("\r\n", "\n");
    let body = if old.contains("\r\n") {
        normalized.replace('\n', "\r\n")
    } else {
        normalized
    };
    let mut output = if original.starts_with(b"\xef\xbb\xbf") {
        b"\xef\xbb\xbf".to_vec()
    } else {
        Vec::new()
    };
    output.extend_from_slice(body.as_bytes());
    if output.len() > MAX_BYTES {
        return Err(invalid("此文档超过 2 MB，请缩减内容后保存"));
    }
    decode(&output)?;
    if output == original {
        return snapshot(id, &path, &original);
    }
    let parent = path
        .parent()
        .ok_or_else(|| invalid("无法确定原文本所在目录"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(&output)?;
    temporary
        .as_file()
        .set_permissions(metadata.permissions())?;
    temporary.as_file().sync_all()?;
    // Recheck after preparing the replacement, immediately before atomic commit.
    if source(db, id)? != path || bytes(&path)? != original {
        return Err(changed());
    }
    temporary.persist(&path).map_err(|error| {
        invalid(&format!(
            "文件未保存，请检查文件占用及目录权限：{}",
            error.error
        ))
    })?;
    if db.index_connected_file(paths, &path, None).is_err() {
        return Err(invalid(
            "原文件已保存，但素材库索引尚未更新，请刷新素材库后重新打开",
        ));
    }
    snapshot(id, &path, &output)
}

#[cfg(test)]
#[path = "text_documents_tests.rs"]
mod tests;
