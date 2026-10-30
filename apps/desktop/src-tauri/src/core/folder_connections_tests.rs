use super::*;
struct Fixture {
    _temp: tempfile::TempDir,
    db: Database,
    paths: LibraryPaths,
    source: PathBuf,
    target: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::init(temp.path().join("library")).unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&target).unwrap();
        image::RgbImage::from_pixel(8, 8, image::Rgb([20, 40, 60]))
            .save(source.join("one.png"))
            .unwrap();
        Self {
            _temp: temp,
            db,
            paths,
            source: directory(&source).unwrap(),
            target: directory(&target).unwrap(),
        }
    }
    fn connect(&self, path: &Path) -> String {
        let id = self.db.connect_directory(path, None).unwrap();
        self.db.scan_connection(&self.paths, &id).unwrap();
        id
    }
    fn entries(&self, id: &str) -> Vec<ConnectionEntry> {
        let ids = self.db.every_entry_id(Some(id)).unwrap();
        self.db.resolve_connection_entries(&ids).unwrap()
    }
}
#[test]
fn connects_without_copy_and_keeps_identity_on_incremental_refresh() {
    let f = Fixture::new();
    let bytes = fs::read(f.source.join("one.png")).unwrap();
    let root = f.connect(&f.source);
    let before = f.entries(&root);
    assert_eq!(before.len(), 1);
    assert_eq!(
        before[0].asset.store_path.as_deref(),
        f.source.join("one.png").to_str()
    );
    assert_eq!(fs::read_dir(&f.paths.images).unwrap().count(), 0);
    f.db.scan_connection(&f.paths, &root).unwrap();
    let after = f.entries(&root);
    assert_eq!(after[0].id, before[0].id);
    assert_eq!(after[0].asset_id, before[0].asset_id);
    assert_eq!(fs::read(f.source.join("one.png")).unwrap(), bytes);
}
#[test]
fn references_have_independent_entries_and_reference_deletion_preserves_original() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let original = f.entries(&root).pop().unwrap();
    f.db.create_material_references(&f.paths, &[original.asset_id.clone()], &target)
        .unwrap();
    let entry = f.entries(&target).pop().unwrap();
    assert!(entry.is_reference);
    assert_ne!(entry.id, original.id);
    assert_eq!(entry.asset_id, original.asset_id);
    assert!(fs::metadata(&entry.path).unwrap().len() < 2048);
    f.db.rename_connection_entry(&entry.id, "alternate")
        .unwrap();
    assert!(f.target.join("alternate.bowerbird").is_file());
    let recycle = f._temp.path().join("test-trash");
    fs::create_dir(&recycle).unwrap();
    f.db.trash_entries_with(&[entry.id], |path| {
        fs::rename(path, recycle.join(name(path)))?;
        Ok(())
    })
    .unwrap();
    assert!(f.source.join("one.png").exists());
    assert!(f.db.get_asset(&original.asset_id).unwrap().is_some());
    assert_eq!(f.entries(&target).len(), 0);
}
#[test]
fn original_moves_update_references_without_changing_creative_identity() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let original = f.entries(&root).pop().unwrap();
    f.db.create_material_references(&f.paths, &[original.asset_id.clone()], &target)
        .unwrap();
    f.db.rename_connection_entry(&original.id, "renamed.png")
        .unwrap();
    let reference = f.entries(&target).pop().unwrap();
    let data = load_reference(Path::new(&reference.path)).unwrap();
    assert!(data.target_path.ends_with("renamed.png"));
    assert_eq!(data.asset_id, original.asset_id);
    assert!(reference.available);
    assert!(!f.source.join("one.png").exists());
    f.db.move_connection_entries(&[original.id.clone()], &target)
        .unwrap();
    assert_eq!(f.entries(&target).len(), 2);
    assert!(f.target.join("renamed.png").exists());
    assert!(
        f.db.get_asset(&original.asset_id)
            .unwrap()
            .unwrap()
            .store_path
            .unwrap()
            .ends_with("target\\renamed.png")
            || cfg!(not(windows))
    );
}
#[test]
fn cached_entries_survive_offline_and_disconnect_does_not_delete_assets() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let original = f.entries(&root).pop().unwrap();
    let moved = f.source.with_file_name("offline");
    fs::rename(&f.source, &moved).unwrap();
    assert!(f.db.scan_connection(&f.paths, &root).is_err());
    assert_eq!(f.entries(&root).len(), 1);
    assert!(!f.db.connected_folder(&root).unwrap().available);
    f.db.relocate_connected_directory(&root, &moved).unwrap();
    assert!(f.entries(&root)[0].available);
    f.db.disconnect_directory(&root).unwrap();
    assert!(moved.join("one.png").is_file());
    assert!(f.db.get_asset(&original.asset_id).unwrap().is_some());
}
#[test]
fn nested_directories_are_direct_only_and_move_as_a_subtree() {
    let f = Fixture::new();
    fs::create_dir(f.source.join("child")).unwrap();
    fs::copy(f.source.join("one.png"), f.source.join("child/two.png")).unwrap();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let child =
        f.db.connection_folders(None, None)
            .unwrap()
            .into_iter()
            .find(|v| v.name == "child")
            .unwrap();
    assert_eq!(f.entries(&root).len(), 1);
    assert_eq!(f.entries(&child.id).len(), 1);
    let before = f.entries(&child.id).pop().unwrap();
    assert!(f.db.move_connected_directory(&root, &child.id).is_err());
    f.db.move_connected_directory(&child.id, &target).unwrap();
    let after = f.entries(&child.id).pop().unwrap();
    assert_eq!(before.asset_id, after.asset_id);
    assert!(f.target.join("child/two.png").is_file());
    assert_eq!(f.db.connected_folder(&child.id).unwrap().root_id, target);
}
#[test]
fn deleted_original_keeps_creative_record_and_other_references_are_missing() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let original = f.entries(&root).pop().unwrap();
    f.db.create_material_references(&f.paths, &[original.asset_id.clone()], &target)
        .unwrap();
    let recycle = f._temp.path().join("one-recycled.png");
    f.db.trash_entries_with(&[original.id], |path| {
        fs::rename(path, &recycle)?;
        Ok(())
    })
    .unwrap();
    assert!(f.db.get_asset(&original.asset_id).unwrap().is_some());
    assert!(!f.entries(&target)[0].available);
}
#[test]
fn foreign_reference_is_verified_and_resolves_relative_location() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let original = f.entries(&root).pop().unwrap();
    f.db.create_material_references(&f.paths, &[original.asset_id], &target)
        .unwrap();
    let entry = f.entries(&target).pop().unwrap();
    let db = Database::open_in_memory().unwrap();
    db.migrate().unwrap();
    let root = db.connect_directory(&f.target, None).unwrap();
    db.scan_connection(&f.paths, &root).unwrap();
    let ids = db.every_entry_id(Some(&root)).unwrap();
    let entries = db.resolve_connection_entries(&ids).unwrap();
    assert_eq!(entries.len(), 1);
    assert!(entries[0].is_reference);
    assert!(entries[0].available);
    assert_eq!(entries[0].asset_id, entry.asset_id);
    let mut data = load_reference(Path::new(&entry.path)).unwrap();
    data.sha256 = "0".repeat(64);
    super::super::file_workspace::write_json(Path::new(&entry.path), &data).unwrap();
    let other = Database::open_in_memory().unwrap();
    other.migrate().unwrap();
    let root = other.connect_directory(&f.target, None).unwrap();
    assert!(other.scan_connection(&f.paths, &root).is_err());
    assert!(other.every_entry_id(Some(&root)).unwrap().is_empty());
}

