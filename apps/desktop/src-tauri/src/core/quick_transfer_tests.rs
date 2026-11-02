use super::*;
use std::fs;

struct Fixture {
    _temp: tempfile::TempDir,
    receive: PathBuf,
    paths: LibraryPaths,
    db: Database,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let receive = temp.path().join("receive");
        fs::create_dir(&receive).unwrap();
        let paths = LibraryPaths::init(temp.path().join("library")).unwrap();
        let db = Database::open(&paths.db).unwrap();
        db.migrate().unwrap();
        Self {
            _temp: temp,
            receive,
            paths,
            db,
        }
    }
    fn image(&self) -> Vec<u8> {
        let path = self._temp.path().join("sample.png");
        image::RgbImage::from_pixel(3, 2, image::Rgb([10, 90, 200]))
            .save(&path)
            .unwrap();
        fs::read(path).unwrap()
    }
    fn count(&self) -> i64 {
        self.db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))
            .unwrap()
    }
}

#[test]
fn transfer_rejects_paths_untrusted_types_and_conflicting_identity() {
    let f = Fixture::new();
    let mut store = QuickTransferStore::open(&f.receive).unwrap();
    for name in [
        "../a.png",
        "sub/a.png",
        "sub\\a.png",
        "C:a.png",
        "CON.png",
        "a.png.",
        "a.exe",
        "a.svg",
        "a.bowerbird",
        "x\0.png",
    ] {
        assert!(store.prepare("id", name, 10).is_err(), "{name}");
    }
    assert!(store.prepare("../id", "a.png", 10).is_err());
    let first = store.prepare("valid-id", "a.png", 10).unwrap();
    assert_eq!(
        store.prepare("valid-id", "a.png", 10).unwrap().staging_path,
        first.staging_path
    );
    assert!(store.prepare("valid-id", "other.png", 10).is_err());
    assert!(store.prepare("valid-id", "a.png", 11).is_err());
    assert_eq!(f.count(), 0);
}

#[test]
fn incomplete_and_fake_media_never_reach_final_directory_or_library() {
    let f = Fixture::new();
    let mut store = QuickTransferStore::open(&f.receive).unwrap();
    let bytes = f.image();
    let record = store
        .prepare("partial", "photo.png", bytes.len() as u64)
        .unwrap();
    fs::write(&record.staging_path, &bytes[..10]).unwrap();
    let root = f.db.connect_directory(&f.receive, None).unwrap();
    f.db.scan_connection(&f.paths, &root).unwrap();
    assert_eq!(
        f.count(),
        0,
        "the normal folder watcher must ignore incomplete bytes"
    );
    assert!(store.complete("partial", &f.paths, &f.db).is_err());
    assert!(!record.final_path.exists());
    assert_eq!(f.count(), 0);
    let fake_bytes = b"<html>not PNG</html>";
    let fake = store
        .prepare("fake", "fake.png", fake_bytes.len() as u64)
        .unwrap();
    fs::write(&fake.staging_path, fake_bytes).unwrap();
    assert!(store.complete("fake", &f.paths, &f.db).is_err());
    assert!(!fake.final_path.exists());
    drop(store);
    let mut store = QuickTransferStore::open(&f.receive).unwrap();
    assert!(store.recover(&f.paths, &f.db).is_empty());
    assert_eq!(f.count(), 0);
}

#[test]
fn received_original_is_indexed_once_without_overwriting_same_name() {
    let f = Fixture::new();
    fs::write(f.receive.join("photo.png"), b"existing").unwrap();
    let bytes = f.image();
    let mut store = QuickTransferStore::open(&f.receive).unwrap();
    let record = store
        .prepare("image", "photo.png", bytes.len() as u64)
        .unwrap();
    fs::write(&record.staging_path, &bytes).unwrap();
    let asset = store.complete("image", &f.paths, &f.db).unwrap();
    assert_eq!(fs::read(&record.final_path).unwrap(), bytes);
    assert_eq!(fs::read(f.receive.join("photo.png")).unwrap(), b"existing");
    assert_eq!(
        Path::new(asset.store_path.as_ref().unwrap()),
        record.final_path
    );
    assert_eq!(asset.store_path, asset.origin_path);
    assert!(!asset.library_hidden);
    assert_eq!(
        store.complete("image", &f.paths, &f.db).unwrap().id,
        asset.id
    );
    drop(store);
    let mut store = QuickTransferStore::open(&f.receive).unwrap();
    assert_eq!(
        store.complete("image", &f.paths, &f.db).unwrap().id,
        asset.id
    );
    assert_eq!(f.count(), 1);
    assert_eq!(fs::read_dir(&f.paths.images).unwrap().count(), 0);
}

