use super::*;
use std::{fs, path::Path};
use serde_json::json;

fn clip() -> Vec<u8> {
    fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/media/fragmented.mp4")).unwrap()
}
fn metadata() -> Value {
    json!({"type":"save_blob","media_kind":"video","requested_url":"https://cdn.example/clip.mp4", "effective_url":"https://cdn.example/final.mp4", "page_url":"https://example.com/watch", "file_name":"我的视频.mp4", "content_type":"video/mp4"})
}

#[test]
fn extension_video_blob_saves_actual_video_and_retains_frozen_project() {
    let temporary = tempfile::tempdir().unwrap();
    let paths = LibraryPaths::init(temporary.path().to_owned()).unwrap();
    let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
    db.create_project("original","Original","","original","user").unwrap();
    db.create_project("later","Later","","later","user").unwrap();
    let asset = save(&paths, &db, &clip(), &metadata(), Some("original")).expect("a real MP4 from the extension must save");
    assert_eq!(asset.ext.as_deref(), Some("mp4"));
    assert!(asset.width.unwrap_or(0) > 0 && asset.height.unwrap_or(0) > 0 && asset.duration.unwrap_or(0.0) > 0.0);
    assert_eq!(asset.name, "我的视频");
    assert_eq!(asset.source.as_deref(), Some("extension"));
    assert_eq!(asset.source_url.as_deref(), Some("https://example.com/watch"));
    assert_eq!(asset.origin_path, None);
    assert_eq!(fs::read(asset.store_path.as_ref().unwrap()).unwrap(), clip());
    let conn = db.conn.lock().unwrap();
    let projects: Vec<String> = conn.prepare("SELECT project_id FROM project_assets WHERE asset_id=?1").unwrap()
        .query_map([&asset.id], |row| row.get(0)).unwrap().map(Result::unwrap).collect();
    assert_eq!(projects, ["original"]);
}

fn files(path: &Path) -> Vec<std::path::PathBuf> {
    let mut result = Vec::new();
    for entry in fs::read_dir(path).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() { result.extend(files(&path)); } else { result.push(path); }
    }
    result
}

#[test]
fn extension_video_blob_uses_real_container_not_mime_or_filename() {
    let temporary = tempfile::tempdir().unwrap();
    let paths = LibraryPaths::init(temporary.path().to_owned()).unwrap();
    let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
    let mut meta = metadata(); meta["content_type"] = json!("image/png"); meta["file_name"] = json!("wrong.png");
    let asset = save(&paths, &db, &clip(), &meta, None).unwrap();
    assert_eq!(asset.ext.as_deref(),Some("mp4"));
    assert!(asset.store_path.as_ref().unwrap().ends_with(".mp4"));
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(8,8).write_to(&mut png,image::ImageFormat::Png).unwrap();
    for bytes in [b"<html>login</html>".to_vec(), png.into_inner(), b"\0\0\0\x10ftypisom\0\0\0\0".to_vec(), vec![]] {
        assert_eq!(save(&paths,&db,&bytes,&metadata(),None).unwrap_err().code,"invalid_media");
    }
    assert_eq!(db.count_assets(None).unwrap(),1);
    assert_eq!(fs::read_dir(paths.root.join("extension-uploads")).unwrap().count(),0);
}

#[test]
fn extension_video_blob_enforces_declared_size_type_and_project_before_ingest() {
    let temporary = tempfile::tempdir().unwrap();
    let paths = LibraryPaths::init(temporary.path().to_owned()).unwrap();
    let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
    let bytes = clip();
    let mut meta = metadata(); meta["byte_length"] = json!(MAX_BYTES);
    validate_metadata(&meta).expect("the video protocol must support up to 200 MiB, not the image limit");
    meta["byte_length"] = json!(MAX_BYTES + 1);
    assert_eq!(save(&paths,&db,&bytes,&meta,None).unwrap_err().code,"too_large");
    meta["byte_length"] = json!(bytes.len() + 1);
    assert_eq!(save(&paths,&db,&bytes,&meta,None).unwrap_err().code,"invalid_media");
    meta["media_kind"] = json!("image");
    assert_eq!(save(&paths,&db,&bytes,&meta,None).unwrap_err().code,"invalid_metadata");
    assert_eq!(save(&paths,&db,&bytes,&metadata(),Some("gone")).unwrap_err().code,"project_unavailable");
    assert_eq!(db.count_assets(None).unwrap(),0);
    assert!(files(temporary.path()).is_empty());
}

