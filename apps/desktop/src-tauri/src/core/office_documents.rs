//! Registered Office originals. Parsing is local; spreadsheets are value snapshots, never executed.
use super::*;
use base64::Engine;
use calamine::{Data, Reader, Xlsx};
use quick_xml::{events::Event, Reader as XmlReader};
use std::io::Cursor;

pub(super) const MAX_BYTES: usize = 20 * 1024 * 1024;
const MAX_EXPANDED: u64 = 64 * 1024 * 1024;
const MAX_CELLS: usize = 10_000;

pub(super) fn is_office(path: &Path) -> bool {
    path.extension().and_then(|v| v.to_str()).is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "docx" | "xlsx" | "csv"))
}
fn office_error(error: impl std::fmt::Display) -> AppError {
    tracing::warn!(%error, "Office document parsing failed");
    invalid("文档无法读取，请确认文件完整、未加密，并在办公软件中另存后重试")
}

// Validate expanded sizes before passing a package to a parser. Nothing is extracted to disk.
fn package(data: &[u8]) -> AppResult<zip::ZipArchive<Cursor<&[u8]>>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(data)).map_err(office_error)?;
    let mut expanded = 0u64;
    if archive.len() > 4096 { return Err(invalid("文档内容过多，请拆分后打开")); }
    for i in 0..archive.len() {
        let file = archive.by_index(i).map_err(office_error)?;
        expanded = expanded.saturating_add(file.size());
        if expanded > MAX_EXPANDED { return Err(invalid("文档展开后过大，请拆分后打开")); }
    }
    Ok(archive)
}
fn xml(archive: &mut zip::ZipArchive<Cursor<&[u8]>>, name: &str) -> AppResult<String> {
    let mut text = String::new();
    archive.by_name(name).map_err(office_error)?.take(MAX_EXPANDED + 1).read_to_string(&mut text).map_err(office_error)?;
    if text.len() as u64 > MAX_EXPANDED { return Err(invalid("文档内容过大，请拆分后打开")); }
    Ok(text)
}
fn docx_text(data: &[u8]) -> AppResult<String> {
    let mut archive = package(data)?;
    let contents = xml(&mut archive, "word/document.xml")?;
    let mut reader = XmlReader::from_str(&contents);
    let mut text = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event().map_err(office_error)? {
            Event::Start(tag) => { in_text = tag.local_name().as_ref() == b"t"; }
            Event::Text(value) if in_text => text.push_str(&value.decode().map_err(office_error)?),
            Event::CData(value) if in_text => text.push_str(&value.decode().map_err(office_error)?),
            Event::GeneralRef(value) if in_text => {
                let value = value.decode().map_err(office_error)?;
                text.push_str(&quick_xml::escape::unescape(&format!("&{value};")).map_err(office_error)?);
            }
            Event::Empty(tag) if matches!(tag.local_name().as_ref(), b"tab" | b"br") => text.push(' '),
            Event::End(tag) => {
                in_text = false;
                if matches!(tag.local_name().as_ref(), b"p" | b"tr") { text.push('\n'); }
                if tag.local_name().as_ref() == b"tc" { text.push('\t'); }
            }
            Event::DocType(_) => return Err(invalid("文档包含不支持的内容，请在办公软件中另存后重试")),
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(text)
}

#[derive(Debug, Serialize)]
pub struct SpreadsheetSheet { pub name: String, pub rows: Vec<Vec<String>> }
#[derive(Debug, Serialize)]
pub struct SpreadsheetDocument { pub sheets: Vec<SpreadsheetSheet> }

fn csv_text(data: &[u8]) -> AppResult<String> {
    let (encoding, skip) = encoding_rs::Encoding::for_bom(data).unwrap_or((encoding_rs::UTF_8, 0));
    let (text, errors) = encoding.decode_without_bom_handling(&data[skip..]);
    if !errors { return Ok(text.into_owned()); }
    let (text, errors) = encoding_rs::GB18030.decode_without_bom_handling(data);
    if errors { return Err(invalid("表格编码无法读取，请另存为 UTF-8 CSV 后重试")); }
    Ok(text.into_owned())
}
fn check_grid(rows: usize, columns: usize) -> AppResult<()> {
    if rows.saturating_mul(columns) > MAX_CELLS { return Err(invalid("每张工作表最多支持 10000 个单元格，请拆分后打开")); }
    Ok(())
}
fn spreadsheet(path: &Path, data: &[u8]) -> AppResult<SpreadsheetDocument> {
    if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("csv")) {
        let text = csv_text(data)?;
        let mut reader = csv::ReaderBuilder::new().has_headers(false).flexible(true).from_reader(text.as_bytes());
        let mut rows = Vec::new();
        let mut columns = 1;
        for record in reader.records() {
            let record = record.map_err(office_error)?;
            columns = columns.max(record.len()); check_grid(rows.len() + 1, columns)?;
            rows.push(record.iter().map(str::to_owned).collect::<Vec<_>>());
        }
        if rows.is_empty() { rows.push(vec![String::new()]); }
        for row in &mut rows { row.resize(columns, String::new()); }
        return Ok(SpreadsheetDocument { sheets: vec![SpreadsheetSheet { name: path.file_stem().unwrap_or_default().to_string_lossy().into_owned(), rows }] });
    }
    let mut archive = package(data)?;
    // Reject extreme sparse coordinates before calamine allocates a rectangular Range.
    let names: Vec<_> = archive.file_names().filter(|name| name.starts_with("xl/worksheets/") && name.ends_with(".xml")).map(str::to_owned).collect();
    if names.len() > 100 { return Err(invalid("工作表过多，请拆分后打开")); }
    for name in names {
        let contents = xml(&mut archive, &name)?;
        let mut reader = XmlReader::from_str(&contents);
        let (mut rows, mut columns) = (0, 0);
        loop {
            match reader.read_event().map_err(office_error)? {
                Event::Start(tag) | Event::Empty(tag) if tag.local_name().as_ref() == b"c" => {
                    for attribute in tag.attributes() {
                        let attribute = attribute.map_err(office_error)?;
                        if attribute.key.as_ref() != b"r" { continue; }
                        let reference = std::str::from_utf8(&attribute.value).map_err(office_error)?;
                        let (mut column, mut row) = (0usize, 0usize);
                        for byte in reference.bytes() {
                            if byte.is_ascii_alphabetic() { column = column.saturating_mul(26).saturating_add((byte.to_ascii_uppercase() - b'A' + 1) as usize); }
                            else if byte.is_ascii_digit() { row = row.saturating_mul(10).saturating_add((byte - b'0') as usize); }
                        }
                        rows = rows.max(row); columns = columns.max(column); check_grid(rows, columns)?;
                    }
                }
                Event::Eof => break,
                Event::DocType(_) => return Err(office_error("DTD is unsupported")),
                _ => {}
            }
        }
    }
    let mut workbook: Xlsx<_> = calamine::open_workbook_from_rs(Cursor::new(data)).map_err(office_error)?;
    let mut sheets = Vec::new();
    let mut total = 0usize;
    for name in workbook.sheet_names().to_vec() {
        let range = workbook.worksheet_range(&name).map_err(office_error)?;
        let formulas = workbook.worksheet_formula(&name).map_err(office_error)?;
        let end = [range.end(), formulas.end()].into_iter().flatten().fold((0, 0), |a, b| (a.0.max(b.0), a.1.max(b.1)));
        let (height, width) = (end.0 as usize + 1, end.1 as usize + 1); check_grid(height, width)?;
        total += height.saturating_mul(width);
        if total > 100_000 { return Err(invalid("工作簿内容过多，请拆分后打开")); }
        let rows = (0..height).map(|r| (0..width).map(|c| {
            let position = (r as u32, c as u32);
            match range.get_value(position) {
                Some(Data::DateTime(date)) => date.as_datetime().map(|date| date.format("%Y-%m-%d %H:%M:%S").to_string()).unwrap_or_else(|| date.to_string()),
                None | Some(Data::Empty) => formulas.get_value(position).filter(|formula| !formula.is_empty()).map(|formula| format!("={formula}")).unwrap_or_default(),
                Some(value) => value.to_string(),
            }
        }).collect()).collect();
        sheets.push(SpreadsheetSheet { name, rows });
    }
    if sheets.is_empty() { return Err(invalid("工作簿中没有可读取的工作表")); }
    Ok(SpreadsheetDocument { sheets })
}

