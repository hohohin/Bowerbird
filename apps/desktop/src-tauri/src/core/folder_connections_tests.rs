use super::*;

#[test]
fn original_trash_preview_resolves_registered_original_once_without_copying() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let asset = f.entries(&root).pop().unwrap().asset;
    let bytes = fs::read(f.source.join("one.png")).unwrap();
    let preview =
        f.db.preview_asset_originals(&[asset.id.clone(), asset.id.clone()])
            .unwrap();
    assert_eq!(preview.len(), 1);
    assert_eq!(preview[0].asset_id, asset.id);
    assert_eq!(preview[0].name, "one.png");
    assert_eq!(preview[0].path, string(&f.source.join("one.png")));
    assert_eq!(
        preview[0].fingerprint,
        external_files::fingerprint(&f.source.join("one.png")).unwrap()
    );
    assert_eq!(fs::read(f.source.join("one.png")).unwrap(), bytes);
    assert_eq!(fs::read_dir(&f.paths.images).unwrap().count(), 0);
}

#[test]
fn original_trash_preview_rejects_unknown_missing_and_non_media_targets() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let asset = f.entries(&root).pop().unwrap().asset;
    assert!(f.db.preview_asset_originals(&[]).is_err());
    assert!(f
        .db
        .preview_asset_originals(&[asset.id.clone(), "unknown".into()])
        .is_err());
    let invalid_file = f.source.join("reference.bowerbird");
    fs::write(&invalid_file, b"{}").unwrap();
    for path in [&f.source, &invalid_file, &f.source.join("missing.png")] {
        f.db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE assets SET store_path=?2 WHERE id=?1",
                params![asset.id, string(path)],
            )
            .unwrap();
        assert!(f.db.preview_asset_originals(&[asset.id.clone()]).is_err());
    }
}

#[test]
fn original_trash_keeps_creative_identity_and_reference_files_but_marks_them_missing() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let original = f.entries(&root).pop().unwrap();
    f.db.create_material_references(&f.paths, &[original.asset_id.clone()], &target)
        .unwrap();
    f.db.create_project(
        "trash-project",
        "project",
        f.source.to_str().unwrap(),
        "project",
        "user",
    )
    .unwrap();
    f.db.add_assets_to_project("trash-project", &[original.asset_id.clone()])
        .unwrap();
    let reference = f.entries(&target).pop().unwrap();
    let expected = fs::read(&original.path).unwrap();
    let preview =
        f.db.preview_asset_originals(&[reference.asset_id.clone()])
            .unwrap();
    let recycled = f._temp.path().join("recycled.png");
    f.db.trash_asset_original_with(&preview[0], |path| {
        fs::rename(path, &recycled)?;
        Ok(())
    })
    .unwrap();
    assert_eq!(fs::read(&recycled).unwrap(), expected);
    assert!(Path::new(&reference.path).is_file());
    assert!(f.db.get_asset(&original.asset_id).unwrap().is_some());
    assert!(!f.entries(&target)[0].available);
    assert!(f.entries(&root).is_empty());
    let membership: i64 = f
        .db
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM project_assets WHERE project_id='trash-project' AND asset_id=?1",
            [&original.asset_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(membership, 1);
}

#[test]
fn original_trash_rechecks_the_confirmed_path_and_bytes() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let preview =
        f.db.preview_asset_originals(&[entry.asset_id.clone()])
            .unwrap();
    f.db.rename_connection_entry(&entry.id, "moved.png")
        .unwrap();
    assert!(f
        .db
        .trash_asset_original_with(&preview[0], |_| panic!("stale path must not recycle"))
        .is_err());
    let preview =
        f.db.preview_asset_originals(&[entry.asset_id.clone()])
            .unwrap();
    fs::write(&preview[0].path, b"replaced while confirming").unwrap();
    assert!(f
        .db
        .trash_asset_original_with(&preview[0], |_| panic!("stale bytes must not recycle"))
        .is_err());
    assert!(Path::new(&preview[0].path).is_file());
}

