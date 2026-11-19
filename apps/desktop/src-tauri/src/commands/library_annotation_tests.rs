use super::*;

struct Fixture { _dir: tempfile::TempDir, paths: LibraryPaths, db: Database, asset: Asset }
impl Fixture {
    fn new(extension: &str, external: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::init(dir.path().join("library")).unwrap();
        let db = Database::open(&paths.db).unwrap(); db.migrate().unwrap();
        let path = dir.path().join(format!("landscape.{extension}"));
        image::RgbImage::from_pixel(80, 40, image::Rgb([240, 20, 30])).save(&path).unwrap();
        let asset = if external { db.index_connected_file(&paths, &path, None).unwrap() }
            else { crate::core::ingest::ingest_generated(&paths, &db, &path, None, "test").unwrap() };
        Self { _dir: dir, paths, db, asset }
    }
    fn request(&self) -> Overwrite { Overwrite { asset_id: self.asset.id.clone(), source_hash: fingerprint(Path::new(self.asset.store_path.as_deref().unwrap())).unwrap() } }
    fn bytes(&self) -> Vec<u8> { fs::read(self.asset.store_path.as_deref().unwrap()).unwrap() }
    fn output(&self) -> (Vec<u8>, String) {
        let mut data = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(40,80,image::Rgba([30,40,200,120])))
            .write_to(&mut data, ImageFormat::Png).unwrap();
        (data.into_inner(), serde_json::json!({"schema_version":1,"source_asset_id":self.asset.id,"source_store_path":self.asset.store_path,
            "image":{"width":40,"height":80},"shapes":[],"transform":[{"kind":"rotate","dir":1}]}).to_string())
    }
    fn save(&self, request: &Overwrite) -> AppResult<Asset> { let (bytes, meta) = self.output(); overwrite(&self.paths, &self.db, request, &bytes, &meta) }
}

#[test]
fn preserves_identity_format_membership_and_records_transform_only_edits() {
    for (ext, external) in [("png",false),("png",true),("jpg",true),("webp",true),("bmp",true)] {
        let f = Fixture::new(ext,external);
        f.db.conn.lock().unwrap().execute("UPDATE assets SET name='kept',name_manual=1,library_hidden=1 WHERE id=?1", [&f.asset.id]).unwrap();
        let request = f.request();
        let old_bytes = f.bytes();
        let saved = f.save(&request).unwrap();
        assert_eq!(saved.id,f.asset.id); assert_eq!(saved.store_path,f.asset.store_path);
        assert_eq!((saved.width,saved.height),(Some(40),Some(80)));
        assert_eq!(saved.name,"kept"); assert!(saved.library_hidden);
        assert_ne!(saved.thumb_path,f.asset.thumb_path);
        assert_eq!(image::image_dimensions(saved.thumb_path.as_ref().unwrap()).unwrap(),(40,80));
        assert_eq!(image::guess_format(&f.bytes()).unwrap(),ImageFormat::from_extension(ext).unwrap());
        assert_ne!(old_bytes,f.bytes());
        if ext == "png" || ext == "webp" { assert_eq!(image::load_from_memory(&f.bytes()).unwrap().to_rgba8().get_pixel(0,0)[3],120); }
        let analyses = f.db.list_analyses_by_asset(&saved.id).unwrap();
        let meta: Value = serde_json::from_str(&analyses[0].payload).unwrap();
        assert_eq!(meta["transform"][0]["kind"],"rotate"); assert_eq!(meta["shapes"],serde_json::json!([]));
        assert_eq!(meta["source_sha256"],request.source_hash);
        assert_eq!(meta["output_sha256"],f.request().source_hash);
        assert_eq!(meta["save_mode"],"overwrite");
        if external { assert!(f.db.resolve_external_paths(&[saved.store_path.clone().unwrap()]).is_ok()); }
        // Reindexing must not invalidate the replacement or lose its geometry/history.
        let indexed = f.db.index_connected_file(&f.paths, Path::new(saved.store_path.as_deref().unwrap()),None).unwrap();
        assert_eq!(indexed.id,saved.id); assert_eq!(indexed.thumb_path,saved.thumb_path);
        f.save(&f.request()).unwrap();
        assert_eq!(f.db.list_analyses_by_asset(&saved.id).unwrap().len(),2);
        let reopened = Database::open(&f.paths.db).unwrap();
        assert_eq!(reopened.get_asset(&saved.id).unwrap().unwrap().height,Some(80));
        assert_eq!(reopened.list_analyses_by_asset(&saved.id).unwrap().len(),2);
    }
}

