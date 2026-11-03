use super::*;

struct Fixture {
    db: Database,
    path: PathBuf,
    paths: LibraryPaths,
    _directory: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        let paths = LibraryPaths::init(root.join("library")).unwrap();
        let db = Database::open(&paths.db).unwrap();
        db.migrate().unwrap();
        let path = root.join("original.png");
        image::RgbImage::from_pixel(10, 20, image::Rgb([240, 10, 20]))
            .save(&path)
            .unwrap();
        Self {
            _directory: directory,
            path,
            paths,
            db,
        }
    }
    fn index(&self) -> Asset {
        self.db
            .index_connected_file(&self.paths, &self.path, None)
            .unwrap()
    }
    fn changed(&self) {
        image::RgbImage::from_pixel(40, 70, image::Rgb([12, 30, 240]))
            .save(&self.path)
            .unwrap();
    }
}

#[test]
fn connected_index_reads_headers_without_creating_media_caches() {
    let f = Fixture::new();
    let original = fs::read(&f.path).unwrap();
    let asset = f.index();
    assert_eq!((asset.width, asset.height), (Some(10), Some(20)));
    assert!(asset.thumb_path.is_none());
    assert!(asset.phash.is_none());
    assert!(asset.colors.is_none());
    assert!(!asset.library_hidden);
    assert_eq!(asset.store_path.as_deref(), f.path.to_str());
    assert_eq!(original, fs::read(&f.path).unwrap());
    assert!(!f.paths.root.join("external-previews").exists());
    assert_eq!(fs::read_dir(&f.paths.images).unwrap().count(), 0);
}

#[test]
fn connected_preview_is_demand_generated_and_unchanged_index_keeps_it() {
    let f = Fixture::new();
    let initial = f.index();
    let completed =
        f.db.ensure_connected_preview(&f.paths, &initial.id)
            .unwrap()
            .unwrap();
    assert!(Path::new(completed.thumb_path.as_deref().unwrap()).is_file());
    assert!(completed.colors.is_some());
    assert!(completed.phash.is_some());
    let before = fs::metadata(completed.thumb_path.as_ref().unwrap())
        .unwrap()
        .modified()
        .unwrap();
    let again = f.index();
    assert_eq!(again.id, initial.id);
    assert_eq!(again.thumb_path, completed.thumb_path);
    assert_eq!(again.colors, completed.colors);
    assert_eq!(again.phash, completed.phash);
    let cached =
        f.db.ensure_connected_preview(&f.paths, &initial.id)
            .unwrap()
            .unwrap();
    assert_eq!(cached.thumb_path, completed.thumb_path);
    assert_eq!(
        fs::metadata(cached.thumb_path.unwrap())
            .unwrap()
            .modified()
            .unwrap(),
        before
    );
}

