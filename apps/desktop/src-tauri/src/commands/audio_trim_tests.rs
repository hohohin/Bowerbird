use super::*;
use crate::{core::audio::waveform, media::audio::tests::write_wav};
use std::path::PathBuf;

struct Fixture {
    paths: LibraryPaths,
    db: Database,
    folder: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let folder = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::init(folder.path().join("library")).unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        Self { paths, db, folder }
    }

    fn managed(&self, source: &Path) -> Asset {
        ingest::ingest_generated(&self.paths, &self.db, source, None, "test").unwrap()
    }

    fn wav(&self, name: &str, frames: u32) -> PathBuf {
        let path = self.folder.path().join(name);
        write_wav(&path, frames, false);
        path
    }
}

#[test]
fn rejects_invalid_intervals_and_unregistered_inputs() {
    let fixture = Fixture::new();
    let source = fixture.wav("sound.wav", 16000);
    assert!(trim(&fixture.db, &fixture.paths, source.to_str().unwrap(), 0.0, 1.0, false, None).unwrap_err().to_string().contains("加入素材库"));
    let original = fixture.managed(&source);
    let stored = original.store_path.as_deref().unwrap();
    for (start, end) in [(f64::NAN, 1.0), (0.0, f64::INFINITY), (-1.0, 1.0), (1.0, 1.0), (1.5, 1.0), (0.0, 2.002), (2.0, 2.001)] {
        assert!(trim(&fixture.db, &fixture.paths, stored, start, end, true, None).unwrap_err().to_string().contains("入点"));
    }
    assert_eq!(fs::read(stored).unwrap(), fs::read(source).unwrap());
}

#[test]
fn overwrite_rejects_external_registrations_and_unmanaged_locations() {
    let fixture = Fixture::new();
    let source = fixture.wav("sound.wav", 16000);
    let original = fixture.managed(&source);
    let stored = original.store_path.as_deref().unwrap();
    let db = &fixture.db;
    db.conn.lock().unwrap().execute("INSERT INTO external_assets(asset_id,fingerprint) VALUES(?1,'external')", [&original.id]).unwrap();
    assert!(trim(db, &fixture.paths, stored, 0.0, 1.0, true, None).unwrap_err().to_string().contains("另存为新音频"));
    db.conn.lock().unwrap().execute("DELETE FROM external_assets WHERE asset_id=?1", [&original.id]).unwrap();
    db.conn.lock().unwrap().execute("UPDATE assets SET store_path=?1 WHERE id=?2", params![source.to_str().unwrap(), original.id]).unwrap();
    assert!(trim(db, &fixture.paths, source.to_str().unwrap(), 0.0, 1.0, true, None).unwrap_err().to_string().contains("另存为新音频"));
    assert_eq!(fs::read(stored).unwrap(), fs::read(source).unwrap());
}

#[test]
fn copy_registration_rolls_back_when_membership_cannot_be_written() {
    let fixture = Fixture::new();
    let source = fixture.wav("clip.wav", 4000);
    let result = ingest::ingest_generated_audio_clip(&fixture.paths, &fixture.db, &source, ingest::GeneratedAudioClip {
        name: "原素材-裁剪".into(), duration: 0.5, project_id: Some("deleted-project"),
    });
    assert!(result.is_err());
    assert_eq!(fixture.db.count_assets(None).unwrap(), 0);
    let parent = fixture.paths.asset_store_path("fixture", "wav").unwrap();
    assert_eq!(fs::read_dir(parent.parent().unwrap()).unwrap().count(), 0);
}

