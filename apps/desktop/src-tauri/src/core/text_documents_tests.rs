use super::*;
use crate::core::{catalog_browser::CatalogFilter, external_files, ingest};
use std::{fs, path::PathBuf};

struct Fixture {
    _temp: tempfile::TempDir,
    paths: LibraryPaths,
    db: Database,
    source: PathBuf,
}
impl Fixture {
    fn new(content: &[u8]) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let paths = LibraryPaths::init(root.join("library")).unwrap();
        let db = Database::open(&paths.db).unwrap();
        db.migrate().unwrap();
        let source = root.join("中文文档.md");
        fs::write(&source, content).unwrap();
        Self {
            _temp: temp,
            paths,
            db,
            source,
        }
    }
    fn registered(&self) -> String {
        let id = "text-fixture";
        self.db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,ext,store_path,source,created_at) VALUES(?1,'中文文档','md',?2,'external',1)", rusqlite::params![id,self.source.to_string_lossy()]).unwrap();
        id.into()
    }
}

#[test]
fn text_connection_keeps_original_identity_and_skips_visual_work() {
    let f = Fixture::new("# 标题\n正文".as_bytes());
    let before = fs::read(&f.source).unwrap();
    let asset = ingest::ingest_file(&f.paths, &f.db, &f.source).unwrap();
    assert_eq!(asset.store_path.as_deref(), f.source.to_str());
    assert!(asset.thumb_path.is_none() && asset.phash.is_none() && asset.colors.is_none());
    assert_eq!(fs::read(&f.source).unwrap(), before);
    assert_eq!(fs::read_dir(&f.paths.images).unwrap().count(), 0);
    assert!(!f.paths.root.join("external-previews").exists());
    assert!(!f
        .db
        .local_targets_for_model(false, "test")
        .unwrap()
        .contains(&asset.id));
    for media in ["texts", "images", "audios", "videos"] {
        let ids =
            f.db.catalog_ids(
                &CatalogFilter {
                    kind: "all".into(),
                    media: media.into(),
                    ..Default::default()
                },
                0,
                50,
            )
            .unwrap();
        assert_eq!(
            ids,
            if media == "texts" {
                vec![asset.id.clone()]
            } else {
                vec![]
            }
        );
    }
    fs::write(&f.source, "changed").unwrap();
    assert_eq!(
        f.db.index_connected_file(&f.paths, &f.source, None)
            .unwrap()
            .id,
        asset.id
    );
}

#[test]
fn read_and_save_preserve_bom_crlf_and_registered_asset() {
    let f = Fixture::new(b"\xef\xbb\xbf# Title\r\nFirst\r\n");
    let id = f.registered();
    let opened = read(&f.db, &id).unwrap();
    assert_eq!(opened.text, "# Title\r\nFirst\r\n");
    assert_eq!(opened.format, "markdown");
    let saved = save(&f.paths, &f.db, &id, &opened.version, "# Title\nEdited\n").unwrap();
    assert_eq!(
        fs::read(&f.source).unwrap(),
        b"\xef\xbb\xbf# Title\r\nEdited\r\n"
    );
    assert_eq!(saved.asset_id, id);
    assert_ne!(saved.version, opened.version);
    assert_eq!(
        saved.version,
        external_files::fingerprint(&f.source).unwrap()
    );
    assert_eq!(fs::read_dir(&f.paths.images).unwrap().count(), 0);
}

#[test]
fn external_edit_conflict_leaves_original_untouched() {
    let f = Fixture::new(b"before");
    let id = f.registered();
    let opened = read(&f.db, &id).unwrap();
    fs::write(&f.source, "external").unwrap();
    let error = save(&f.paths, &f.db, &id, &opened.version, "mine")
        .unwrap_err()
        .to_string();
    assert!(error.contains("变化") || error.contains("修改"), "{error}");
    assert_eq!(fs::read_to_string(&f.source).unwrap(), "external");
}

#[test]
fn unknown_asset_and_binary_encoding_cannot_be_written() {
    let f = Fixture::new(&[0xff, 0xfe, 0, 0]);
    let id = f.registered();
    assert!(read(&f.db, "absent").is_err());
    assert!(read(&f.db, &id).unwrap_err().to_string().contains("编码"));
    let hash = external_files::fingerprint(&f.source).unwrap();
    assert!(save(&f.paths, &f.db, &id, &hash, "replace").is_err());
    assert_eq!(fs::read(&f.source).unwrap(), [0xff, 0xfe, 0, 0]);
}