pub(super) fn snapshot(id: &str, path: &Path, data: &[u8], preview_only: bool) -> AppResult<TextDocument> {
    let docx = path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("docx"));
    let text = if docx { docx_text(data)? } else {
        spreadsheet(path, data)?.sheets.iter().map(|sheet| format!("{}\n{}", sheet.name, sheet.rows.iter().take(20).map(|row| row.join("　")).collect::<Vec<_>>().join("\n"))).collect::<Vec<_>>().join("\n")
    };
    Ok(TextDocument { asset_id: id.into(), path: path.to_string_lossy().into_owned(),
        text: text.chars().take(if preview_only { 1200 } else { usize::MAX }).collect(), version: hash(data),
        format: if docx && !preview_only { "docx" } else { "text" }.into(),
        docx_data: (docx && !preview_only).then(|| base64::engine::general_purpose::STANDARD.encode(data)) })
}
pub fn read_spreadsheet(db: &Database, id: &str) -> AppResult<SpreadsheetDocument> {
    let path = source(db, id)?;
    if !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("xlsx") || ext.eq_ignore_ascii_case("csv")) { return Err(invalid("请选择表格文件")); }
    let data = bytes(&path)?;
    let result = spreadsheet(&path, &data)?;
    if source(db, id)? != path || bytes(&path)? != data { return Err(changed()); }
    Ok(result)
}
pub fn save_docx(paths: &LibraryPaths, db: &Database, id: &str, expected: &str, encoded: &str) -> AppResult<TextDocument> {
    if encoded.len() > MAX_BYTES * 4 / 3 + 4 { return Err(invalid("文档超过 20 MB，请缩减内容后保存")); }
    let data = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(office_error)?;
    if data.len() > MAX_BYTES { return Err(invalid("文档超过 20 MB，请缩减内容后保存")); }
    docx_text(&data)?;
    let path = source(db, id)?;
    if !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("docx")) { return Err(invalid("请选择 Word 文档")); }
    let writer = source_lock(&path); let _guard = writer.lock().unwrap();
    let original = bytes(&path)?;
    if source(db, id)? != path || hash(&original) != expected { return Err(changed()); }
    replace_original(paths, db, id, &path, &original, &data)?;
    snapshot(id, &path, &data, true)
}

#[cfg(test)]
#[path = "office_documents_tests.rs"]
mod tests;