#[test]
fn reconnecting_to_projects_associates_cached_and_new_entries() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    for project in ["first", "second"] {
        f.db.create_project(project, project, project, project, "project")
            .unwrap();
        assert_eq!(
            f.db.connect_directory(&f.source, Some(project)).unwrap(),
            root
        );
        assert_eq!(
            f.db.connection_entry_ids(Some(&root), Some(project), None, 0, 10)
                .unwrap()
                .len(),
            1
        );
    }
    fs::copy(f.source.join("one.png"), f.source.join("new.png")).unwrap();
    f.db.scan_connection(&f.paths, &root).unwrap();
    for project in ["first", "second"] {
        assert_eq!(
            f.db.connection_entry_ids(Some(&root), Some(project), None, 0, 10)
                .unwrap()
                .len(),
            2
        );
    }
}
#[test]
fn missing_child_marks_all_descendants_offline_without_forgetting_entries() {
    let f = Fixture::new();
    fs::create_dir_all(f.source.join("child/grandchild")).unwrap();
    fs::copy(
        f.source.join("one.png"),
        f.source.join("child/grandchild/two.png"),
    )
    .unwrap();
    let root = f.connect(&f.source);
    let nested =
        f.db.connection_folders(None, None)
            .unwrap()
            .into_iter()
            .find(|v| v.name == "grandchild")
            .unwrap();
    fs::rename(f.source.join("child"), f._temp.path().join("offline-child")).unwrap();
    f.db.scan_connection(&f.paths, &root).unwrap();
    assert!(!f.db.connected_folder(&nested.id).unwrap().available);
    assert_eq!(f.entries(&nested.id).len(), 1);
    assert!(!f.entries(&nested.id)[0].available);
}
#[test]
fn moving_a_root_under_another_root_preserves_every_descendant() {
    let f = Fixture::new();
    fs::create_dir_all(f.source.join("child")).unwrap();
    fs::copy(f.source.join("one.png"), f.source.join("child/two.png")).unwrap();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let child =
        f.db.connection_folders(None, None)
            .unwrap()
            .into_iter()
            .find(|v| v.name == "child")
            .unwrap();
    let before = f.entries(&child.id).pop().unwrap();
    f.db.move_connected_directory(&root, &target).unwrap();
    assert_eq!(f.db.connected_root_ids().unwrap(), vec![target.clone()]);
    assert_eq!(
        f.db.connected_folder(&root).unwrap().parent_id,
        Some(target)
    );
    assert_eq!(f.entries(&child.id)[0].id, before.id);
    assert!(f.entries(&child.id)[0].available);
    assert!(f.target.join("source/child/two.png").exists());
}
#[test]
fn directory_database_failure_rolls_back_the_disk_rename_and_all_paths() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let original = f.entries(&root).pop().unwrap();
    f.db.conn.lock().unwrap().execute_batch("CREATE TRIGGER reject_folder_update BEFORE UPDATE OF path ON connected_folders BEGIN SELECT RAISE(ABORT,'test injected failure'); END;").unwrap();
    assert!(f.db.rename_connected_directory(&root, "renamed").is_err());
    assert!(f.source.join("one.png").exists());
    assert!(!f.source.with_file_name("renamed").exists());
    assert_eq!(f.entries(&root)[0].path, original.path);
    assert_eq!(
        f.entries(&root)[0].asset.store_path,
        original.asset.store_path
    );
}
#[test]
fn cross_volume_copy_checks_bytes_before_committing_and_deleting_source() {
    let f = Fixture::new();
    let original = f.source.join("one.png");
    let target = f.target.join("moved.png");
    let expected = fs::read(&original).unwrap();
    copy_move_with(&original, &target, || {
        assert_eq!(fs::read(&target).unwrap(), expected);
        assert!(original.exists());
        Ok(())
    })
    .unwrap();
    assert!(!original.exists());
    assert_eq!(fs::read(&target).unwrap(), expected);
}
#[test]
fn cross_volume_conflict_and_database_failure_keep_the_complete_source() {
    let f = Fixture::new();
    let original = f.source.join("one.png");
    let target = f.target.join("existing.png");
    fs::write(&target, b"existing").unwrap();
    assert!(copy_move_with(&original, &target, || panic!("must not commit a collision")).is_err());
    assert_eq!(fs::read(&target).unwrap(), b"existing");
    assert!(original.exists());
    let next = f.target.join("next.png");
    assert!(copy_move_with(&original, &next, || Err(invalid(
        "injected database failure"
    )))
    .is_err());
    assert_eq!(fs::read(&next).unwrap(), fs::read(&original).unwrap());
}
#[test]
fn cross_volume_cleanup_refuses_changed_source_and_keeps_verified_destination() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let source = PathBuf::from(&entry.path);
    let destination = f.target.join("moved.png");
    let expected = fs::read(&source).unwrap();
    let result = copy_move_with(&source, &destination, || {
        f.db.repoint_asset(&entry.asset_id, &source, &destination)?;
        fs::write(&source, b"new contents")?;
        Ok(())
    });
    assert!(result.is_err());
    assert_eq!(fs::read(&destination).unwrap(), expected);
    assert_eq!(fs::read(&source).unwrap(), b"new contents");
    assert_eq!(
        f.db.get_asset(&entry.asset_id).unwrap().unwrap().store_path,
        Some(string(&destination))
    );
}
#[test]
fn cross_volume_new_files_block_directory_cleanup_without_losing_the_copy() {
    let f = Fixture::new();
    let destination = f.target.join("source");
    let expected = fs::read(f.source.join("one.png")).unwrap();
    let result = copy_move_with(&f.source, &destination, || {
        fs::write(f.source.join("arrived-later.txt"), b"retain me")?;
        Ok(())
    });
    assert!(result.is_err());
    assert!(f.source.join("arrived-later.txt").exists());
    assert_eq!(fs::read(destination.join("one.png")).unwrap(), expected);
}
#[test]
fn failed_recycle_retains_original_entry_and_all_creative_identity() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    assert!(f
        .db
        .trash_entries_with(&[entry.id.clone()], |_| Err(invalid("recycle unavailable")))
        .is_err());
    assert!(Path::new(&entry.path).exists());
    assert_eq!(f.entries(&root)[0].id, entry.id);
    assert!(f.db.get_asset(&entry.asset_id).unwrap().is_some());
}