#[test]
fn saved_file_survives_database_failure_and_recovers_same_asset_after_restart() {
    let f = Fixture::new();
    let bytes = f.image();
    let mut store = QuickTransferStore::open(&f.receive).unwrap();
    let record = store
        .prepare("recover", "photo.png", bytes.len() as u64)
        .unwrap();
    fs::write(&record.staging_path, &bytes).unwrap();
    let unavailable = Database::open_in_memory().unwrap();
    assert!(store.complete("recover", &f.paths, &unavailable).is_err());
    assert!(record.final_path.is_file());
    drop(store);
    let mut store = QuickTransferStore::open(&f.receive).unwrap();
    let result = store.recover(&f.paths, &f.db);
    assert_eq!(result.len(), 1);
    assert!(result[0].1.is_ok());
    assert_eq!(f.count(), 1);
    assert!(store.recover(&f.paths, &f.db).is_empty());
}

#[test]
fn store_has_one_writer_and_cancel_only_removes_unpublished_transfer() {
    let f = Fixture::new();
    let mut store = QuickTransferStore::open(&f.receive).unwrap();
    assert!(QuickTransferStore::open(&f.receive).is_err());
    assert!(QuickTransferStore::open(&f.receive.join(".")).is_err());
    let record = store.prepare("cancel", "photo.png", 10).unwrap();
    fs::write(&record.staging_path, b"partial").unwrap();
    store.cancel("cancel").unwrap();
    assert!(!record.staging_path.exists());
    assert!(store.records().is_empty());
    drop(store);
    assert!(QuickTransferStore::open(&f.receive).is_ok());
}

#[test]
fn heic_remains_the_received_original_not_a_png_copy() {
    let f = Fixture::new();
    let bytes = include_bytes!("../../tests/fixtures/heic/rgb-strips-96.heic");
    let mut store = QuickTransferStore::open(&f.receive).unwrap();
    let record = store
        .prepare("heic", "IMG_0001.HEIC", bytes.len() as u64)
        .unwrap();
    fs::write(&record.staging_path, bytes).unwrap();
    let asset = store.complete("heic", &f.paths, &f.db).unwrap();
    assert_eq!(asset.ext.as_deref(), Some("heic"));
    assert_eq!(fs::read(record.final_path).unwrap(), bytes);
    assert_eq!(asset.store_path, asset.origin_path);
    assert_eq!(fs::read_dir(&f.paths.images).unwrap().count(), 0);
}

#[test]
fn complete_refuses_final_path_conflict_and_keeps_incoming_bytes() {
    let f = Fixture::new();
    let bytes = f.image();
    let mut store = QuickTransferStore::open(&f.receive).unwrap();
    let record = store
        .prepare("conflict", "photo.png", bytes.len() as u64)
        .unwrap();
    fs::write(&record.staging_path, &bytes).unwrap();
    fs::write(&record.final_path, b"another writer").unwrap();
    assert!(store.complete("conflict", &f.paths, &f.db).is_err());
    assert_eq!(fs::read(&record.final_path).unwrap(), b"another writer");
    assert_eq!(fs::read(record.staging_path).unwrap(), bytes);
    assert_eq!(f.count(), 0);
    drop(store);
    fs::remove_file(&record.final_path).unwrap();
    let mut reopened = QuickTransferStore::open(&f.receive).unwrap();
    let recovered = reopened.recover(&f.paths, &f.db);
    assert_eq!(recovered.len(), 1);
    assert!(recovered[0].1.is_ok());
    assert_eq!(fs::read(record.final_path).unwrap(), bytes);
    assert_eq!(f.count(), 1);
}

