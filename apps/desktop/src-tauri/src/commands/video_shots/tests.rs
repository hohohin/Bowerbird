use super::*;
use crate::core::external_files::fingerprint;

#[tokio::test]
#[ignore = "requires local FFmpeg; creates synthetic video in a temporary library"]
async fn local_scene_and_frame_smoke() {
    use crate::media::tools::{self, Tool};
    let (tmp, db, path, _) = fixture();
    let output = tools::command(tools::resolve(Tool::Ffmpeg).unwrap())
        .args([
            "-y",
            "-nostdin",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=black:s=80x64:r=25:d=1",
            "-f",
            "lavfi",
            "-i",
            "color=white:s=80x64:r=25:d=1",
            "-filter_complex",
            "concat=n=2:v=1:a=0",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
        ])
        .arg(&path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let plan = get(&db, "v").unwrap();
    assert_eq!(plan.duration_ms, 2000);
    let (_, h) = matching(&db.conn.lock().unwrap(), "v", &path, &plan.source_hash).unwrap();
    let cuts = media::detect(&path, &h, 0.3).await.unwrap();
    assert_eq!(
        cuts,
        vec![Cut {
            at: 1000,
            kind: Kind::Scene
        }]
    );
    let frame = media::frame(&path, tmp.path(), 1000, &h.version)
        .await
        .unwrap();
    let image = image::open(&frame).unwrap().into_rgb8();
    assert!(image.get_pixel(0, 0)[0] > 225);
    let paths = LibraryPaths::init(tmp.path().join("shots")).unwrap();
    let keep = || {
        crate::core::ingest::ingest_video_shot_frame(&paths, &db, &frame)
            .unwrap()
            .id
    };
    let id = keep();
    assert_eq!(id, keep());
    let queued: i64 = db
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM local_auto_classification_pending WHERE asset_id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(queued, 0);
}

pub(in crate::commands) fn fixture() -> (tempfile::TempDir, Database, PathBuf, String) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("video.mp4");
    std::fs::write(&path, b"source-fixture").unwrap();
    let db = Database::open(&dir.path().join("library.db")).unwrap();
    db.migrate().unwrap();
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO assets(id,name,ext,store_path,created_at) VALUES ('v','video','mp4',?1,0)",
            [path.to_str().unwrap()],
        )
        .unwrap();
    let hash = fingerprint(&path).unwrap();
    let h = Header {
        current: true,
        source_hash: hash.clone(),
        version: source_version(&path).unwrap(),
        stamp: FileStamp::read(&path).unwrap(),
        registration: registration(&db, "v").unwrap(),
        duration_ms: 30_000,
        revision: 1,
        threshold: 0.35,
        layout: Layout {
            cuts: vec![Cut {
                at: 15000,
                kind: Kind::Scene,
            }],
            selected: vec!["0-15000".into()],
            ..Default::default()
        },
        undo: None,
    };
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO analyses(id,asset_id,kind,payload) VALUES ('plan','v','video_shots',?1)",
            [serde_json::to_string(&h).unwrap()],
        )
        .unwrap();
    (dir, db, path, hash)
}
fn texts(label: &str) -> Texts {
    [label.into(), "首帧".into(), "运镜".into()]
}

#[test]
fn image_evidence_requires_the_same_revision_before_and_after_io() {
    let (_tmp, db, path, hash) = fixture();
    let (_, p) = checked_plan(&db, "v", &hash).unwrap();
    assert_eq!(p.interval("0-15000"), Some((0, 15000)));
    assert_eq!(p.interval("00-15000"), None);
    assert_eq!(p.interval("1-2"), None);
    std::fs::write(path, b"same-size-demo").unwrap();
    assert!(checked_plan(&db, "v", &hash).is_err());
    assert!(update(&db, "v", &hash, 1, Change::Select { selected: vec![] }).is_err());
    assert!(apply_result(&db, "v", &hash, "0-15000", "late", texts("旧原件"), None).is_err());
}

#[test]
fn stale_source_guard_rejects_trim_and_stale_plan_updates() {
    let (_tmp, db, _path, hash) = fixture();
    let p = update(
        &db,
        "v",
        &hash,
        1,
        Change::Select {
            selected: vec!["15000-30000".into()],
        },
    )
    .unwrap();
    assert_eq!(p.revision, 2);
    assert!(update(&db, "v", &hash, 1, Change::Select { selected: vec![] }).is_err());
    db.conn.lock().unwrap().execute("UPDATE analyses SET payload=json_set(payload,'$.current',json('false')) WHERE id='plan'",[]).unwrap();
    assert!(current_plan(&db, "v", &hash).is_err());
    assert!(apply_result(&db, "v", &hash, "0-15000", "late", texts("旧原件"), None).is_err());
}

#[test]
fn protects_edits_paid_results_and_undo_inside_one_transaction() {
    let (_tmp, db, _path, hash) = fixture();
    let shot = "0-15000";
    apply_result(&db, "v", &hash, shot, "task1", texts("初始"), None).unwrap();
    let p = update(
        &db,
        "v",
        &hash,
        2,
        Change::Edit {
            id: shot.into(),
            texts: texts("手改"),
        },
    )
    .unwrap();
    apply_result(&db, "v", &hash, shot, "task1", texts("初始"), None).unwrap();
    assert_eq!(
        current_plan(&db, "v", &hash).unwrap().1.results[shot],
        texts("手改")
    );
    let merge = |confirmed| Change::Cuts {
        cuts: vec![],
        threshold: None,
        suppressed_at: Some(15000),
        confirmed,
    };
    assert!(update(&db, "v", &hash, p.revision, merge(vec![])).is_err());
    let p = update(&db, "v", &hash, p.revision, merge(vec![shot.into()])).unwrap();
    assert!(p.results.is_empty());
    assert!(p.can_undo);
    let after = "0-30000";
    apply_result(&db, "v", &hash, after, "task2", texts("新分镜"), None).unwrap();
    assert!(update(
        &db,
        "v",
        &hash,
        p.revision + 1,
        Change::Undo { confirmed: vec![] }
    )
    .is_err());
    let undo = update(
        &db,
        "v",
        &hash,
        p.revision + 1,
        Change::Undo {
            confirmed: vec![after.into()],
        },
    )
    .unwrap();
    assert_eq!(undo.results[shot], texts("手改"));
    assert_eq!(undo.selected, vec![shot.to_string()]);
    assert!(!undo.can_undo);
    assert!(apply_result(
        &db,
        "v",
        &hash,
        shot,
        "rerun",
        texts("新结果"),
        Some(&texts("初始"))
    )
    .is_err());
    apply_result(
        &db,
        "v",
        &hash,
        shot,
        "rerun",
        texts("新结果"),
        Some(&texts("手改")),
    )
    .unwrap();
    apply_result(&db, "v", &hash, shot, "task1", texts("旧回执"), None).unwrap();
    assert_eq!(
        current_plan(&db, "v", &hash).unwrap().1.results[shot],
        texts("新结果")
    );
}

#[test]
fn distinguishes_long_unbroken_shots_from_scene_cuts() {
    let duration = 7_260_010;
    let cuts = model::with_long_segments(
        vec![Cut {
            at: 2020,
            kind: Kind::Scene,
        }],
        duration,
    );
    assert_eq!(
        cuts[0],
        Cut {
            at: 2020,
            kind: Kind::Scene
        }
    );
    assert!(cuts[1..].iter().all(|c| c.kind == Kind::Long));
    assert!(intervals(&cuts, duration).all(|(s, e)| e > s && e - s <= 15000));
    assert!(model::validate(&cuts, duration).is_ok());
}