#[test]
fn overwrite_refreshes_fingerprint_and_waveform_and_retires_transcript() {
    let fixture = Fixture::new();
    let db = &fixture.db;
    let original = fixture.managed(&fixture.wav("sound.wav", 16000));
    let previous = waveform(&fixture.paths, db, &original.id, None).unwrap();
    let stored = Path::new(original.store_path.as_deref().unwrap());
    let path = fs::canonicalize(stored).unwrap();
    let before = fs::metadata(&path).unwrap();
    let output = fixture.wav("trimmed.wav", 4800);
    let conn = db.conn.lock().unwrap();
    conn.execute("UPDATE assets SET connected_scan_key='stale' WHERE id=?1", [&original.id]).unwrap();
    for kind in ["video_transcript", "description"] {
        conn.execute("INSERT INTO analyses(id,asset_id,kind,payload) VALUES(?1,?2,?1,'{\"current\":true}')", params![kind, original.id]).unwrap();
    }
    drop(conn);

    replace(db, &original, &path, &before, &output, 0.6).unwrap();
    let saved = db.get_asset(&original.id).unwrap().unwrap();
    assert_eq!(saved.store_path, original.store_path);
    assert_eq!(saved.duration, Some(0.6));
    assert_eq!(fs::read(stored).unwrap(), fs::read(&output).unwrap());
    let expected_hash = external_files::fingerprint(stored).unwrap();
    assert!(waveform(&fixture.paths, db, &original.id, Some(&previous.source_version)).is_err());
    let updated = waveform(&fixture.paths, db, &original.id, Some(&expected_hash)).unwrap();
    assert_eq!(updated.waveform.duration, 0.6);
    assert_ne!(updated.source_version, previous.source_version);
    let conn = db.conn.lock().unwrap();
    let recorded: (String, i64, i64) = conn.query_row("SELECT sha256,asset_size,asset_mtime FROM creative_file_fingerprints WHERE asset_id=?1", [&original.id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap();
    assert_eq!(recorded, (expected_hash, saved.size.unwrap(), saved.file_mtime.unwrap()));
    let current: String = conn.query_row("SELECT group_concat(kind) FROM analyses WHERE json_extract(payload,'$.current')=1", [], |row| row.get(0)).unwrap();
    assert_eq!(current, "description");
    let scan_key: Option<String> = conn.query_row("SELECT connected_scan_key FROM assets WHERE id=?1", [&original.id], |row| row.get(0)).unwrap();
    assert!(scan_key.is_none());
}

#[test]
fn commit_failure_restores_original_bytes_mtime_fingerprint_and_transcript() {
    let fixture = Fixture::new();
    let db = &fixture.db;
    let input = fixture.wav("sound.wav", 16000);
    let original = fixture.managed(&input);
    let previous = waveform(&fixture.paths, db, &original.id, None).unwrap();
    let path = fs::canonicalize(original.store_path.as_deref().unwrap()).unwrap();
    let before = fs::metadata(&path).unwrap();
    let output = fixture.wav("trimmed.wav", 4800);
    let conn = db.conn.lock().unwrap();
    conn.execute("INSERT INTO analyses(id,asset_id,kind,payload) VALUES('transcript',?1,'video_transcript','{\"current\":true}')", [&original.id]).unwrap();
    conn.execute_batch("CREATE TABLE trim_commit_check (asset_id TEXT REFERENCES assets(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TRIGGER reject_trim_commit AFTER UPDATE OF duration ON assets BEGIN INSERT INTO trim_commit_check VALUES ('missing-asset'); END;").unwrap();
    drop(conn);

    assert!(replace(db, &original, &path, &before, &output, 0.6).is_err());
    assert_eq!(fs::read(&path).unwrap(), fs::read(input).unwrap());
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), before.modified().unwrap());
    assert_eq!(db.get_asset(&original.id).unwrap().unwrap().duration, Some(2.0));
    let old = waveform(&fixture.paths, db, &original.id, Some(&previous.source_version)).unwrap();
    assert_eq!(old.waveform.duration, 2.0);
    let still_current: bool = db.conn.lock().unwrap().query_row("SELECT json_extract(payload,'$.current') FROM analyses WHERE id='transcript'", [], |row| row.get(0)).unwrap();
    assert!(still_current);
    assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
}

#[test]
#[ignore = "requires local FFmpeg; run with --include-ignored for clip encoding verification"]
fn formats_keep_extensions_and_project_membership() {
    let fixture = Fixture::new();
    let db = &fixture.db;
    db.create_project("p", "test", "blank:p", "blank:p", "blank").unwrap();
    let binary = tools::resolve(Tool::Ffmpeg).unwrap();
    for (ext, encoder) in [("wav", "pcm_s16le"), ("mp3", "libmp3lame"), ("flac", "flac"), ("m4a", "aac"), ("ogg", "libvorbis")] {
        let source = fixture.folder.path().join(format!("recording.{ext}"));
        let result = tools::command(binary).args(["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", encoder])
            .arg(&source).output().unwrap();
        assert!(result.status.success(), "{ext}: {}", String::from_utf8_lossy(&result.stderr));
        let contents = fs::read(&source).unwrap();
        let external = db.index_connected_file(&fixture.paths, &source, None).unwrap();
        let stored = external.store_path.as_deref().unwrap();
        let asset = trim(db, &fixture.paths, stored, 0.2, 1.2, false, Some("p")).unwrap_or_else(|error| panic!("{ext}: {error}"));
        assert_ne!(asset.id, external.id);
        assert_eq!(asset.ext.as_deref(), Some(ext));
        assert_eq!(asset.name, "recording-裁剪");
        assert_eq!(asset.source.as_deref(), Some("audio-trim"));
        assert!(asset.origin_path.is_none());
        assert!((asset.duration.unwrap() - 1.0).abs() < 0.12, "{ext}: {:?}", asset.duration);
        assert_eq!(fs::read(&source).unwrap(), contents);
        let in_project: bool = db.conn.lock().unwrap().query_row("SELECT EXISTS(SELECT 1 FROM project_assets WHERE asset_id=?1 AND project_id='p')", [&asset.id], |row| row.get(0)).unwrap();
        assert!(in_project);
        let replacement = trim(db, &fixture.paths, asset.store_path.as_deref().unwrap(), 0.1, 0.6, true, None).unwrap_or_else(|error| panic!("{ext}: {error}"));
        assert_eq!(asset.id, replacement.id);
        assert!((replacement.duration.unwrap() - 0.5).abs() < 0.12, "{ext}: {:?}", replacement.duration);
    }
}
