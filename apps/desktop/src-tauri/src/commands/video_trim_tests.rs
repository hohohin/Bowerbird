use super::*;

#[test]
fn trim_ranges_reject_invalid_values() {
    for (start, end) in [(f64::NAN, 1.0), (0.0, f64::INFINITY), (-1.0, 1.0), (1.0, 1.0), (2.0, 1.0), (0.0, 4.0)] {
        assert!(validate_range(start, end, 3.0).is_err());
    }
    assert!(validate_range(0.0, 0.04, 0.04).is_ok());
}

#[test]
#[ignore = "requires local FFmpeg/FFprobe; uses only synthetic media and a temporary library"]
fn trim_real_video_copy_overwrite_and_failure_preservation() {
    let scratch = Scratch(std::env::temp_dir().join(format!("bowerbird-trim-test-{}", ulid::Ulid::new())));
    let paths = LibraryPaths::init(scratch.0.join("library")).unwrap();
    let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
    db.create_project("p", "test", "blank:p", "blank:p", "blank").unwrap();
    let source = scratch.0.join("source.mp4");
    let binary = tools::resolve(Tool::Ffmpeg).unwrap();
    let result = tools::command(binary).args(["-nostdin", "-v", "error", "-y",
        "-f", "lavfi", "-i", "color=red:s=64x48:r=25:d=1", "-f", "lavfi", "-i", "color=lime:s=64x48:r=25:d=1",
        "-f", "lavfi", "-i", "color=blue:s=64x48:r=25:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-map", "3:a",
        "-c:v", "libx264", "-g", "75", "-c:a", "aac", "-pix_fmt", "yuv420p"]).arg(&source).output().unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    let original = ingest::ingest_generated(&paths, &db, &source, None, "test").unwrap();
    let path = original.store_path.as_deref().unwrap();
    let bytes = fs::read(path).unwrap();
    let copy = trim(&db, &paths, path, 1.1, 1.9, false, Some("p")).unwrap();
    assert_ne!(copy.id, original.id);
    assert!((copy.duration.unwrap() - 0.8).abs() < 0.08);
    assert_eq!(fs::read(path).unwrap(), bytes);
    assert_eq!(db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM project_assets WHERE asset_id=?1 AND project_id='p'", [&copy.id], |r| r.get::<_, i64>(0)).unwrap(), 1);
    let frame = tools::command(binary).args(["-v", "error", "-i"]).arg(copy.store_path.as_deref().unwrap())
        .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]).output().unwrap();
    assert!(frame.status.success());
    assert!(frame.stdout[0] < 30 && frame.stdout[1] > 220 && frame.stdout[2] < 30, "non-keyframe input must start on green");
    let probe = tools::command(tools::resolve(Tool::Ffprobe).unwrap()).args(["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0"])
        .arg(copy.store_path.as_deref().unwrap()).output().unwrap();
    assert!(String::from_utf8_lossy(&probe.stdout).contains("audio"));
    // A DB write failure must leave source bytes and metadata intact.
    db.conn.lock().unwrap().execute_batch("CREATE TRIGGER reject_trim BEFORE UPDATE OF duration ON assets BEGIN SELECT RAISE(ABORT, 'test save failure'); END;").unwrap();
    assert!(trim(&db, &paths, path, 0.2, 0.7, true, None).is_err());
    assert_eq!(fs::read(path).unwrap(), bytes);
    assert_eq!(db.get_asset(&original.id).unwrap().unwrap().duration, original.duration);
    db.conn.lock().unwrap().execute_batch("DROP TRIGGER reject_trim;").unwrap();
    // A deferred constraint fails at COMMIT, after the file has been replaced.
    db.conn.lock().unwrap().execute_batch("CREATE TABLE trim_commit_check (asset_id TEXT REFERENCES assets(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER reject_trim_commit AFTER UPDATE OF duration ON assets BEGIN INSERT INTO trim_commit_check VALUES ('missing-asset'); END;").unwrap();
    assert!(trim(&db, &paths, path, 0.2, 0.7, true, None).is_err());
    assert_eq!(fs::read(path).unwrap(), bytes, "failed commit restores the original bytes");
    assert_eq!(db.get_asset(&original.id).unwrap().unwrap().duration, original.duration);
    db.conn.lock().unwrap().execute_batch("DROP TRIGGER reject_trim_commit; DROP TABLE trim_commit_check;").unwrap();
    let replaced = trim(&db, &paths, path, 0.2, 0.7, true, None).unwrap();
    assert_eq!(replaced.id, original.id); assert_eq!(replaced.store_path, original.store_path);
    assert!((replaced.duration.unwrap() - 0.5).abs() < 0.08);
    assert_ne!(replaced.thumb_path, original.thumb_path);
    assert_ne!(fs::read(path).unwrap(), bytes);
    assert!(trim(&db, &paths, path, 0.0, 4.0, true, None).is_err());
    let external = source.to_string_lossy().into_owned();
    db.conn.lock().unwrap().execute("UPDATE assets SET store_path=?1 WHERE id=?2", params![external, original.id]).unwrap();
    assert!(trim(&db, &paths, &external, 0.0, 1.0, true, None).unwrap_err().to_string().contains("外部引用"));
    assert_eq!(fs::read(source).unwrap(), bytes);
}