#[test]
fn cross_volume_changed_destination_never_causes_source_deletion() {
    let f = Fixture::new();
    let source = f.source.join("one.png");
    let destination = f.target.join("moved.png");
    let expected = fs::read(&source).unwrap();
    assert!(copy_move_with(&source, &destination, || {
        fs::write(&destination, b"changed target")?;
        Ok(())
    })
    .is_err());
    assert_eq!(fs::read(&source).unwrap(), expected);
}
#[test]
fn reference_cannot_reassign_a_missing_known_original_to_different_bytes() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let asset = f.entries(&root).pop().unwrap();
    f.db.create_material_references(&f.paths, &[asset.asset_id.clone()], &target)
        .unwrap();
    let reference = f.entries(&target).pop().unwrap();
    fs::rename(&asset.path, f._temp.path().join("offline.png")).unwrap();
    let replacement = f.target.join("other.png");
    image::RgbImage::from_pixel(8, 8, image::Rgb([90, 60, 30]))
        .save(&replacement)
        .unwrap();
    let mut data = load_reference(Path::new(&reference.path)).unwrap();
    data.target_relative = Some("other.png".into());
    data.target_path = string(&replacement);
    data.sha256 = external_files::fingerprint(&replacement).unwrap();
    super::super::file_workspace::write_json(Path::new(&reference.path), &data).unwrap();
    assert!(f.db.scan_connection(&f.paths, &target).is_err());
    assert_eq!(
        f.db.get_asset(&asset.asset_id).unwrap().unwrap().store_path,
        asset.asset.store_path
    );
    assert!(f
        .entries(&target)
        .iter()
        .any(|e| e.id == reference.id && !e.available));
}