#[test]
fn extension_video_blob_exact_reuse_preserves_manual_metadata_and_records_each_source_once() {
    let temporary = tempfile::tempdir().unwrap();
    let paths = LibraryPaths::init(temporary.path().to_owned()).unwrap();
    let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
    let first = save(&paths,&db,&clip(),&metadata(),None).unwrap();
    db.conn.lock().unwrap().execute("UPDATE assets SET name='用户命名',source='jimeng',source_url='https://original.example',rating=5,file_mtime=123 WHERE id=?1",[&first.id]).unwrap();
    let mut meta = metadata(); meta["page_url"] = json!("https://another.example/watch"); meta["file_name"] = json!("不要覆盖.mp4");
    for _ in 0..2 {
        let reused = save(&paths,&db,&clip(),&meta,None).unwrap();
        assert_eq!(reused.id,first.id); assert_eq!(reused.name,"用户命名"); assert_eq!(reused.source.as_deref(),Some("jimeng"));
        assert_eq!(reused.source_url.as_deref(),Some("https://original.example"));
        assert_eq!(reused.rating,Some(5)); assert_eq!(reused.file_mtime,Some(123));
        assert_eq!(reused.store_path,first.store_path);
    }
    let analyses = db.list_analyses_by_asset(&first.id).unwrap();
    assert_eq!(analyses.iter().filter(|a| a.kind == "extension_capture").count(),2);
    assert_eq!(db.count_assets(None).unwrap(),1);
    assert_eq!(fs::read_dir(paths.root.join("extension-uploads")).unwrap().count(),0);
}

#[test]
fn extension_video_blob_failed_ingest_and_metadata_commit_leave_no_new_files_or_rows() {
    for trigger in [
        "CREATE TRIGGER fail_upload BEFORE INSERT ON assets BEGIN SELECT RAISE(ABORT,'fixture insert failure'); END;",
        "CREATE TRIGGER fail_upload BEFORE INSERT ON analyses WHEN NEW.kind='extension_capture' BEGIN SELECT RAISE(ABORT,'fixture provenance failure'); END;",
    ] {
        let temporary = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::init(temporary.path().to_owned()).unwrap();
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute_batch(trigger).unwrap();
        assert_eq!(save(&paths,&db,&clip(),&metadata(),None).unwrap_err().code,"save_failed");
        assert_eq!(db.count_assets(None).unwrap(),0);
        assert!(files(temporary.path()).is_empty(),"only owned provisional files may be removed");
    }
}

#[test]
fn extension_video_blob_file_workspace_uses_frozen_project_directory() {
    let temporary = tempfile::tempdir().unwrap();
    let mut paths = LibraryPaths::init(temporary.path().join("appdata")).unwrap();
    paths.files = Some(std::sync::Arc::new(crate::core::file_workspace::FileWorkspace::open(
        temporary.path().join("workspace.json"), temporary.path().join("visible-library")).unwrap()));
    let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
    db.create_project("original","Original","","original","user").unwrap();
    let target = paths.for_project(&db,Some("original")).unwrap().destination.unwrap();
    let asset = save(&paths,&db,&clip(),&metadata(),Some("original")).unwrap();
    assert!(Path::new(asset.store_path.as_ref().unwrap()).starts_with(target));
    assert_eq!(fs::read(asset.store_path.unwrap()).unwrap(),clip());
}
