use super::*;

fn extract(
    db: &Database,
    paths: &LibraryPaths,
    source: &str,
    operation: &str,
    project: Option<&str>,
) -> AppResult<Asset> {
    super::extract(
        db,
        paths,
        &registered_source(db, source)?,
        operation,
        project,
    )
    .map(|(asset, _)| asset)
}

#[test]
#[ignore = "requires local FFmpeg; synthetic media and temporary library only"]
fn audio_extract_reuses_current_source_per_project_and_repairs_missing_results() {
    let scratch =
        Scratch(std::env::temp_dir().join(format!("bowerbird-audio-reuse-{}", ulid::Ulid::new())));
    let paths = LibraryPaths::init(scratch.0.join("library")).unwrap();
    let db = Database::open_in_memory().unwrap();
    db.migrate().unwrap();
    db.create_project("p", "test", "blank:p", "blank:p", "blank")
        .unwrap();
    let original = scratch.0.join("source.mp4");
    let binary = tools::resolve(Tool::Ffmpeg).unwrap();
    write_video(binary, &original, "440");
    let asset = ingest::ingest_generated(&paths, &db, &original, None, "test").unwrap();
    let source = asset.store_path.as_deref().unwrap();
    let first = extract(&db, &paths, source, "first", Some("p")).unwrap();
    let second = extract(&db, &paths, source, "second", Some("p")).unwrap();
    assert_eq!(first.id, second.id, "different operations reuse one WAV");
    assert!(
        extract(&db, &paths, source, "second", None).is_err(),
        "cache hits still claim the operation destination"
    );
    assert_ne!(
        extract(&db, &paths, source, "library", None).unwrap().id,
        first.id
    );
    fs::remove_file(first.store_path.as_deref().unwrap()).unwrap();
    let repaired = extract(&db, &paths, source, "first", Some("p")).unwrap();
    assert_ne!(repaired.id, first.id);
    assert_eq!(
        extract(&db, &paths, source, "second", Some("p"))
            .unwrap()
            .id,
        repaired.id
    );
    let old = fs::metadata(source).unwrap();
    let modified = old.modified().unwrap() + Duration::from_secs(2);
    fs::OpenOptions::new()
        .write(true)
        .open(source)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    assert_eq!(fs::metadata(source).unwrap().len(), old.len());
    let new = extract(&db, &paths, source, "first", Some("p")).unwrap();
    assert_ne!(new.id, repaired.id, "a new mtime alone creates a fresh WAV");
    assert_eq!(
        extract(&db, &paths, source, "next", Some("p")).unwrap().id,
        new.id
    );
    let legacy_payload =
        serde_json::json!({"source_asset_id":asset.id,"project_id":"p","source_size":old.len()});
    db.conn.lock().unwrap().execute("INSERT INTO analyses(id,asset_id,kind,payload) VALUES('video-audio:legacy',?1,'video_audio',?2)",
        params![new.id, legacy_payload.to_string()]).unwrap();
    use std::io::Write;
    fs::OpenOptions::new()
        .append(true)
        .open(source)
        .unwrap()
        .write_all(b"\0\0\0\x08free")
        .unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(source)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    assert_ne!(fs::metadata(source).unwrap().len(), old.len());
    assert_ne!(
        extract(&db, &paths, source, "changed-size", Some("p"))
            .unwrap()
            .id,
        new.id
    );
    assert_eq!(
        extract(&db, &paths, source, "legacy", Some("p"))
            .unwrap()
            .id,
        new.id,
        "an exact legacy operation remains replayable"
    );
    assert!(extract(&db, &paths, source, "legacy", None).is_err());
}

#[tokio::test]
#[ignore = "requires local FFmpeg; synthetic media and temporary library only"]
async fn queue_handles_parallel_sources_and_coalesces_same_source() {
    let scratch =
        Scratch(std::env::temp_dir().join(format!("bowerbird-audio-queue-{}", ulid::Ulid::new())));
    let paths = Arc::new(LibraryPaths::init(scratch.0.join("library")).unwrap());
    let db = Arc::new(Database::open_in_memory().unwrap());
    db.migrate().unwrap();
    let original = scratch.0.join("source.mp4");
    write_video(tools::resolve(Tool::Ffmpeg).unwrap(), &original, "440");
    let register = || {
        ingest::ingest_generated(&paths, &db, &original, None, "test")
            .unwrap()
            .store_path
            .unwrap()
    };
    let (a, b, c) = (register(), register(), register());
    let request = |source: String, operation: &str| {
        extract_queued(
            db.clone(),
            paths.clone(),
            source,
            operation.to_owned(),
            None,
        )
    };
    let (first, second, third, fourth) = tokio::join!(
        request(a.clone(), "a1"),
        request(a, "a2"),
        request(b, "b"),
        request(c, "c")
    );
    let (first, first_created) = first.unwrap();
    let (second, second_created) = second.unwrap();
    assert_eq!(first.id, second.id);
    assert_ne!(
        first_created, second_created,
        "only one of the competing requests creates the WAV"
    );
    assert!(third.unwrap().1);
    assert!(fourth.unwrap().1);
    let count: i64 = db
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM assets WHERE source='video-audio'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 3);
}

