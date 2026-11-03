//! Collection documents have one original file; project documents have one canvas payload.
use super::*;
use crate::core::{
    creative_session_contract::{parse_node_payload, CreativeNodeKind},
    project_canvas::NewCanvasNode,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum DocumentDestination {
    Collection {
        #[serde(rename = "folderId")]
        folder_id: String,
    },
    Project {
        #[serde(rename = "projectId")]
        project_id: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateTextDocument {
    pub request_id: String,
    pub title: String,
    pub text: String,
    pub destination: DocumentDestination,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CreatedTextDocument {
    Collection {
        #[serde(flatten)]
        document: TextDocument,
    },
    Project {
        #[serde(rename = "nodeId")]
        node_id: String,
    },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum SavedOutput {
    Collection { path: PathBuf, asset_id: String },
    Project { node_id: String },
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    request_hash: String,
    output: SavedOutput,
    complete: bool,
}

fn reserved_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}
fn validate_input(input: &CreateTextDocument) -> AppResult<()> {
    if input.request_id.is_empty()
        || input.request_id.len() > 128
        || !input
            .request_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(invalid("保存请求已失效，请重新打开编辑器"));
    }
    if input.text.len() > MAX_BYTES {
        return Err(invalid("此文档超过 2 MB，请缩减内容后保存"));
    }
    decode(input.text.as_bytes())?;
    Ok(())
}

fn validate_filename(name: &str) -> AppResult<()> {
    let invalid_name = name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        || name.chars().any(char::is_control);
    if name.starts_with('.') || name.ends_with('.') || reserved_name(name) || invalid_name {
        return Err(invalid("请输入有效文档名称，不包含路径分隔符或特殊字符"));
    }
    Ok(())
}

fn title(input: &CreateTextDocument) -> AppResult<&str> {
    validate_input(input)?;
    let name = input.title.trim();
    let name = if name.is_empty() {
        "未命名文本"
    } else {
        name
    };
    if name.chars().count() > 100 {
        return Err(invalid("文档名称请控制在 100 字以内"));
    }
    if matches!(input.destination, DocumentDestination::Collection { .. }) {
        validate_filename(name)?;
    }
    Ok(name)
}

fn available_path(directory: &Path, name: &str) -> AppResult<PathBuf> {
    let stem = name.strip_suffix(".md").unwrap_or(name);
    for sequence in 0..10000 {
        let filename = if sequence == 0 {
            format!("{stem}.md")
        } else {
            format!("{stem} ({sequence}).md")
        };
        let path = directory.join(filename);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(path),
            Err(error) => return Err(error.into()),
            Ok(_) => {}
        }
    }
    Err(invalid("同名文档过多，请修改名称后保存"))
}

fn load_receipt(path: &Path, fingerprint: &str) -> AppResult<Option<Receipt>> {
    if !path.exists() {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?.take(16_385).read_to_end(&mut bytes)?;
    if bytes.len() > 16_384 {
        return Err(invalid("保存记录无法读取，请重新打开编辑器"));
    }
    let receipt: Receipt = serde_json::from_slice(&bytes)?;
    if receipt.request_hash != fingerprint {
        return Err(invalid(
            "保存内容或位置已变化，请重新发起保存；原记录已保留",
        ));
    }
    Ok(Some(receipt))
}

fn write_original(path: &Path, text: &str) -> AppResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || bytes(path)? != text.as_bytes()
            {
                return Err(invalid(
                    "保存位置已有不同内容，请核对原文件；当前草稿已保留",
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            write_new_original(path, text)?;
        }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn write_new_original(path: &Path, text: &str) -> AppResult<()> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    file.write_all(text.as_bytes())?;
    file.as_file().sync_all()?;
    file.persist_noclobber(path)
        .map_err(|_| invalid("文件未保存，请检查同名文件及目录权限后重试"))?;
    Ok(())
}

fn pending_receipt(input: &CreateTextDocument, output: SavedOutput) -> AppResult<Receipt> {
    Ok(Receipt {
        request_hash: hash(&serde_json::to_vec(input)?),
        complete: false,
        output,
    })
}

fn collection_receipt(
    input: &CreateTextDocument,
    previous: Option<Receipt>,
    directory: &Path,
    name: &str,
) -> AppResult<Receipt> {
    match previous {
        Some(receipt) => Ok(receipt),
        None => pending_receipt(
            input,
            SavedOutput::Collection {
                path: available_path(directory, name)?,
                asset_id: format!("text-{}", hash(input.request_id.as_bytes())),
            },
        ),
    }
}

fn register_collection(
    db: &Database,
    folder_id: &str,
    path: &Path,
    asset_id: &str,
) -> AppResult<()> {
    let metadata = fs::metadata(path)?;
    db.conn.lock().unwrap().execute(
        "INSERT INTO connected_entries(id,folder_id,asset_id,path,name,is_reference,size,mtime) VALUES(?1,?2,?3,?4,?5,0,?6,?7) ON CONFLICT(path) DO UPDATE SET available=1,size=excluded.size,mtime=excluded.mtime",
        rusqlite::params![format!("entry-{asset_id}"), folder_id, asset_id, path.to_string_lossy(), path.file_name().unwrap().to_string_lossy(), metadata.len() as i64, format!("{:?}",metadata.modified()?)])?;
    db.connect_entry_projects(folder_id, asset_id)
}

fn finish_collection(
    paths: &LibraryPaths,
    db: &Database,
    input: &CreateTextDocument,
    folder_id: &str,
    journal: &Path,
    receipt: &mut Receipt,
) -> AppResult<String> {
    let SavedOutput::Collection { path, asset_id } = receipt.output.clone() else {
        return Err(invalid("保存记录与目标不一致，请重新发起保存"));
    };
    crate::core::file_workspace::write_json(journal, receipt)?;
    write_original(&path, &input.text)?;
    let asset_id = db.index_connected_file(paths, &path, Some(&asset_id))?.id;
    receipt.output = SavedOutput::Collection {
        path: path.clone(),
        asset_id: asset_id.clone(),
    };
    register_collection(db, folder_id, &path, &asset_id)?;
    receipt.complete = true;
    crate::core::file_workspace::write_json(journal, receipt)?;
    Ok(asset_id)
}

fn create_collection(
    paths: &LibraryPaths,
    db: &Database,
    input: &CreateTextDocument,
    folder_id: &str,
    name: &str,
    journal: &Path,
    previous: Option<Receipt>,
) -> AppResult<CreatedTextDocument> {
    let directory = PathBuf::from(db.writable_connection(folder_id)?.path);
    let directory_lock = source_lock(&directory);
    let _guard = directory_lock.lock().unwrap();
    let mut receipt = collection_receipt(input, previous, &directory, name)?;
    let SavedOutput::Collection { path, mut asset_id } = receipt.output.clone() else {
        return Err(invalid("保存记录与目标不一致，请重新发起保存"));
    };
    if path.parent() != Some(directory.as_path()) {
        return Err(invalid("保存位置已变化，请重新选择"));
    }
    if !receipt.complete {
        asset_id = finish_collection(paths, db, input, folder_id, journal, &mut receipt)?;
    }
    Ok(CreatedTextDocument::Collection {
        document: read(db, &asset_id)?,
    })
}

fn existing_card(db: &Database, project_id: &str, id: &str) -> AppResult<bool> {
    let Some(existing) = db.get_canvas_node(id)? else {
        return Ok(false);
    };
    if existing.project_id != project_id
        || existing.kind != CreativeNodeKind::Note
        || existing.hidden_at.is_some()
    {
        return Err(invalid("保存的文本卡片已变化，请核对项目"));
    }
    Ok(true)
}

fn deliver_project(
    db: &Database,
    project_id: &str,
    node_id: &str,
    payload: String,
) -> AppResult<()> {
    if existing_card(db, project_id, node_id)? {
        return Ok(());
    }
    db.ensure_project_canvas(project_id)?;
    let nodes = db.list_canvas_nodes(project_id)?;
    let x = nodes
        .iter()
        .filter(|node| node.hidden_at.is_none())
        .map(|node| node.x + node.width + 40.0)
        .fold(80.0, f64::max);
    db.create_canvas_node(&NewCanvasNode {
        id: node_id.into(),
        project_id: project_id.into(),
        thread_id: None,
        kind: CreativeNodeKind::Note,
        asset_id: None,
        role: None,
        payload_json: payload,
        x,
        y: 100.0,
        width: 420.0,
        height: 480.0,
        z_index: nodes.iter().map(|node| node.z_index).max().unwrap_or(0) + 1,
        position_locked: false,
    })?;
    Ok(())
}

fn project_payload(
    db: &Database,
    input: &CreateTextDocument,
    project_id: &str,
    name: &str,
) -> AppResult<String> {
    let project = db
        .get_project(project_id)?
        .ok_or_else(|| invalid("项目已不存在，请重新选择"))?;
    if project.archived_at.is_some() {
        return Err(invalid("项目已归档，请重新选择"));
    }
    let payload = serde_json::json!({ "schema_version":1, "note_type":"document", "text":input.text, "title":name, "cells":[], "member_ids":[] }).to_string();
    parse_node_payload(CreativeNodeKind::Note, &payload)
        .map_err(|_| invalid("文档内容过大或格式不受支持，请缩减后保存"))?;
    Ok(payload)
}

fn finish_project(
    db: &Database,
    project_id: &str,
    node_id: &str,
    payload: String,
    journal: &Path,
    receipt: &mut Receipt,
) -> AppResult<()> {
    crate::core::file_workspace::write_json(journal, receipt)?;
    deliver_project(db, project_id, node_id, payload)?;
    receipt.complete = true;
    crate::core::file_workspace::write_json(journal, receipt)
}

fn create_project(
    db: &Database,
    input: &CreateTextDocument,
    project_id: &str,
    name: &str,
    journal: &Path,
    previous: Option<Receipt>,
) -> AppResult<CreatedTextDocument> {
    let payload = project_payload(db, input, project_id, name)?;
    let mut receipt = match previous {
        Some(receipt) => receipt,
        None => pending_receipt(
            input,
            SavedOutput::Project {
                node_id: format!("document-{}", hash(input.request_id.as_bytes())),
            },
        )?,
    };
    let SavedOutput::Project { node_id } = receipt.output.clone() else {
        return Err(invalid("保存记录与目标不一致，请重新发起保存"));
    };
    if !receipt.complete {
        finish_project(db, project_id, &node_id, payload, journal, &mut receipt)?;
    }
    if !existing_card(db, project_id, &node_id)? {
        return Err(invalid("已保存的文本卡片已被移除，请重新发起保存"));
    }
    Ok(CreatedTextDocument::Project { node_id })
}

pub fn create(
    paths: &LibraryPaths,
    db: &Database,
    input: &CreateTextDocument,
) -> AppResult<CreatedTextDocument> {
    let name = title(input)?;
    let journal = paths
        .root
        .join("text-document-creates")
        .join(format!("{}.json", hash(input.request_id.as_bytes())));
    let request_lock = source_lock(&journal);
    let _request_guard = request_lock.lock().unwrap();
    let previous = load_receipt(&journal, &hash(&serde_json::to_vec(input)?))?;
    match &input.destination {
        DocumentDestination::Collection { folder_id } => {
            create_collection(paths, db, input, folder_id, name, &journal, previous)
        }
        DocumentDestination::Project { project_id } => {
            create_project(db, input, project_id, name, &journal, previous)
        }
    }
}

#[cfg(test)]
#[path = "text_document_create_tests.rs"]
mod tests;