#[test]
fn original_trash_failure_preserves_files_and_connection_availability() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let preview =
        f.db.preview_asset_originals(&[entry.asset_id.clone()])
            .unwrap();
    assert!(f
        .db
        .trash_asset_original_with(&preview[0], |_| Err(invalid("recycle unavailable")))
        .is_err());
    assert!(Path::new(&entry.path).is_file());
    assert!(f.entries(&root)[0].available);
    assert!(f.db.get_asset(&entry.asset_id).unwrap().is_some());
}

#[test]
fn original_trash_sql_preflight_failure_never_touches_the_file() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let preview =
        f.db.preview_asset_originals(&[entry.asset_id.clone()])
            .unwrap();
    f.db.conn.lock().unwrap().execute_batch("CREATE TRIGGER refuse_original_trash BEFORE UPDATE OF library_hidden ON assets BEGIN SELECT RAISE(ABORT,'synthetic SQL failure'); END;").unwrap();
    assert!(f
        .db
        .trash_asset_original_with(&preview[0], |_| panic!("SQL failure must precede recycle"))
        .is_err());
    assert!(Path::new(&entry.path).is_file());
    assert!(f.entries(&root)[0].available);
    assert_eq!(
        f.db.conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM trashed_asset_originals", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn original_trash_commit_failure_reports_that_the_original_is_already_recycled() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let preview =
        f.db.preview_asset_originals(&[entry.asset_id.clone()])
            .unwrap();
    f.db.conn.lock().unwrap().execute_batch("CREATE TABLE fail_commit(id TEXT REFERENCES assets(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER defer_original_trash_failure AFTER INSERT ON trashed_asset_originals BEGIN INSERT INTO fail_commit VALUES('absent'); END;").unwrap();
    let recycled = f._temp.path().join("recycled.png");
    let error =
        f.db.trash_asset_original_with(&preview[0], |path| {
            fs::rename(path, &recycled)?;
            Ok(())
        })
        .unwrap_err();
    assert!(error.to_string().contains("原文件已放入回收站"));
    assert!(!Path::new(&entry.path).exists());
    assert!(recycled.is_file());
    assert!(f.db.get_asset(&entry.asset_id).unwrap().is_some());
}

#[test]
fn original_trash_updates_all_registered_identities_for_the_same_file() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let entry = f.entries(&root).pop().unwrap();
    let mut duplicate = entry.asset.clone();
    duplicate.id = "same-original".into();
    f.db.insert_asset(&duplicate).unwrap();
    f.db.create_material_references(&f.paths, &[duplicate.id.clone()], &target)
        .unwrap();
    let preview =
        f.db.preview_asset_originals(&[entry.asset_id.clone()])
            .unwrap();
    f.db.trash_asset_original_with(&preview[0], |path| {
        fs::rename(path, f._temp.path().join("recycled.png"))?;
        Ok(())
    })
    .unwrap();
    assert!(
        f.db.get_asset(&entry.asset_id)
            .unwrap()
            .unwrap()
            .library_hidden
    );
    assert!(
        f.db.get_asset(&duplicate.id)
            .unwrap()
            .unwrap()
            .library_hidden
    );
    assert!(!f.entries(&target)[0].available);
    assert_eq!(
        f.db.conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM trashed_asset_originals", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn original_trash_supports_unconnected_registered_files() {
    let f = Fixture::new();
    let asset =
        f.db.index_connected_file(&f.paths, &f.source.join("one.png"), None)
            .unwrap();
    assert!(!f.db.has_connected_asset(&asset.id).unwrap());
    let preview = f.db.preview_asset_originals(&[asset.id.clone()]).unwrap();
    f.db.trash_asset_original_with(&preview[0], |path| {
        fs::rename(path, f._temp.path().join("recycled.png"))?;
        Ok(())
    })
    .unwrap();
    assert!(!f.source.join("one.png").exists());
    assert!(f.db.get_asset(&asset.id).unwrap().is_some());
}