fn write_video(binary: &Path, output: &Path, frequency: &str) {
    let sound = format!("sine=frequency={frequency}:duration=2");
    let result = tools::command(binary)
        .args([
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=red:s=64x48:r=25:d=2",
            "-f",
            "lavfi",
            "-i",
            &sound,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
        ])
        .arg(output)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
#[ignore = "requires local FFmpeg; synthetic media and temporary library only"]
fn audio_extract_preserves_source_retries_and_rejects_silent_video() {
    let scratch =
        Scratch(std::env::temp_dir().join(format!("bowerbird-audio-test-{}", ulid::Ulid::new())));
    let paths = LibraryPaths::init(scratch.0.join("library")).unwrap();
    let db = Database::open_in_memory().unwrap();
    db.migrate().unwrap();
    db.create_project("p", "test", "blank:p", "blank:p", "blank")
        .unwrap();
    let source = scratch.0.join("test.mp4");
    let binary = tools::resolve(Tool::Ffmpeg).unwrap();
    write_video(binary, &source, "440");
    let original = ingest::ingest_generated(&paths, &db, &source, None, "test").unwrap();
    let source = original.store_path.as_deref().unwrap();
    let before = fs::read(source).unwrap();
    let audio = extract(&db, &paths, source, "same-operation", Some("p")).unwrap();
    assert_eq!(audio.ext.as_deref(), Some("wav"));
    assert!(audio.name.ends_with("-音轨"));
    assert!(audio.origin_path.is_none());
    let decoded = media::audio::decode(Path::new(audio.store_path.as_deref().unwrap())).unwrap();
    assert!((decoded.duration - 2.0).abs() < 0.1);
    assert!(
        decoded.peaks.iter().any(|p| p[1] > 0.05),
        "real waveform must contain sound"
    );
    assert_eq!(
        extract(&db, &paths, source, "same-operation", Some("p"))
            .unwrap()
            .id,
        audio.id
    );
    assert!(
        extract(&db, &paths, source, "same-operation", None).is_err(),
        "cannot reuse identity for another destination"
    );
    assert!(extract(&db, &paths, source, "invalid-project", Some("missing")).is_err());
    assert_eq!(fs::read(source).unwrap(), before);
    db.conn.lock().unwrap().execute_batch("CREATE TRIGGER reject_audio BEFORE INSERT ON analyses WHEN NEW.kind='video_audio' BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
    let count_before: i64 = db
        .conn
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))
        .unwrap();
    assert!(extract(&db, &paths, source, "failed-save", None).is_err());
    assert_eq!(
        db.conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM assets", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        count_before,
        "failed persistence removes the new asset"
    );
    assert_eq!(fs::read(source).unwrap(), before);
    db.conn
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_audio;")
        .unwrap();
    assert_eq!(
        db.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM project_assets WHERE asset_id=?1 AND project_id='p'",
                [&audio.id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    let silent = scratch.0.join("silent.mp4");
    assert!(tools::command(binary)
        .args(["-nostdin", "-v", "error", "-y", "-i", source, "-an", "-c:v", "copy"])
        .arg(&silent)
        .status()
        .unwrap()
        .success());
    let silent = ingest::ingest_generated(&paths, &db, &silent, None, "test").unwrap();
    let count: i64 = db
        .conn
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))
        .unwrap();
    assert!(extract(
        &db,
        &paths,
        silent.store_path.as_deref().unwrap(),
        "silent-operation",
        None
    )
    .unwrap_err()
    .to_string()
    .contains("没有可提取"));
    assert_eq!(
        db.conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM assets", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        count
    );
    assert!(
        fs::read_dir(paths.root.join(".video-audio"))
            .unwrap()
            .next()
            .is_none(),
        "scratch cleaned on success and error"
    );
    assert!(extract(&db, &paths, "unregistered.mp4", "unknown", None).is_err());
}
