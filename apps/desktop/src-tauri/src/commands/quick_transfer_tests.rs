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

#[test]
fn project_preview_uses_the_managed_path_without_creating_it() {
    let temp = tempfile::tempdir().unwrap();
    let files = workspace(&temp);
    let paths = LibraryPaths::init(temp.path().join("index")).unwrap();
    let db = Database::open(&paths.db).unwrap();
    db.migrate().unwrap();
    let project = QuickTransferDestination::Project { project_id: "p1".into() };
    assert!(resolve_destination(&files, &db, project.clone(), true).is_err());
    db.create_project("p1", "海报/设计", "", "blank:p1", "blank").unwrap();
    let preview = resolve_destination(&files, &db, project.clone(), false).unwrap();
    assert_eq!(preview.directory, temp.path().join("BowerbirdLibrary/项目/海报设计-p1"));
    assert!(!files.proposed_root().exists());
    let prepared = resolve_destination(&files, &db, project.clone(), true).unwrap();
    assert_eq!(prepared.directory, fs::canonicalize(preview.directory).unwrap());
    assert_eq!(resolve_destination(&files, &db, project, false).unwrap().directory, prepared.directory);
}

#[test]
fn only_registered_available_folders_can_receive() {
    let temp = tempfile::tempdir().unwrap();
    let paths = LibraryPaths::init(temp.path().join("index")).unwrap();
    let db = Database::open(&paths.db).unwrap();
    db.migrate().unwrap();
    let root = temp.path().join("接收");
    let child = root.join("子目录");
    fs::create_dir_all(&child).unwrap();
    assert!(connected_destination(&db, &child.to_string_lossy()).is_err());
    let root_id = db.connect_directory(&root, None).unwrap();
    db.scan_connection(&paths, &root_id).unwrap();
    let folder = db.connection_folders(None, None).unwrap().into_iter()
        .find(|folder| folder.parent_id.as_deref() == Some(root_id.as_str())).unwrap();
    let destination = connected_destination(&db, &folder.id).unwrap();
    assert_eq!(destination.directory, fs::canonicalize(&child).unwrap());
    assert!(!child.join(".bowerbird-quick-transfer").exists());
    let mut store = QuickTransferStore::open_for_destination(&destination.directory, None, Some(folder.id.clone())).unwrap();
    let bytes = b"connected original";
    let record = store.prepare("connected-note", "note.txt", bytes.len() as u64).unwrap();
    fs::write(&record.staging_path, bytes).unwrap();
    let asset = store.complete(&record.id, &paths, &db).unwrap();
    assert_eq!(fs::read(child.join("note.txt")).unwrap(), bytes);
    let indexed: bool = db.conn.lock().unwrap().query_row(
        "SELECT EXISTS(SELECT 1 FROM connected_entries WHERE folder_id=?1 AND asset_id=?2)",
        rusqlite::params![folder.id, asset.id], |row| row.get(0),
    ).unwrap();
    assert!(indexed);
    db.set_connection_root_available(&root_id, &fs::canonicalize(&root).unwrap(), false).unwrap();
    assert!(connected_destination(&db, &folder.id).is_err());
}

#[test]
fn default_folder_persists_and_falls_back_without_creating_directories() {
    let temp = tempfile::tempdir().unwrap();
    let files = workspace(&temp);
    let paths = LibraryPaths::init(temp.path().join("index")).unwrap();
    let db = Database::open(&paths.db).unwrap();
    db.migrate().unwrap();
    let settings_file = temp.path().join("settings.json");
    let settings = SettingsState::init(settings_file.clone()).unwrap();
    assert!(settings.get().quick_transfer_default_folder.is_none());
    let root = temp.path().join("个人收件");
    fs::create_dir(&root).unwrap();
    let folder_id = db.connect_directory(&root, None).unwrap();
    let folder = connected_destination(&db, &folder_id).unwrap();
    let saved = QuickTransferDefaultFolder {
        folder_id: folder_id.clone(), name: folder.name, path: folder.directory.to_string_lossy().into_owned(),
    };
    save_default_folder(&settings, Some(saved)).unwrap();
    settings.update(Default::default()).unwrap(); // A stale general settings save preserves this preference.
    let settings = SettingsState::init(settings_file.clone()).unwrap();
    let current = || default_destination(&files, &db, settings.get().quick_transfer_default_folder);
    assert_eq!(current().effective.target, QuickTransferDestination::Folder { folder_id: folder_id.clone() });
    assert!(current().warning.is_none());
    assert!(!root.join(".bowerbird-quick-transfer").exists());

    let offline = temp.path().join("offline");
    fs::rename(&root, &offline).unwrap();
    let fallback = current();
    assert_eq!(fallback.effective.target, QuickTransferDestination::Default);
    assert_eq!(fallback.effective.directory, receive_directory(&files));
    assert!(fallback.warning.unwrap().contains("「个人收件」不可用，已回退到默认「快传」"));
    assert!(!root.exists());
    assert!(!files.proposed_root().exists());

    fs::rename(&offline, &root).unwrap();
    assert!(current().warning.is_none());
    db.disconnect_directory(&paths, &folder_id).unwrap();
    assert!(current().warning.is_some());
    save_default_folder(&settings, None).unwrap();
    let cleared = SettingsState::init(settings_file).unwrap();
    assert!(cleared.get().quick_transfer_default_folder.is_none());
    assert_eq!(current().effective.target, QuickTransferDestination::Default);
    assert!(current().warning.is_none());
}