#[test]
fn original_trash_supports_managed_generated_assets_without_external_registration() {
    let f = Fixture::new();
    let asset =
        f.db.index_connected_file(&f.paths, &f.source.join("one.png"), None)
            .unwrap();
    f.db.conn
        .lock()
        .unwrap()
        .execute("DELETE FROM external_assets WHERE asset_id=?1", [&asset.id])
        .unwrap();
    f.db.conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE assets SET source='generated' WHERE id=?1",
            [&asset.id],
        )
        .unwrap();
    let preview = f.db.preview_asset_originals(&[asset.id.clone()]).unwrap();
    f.db.trash_asset_original_with(&preview[0], |path| {
        fs::rename(path, f._temp.path().join("recycled.png"))?;
        Ok(())
    })
    .unwrap();
    assert!(!f.source.join("one.png").exists());
    assert!(f.db.get_asset(&asset.id).unwrap().unwrap().library_hidden);
}

#[test]
fn reference_removal_rejects_originals_before_touching_any_selected_file() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let original = f.entries(&root).pop().unwrap();
    f.db.create_material_references(&f.paths, &[original.asset_id.clone()], &target)
        .unwrap();
    let reference = f.entries(&target).pop().unwrap();
    assert!(f
        .db
        .remove_connection_references_with(&[reference.id.clone(), original.id], |_| panic!(
            "mixed removal must not recycle"
        ))
        .is_err());
    assert!(Path::new(&reference.path).is_file());
    assert!(Path::new(&original.path).is_file());
    f.db.remove_connection_references_with(&[reference.id.clone(), reference.id], |path| {
        fs::rename(path, f._temp.path().join("recycled.bowerbird"))?;
        Ok(())
    })
    .unwrap();
    assert!(f.entries(&target).is_empty());
    assert!(Path::new(&original.path).is_file());
    assert!(f.db.get_asset(&original.asset_id).unwrap().is_some());
}

