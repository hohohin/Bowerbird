use super::*;

#[test]
#[ignore = "requires local FFmpeg; synthetic media and temporary library only"]
fn audio_extract_preserves_source_retries_and_rejects_silent_video() {
    let scratch = Scratch(std::env::temp_dir().join(format!("bowerbird-audio-test-{}",ulid::Ulid::new())));
    let paths = LibraryPaths::init(scratch.0.join("library")).unwrap();
    let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
    db.create_project("p","test","blank:p","blank:p","blank").unwrap();
    let source = scratch.0.join("test.mp4");
    let binary = tools::resolve(Tool::Ffmpeg).unwrap();
    let result = tools::command(binary).args(["-nostdin","-v","error","-y","-f","lavfi","-i","color=red:s=64x48:r=25:d=2",
        "-f","lavfi","-i","sine=frequency=440:duration=2","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac"]).arg(&source).output().unwrap();
    assert!(result.status.success());
    let original = ingest::ingest_generated(&paths,&db,&source,None,"test").unwrap();
    let source = original.store_path.as_deref().unwrap(); let before=fs::read(source).unwrap();
    let audio = extract(&db,&paths,source,"same-operation",Some("p")).unwrap();
    assert_eq!(audio.ext.as_deref(),Some("wav"));
    assert!(audio.name.ends_with("-音轨")); assert!(audio.origin_path.is_none());
    let decoded=media::audio::decode(Path::new(audio.store_path.as_deref().unwrap())).unwrap();
    assert!((decoded.duration-2.0).abs()<0.1);
    assert!(decoded.peaks.iter().any(|p|p[1]>0.05),"real waveform must contain sound");
    assert_eq!(extract(&db,&paths,source,"same-operation",Some("p")).unwrap().id,audio.id);
    assert!(extract(&db,&paths,source,"same-operation",None).is_err(),"cannot reuse identity for another destination");
    assert!(extract(&db,&paths,source,"invalid-project",Some("missing")).is_err());
    assert_eq!(fs::read(source).unwrap(),before);
    db.conn.lock().unwrap().execute_batch("CREATE TRIGGER reject_audio BEFORE INSERT ON analyses WHEN NEW.kind='video_audio' BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
    let count_before: i64=db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM assets",[],|r|r.get(0)).unwrap();
    assert!(extract(&db,&paths,source,"failed-save",Some("p")).is_err());
    assert_eq!(db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM assets",[],|r|r.get::<_,i64>(0)).unwrap(),count_before,"failed persistence removes the new asset");
    assert_eq!(fs::read(source).unwrap(),before);
    db.conn.lock().unwrap().execute_batch("DROP TRIGGER reject_audio;").unwrap();
    assert_eq!(db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM project_assets WHERE asset_id=?1 AND project_id='p'",[&audio.id],|r|r.get::<_,i64>(0)).unwrap(),1);
    let silent=scratch.0.join("silent.mp4");
    assert!(tools::command(binary).args(["-nostdin","-v","error","-y","-i",source,"-an","-c:v","copy"]).arg(&silent).status().unwrap().success());
    let silent=ingest::ingest_generated(&paths,&db,&silent,None,"test").unwrap();
    let count: i64=db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM assets",[],|r|r.get(0)).unwrap();
    assert!(extract(&db,&paths,silent.store_path.as_deref().unwrap(),"silent-operation",None).unwrap_err().to_string().contains("没有可提取"));
    assert_eq!(db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM assets",[],|r|r.get::<_,i64>(0)).unwrap(),count);
    assert!(fs::read_dir(paths.root.join(".video-audio")).unwrap().next().is_none(),"scratch cleaned on success and error");
    assert!(extract(&db,&paths,"unregistered.mp4","unknown",None).is_err());
}
