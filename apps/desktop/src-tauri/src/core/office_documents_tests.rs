use super::*;
use crate::core::{catalog_browser::CatalogFilter, file_intake, ingest};

fn zip(parts: &[(&str, &str)]) -> Vec<u8> {
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, data) in parts {
        archive.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
        archive.write_all(data.as_bytes()).unwrap();
    }
    archive.finish().unwrap().into_inner()
}
fn docx(body: &str) -> Vec<u8> {
    zip(&[("word/document.xml", &format!(r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{body}</w:t></w:r></w:p></w:body></w:document>"#))])
}
fn xlsx(cell: &str) -> Vec<u8> {
    zip(&[
        ("xl/workbook.xml", r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="预算" sheetId="1" r:id="rId1"/><sheet name="备注" sheetId="2" r:id="rId2"/></sheets></workbook>"#),
        ("xl/_rels/workbook.xml.rels", r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>"#),
        ("xl/sharedStrings.xml", r#"<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>项目 &amp; 中文</t></si></sst>"#),
        ("xl/worksheets/sheet1.xml", &format!(r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><f>1+2</f><v>3</v></c></row><row r="2"><c r="A2" t="b"><v>1</v></c><c r="{cell}" t="inlineStr"><is><t>换行&#10;正文</t></is></c></row></sheetData></worksheet>"#)),
        ("xl/worksheets/sheet2.xml", r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>独立工作表</t></is></c></row></sheetData></worksheet>"#),
    ])
}
struct Fixture { _temp: tempfile::TempDir, paths: LibraryPaths, db: Database, path: PathBuf, id: String }
impl Fixture {
    fn new(ext: &str, data: &[u8]) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let mut paths = LibraryPaths::init(root.join("library")).unwrap();
        paths.files = Some(Arc::new(crate::core::file_workspace::FileWorkspace::open(root.join("files.json"), root.join("BowerbirdLibrary")).unwrap()));
        let db = Database::open(&paths.db).unwrap(); db.migrate().unwrap();
        let path = root.join(format!("中文文档.{ext}")); fs::write(&path, data).unwrap();
        let asset = ingest::ingest_file(&paths, &db, &path).unwrap();
        Self { _temp: temp, paths, db, path, id: asset.id }
    }
}

#[test]
fn office_imports_keep_originals_and_share_text_catalog_and_folder_filters() {
    for (ext, data) in [("DOCX", docx("正文")), ("xlsx", xlsx("B2")), ("csv", "字段,值\n中文,0123".as_bytes().to_vec())] {
        let f = Fixture::new(ext, &data);
        assert_eq!(fs::read(&f.path).unwrap(), data);
        let asset = f.db.get_asset(&f.id).unwrap().unwrap();
        assert!(asset.thumb_path.is_none() && asset.phash.is_none());
        assert_eq!(asset.store_path.as_deref(), f.path.to_str());
        for media in ["texts", "images", "videos", "audios"] {
            let ids = f.db.catalog_ids(&CatalogFilter { kind: "all".into(), media: media.into(), ..Default::default() }, 0, 30).unwrap();
            assert_eq!(ids, if media == "texts" { vec![f.id.clone()] } else { vec![] });
        }
        let folder = f.db.connect_directory(f.path.parent().unwrap(), None).unwrap();
        f.db.scan_connection(&f.paths, &folder).unwrap();
        assert!(f.db.connection_entry_ids(Some(&folder), None, Some("texts"), 0, 30).unwrap().len() >= 1);
        assert_eq!(file_intake::collect(&f.paths, &f.db, &f.path).unwrap().id, f.id);
        assert!(f.db.resolve_external_image_paths(&[f.path.to_string_lossy().into_owned()]).is_err());
        assert!(save(&f.paths, &f.db, &f.id, &hash(&data), "never overwrite binary").is_err());
    }
}
#[test]
fn loose_office_files_are_copied_byte_for_byte_and_connected_files_stay_in_place() {
    for (ext, data) in [("docx", docx("原件正文")), ("xlsx", xlsx("B2")), ("csv", "中文,00123".as_bytes().to_vec())] {
        let f = Fixture::new(ext, &data);
        let collected = file_intake::collect(&f.paths, &f.db, &f.path).unwrap();
        let target = PathBuf::from(collected.store_path.unwrap());
        assert_ne!(target, f.path);
        assert!(target.starts_with(f.path.parent().unwrap().join("BowerbirdLibrary")));
        assert_eq!(fs::read(&target).unwrap(), data);
        assert_eq!(fs::read(&f.path).unwrap(), data);
    }
}
#[test]
fn docx_preview_is_body_text_and_full_read_carries_validated_package() {
    let data = docx("正文 &amp; 内容"); let f = Fixture::new("docx", &data);
    let preview = read_with_options(&f.db, &f.id, true).unwrap();
    assert_eq!(preview.text.trim(), "正文 & 内容"); assert_eq!(preview.format, "text"); assert!(preview.docx_data.is_none());
    let full = read(&f.db, &f.id).unwrap(); assert_eq!(full.format, "docx");
    assert_eq!(base64::engine::general_purpose::STANDARD.decode(full.docx_data.unwrap()).unwrap(), data);
}
#[test]
fn docx_atomic_save_keeps_identity_conflicts_and_rejects_invalid_replacement() {
    let f = Fixture::new("docx", &docx("原文")); let old = read(&f.db, &f.id).unwrap();
    let updated = docx("保存后正文"); let encoded = base64::engine::general_purpose::STANDARD.encode(&updated);
    let saved = save_docx(&f.paths, &f.db, &f.id, &old.version, &encoded).unwrap();
    assert_eq!(saved.asset_id, f.id); assert_eq!(fs::read(&f.path).unwrap(), updated);
    assert_eq!(read(&f.db, &f.id).unwrap().text.trim(), "保存后正文");
    assert!(save_docx(&f.paths, &f.db, &f.id, &old.version, &encoded).is_err());
    assert!(save_docx(&f.paths, &f.db, &f.id, &saved.version, "bm90IGEgemlw").is_err());
    fs::write(&f.path, docx("外部编辑")).unwrap();
    assert!(save_docx(&f.paths, &f.db, &f.id, &saved.version, &encoded).is_err());
    assert_eq!(read(&f.db, &f.id).unwrap().text.trim(), "外部编辑");
}
#[test]
fn xlsx_reads_all_sheets_shared_inline_strings_gaps_and_cached_formula_values() {
    let f = Fixture::new("xlsx", &xlsx("B2")); let document = read_spreadsheet(&f.db, &f.id).unwrap();
    assert_eq!(document.sheets.len(), 2); assert_eq!(document.sheets[0].name, "预算");
    assert_eq!(document.sheets[0].rows, vec![vec!["项目 & 中文", "", "3"], vec!["true", "换行\n正文", ""]]);
    assert_eq!(document.sheets[1].rows, vec![vec!["独立工作表"]]);
}
#[test]
fn csv_keeps_quoted_commas_newlines_empty_cells_and_literal_formulas() {
    let data = "\u{feff}名称,备注,编号\r\n中文,\"逗号,以及\"\"引号\"\"\n第二行\",00123\r\n=1+2,,\r\n";
    let f = Fixture::new("csv", data.as_bytes()); let document = read_spreadsheet(&f.db, &f.id).unwrap();
    assert_eq!(document.sheets[0].rows[1], ["中文", "逗号,以及\"引号\"\n第二行", "00123"]);
    assert_eq!(document.sheets[0].rows[2], ["=1+2", "", ""]);
    assert_eq!(fs::read_to_string(&f.path).unwrap(), data);
}
#[test]
fn csv_supports_chinese_legacy_encoding_utf16_empty_and_ragged_rows() {
    let (gbk, _, _) = encoding_rs::GBK.encode("名称,值\n中文,一\n单列");
    let document = spreadsheet(Path::new("test.csv"), &gbk).unwrap();
    assert_eq!(document.sheets[0].rows[1], ["中文", "一"]);
    assert_eq!(document.sheets[0].rows[2], ["单列", ""]);
    let utf16: Vec<u8> = [0xff, 0xfe].into_iter().chain("甲,乙".encode_utf16().flat_map(u16::to_le_bytes)).collect();
    assert_eq!(spreadsheet(Path::new("test.csv"), &utf16).unwrap().sheets[0].rows[0], ["甲", "乙"]);
    assert_eq!(spreadsheet(Path::new("empty.csv"), b"").unwrap().sheets[0].rows, vec![vec![""]]);
}
#[test]
fn corrupt_and_oversize_documents_fail_without_overwriting_originals() {
    let f = Fixture::new("docx", b"broken"); assert!(read(&f.db, &f.id).is_err());
    assert_eq!(fs::read(&f.path).unwrap(), b"broken");
    assert!(spreadsheet(Path::new("book.xlsx"), &xlsx("XFD1048576")).is_err());
    assert!(spreadsheet(Path::new("large.csv"), "a,b\n".repeat(5001).as_bytes()).is_err());
    let data = zip(&[("word/document.xml", &"x".repeat(MAX_EXPANDED as usize + 1))]);
    assert!(docx_text(&data).is_err());
}