#[test]
fn reference_removal_can_retry_after_partial_failure_without_touching_originals() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let original = f.entries(&root).pop().unwrap();
    f.db.create_material_references(&f.paths, &[original.asset_id.clone()], &target)
        .unwrap();
    fs::copy(
        &f.entries(&target)[0].path,
        f.target.join("second.bowerbird"),
    )
    .unwrap();
    f.db.scan_connection(&f.paths, &target).unwrap();
    let entries = f.entries(&target);
    let ids = entries
        .iter()
        .map(|entry| entry.id.clone())
        .collect::<Vec<_>>();
    assert_eq!(ids.len(), 2);
    let count = std::cell::Cell::new(0);
    assert!(f
        .db
        .remove_connection_references_with(&ids, |path| {
            count.set(count.get() + 1);
            if count.get() == 2 {
                return Err(invalid("synthetic locked file"));
            }
            fs::rename(path, f._temp.path().join("first.bowerbird"))?;
            Ok(())
        })
        .is_err());
    assert_eq!(f.entries(&target).len(), 1);
    f.db.remove_connection_references_with(&ids, |path| {
        fs::rename(path, f._temp.path().join("second.bowerbird"))?;
        Ok(())
    })
    .unwrap();
    assert!(f.entries(&target).is_empty());
    assert!(Path::new(&original.path).is_file());
}
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
    fn duplicate_folder_path(&self, folder: &FolderConnection, duplicate: &str) {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "UPDATE connected_folders SET path=?2,available=0 WHERE id=?1",
            params![folder.id, string(&Path::new(&folder.path).join(""))],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO connected_folders(id,root_id,parent_id,path,name) VALUES(?1,?2,?3,?4,?5)",
            params![duplicate, folder.root_id, folder.parent_id, folder.path, folder.name],
        )
        .unwrap();
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
fn refresh_checks_selected_directory_before_other_cached_directories() {
    let f = Fixture::new();
    let child = f.source.join("selected");
    fs::create_dir(&child).unwrap();
    let root = f.connect(&f.source);
    let selected =
        f.db.connection_folders(None, None)
            .unwrap()
            .into_iter()
            .find(|folder| folder.path == string(&child))
            .unwrap()
            .id;
    fs::copy(f.source.join("one.png"), f.source.join("root-new.png")).unwrap();
    fs::copy(f.source.join("one.png"), child.join("selected-new.png")).unwrap();
    let mut selected_seen_first = false;
    f.db.scan_connection_prioritized(&f.paths, &root, Some(&selected), || {
        let selected_count = f.entries(&selected).len();
        let root_count = f.entries(&root).len();
        if selected_count == 1 && root_count == 1 {
            selected_seen_first = true;
        }
    })
    .unwrap();
    assert!(selected_seen_first);
    assert_eq!(f.entries(&root).len(), 2);
    assert_eq!(f.entries(&selected).len(), 1);
}
#[test]
fn scan_excludes_only_its_own_generated_cache_and_database_paths() {
    let f = Fixture::new();
    let library = fs::canonicalize(&f.paths.root).unwrap();
    let preview = library.join("external-previews");
    fs::create_dir(&preview).unwrap();
    fs::copy(f.source.join("one.png"), preview.join("cache.png")).unwrap();
    fs::copy(
        f.source.join("one.png"),
        f.paths.thumbnails.join("cache.png"),
    )
    .unwrap();
    fs::copy(f.source.join("one.png"), library.join("original.png")).unwrap();
    let ignored = generated_connection_paths(&f.paths);
    assert!(ignored.contains(&library.join("library.db-wal")));
    assert!(!ignored
        .iter()
        .any(|path| library.join("images").starts_with(path)));
    let root = f.connect(&library);
    assert_eq!(f.entries(&root).len(), 1);
    assert!(!f
        .db
        .connection_folders(None, None)
        .unwrap()
        .iter()
        .any(|folder| folder.path == string(&preview)));
    let user_named_cache = f.source.join("external-previews");
    fs::create_dir(&user_named_cache).unwrap();
    fs::copy(
        f.source.join("one.png"),
        user_named_cache.join("original.png"),
    )
    .unwrap();
    f.connect(&f.source);
    let user_folder =
        f.db.connection_folders(None, None)
            .unwrap()
            .into_iter()
            .find(|folder| folder.path == string(&user_named_cache))
            .unwrap();
    assert_eq!(f.entries(&user_folder.id).len(), 1);
}
#[test]
fn cached_reference_tracks_changed_original_outside_connected_roots() {
    let f = Fixture::new();
    let source = f.connect(&f.source);
    let target = f.connect(&f.target);
    let original = f.entries(&source).pop().unwrap();
    f.db.create_material_references(&f.paths, &[original.asset_id.clone()], &target)
        .unwrap();
    f.db.scan_connection(&f.paths, &target).unwrap();
    f.db.disconnect_directory(&source).unwrap();
    image::RgbImage::from_pixel(11, 6, image::Rgb([90, 70, 25]))
        .save(f.source.join("one.png"))
        .unwrap();
    f.db.scan_connection(&f.paths, &target).unwrap();
    let updated = f.entries(&target).pop().unwrap();
    assert!(updated.available);
    assert_eq!(updated.asset_id, original.asset_id);
    assert_ne!(updated.version, original.version);
    assert_eq!(updated.asset.width, Some(11));
    let reference = load_reference(Path::new(&updated.path)).unwrap();
    assert_eq!(Some(reference.sha256), updated.version);
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
    for _ in 0..2 {
        f.db.scan_connection(&f.paths, &root).unwrap();
        assert_eq!(f.db.connection_folders(None, None).unwrap().len(), 1);
        assert_eq!(f.db.connected_folder(&root).unwrap().path, string(&moved));
        assert_eq!(f.entries(&root)[0].id, original.id);
        assert_eq!(f.entries(&root)[0].asset_id, original.asset_id);
    }
    f.db.disconnect_directory(&root).unwrap();
    assert!(moved.join("one.png").is_file());
    assert!(f.db.get_asset(&original.asset_id).unwrap().is_some());
}
#[test]
fn disconnected_child_can_be_removed_without_deleting_originals_or_assets() {
    let f = Fixture::new();
    fs::create_dir_all(f.source.join("child/nested")).unwrap();
    fs::copy(f.source.join("one.png"), f.source.join("child/nested/item.png")).unwrap();
    let root = f.connect(&f.source);
    let folders = f.db.connection_folders(None, None).unwrap();
    let child = folders.iter().find(|v| v.name == "child").unwrap();
    let nested = folders.iter().find(|v| v.name == "nested").unwrap();
    let asset = f.entries(&nested.id)[0].asset_id.clone();
    assert!(f.db.disconnect_directory(&child.id).is_err());
    let offline = f.target.join("offline");
    fs::rename(f.source.join("child"), &offline).unwrap();
    f.db.scan_connection(&f.paths, &root).unwrap();
    f.db.disconnect_directory(&child.id).unwrap();
    f.db.scan_connection(&f.paths, &root).unwrap();
    assert_eq!(f.db.connection_folders(None, None).unwrap().len(), 1);
    assert!(f.db.get_asset(&asset).unwrap().is_some());
    assert!(offline.join("nested/item.png").is_file());
    assert!(f.source.join("one.png").is_file());
}
#[test]
fn disconnected_child_rechecks_disk_before_removing_cached_collection() {
    let f = Fixture::new();
    fs::create_dir(f.source.join("child")).unwrap();
    let root = f.connect(&f.source);
    let child = f.db.connection_folders(None, None).unwrap().into_iter().find(|v| v.name == "child").unwrap();
    let offline = f.target.join("offline");
    fs::rename(f.source.join("child"), &offline).unwrap();
    f.db.scan_connection(&f.paths, &root).unwrap();
    fs::rename(&offline, f.source.join("child")).unwrap();
    assert!(f.db.disconnect_directory(&child.id).is_err());
    assert!(f.db.connected_folder(&child.id).is_ok());
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
    for _ in 0..2 {
        f.db.scan_connection(&f.paths, &root).unwrap();
        f.db.scan_connection(&f.paths, &target).unwrap();
        assert_eq!(f.db.connection_folders(None, None).unwrap().len(), 3);
        assert_eq!(f.entries(&child.id)[0].id, before.id);
        assert_eq!(f.entries(&child.id)[0].asset_id, before.asset_id);
        assert!(f.entries(&child.id)[0].available);
    }
}
#[test]
fn renamed_collection_keeps_one_identity_after_repeated_refreshes() {
    let f = Fixture::new();
    fs::create_dir_all(f.source.join("child/nested")).unwrap();
    fs::copy(f.source.join("one.png"), f.source.join("child/nested/two.png")).unwrap();
    let root = f.connect(&f.source);
    let folders = f.db.connection_folders(None, None).unwrap();
    let child = folders.iter().find(|v| v.name == "child").unwrap();
    let nested = folders.iter().find(|v| v.name == "nested").unwrap();
    let original = f.entries(&nested.id).pop().unwrap();

    f.db.rename_connected_directory(&child.id, "改名后").unwrap();
    for _ in 0..2 {
        f.db.scan_connection(&f.paths, &root).unwrap();
        let after = f.db.connection_folders(None, None).unwrap();
        assert_eq!(after.len(), folders.len(), "rename must not create an offline duplicate");
        assert!(after.iter().all(|folder| folder.available));
        let renamed = after.iter().find(|folder| folder.id == child.id).unwrap();
        assert_eq!(renamed.name, "改名后");
        assert_eq!(renamed.path, string(&f.source.join("改名后")));
        assert_eq!(f.entries(&nested.id)[0].id, original.id);
        assert_eq!(f.entries(&nested.id)[0].asset_id, original.asset_id);
    }
}
#[test]
fn refresh_repairs_duplicate_ancestor_paths_without_losing_entries_or_projects() {
    let f = Fixture::new();
    fs::create_dir_all(f.source.join("child/nested/leaf")).unwrap();
    for folder in ["child", "child/nested"] {
        for file in ["first.png", "second.png"] {
            fs::copy(f.source.join("one.png"), f.source.join(folder).join(file)).unwrap();
        }
    }
    let root = f.connect(&f.source);
    let folders = f.db.connection_folders(None, None).unwrap();
    let child = folders.iter().find(|v| v.name == "child").unwrap();
    let nested = folders.iter().find(|v| v.name == "nested").unwrap();
    let leaf = folders.iter().find(|v| v.name == "leaf").unwrap();
    for project in ["old-project", "new-project"] {
        f.db.create_project(project, project, project, project, "project").unwrap();
    }
    let mut originals = Vec::new();
    for (folder, duplicate) in [(child, "duplicate-child"), (nested, "duplicate-nested")] {
        let entries = f.entries(&folder.id);
        f.duplicate_folder_path(folder, duplicate);
        let conn = f.db.conn.lock().unwrap();
        conn.execute("UPDATE connected_entries SET folder_id=?2 WHERE id=?1", params![entries[0].id, duplicate]).unwrap();
        for (id, project) in [(&folder.id[..], "old-project"), (duplicate, "new-project"), (duplicate, "old-project")] {
            conn.execute("INSERT INTO connected_folder_projects(folder_id,project_id) VALUES(?1,?2)", params![id, project]).unwrap();
        }
        originals.push((folder.id.clone(), entries));
    }
    f.db.conn.lock().unwrap().execute(
        "UPDATE connected_folders SET parent_id=CASE WHEN id=?1 THEN 'duplicate-child' ELSE 'duplicate-nested' END WHERE id IN (?1,?2)",
        params![nested.id, leaf.id],
    ).unwrap();

    for _ in 0..2 {
        f.db.scan_connection_prioritized(&f.paths, &root, Some(&nested.id), || {}).unwrap();
        let after = f.db.connection_folders(None, None).unwrap();
        assert_eq!(after.len(), folders.len());
        assert!(after.iter().all(|folder| folder.available));
        assert_eq!(f.db.connected_folder(&nested.id).unwrap().parent_id.as_deref(), Some(child.id.as_str()));
        assert_eq!(f.db.connected_folder(&leaf.id).unwrap().parent_id.as_deref(), Some(nested.id.as_str()));
        for (folder_id, before) in &originals {
            let entries = f.entries(folder_id);
            assert_eq!(entries.len(), before.len());
            for entry in before {
                let current = entries.iter().find(|value| value.id == entry.id).unwrap();
                assert_eq!(current.asset_id, entry.asset_id);
                assert_eq!(current.path, entry.path);
                assert!(current.available);
                assert!(Path::new(&current.path).is_file());
            }
            let conn = f.db.conn.lock().unwrap();
            let mut stmt = conn.prepare("SELECT project_id FROM connected_folder_projects WHERE folder_id=?1 ORDER BY project_id").unwrap();
            let projects = stmt.query_map([folder_id], |r| r.get::<_, String>(0)).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
            assert_eq!(projects, ["new-project", "old-project"]);
        }
    }
}
#[test]
fn refresh_repairs_only_equal_paths_and_keeps_offline_collections() {
    let f = Fixture::new();
    for path in ["first/same", "second/same"] {
        fs::create_dir_all(f.source.join(path)).unwrap();
        fs::copy(f.source.join("one.png"), f.source.join(path).join("item.png")).unwrap();
    }
    let root = f.connect(&f.source);
    let folders = f.db.connection_folders(None, None).unwrap();
    let affected = folders.iter().find(|v| v.path == string(&f.source.join("first/same"))).unwrap();
    let other = folders.iter().find(|v| v.path == string(&f.source.join("second/same"))).unwrap();
    let original = f.entries(&affected.id).pop().unwrap();
    f.duplicate_folder_path(affected, "duplicate-offline");
    fs::rename(&f.source, f.source.with_file_name("offline")).unwrap();

    for _ in 0..2 {
        assert!(f.db.scan_connection(&f.paths, &root).is_err());
        let after = f.db.connection_folders(None, None).unwrap();
        assert_eq!(after.len(), folders.len());
        assert_eq!(after.iter().filter(|v| v.name == "same").count(), 2);
        assert_eq!(f.db.connected_folder(&affected.id).unwrap().path, affected.path);
        assert_eq!(f.db.connected_folder(&other.id).unwrap().path, other.path);
        assert!(after.iter().all(|folder| !folder.available));
        assert_eq!(f.entries(&affected.id)[0].id, original.id);
        assert_eq!(f.entries(&affected.id)[0].asset_id, original.asset_id);
        assert!(!f.entries(&affected.id)[0].available);
    }
}
#[test]
fn duplicate_path_repair_failure_rolls_back_all_relationships() {
    let f = Fixture::new();
    fs::create_dir_all(f.source.join("child/leaf")).unwrap();
    fs::copy(f.source.join("one.png"), f.source.join("child/item.png")).unwrap();
    let root = f.connect(&f.source);
    let folders = f.db.connection_folders(None, None).unwrap();
    let child = folders.iter().find(|v| v.name == "child").unwrap();
    let leaf = folders.iter().find(|v| v.name == "leaf").unwrap();
    let entry = f.entries(&child.id).pop().unwrap();
    f.db.create_project("repair-project", "project", "project", "project", "project").unwrap();
    f.duplicate_folder_path(child, "duplicate-rollback");
    {
        let conn = f.db.conn.lock().unwrap();
        conn.execute("UPDATE connected_entries SET folder_id='duplicate-rollback' WHERE id=?1", [&entry.id]).unwrap();
        conn.execute("UPDATE connected_folders SET parent_id='duplicate-rollback' WHERE id=?1", [&leaf.id]).unwrap();
        conn.execute("INSERT INTO connected_folder_projects(folder_id,project_id) VALUES('duplicate-rollback','repair-project')", []).unwrap();
        conn.execute_batch("CREATE TRIGGER reject_repair BEFORE UPDATE OF path ON connected_folders BEGIN SELECT RAISE(ABORT,'test repair failure'); END;").unwrap();
    }
    assert!(f.db.scan_connection(&f.paths, &root).is_err());
    assert_eq!(f.db.connection_folders(None, None).unwrap().len(), folders.len() + 1);
    assert_eq!(f.db.connected_folder(&child.id).unwrap().path, string(&Path::new(&child.path).join("")));
    assert_eq!(f.db.connected_folder("duplicate-rollback").unwrap().path, child.path);
    assert_eq!(f.db.connected_folder(&leaf.id).unwrap().parent_id.as_deref(), Some("duplicate-rollback"));
    assert!(f.entries(&child.id).is_empty());
    assert_eq!(f.entries("duplicate-rollback")[0].id, entry.id);
    let conn = f.db.conn.lock().unwrap();
    let project_folder: String = conn.query_row("SELECT folder_id FROM connected_folder_projects WHERE project_id='repair-project'", [], |r| r.get(0)).unwrap();
    assert_eq!(project_folder, "duplicate-rollback");
    assert!(Path::new(&entry.path).is_file());
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
        Some(target.clone())
    );
    assert_eq!(f.entries(&child.id)[0].id, before.id);
    assert!(f.entries(&child.id)[0].available);
    assert!(f.target.join("source/child/two.png").exists());
    for _ in 0..2 {
        f.db.scan_connection(&f.paths, &target).unwrap();
        assert_eq!(f.db.connection_folders(None, None).unwrap().len(), 3);
        assert!(f.db.connected_folder(&root).unwrap().available);
        assert_eq!(f.entries(&child.id)[0].id, before.id);
        assert_eq!(f.entries(&child.id)[0].asset_id, before.asset_id);
        assert!(f.entries(&child.id)[0].available);
    }
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