#[test]
fn stale_edit_and_database_failures_leave_original_and_history_untouched() {
    let f = Fixture::new("png",true);
    let original = f.bytes();
    let mut stale = f.request(); stale.source_hash = "0".repeat(64);
    assert!(f.save(&stale).unwrap_err().to_string().contains("已变化"));
    assert_eq!(f.bytes(),original);
    for trigger in [
        "CREATE TRIGGER reject_annotation BEFORE INSERT ON analyses BEGIN SELECT RAISE(ABORT,'test'); END;",
        "CREATE TABLE commit_check (id TEXT REFERENCES assets(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER reject_annotation AFTER INSERT ON analyses BEGIN INSERT INTO commit_check VALUES ('absent'); END;"
    ] {
        f.db.conn.lock().unwrap().execute_batch(trigger).unwrap();
        assert!(f.save(&f.request()).is_err());
        assert_eq!(f.bytes(),original,"including commit failure after atomic replacement");
        let current = f.db.get_asset(&f.asset.id).unwrap().unwrap();
        assert_eq!(current.width,Some(80)); assert_eq!(current.thumb_path,f.asset.thumb_path);
        assert!(f.db.list_analyses_by_asset(&f.asset.id).unwrap().is_empty());
        f.db.conn.lock().unwrap().execute_batch("DROP TRIGGER reject_annotation;").unwrap();
    }
    let first = f.request(); f.save(&first).unwrap();
    assert!(f.save(&first).is_err(),"two editors cannot overwrite the newer revision");
}

#[test]
fn rejects_readonly_unsupported_and_mismatched_metadata() {
    let f = Fixture::new("png",true);
    let original = f.bytes(); let request = f.request(); let (bytes, mut meta) = f.output();
    meta = meta.replace("\"width\":40","\"width\":41");
    assert!(overwrite(&f.paths,&f.db,&request,&bytes,&meta).is_err());
    let path = Path::new(f.asset.store_path.as_deref().unwrap());
    let permissions = fs::metadata(path).unwrap().permissions();
    let mut readonly = permissions.clone(); readonly.set_readonly(true); fs::set_permissions(path,readonly).unwrap();
    assert!(f.save(&request).is_err()); fs::set_permissions(path,permissions).unwrap();
    assert_eq!(f.bytes(),original);
    let gif = Fixture::new("gif",true);
    assert!(gif.save(&gif.request()).unwrap_err().to_string().contains("不能覆盖"));
}

#[test]
fn refreshes_all_identities_of_the_same_original_without_changing_canvas_or_tags() {
    let f = Fixture::new("png",true);
    f.db.create_project("p","test","blank:p","blank:p","blank").unwrap();
    f.db.add_assets_to_project("p",std::slice::from_ref(&f.asset.id)).unwrap();
    let conn = f.db.conn.lock().unwrap();
    conn.execute("INSERT INTO assets(id,name,store_path,ext,width,height,library_hidden,created_at) VALUES('alias','legacy',?1,'png',80,40,1,1)", [&f.asset.store_path]).unwrap();
    conn.execute("INSERT INTO analyses(id,asset_id,kind,payload,created_at) VALUES('caption',?1,'caption','{\"text\":\"kept\"}',1)", [&f.asset.id]).unwrap();
    drop(conn);
    f.save(&f.request()).unwrap();
    let alias = f.db.get_asset("alias").unwrap().unwrap();
    assert_eq!((alias.width,alias.height),(Some(40),Some(80))); assert!(alias.library_hidden);
    assert_eq!(alias.name,"legacy");
    let records = f.db.list_analyses_by_asset(&f.asset.id).unwrap();
    assert_eq!(records.len(),2); assert!(records.iter().any(|r|r.id=="caption"));
    assert_eq!(f.db.list_analyses_by_asset("alias").unwrap().len(),1);
    let conn = f.db.conn.lock().unwrap();
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM assets",[],|r|r.get::<_,i64>(0)).unwrap(),2);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM project_assets WHERE project_id='p'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
}
