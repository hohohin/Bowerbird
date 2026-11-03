use super::*;
use crate::core::quick_transfer::QuickTransferStore;
use std::fs;

fn workspace(temp: &tempfile::TempDir) -> FileWorkspace {
    FileWorkspace::open(
        temp.path().join("settings/file-workspace.json"),
        temp.path().join("BowerbirdLibrary"),
    )
    .unwrap()
}

#[test]
fn default_receive_directory_is_read_only_until_prepared() {
    let temp = tempfile::tempdir().unwrap();
    let files = workspace(&temp);
    let proposed = receive_directory(&files);
    assert_eq!(proposed, temp.path().join("BowerbirdLibrary/快传"));
    assert!(!proposed.parent().unwrap().exists());
    assert!(files.snapshot().root.is_none());
    let created = prepare_receive_directory(&files).unwrap();
    assert_eq!(created, fs::canonicalize(&proposed).unwrap());
    fs::write(created.join("保留.txt"), "原来的素材").unwrap();
    assert_eq!(prepare_receive_directory(&files).unwrap(), created);
    assert_eq!(
        fs::read_to_string(created.join("保留.txt")).unwrap(),
        "原来的素材"
    );
}

#[test]
fn default_receive_directory_respects_migrated_root_after_restart() {
    let temp = tempfile::tempdir().unwrap();
    let files = workspace(&temp);
    let migrated = files
        .configure(&temp.path().join("another-disk/BowerbirdLibrary"))
        .unwrap();
    drop(files);
    let files = workspace(&temp);
    assert_eq!(receive_directory(&files), migrated.join("快传"));
    assert!(!migrated.join("快传").exists());
    assert_eq!(
        prepare_receive_directory(&files).unwrap(),
        migrated.join("快传")
    );
    assert!(!temp.path().join("BowerbirdLibrary").exists());
}

#[test]
fn unavailable_migrated_root_does_not_create_a_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let files = workspace(&temp);
    let migrated = files
        .configure(&temp.path().join("offline/BowerbirdLibrary"))
        .unwrap();
    fs::remove_dir(&migrated).unwrap();
    assert!(prepare_receive_directory(&files).is_err());
    assert!(!migrated.exists());
    assert!(!temp.path().join("BowerbirdLibrary").exists());
}

#[test]
fn occupied_receive_directory_is_not_overwritten() {
    let temp = tempfile::tempdir().unwrap();
    let files = workspace(&temp);
    let root = files.ensure_root().unwrap();
    fs::write(root.join("快传"), "已有同名文件").unwrap();
    assert!(prepare_receive_directory(&files).is_err());
    assert_eq!(
        fs::read_to_string(root.join("快传")).unwrap(),
        "已有同名文件"
    );
}

#[tokio::test]
async fn default_directory_reuses_durable_receipt_recovery() {
    let temp = tempfile::tempdir().unwrap();
    let files = workspace(&temp);
    let receive = prepare_receive_directory(&files).unwrap();
    let mut store = QuickTransferStore::open(&receive).unwrap();
    let bytes = "手机传来的资料".as_bytes();
    let record = store
        .prepare("durable-receipt", "资料.txt", bytes.len() as u64)
        .unwrap();
    fs::write(record.staging_path, bytes).unwrap();
    store.mark_received("durable-receipt").unwrap();
    drop(store);
    let paths = Arc::new(LibraryPaths::init(temp.path().join("index")).unwrap());
    let db = Arc::new(Database::open(&paths.db).unwrap());
    db.migrate().unwrap();
    let runtime = QuickTransfer::default();
    let started = runtime
        .start(
            &prepare_receive_directory(&files).unwrap(),
            Ipv4Addr::LOCALHOST,
            paths,
            db.clone(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    assert_eq!(started.transfers.len(), 1);
    assert_eq!(
        started.transfers[0].status,
        crate::quick_transfer::TransferStatus::Complete
    );
    let asset = db
        .get_asset(started.transfers[0].asset_id.as_deref().unwrap())
        .unwrap()
        .unwrap();
    let stored = PathBuf::from(asset.store_path.unwrap());
    assert!(stored.starts_with(&receive));
    assert_eq!(fs::read(&stored).unwrap(), bytes);
    runtime.stop().await.unwrap();
}