#[test]
fn connected_assets_reject_legacy_and_raw_deletion_without_losing_records() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    f.db.conn.lock().unwrap().execute("INSERT INTO analyses(id,asset_id,kind,payload,provider,created_at) VALUES('analysis',?1,'caption','{}','test',0)",[&entry.asset_id]).unwrap();
    assert!(f.db.has_connected_asset(&entry.asset_id).unwrap());
    assert!(f.db.delete_asset(&entry.asset_id).is_err());
    assert!(f
        .db
        .conn
        .lock()
        .unwrap()
        .execute("DELETE FROM assets WHERE id=?1", [&entry.asset_id])
        .is_err());
    assert!(Path::new(&entry.path).is_file());
    assert_eq!(f.entries(&root)[0].asset_id, entry.asset_id);
    let count: i64 =
        f.db.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM analyses WHERE asset_id=?1",
                [&entry.asset_id],
                |r| r.get(0),
            )
            .unwrap();
    assert_eq!(count, 1);
}
#[test]
fn shared_detail_rename_updates_connected_original_and_reference_identity() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let entry = f.entries(&root).pop().unwrap();
    f.db.create_material_references(&f.paths, &[entry.asset_id.clone()], &target)
        .unwrap();
    assert!(f
        .db
        .rename_connected_asset_if_present(&entry.asset_id, "named.v2")
        .unwrap());
    assert!(f.source.join("named.v2.png").exists());
    assert_eq!(f.entries(&root)[0].id, entry.id);
    let reference = f.entries(&target).pop().unwrap();
    assert_eq!(reference.asset_id, entry.asset_id);
    assert!(load_reference(Path::new(&reference.path))
        .unwrap()
        .target_path
        .ends_with("named.v2.png"));
}