#[test]
fn resumed_manifest_cannot_redirect_paths_outside_the_receiving_directory() {
    let f = Fixture::new();
    let mut store = QuickTransferStore::open(&f.receive).unwrap();
    let mut record = store.prepare("manifest", "a.png", 10).unwrap();
    record.final_path = f._temp.path().join("outside.png");
    fs::write(
        store.manifest_path(&record.id),
        serde_json::to_vec(&record).unwrap(),
    )
    .unwrap();
    drop(store);
    assert!(QuickTransferStore::open(&f.receive).is_err());
    assert!(!record.final_path.exists());
    assert_eq!(f.count(), 0);
}

#[test]
fn utf8_text_is_preserved_and_binary_or_oversized_text_is_rejected() {
    let f = Fixture::new();
    let mut store = QuickTransferStore::open(&f.receive).unwrap();
    let bytes = "提示词\r\n# Material".as_bytes();
    let record = store
        .prepare("text", "note.md", bytes.len() as u64)
        .unwrap();
    fs::write(&record.staging_path, bytes).unwrap();
    let asset = store.complete("text", &f.paths, &f.db).unwrap();
    assert_eq!(asset.ext.as_deref(), Some("md"));
    assert_eq!(fs::read(record.final_path).unwrap(), bytes);
    for (id, bytes) in [
        ("binary", vec![0, 0xff, 0x21]),
        ("large", vec![b'a'; 2 * 1024 * 1024 + 1]),
    ] {
        let record = store.prepare(id, "bad.txt", bytes.len() as u64).unwrap();
        fs::write(&record.staging_path, bytes).unwrap();
        assert!(store.complete(id, &f.paths, &f.db).is_err());
        assert!(!record.final_path.exists());
    }
    assert_eq!(f.count(), 1);
}

#[test]
fn durable_receipt_recovers_after_restart_before_any_library_write() {
    let f = Fixture::new();
    let bytes = f.image();
    let mut store = QuickTransferStore::open(&f.receive).unwrap();
    let record = store
        .prepare("received", "phone.png", bytes.len() as u64)
        .unwrap();
    fs::write(&record.staging_path, &bytes).unwrap();
    store.mark_received("received").unwrap();
    store.mark_received("received").unwrap();
    assert_eq!(store.records()[0].state, UploadState::Ready);
    assert_eq!(f.count(), 0);
    assert!(!record.final_path.exists());
    assert!(store.cancel("received").is_err());
    drop(store);
    let mut store = QuickTransferStore::open(&f.receive).unwrap();
    let recovered = store.recover(&f.paths, &f.db);
    assert_eq!(recovered.len(), 1);
    assert!(recovered[0].1.is_ok());
    assert_eq!(fs::read(&record.final_path).unwrap(), bytes);
    assert_eq!(f.count(), 1);
    let asset = store.complete("received", &f.paths, &f.db).unwrap();
    assert_eq!(
        store.records()[0].asset_id.as_deref(),
        Some(asset.id.as_str())
    );
}

#[test]
fn advertised_media_types_cannot_hide_non_media_payloads() {
    let f = Fixture::new();
    let mut store = QuickTransferStore::open(&f.receive).unwrap();
    for (index, name) in ["fake.mp3", "fake.mp4", "fake.heic"]
        .into_iter()
        .enumerate()
    {
        let bytes = b"<html>this is not a media file</html>";
        let id = format!("spoof-{index}");
        let record = store.prepare(&id, name, bytes.len() as u64).unwrap();
        fs::write(&record.staging_path, bytes).unwrap();
        assert!(store.mark_received(&id).is_err(), "{name}");
        assert_eq!(store.uploads[&id].state, UploadState::Receiving);
        assert!(!record.final_path.exists());
    }
    let bytes = f.image();
    let record = store
        .prepare("wrong-image", "wrong.jpg", bytes.len() as u64)
        .unwrap();
    fs::write(&record.staging_path, bytes).unwrap();
    assert!(store.mark_received("wrong-image").is_err());
    assert_eq!(f.count(), 0);
}
