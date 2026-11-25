//! Asset ownership for note attachments, text documents and artboards.
use rusqlite::{params, Transaction};

use crate::{core::creative_session_contract::{CanvasNoteType, NoteNodePayloadV1}, error::{AppError, AppResult}};

fn decode_document_asset_id(encoded: &str) -> Option<String> {
    let bytes = encoded.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            decoded.push(u8::from_str_radix(encoded.get(index + 1..index + 3)?, 16).ok()?);
            index += 3;
        } else { decoded.push(bytes[index]); index += 1; }
    }
    String::from_utf8(decoded).ok().filter(|id| !id.is_empty())
}

// Keep the same whole-block boundaries as documentProjection.ts; source examples are not attachments.
pub(super) fn document_asset_ids(source: &str) -> Vec<String> {
    let rich = crate::core::document_state::has_current_rich_state(source);
    static MEDIA: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(
        r#"^(?:<(?:img|audio|video) data-bowerbird-asset="([^"]+)" data-caption="[^"]*"(?: data-source="[^"]*")? />|!\[[^\]]*\]\(bowerbird-asset:([^\s)]+)\))$"#).unwrap());
    static FENCE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"^ {0,3}(`{3,}|~{3,})").unwrap());
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<_> = normalized.lines().collect();
    let frontmatter_end = (lines.first().map(|line| line.trim()) == Some("---"))
        .then(|| lines.iter().enumerate().skip(1).find(|(_, line)| matches!(line.trim(), "---" | "...")).map(|(index, _)| index)).flatten();
    let mut fence: Option<&str> = None;
    let mut ids = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let in_fence = fence.is_some();
        let marker = FENCE.captures(line).and_then(|value| value.get(1)).map(|value| value.as_str());
        if let Some(marker) = marker {
            if let Some(open) = fence {
                if marker.starts_with(open.chars().next().unwrap()) && marker.len() >= open.len() && line.trim() == marker { fence = None; }
            } else { fence = Some(marker); }
        }
        let isolated = (index == 0 || lines[index - 1].trim().is_empty()) && lines.get(index + 1).is_none_or(|line| line.trim().is_empty());
        if frontmatter_end.is_some_and(|end| index <= end) || in_fence || marker.is_some() || (!rich && (!isolated || line.starts_with("    ") || line.starts_with('\t'))) { continue; }
        if let Some(id) = MEDIA.captures(line.trim()).and_then(|reference| reference.get(1).or_else(|| reference.get(2))).and_then(|id| decode_document_asset_id(id.as_str())) { ids.push(id); }
    }
    ids
}

fn previous_note_asset_ids(value: &serde_json::Value) -> std::collections::BTreeSet<String> {
    let mut ids = std::collections::BTreeSet::new();
    if let Some(id) = value["artboard"]["base_asset_id"].as_str() {
        ids.insert(id.to_owned());
    }
    if value["note_type"] == "document" {
        ids.extend(document_asset_ids(value["text"].as_str().unwrap_or("")));
        return ids;
    }
    if value["note_type"] != "images" && value["note_type"] != "text" { return ids; }
    for row in value["cells"].as_array().into_iter().flatten() {
        for cell in row.as_array().into_iter().flatten() {
            for image in cell["image_refs"].as_array().into_iter().flatten() {
                if let Some(id) = image["asset_id"].as_str() {
                    ids.insert(id.to_owned());
                }
            }
        }
    }
    ids
}

pub(super) fn record_image_container_assets(
    tx: &Transaction<'_>,
    project_id: &str,
    note: &NoteNodePayloadV1,
    previous: Option<&str>,
    now: i64,
) -> AppResult<()> {
    let mut ids = std::collections::BTreeSet::new();
    if let Some(id) = note.artboard.as_ref().and_then(|artboard| artboard.base_asset_id.as_deref()) {
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1)", [id], |row| row.get(0))?;
        if !exists { return Err(AppError::NotFound(format!("artboard base {id}"))); }
        ids.insert(id.to_owned());
    }
    match note.note_type {
        Some(CanvasNoteType::Document) => ids.extend(document_asset_ids(&note.text)),
        Some(CanvasNoteType::Images | CanvasNoteType::Text) => ids.extend(
            note.cells.iter().flatten().flat_map(|cell| cell.image_refs.iter().map(|image| image.asset_id.clone()))
        ),
        _ => {}
    }
    if ids.is_empty() { return Ok(()); }
    // Saving an existing attachment must respect a later explicit project removal.
    if let Some(previous) = previous {
        let existing = previous_note_asset_ids(&serde_json::from_str(previous)?);
        ids.retain(|id| !existing.contains(id));
    }
    for id in ids {
        tx.execute("INSERT OR IGNORE INTO project_assets(project_id,asset_id,created_at) SELECT ?1,id,?3 FROM assets WHERE id=?2", params![project_id,id,now])?;
    }
    Ok(())
}