#[test]
fn changed_original_keeps_identity_user_records_and_rejects_old_preview() {
    let f = Fixture::new();
    let initial = f.index();
    let completed =
        f.db.ensure_connected_preview(&f.paths, &initial.id)
            .unwrap()
            .unwrap();
    {
        let conn = f.db.conn.lock().unwrap();
        conn.execute("INSERT INTO analyses(id,asset_id,kind,payload) VALUES('my-notes',?1,'caption','user text')", [&initial.id]).unwrap();
        conn.execute("INSERT INTO tags(id,name) VALUES('my-tag','手动')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO asset_tags(asset_id,tag_id,origin) VALUES(?1,'my-tag','manual')",
            [&initial.id],
        )
        .unwrap();
    }
    f.changed();
    let changed = f.index();
    assert_eq!(changed.id, initial.id);
    assert_eq!((changed.width, changed.height), (Some(40), Some(70)));
    assert!(changed.thumb_path.is_none());
    assert!(changed.colors.is_none());
    assert!(changed.phash.is_none());
    {
        let conn = f.db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT payload FROM analyses WHERE asset_id=?1",
                [&initial.id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "user text"
        );
        assert_eq!(
            conn.query_row(
                "SELECT origin FROM asset_tags WHERE asset_id=?1",
                [&initial.id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "manual"
        );
    }
    assert!(f
        .db
        .complete_connected_preview(&f.paths, &f.path, completed.thumb_path.as_deref().unwrap())
        .is_err());
    let refreshed =
        f.db.ensure_connected_preview(&f.paths, &changed.id)
            .unwrap()
            .unwrap();
    assert_ne!(refreshed.thumb_path, completed.thumb_path);
    assert_ne!(refreshed.colors, completed.colors);
}

#[test]
fn changed_original_requeues_classification_only_when_enabled() {
    let f = Fixture::new();
    let initial = f.index();
    f.db.set_local_enabled(true).unwrap();
    assert_eq!(
        f.db.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM local_auto_classification_pending",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    f.index();
    assert_eq!(
        f.db.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM local_auto_classification_pending",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    f.changed();
    f.index();
    assert_eq!(
        f.db.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT asset_id FROM local_auto_classification_pending",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        initial.id
    );
    f.db.set_local_enabled(false).unwrap();
    image::RgbImage::from_pixel(80, 90, image::Rgb([20, 240, 20]))
        .save(&f.path)
        .unwrap();
    f.index();
    assert_eq!(
        f.db.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM local_auto_classification_pending",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn heic_connection_defers_conversion_until_preview_is_requested() {
    let f = Fixture::new();
    let source = f.path.with_extension("heic");
    let bytes = include_bytes!("../../tests/fixtures/heic/rgb-strips-96.heic");
    fs::write(&source, bytes).unwrap();
    let asset = f.db.index_connected_file(&f.paths, &source, None).unwrap();
    assert_eq!(asset.ext.as_deref(), Some("heic"));
    assert!(asset.thumb_path.is_none());
    assert!(!f.paths.root.join("external-previews").exists());
    let loaded =
        f.db.ensure_connected_preview(&f.paths, &asset.id)
            .unwrap()
            .unwrap();
    assert_eq!((loaded.width, loaded.height), (Some(96), Some(32)));
    assert!(image::open(loaded.thumb_path.unwrap()).is_ok());
    assert_eq!(fs::read(&source).unwrap(), bytes);
}

#[test]
fn lazy_heic_reference_can_be_used_before_thumbnail_request() {
    let f = Fixture::new();
    let source = f.path.with_extension("heic");
    fs::write(
        &source,
        include_bytes!("../../tests/fixtures/heic/rgb-strips-96.heic"),
    )
    .unwrap();
    let asset = f.db.index_connected_file(&f.paths, &source, None).unwrap();
    assert!(asset.thumb_path.is_none());
    let resolved =
        f.db.resolve_external_image_paths(&[source.to_string_lossy().into_owned()])
            .unwrap();
    assert_ne!(Path::new(&resolved[0]), source);
    assert_eq!(image::image_dimensions(&resolved[0]).unwrap(), (96, 32));
    assert!(f
        .db
        .get_asset(&asset.id)
        .unwrap()
        .unwrap()
        .thumb_path
        .is_none());
}

#[test]
fn video_connection_does_not_start_a_decoder_or_create_a_poster() {
    let f = Fixture::new();
    let source = f.path.with_extension("mp4");
    fs::write(&source, b"not decoded during indexing").unwrap();
    let asset = f.db.index_connected_file(&f.paths, &source, None).unwrap();
    assert_eq!(asset.ext.as_deref(), Some("mp4"));
    assert_eq!(asset.width, Some(0));
    assert!(asset.thumb_path.is_none());
    assert!(!f.paths.root.join("external-previews").exists());
}

#[test]
fn svg_connection_keeps_direct_browser_preview_without_raster_work() {
    let f = Fixture::new();
    let source = f.path.with_extension("svg");
    fs::write(&source, br#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"><rect width="10" height="20" fill="red"/></svg>"#).unwrap();
    let asset = f.db.index_connected_file(&f.paths, &source, None).unwrap();
    assert_eq!(asset.thumb_path.as_deref(), source.to_str());
    assert!(!f.paths.root.join("external-previews").exists());
}

#[test]
fn managed_original_can_refresh_in_place_without_becoming_external() {
    let f = Fixture::new();
    let managed = crate::core::ingest::ingest_new_file(&f.paths, &f.db, &f.path).unwrap();
    let source = Path::new(managed.store_path.as_deref().unwrap());
    assert_eq!(
        f.db.index_connected_file(&f.paths, source, None)
            .unwrap()
            .id,
        managed.id
    );
    image::RgbImage::from_pixel(100, 200, image::Rgb([20, 240, 30]))
        .save(source)
        .unwrap();
    let changed = f.db.index_connected_file(&f.paths, source, None).unwrap();
    assert_eq!(changed.id, managed.id);
    assert_eq!((changed.width, changed.height), (Some(100), Some(200)));
    assert!(changed.thumb_path.is_none());
    assert!(!f.db.is_external_asset(&managed.id).unwrap());
}

#[cfg(target_os = "windows")]
#[test]
fn legacy_ordinary_managed_path_matches_canonical_scan_and_completes_preview() {
    let f = Fixture::new();
    let managed = crate::core::ingest::ingest_new_file(&f.paths, &f.db, &f.path).unwrap();
    let canonical = fs::canonicalize(managed.store_path.as_deref().unwrap()).unwrap();
    let ordinary = connection_path_spellings(&canonical, &canonical)[2].clone();
    assert_ne!(ordinary, canonical.to_string_lossy());
    f.db.conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE assets SET store_path=?2,origin_path=?2 WHERE id=?1",
            params![managed.id, ordinary],
        )
        .unwrap();
    // The scanner supplies canonical paths even when the original row predates them.
    let indexed =
        f.db.index_connected_file(&f.paths, &canonical, None)
            .unwrap();
    assert_eq!(indexed.id, managed.id);
    assert_eq!(indexed.store_path.as_deref(), Some(ordinary.as_str()));
    image::RgbImage::from_pixel(130, 170, image::Rgb([220, 40, 20]))
        .save(&canonical)
        .unwrap();
    let changed =
        f.db.index_connected_file(&f.paths, &canonical, None)
            .unwrap();
    assert_eq!(changed.id, managed.id);
    assert!(changed.thumb_path.is_none());
    let preview = preview_with_index(&f.paths, Some(&f.db), &canonical).unwrap();
    assert!(f
        .db
        .connected_preview_pending(&canonical, &preview)
        .unwrap());
    assert!(f
        .db
        .connected_preview_pending(Path::new(&ordinary), &preview)
        .unwrap());
    let complete =
        f.db.ensure_connected_preview(&f.paths, &managed.id)
            .unwrap()
            .unwrap();
    assert_eq!(complete.thumb_path.as_deref(), Some(preview.as_str()));
    assert_eq!((complete.width, complete.height), (Some(130), Some(170)));
    assert_eq!(complete.store_path.as_deref(), Some(ordinary.as_str()));
    assert_eq!(complete.origin_path.as_deref(), Some(ordinary.as_str()));
    assert!(!f
        .db
        .connected_preview_pending(&canonical, &preview)
        .unwrap());
    assert_eq!(f.db.count_assets(None).unwrap(), 1);
    assert!(!f.db.is_external_asset(&managed.id).unwrap());
}

#[cfg(target_os = "windows")]
#[test]
fn ordinary_unc_spelling_is_preserved_for_matching() {
    let canonical = Path::new(r"\\?\UNC\server\share\photo.png");
    assert_eq!(
        connection_path_spellings(canonical, canonical)[2],
        r"\\server\share\photo.png"
    );
}
