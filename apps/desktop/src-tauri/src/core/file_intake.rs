//! Explicit loose-file collection. Folder connection itself still indexes in place.
use crate::{core::{external_files, ingest, library::Asset, paths::LibraryPaths, text_documents}, db::Database, error::{AppError, AppResult}};
use std::{fs, io::Write, path::Path};

pub fn supported(path: &Path) -> bool {
    external_files::image_path(path) || external_files::video_path(path)
        || external_files::audio_path(path) || text_documents::text_path(path)
}

pub fn collect(paths: &LibraryPaths, db: &Database, source: &Path) -> AppResult<Asset> {
    let source = fs::canonicalize(source)?;
    if !source.is_file() || !supported(&source) {
        return Err(AppError::Media("不支持此素材格式".into()));
    }
    if paths.managed_file_root(&source).is_some() || connected(db, &source)? {
        return ingest::ingest_file(paths, db, &source);
    }
    let mut target_paths = paths.clone();
    target_paths.destination = None; // Loose collection belongs to the shared inbox, even from a project.
    let ext = source.extension().and_then(|v| v.to_str()).unwrap_or("").to_lowercase();
    let destination = target_paths.asset_store_path(&ulid::Ulid::new().to_string(), &ext)?;
    let parent = destination.parent().ok_or_else(|| AppError::Other("无法确定收集箱位置".into()))?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    std::io::copy(&mut fs::File::open(&source)?, &mut temporary)?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    temporary.persist_noclobber(&destination).map_err(|error| AppError::Io(error.error))?;
    // Once durable, preserve the received file even if indexing fails so it can be recovered.
    let mut asset = ingest::ingest_file(paths, db, &destination)?;
    let name = source.file_stem().unwrap_or_default().to_string_lossy();
    db.conn.lock().unwrap().execute("UPDATE assets SET name=?2,origin_path=NULL,source='imported' WHERE id=?1", rusqlite::params![asset.id, name])?;
    if !text_documents::text_path(&source) {
        crate::core::preset::recognize_and_prefill(db, &source, &mut asset)?;
    }
    db.link_external_to_library(&asset.id)
}

fn connected(db: &Database, source: &Path) -> AppResult<bool> {
    for id in db.connected_root_ids()? {
        let folder = db.connected_folder(&id)?;
        if folder.available && fs::canonicalize(folder.path).ok().is_some_and(|root| source.starts_with(root)) { return Ok(true); }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::file_workspace::FileWorkspace;
    use std::sync::Arc;

    #[test]
    fn collected_png_keeps_color_metadata_and_preset_generation_history() {
        let temp = tempfile::tempdir().unwrap();
        let mut paths = LibraryPaths::init(temp.path().join("data")).unwrap();
        paths.files = Some(Arc::new(FileWorkspace::open(temp.path().join("files.json"), temp.path().join("BowerbirdLibrary")).unwrap()));
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        let source = crate::media::phash::testutil::make_photo_file(temp.path(), "preset-12.png", 256, 2);
        let bytes = fs::read(&source).unwrap();
        let asset = collect(&paths, &db, &source).unwrap();
        assert!(asset.phash.is_some(), "collection must preserve normal image indexing");
        assert!(asset.colors.is_some(), "collection must remain available to color filtering");
        assert!(asset.generation_session_id.is_some());
        assert!(db.has_analysis(&asset.id, "generation_meta").unwrap());
        assert_eq!(db.generation_history(&asset.id, None, None).unwrap().turns.len(), 1);
        assert_eq!(fs::read(asset.store_path.unwrap()).unwrap(), bytes);
        assert_eq!(fs::read(source).unwrap(), bytes);
    }

    #[test]
    fn loose_files_enter_inbox_without_folder_connections_and_preserve_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let mut paths = LibraryPaths::init(temp.path().join("data")).unwrap();
        let root = temp.path().join("BowerbirdLibrary");
        paths.files = Some(Arc::new(FileWorkspace::open(temp.path().join("files.json"), root.clone()).unwrap()));
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        let directory = temp.path().join("input"); fs::create_dir(&directory).unwrap();
        let image = directory.join("same.png");
        image::RgbaImage::from_pixel(8,6,image::Rgba([20,50,100,255])).save(&image).unwrap();
        let video = directory.join("clip.mp4"); fs::write(&video,include_bytes!("../../tests/fixtures/media/fragmented.mp4")).unwrap();
        let audio = directory.join("sound.wav");
        // Minimal PCM WAV.
        let mut wav = b"RIFF".to_vec(); wav.extend(38u32.to_le_bytes()); wav.extend(b"WAVEfmt "); wav.extend(16u32.to_le_bytes()); wav.extend(1u16.to_le_bytes()); wav.extend(1u16.to_le_bytes()); wav.extend(8000u32.to_le_bytes()); wav.extend(16000u32.to_le_bytes()); wav.extend(2u16.to_le_bytes()); wav.extend(16u16.to_le_bytes()); wav.extend(b"data"); wav.extend(2u32.to_le_bytes()); wav.extend([0,0]); fs::write(&audio,wav).unwrap();
        let text = directory.join("notes.md"); fs::write(&text,"# original\n").unwrap();
        // A project destination must not redirect standalone collection out of the inbox.
        paths.destination = Some(temp.path().join("project"));
        let mut received = Vec::new();
        for source in [&image,&video,&audio,&text] {
            let bytes=fs::read(source).unwrap(); let asset=collect(&paths,&db,source).unwrap();
            let stored=std::path::PathBuf::from(asset.store_path.unwrap());
            assert!(stored.starts_with(root.canonicalize().unwrap().join("收集箱")));
            assert_eq!(fs::read(&stored).unwrap(),bytes); assert_eq!(fs::read(source).unwrap(),bytes);
            assert!(!asset.library_hidden); received.push(stored.clone());
            let repeated = collect(&paths,&db,source).unwrap();
            let repeated_path = std::path::PathBuf::from(repeated.store_path.unwrap());
            assert!(!received.contains(&repeated_path), "same-name collection cannot overwrite prior files");
            assert_eq!(fs::read(&stored).unwrap(),bytes); assert_eq!(fs::read(repeated_path).unwrap(),bytes);
        }
        assert!(db.connected_root_ids().unwrap().is_empty());
        let id=db.connect_directory(&directory,None).unwrap(); db.scan_connection(&paths,&id).unwrap();
        let linked=collect(&paths,&db,&image).unwrap();
        assert_eq!(std::path::PathBuf::from(linked.store_path.unwrap()),image.canonicalize().unwrap());
        assert_eq!(fs::read_dir(root.join("收集箱")).unwrap().count(),8);
        let managed = collect(&paths,&db,&received[0]).unwrap();
        assert_eq!(std::path::PathBuf::from(managed.store_path.unwrap()),received[0]);
        assert_eq!(fs::read_dir(root.join("收集箱")).unwrap().count(),8);
    }
}