#[test]
fn foreign_reference_rejects_unsafe_asset_identifiers_before_indexing() {
    let f = Fixture::new();
    let root = f.db.connect_directory(&f.target, None).unwrap();
    let original = f.source.join("one.png");
    let path = f.target.join("unsafe.bowerbird");
    let mut data = MaterialReference {
        version: 1,
        kind: "bowerbird-reference".into(),
        asset_id: String::new(),
        target_relative: relative(&f.target, &original),
        target_path: string(&original),
        sha256: external_files::fingerprint(&original).unwrap(),
    };
    for malicious in [
        "../escape".to_owned(),
        "..\\escape".to_owned(),
        "bad\nidentifier".to_owned(),
        "bad\0identifier".to_owned(),
        "非ASCII".to_owned(),
        "a".repeat(129),
    ] {
        data.asset_id = malicious.clone();
        super::super::file_workspace::write_json(&path, &data).unwrap();
        assert!(load_reference(&path).is_err());
        assert!(f.db.scan_connection(&f.paths, &root).is_err());
        assert!(f.db.get_asset(&malicious).unwrap().is_none());
        assert!(f.entries(&root).is_empty());
    }
    assert!(original.is_file());
    data.asset_id = "safe_ID-0123".into();
    super::super::file_workspace::write_json(&path, &data).unwrap();
    f.db.scan_connection(&f.paths, &root).unwrap();
    assert_eq!(f.entries(&root)[0].asset_id, data.asset_id);
}

#[test]
fn refresh_preserves_project_removal_until_explicit_reconnect() {
    let f = Fixture::new();
    let project = "connected-project";
    f.db.create_project(project, project, project, project, "project")
        .unwrap();
    let root = f.db.connect_directory(&f.source, Some(project)).unwrap();
    f.db.scan_connection(&f.paths, &root).unwrap();
    let original = f.entries(&root).pop().unwrap();
    let project_entries = || {
        f.db.connection_entry_ids(Some(&root), Some(project), None, 0, 10)
            .unwrap()
    };
    assert_eq!(project_entries(), vec![original.id.clone()]);

    f.db.delete_asset_with_mode(
        &original.asset_id,
        super::super::projects::AssetDeleteMode::Keep,
        Some(project),
    )
    .unwrap();
    f.db.scan_connection(&f.paths, &root).unwrap();
    assert!(project_entries().is_empty());

    // A metadata change also takes the slow path without undoing the user's project choice.
    fs::OpenOptions::new()
        .write(true)
        .open(&original.path)
        .unwrap()
        .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(60))
        .unwrap();
    f.db.scan_connection(&f.paths, &root).unwrap();
    assert!(project_entries().is_empty());

    fs::copy(&original.path, f.source.join("new.png")).unwrap();
    f.db.scan_connection(&f.paths, &root).unwrap();
    let added = project_entries();
    assert_eq!(added.len(), 1);
    assert_ne!(added[0], original.id);
    assert!(Path::new(&original.path).is_file());

    assert_eq!(
        f.db.connect_directory(&f.source, Some(project)).unwrap(),
        root
    );
    assert_eq!(project_entries().len(), 2);
    assert!(project_entries().contains(&original.id));
}