#[cfg(unix)]
#[test]
fn folder_replaced_by_a_link_is_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let paths = LibraryPaths::init(temp.path().join("index")).unwrap();
    let db = Database::open(&paths.db).unwrap();
    db.migrate().unwrap();
    let folder = temp.path().join("connected");
    fs::create_dir(&folder).unwrap();
    let id = db.connect_directory(&folder, None).unwrap();
    let moved = temp.path().join("moved");
    fs::rename(&folder, &moved).unwrap();
    std::os::unix::fs::symlink(&moved, &folder).unwrap();
    assert!(connected_destination(&db, &id).is_err());
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
            move || Ok(ReceiveDestination { directory: prepare_receive_directory(&files)?, ..builtin_destination(&files) }),
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

#[tokio::test]
async fn deleted_project_receipt_can_recover_via_its_connected_folder() {
    let temp = tempfile::tempdir().unwrap();
    let files = Arc::new(workspace(&temp));
    let paths = Arc::new(LibraryPaths::init(temp.path().join("index")).unwrap());
    let db = Arc::new(Database::open(&paths.db).unwrap());
    db.migrate().unwrap();
    db.create_project("p1", "目标", "", "blank:p1", "blank").unwrap();
    let runtime = QuickTransfer::default();
    let project = QuickTransferDestination::Project { project_id: "p1".into() };
    let started = runtime.start({
        let (files, db, project) = (files.clone(), db.clone(), project.clone());
        move || resolve_destination(&files, &db, project, true)
    }, Ipv4Addr::LOCALHOST, paths.clone(), db.clone(), Arc::new(|_| {})).await.unwrap();
    let location = started.destination.unwrap();
    assert_eq!(location.target, project);
    assert_eq!(location.name, "目标");
    assert!(location.directory.ends_with("项目/目标-p1"));
    let active = serde_json::to_value(runtime.snapshot()).unwrap();
    assert_eq!(active["destination"]["projectId"], "p1");
    assert_eq!(active["destination"]["kind"], "project");
    assert!(runtime.stop().await.unwrap().destination.is_none());

    // Leave a durable receipt before registration, as if the previous process had exited.
    let mut store = QuickTransferStore::open_for_destination(&location.directory, Some("p1".into()), None).unwrap();
    let bytes = b"recover original without project";
    let record = store.prepare("recover-project", "note.txt", bytes.len() as u64).unwrap();
    fs::write(&record.staging_path, bytes).unwrap();
    store.mark_received(&record.id).unwrap();
    drop(store);
    db.conn.lock().unwrap().execute("DELETE FROM projects WHERE id='p1'", []).unwrap();
    assert!(resolve_destination(&files, &db, project, true).is_err());
    let folder_id = db.connected_root_ids().unwrap().pop().unwrap();
    let recovered = runtime.start({
        let db = db.clone();
        move || connected_destination(&db, &folder_id)
    }, Ipv4Addr::LOCALHOST, paths, db.clone(), Arc::new(|_| {})).await.unwrap();
    assert_eq!(recovered.transfers[0].status, crate::quick_transfer::TransferStatus::Complete);
    assert!(db.get_asset(recovered.transfers[0].asset_id.as_deref().unwrap()).unwrap().is_some());
    assert_eq!(fs::read(&record.final_path).unwrap(), bytes);
    assert!(db.get_project("p1").unwrap().is_none());
    assert_eq!(db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM project_assets", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM canvas_nodes", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    runtime.stop().await.unwrap();
}