#[test]
fn no_op_save_does_not_rewrite_file_and_repeat_uses_new_revision() {
    let f = Fixture::new(b"before\n");
    let id = f.registered();
    let opened = read(&f.db, &id).unwrap();
    let modified = fs::metadata(&f.source).unwrap().modified().unwrap();
    let same = save(&f.paths, &f.db, &id, &opened.version, &opened.text).unwrap();
    assert_eq!(same.version, opened.version);
    assert_eq!(
        modified,
        fs::metadata(&f.source).unwrap().modified().unwrap()
    );
    let saved = save(&f.paths, &f.db, &id, &same.version, "after").unwrap();
    assert!(save(&f.paths, &f.db, &id, &same.version, "other").is_err());
    assert!(save(&f.paths, &f.db, &id, &saved.version, "last").is_ok());
}

#[test]
fn bounded_reads_and_writes_reject_large_documents() {
    let f = Fixture::new(b"small");
    let id = f.registered();
    let opened = read(&f.db, &id).unwrap();
    assert!(save(
        &f.paths,
        &f.db,
        &id,
        &opened.version,
        &"x".repeat(2 * 1024 * 1024 + 1)
    )
    .is_err());
    assert_eq!(fs::read(&f.source).unwrap(), b"small");
    fs::write(&f.source, vec![b'x'; 2 * 1024 * 1024 + 1]).unwrap();
    assert!(read(&f.db, &id).is_err());
}

#[test]
fn unchanged_mixed_line_endings_remain_byte_identical() {
    let f = Fixture::new(b"first\r\nsecond\n");
    let id = f.registered();
    let opened = read(&f.db, &id).unwrap();
    let saved = save(&f.paths, &f.db, &id, &opened.version, &opened.text).unwrap();
    assert_eq!(saved.version, opened.version);
    assert_eq!(fs::read(&f.source).unwrap(), b"first\r\nsecond\n");
}

#[test]
fn connected_texts_have_distinct_folder_counts_and_no_image_references() {
    let f = Fixture::new(b"# doc");
    let folder =
        f.db.connect_directory(f.source.parent().unwrap(), None)
            .unwrap();
    f.db.scan_connection(&f.paths, &folder).unwrap();
    assert_eq!(
        f.db.connection_entry_ids(Some(&folder), None, Some("texts"), 0, 30)
            .unwrap()
            .len(),
        1
    );
    assert!(f
        .db
        .connection_entry_ids(Some(&folder), None, Some("images"), 0, 30)
        .unwrap()
        .is_empty());
    assert_eq!(
        f.db.connection_folders(None, Some("texts"))
            .unwrap()
            .iter()
            .find(|item| item.id == folder)
            .unwrap()
            .count,
        1
    );
    assert!(f
        .db
        .resolve_external_image_paths(&[f.source.to_string_lossy().into_owned()])
        .is_err());
}

#[test]
fn parallel_saves_with_the_same_version_have_one_winner() {
    let f = Fixture::new(b"initial");
    let id = f.registered();
    let opened = read(&f.db, &id).unwrap();
    let barrier = std::sync::Barrier::new(2);
    let outcomes = std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            barrier.wait();
            save(&f.paths, &f.db, &id, &opened.version, "first").is_ok()
        });
        let second = scope.spawn(|| {
            barrier.wait();
            save(&f.paths, &f.db, &id, &opened.version, "second").is_ok()
        });
        (first.join().unwrap(), second.join().unwrap())
    });
    assert_ne!(outcomes.0, outcomes.1);
    assert!(matches!(
        fs::read_to_string(&f.source).unwrap().as_str(),
        "first" | "second"
    ));
}

#[test]
fn readonly_original_is_not_replaced_and_temp_files_are_cleaned() {
    let f = Fixture::new(b"original");
    let id = f.registered();
    let opened = read(&f.db, &id).unwrap();
    let original_permissions = fs::metadata(&f.source).unwrap().permissions();
    let mut readonly = original_permissions.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&f.source, readonly).unwrap();
    let result = save(&f.paths, &f.db, &id, &opened.version, "changed");
    fs::set_permissions(&f.source, original_permissions).unwrap();
    assert!(result.unwrap_err().to_string().contains("只读"));
    assert_eq!(fs::read(&f.source).unwrap(), b"original");
    assert_eq!(fs::read_dir(f.source.parent().unwrap()).unwrap().count(), 2);
}
