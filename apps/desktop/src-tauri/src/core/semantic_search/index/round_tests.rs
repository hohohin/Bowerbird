use super::*;
use crate::{core::settings::SemanticIndexPreferences, db::migrations::migrations};

fn db() -> Database {
    let db = Database::open_in_memory().unwrap();
    db.migrate().unwrap();
    db
}

fn no_inference(db: &Database, now: i64) -> WorkerTick {
    run_one_with_clock(db, || now, |_| panic!("no image is due")).unwrap()
}

fn schedule(db: &Database) -> Schedule {
    Schedule::read(&db.conn.lock().unwrap()).unwrap()
}

fn configure(db: &Database, now: i64, automatic: bool, interval_minutes: u32) {
    schedule::reconcile(
        db,
        || SemanticIndexPreferences { automatic, interval_minutes, include_generated: true },
        now,
    ).unwrap();
}

#[test]
fn first_ready_tick_starts_round_and_interval_edits_reseat_its_next_deadline() {
    let db = db();
    let now = 10_000;
    assert_eq!(status(&db).unwrap().index_state, "off");
    assert!(no_inference(&db, now).round_changed);
    assert!(schedule(&db).active());
    assert!(!no_inference(&db, now + 1).round_changed);
    assert!(no_inference(&db, now + 2).round_changed);
    assert_eq!(schedule(&db).last_update_at, Some(now + 2));
    assert_eq!(schedule(&db).next_update_at, Some(now + 902));
    assert!(matches!(no_inference(&db, now + 100).wake, WorkerWake::At(at) if at == now + 902));

    configure(&db, now + 200, true, 60);
    assert_eq!(schedule(&db).next_update_at, Some(now + 3_800));
    assert!(!no_inference(&db, now + 902).progress);
    assert!(no_inference(&db, now + 3_800).round_changed);
}

#[test]
fn automatic_off_manual_round_coalesces_and_pause_and_disable_win_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("library.db");
    let db = Database::open(&path).unwrap();
    db.migrate().unwrap();
    let now = 20_000;
    configure(&db, now, false, 15);
    assert!(matches!(no_inference(&db, now).wake, WorkerWake::Command));
    let first = control(&db, "update").unwrap().operation_id;
    assert_eq!(control(&db, "update").unwrap().operation_id, first);
    assert!(schedule(&db).active());
    drop(db);

    let db = Database::open(&path).unwrap();
    recover(&db).unwrap();
    assert!(schedule(&db).active());
    no_inference(&db, now + 1);
    assert!(no_inference(&db, now + 2).round_changed);
    assert_eq!(schedule(&db).last_update_at, Some(now + 2));
    assert_eq!(schedule(&db).next_update_at, None);
    assert!(!no_inference(&db, now + 3).progress);

    control(&db, "pause").unwrap();
    configure(&db, now + 3, true, 15);
    assert_eq!(control(&db, "update").unwrap().index_state, "paused");
    assert!(!no_inference(&db, now + 2_000).progress);
    assert_eq!(control(&db, "resume").unwrap().index_state, "running");
    assert!(schedule(&db).active());
    control(&db, "disable").unwrap();
    drop(db);

    let db = Database::open(&path).unwrap();
    recover(&db).unwrap();
    assert!(!no_inference(&db, now + 2_000).progress);
    assert_eq!(status(&db).unwrap().index_state, "off");
    assert_eq!(schedule(&db).last_update_at, Some(now + 2));
}

#[test]
fn migration_0061_continues_0060_round_and_retains_vectors_history_and_cursor() {
    let db = Database::open_in_memory().unwrap();
    {
        let mut conn = db.conn.lock().unwrap();
        migrations().to_version(&mut conn, 60).unwrap();
        conn.execute("INSERT INTO semantic_index_state(id,model_key,run_state,operation_id,revision,backfill_after,backfill_complete,audit_after,next_audit)
            VALUES(1,?1,'running','previous-op',9,'image',1,'audit-cursor',900)", [model::MODEL_ID]).unwrap();
        conn.execute("INSERT INTO assets(id,store_path,name,ext,size,created_at) VALUES('image','image.png','image','png',5,1)", []).unwrap();
        let sha = "0".repeat(64);
        conn.execute("INSERT INTO semantic_vectors(asset_id,model_key,content_sha256,dim,vec_f32le,updated_at)
            VALUES('image',?1,?2,768,zeroblob(3072),800)", params![model::MODEL_ID, sha]).unwrap();
        conn.execute("UPDATE semantic_jobs SET status='ready',content_sha256=?1,attempts=2", [&sha]).unwrap();
    }
    db.migrate().unwrap();
    recover(&db).unwrap();
    assert!(schedule(&db).active());
    let status = status(&db).unwrap();
    assert_eq!(status.operation_id.as_deref(), Some("previous-op"));
    assert_eq!(status.index_revision, 9);
    assert_eq!(status.indexed, 1);
    let conn = db.conn.lock().unwrap();
    let run = read_run(&conn).unwrap().unwrap();
    assert!(run.backfill_complete);
    assert_eq!(run.audit_after, "audit-cursor");
    let attempts: i64 = conn.query_row("SELECT attempts FROM semantic_jobs WHERE asset_id='image'", [], |row| row.get(0)).unwrap();
    assert_eq!(attempts, 2);
}

#[test]
fn round_enqueues_one_bounded_audit_batch_and_keeps_its_cursor() {
    let db = db();
    let now = 30_000;
    control(&db, "start").unwrap();
    no_inference(&db, now);
    assert!(no_inference(&db, now + 1).round_changed);
    {
        let conn = db.conn.lock().unwrap();
        conn.execute_batch(
            "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<40)
             INSERT INTO assets(id,name,ext,store_path,created_at)
             SELECT printf('asset-%02d',n),'image','png','missing.png',1 FROM seq;
             UPDATE semantic_jobs SET status='ready';",
        ).unwrap();
    }
    control(&db, "update").unwrap();
    let (claim, wake, _) = take_work(&db, now + 2).unwrap();
    assert!(matches!(wake, WorkerWake::Continue));
    assert_eq!(claim.unwrap().id, "asset-01");
    let conn = db.conn.lock().unwrap();
    assert_eq!(read_run(&conn).unwrap().unwrap().audit_after, "asset-32");
    let queued: i64 = conn.query_row(
        "SELECT COUNT(*) FROM semantic_jobs WHERE status IN ('pending','running')", [], |row| row.get(0),
    ).unwrap();
    assert_eq!(queued, 32);
    assert!(!Schedule::read(&conn).unwrap().audit_pending);
}

#[test]
fn turning_off_automatic_indexing_revokes_its_claim_but_keeps_manual_updates() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image.png");
    image::RgbImage::from_pixel(2, 2, image::Rgb([10, 20, 30])).save(&path).unwrap();
    let db = db();
    db.conn.lock().unwrap().execute(
        "INSERT INTO assets(id,name,ext,store_path,created_at) VALUES('image','image','png',?1,1)",
        [path.to_string_lossy()],
    ).unwrap();
    let now = 40_000;
    assert!(no_inference(&db, now).round_changed);
    let vector = || {
        let mut values = vec![0.0; DIMENSIONS];
        values[0] = 1.0;
        values
    };
    run_one_with_clock(&db, || now + 1, |_| {
        configure(&db, now + 1, false, 15);
        configure(&db, now + 1, true, 15);
        Ok(vector())
    }).unwrap();
    assert_eq!(status(&db).unwrap().indexed, 0);
    assert_eq!(status(&db).unwrap().pending, 1);
    assert!(!no_inference(&db, now + 2).progress);

    assert!(no_inference(&db, now + 901).round_changed);
    control(&db, "update").unwrap();
    run_one_with_clock(&db, || now + 902, |_| {
        configure(&db, now + 902, false, 15);
        Ok(vector())
    }).unwrap();
    assert_eq!(status(&db).unwrap().indexed, 1);
    assert!(!no_inference(&db, now + 903).round_changed);
    assert!(no_inference(&db, now + 904).round_changed);
    assert_eq!(schedule(&db).next_update_at, None);
}

#[test]
fn manual_round_recovers_a_stranded_claim_before_going_idle() {
    let db = db();
    let now = 50_000;
    configure(&db, now, false, 15);
    control(&db, "update").unwrap();
    db.conn.lock().unwrap().execute(
        "INSERT INTO assets(id,name,ext,store_path,created_at) VALUES('image','image','png','missing.png',1)",
        [],
    ).unwrap();
    let first = take_work(&db, now).unwrap().0.unwrap();
    let (replacement, wake, _) = take_work(&db, now + 5).unwrap();
    let replacement = replacement.unwrap();
    assert!(matches!(wake, WorkerWake::Continue));
    assert_eq!(replacement.id, first.id);
    assert_ne!(replacement.lease, first.lease);
    assert_eq!(replacement.generation, first.generation + 1);
    let conn = db.conn.lock().unwrap();
    assert!(!owns_lease(&conn, &first).unwrap());
    assert!(owns_lease(&conn, &replacement).unwrap());
}

#[test]
fn offline_retries_wait_for_the_next_round_even_after_restart() {
    for automatic in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let library = dir.path().join("library.db");
        let offline = dir.path().join("offline.png");
        let mut db = Database::open(&library).unwrap();
        db.migrate().unwrap();
        let start = 60_000;
        configure(&db, start, automatic, 15);
        db.conn.lock().unwrap().execute(
            "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<70)
             INSERT INTO assets(id,name,ext,store_path,created_at)
             SELECT printf('offline-%02d',n),'offline','png',?1,1 FROM seq",
            [offline.to_string_lossy()],
        ).unwrap();
        if automatic {
            assert!(no_inference(&db, start).round_changed);
        } else {
            control_at(&db, "update", start).unwrap();
        }
        let operation_id = status(&db).unwrap().operation_id;

        for elapsed in 1..=71 {
            if elapsed == 36 {
                drop(db);
                db = Database::open(&library).unwrap();
                recover(&db).unwrap();
                assert_eq!(schedule(&db).round_started_at, Some(start));
                if !automatic {
                    let coalesced = control_at(&db, "update", start + elapsed).unwrap();
                    assert_eq!(coalesced.operation_id, operation_id);
                }
                assert_eq!(schedule(&db).round_started_at, Some(start));
                db.conn.lock().unwrap().execute(
                    "INSERT INTO assets(id,name,ext,store_path,created_at)
                     VALUES('new-offline','offline','png',?1,1)",
                    [offline.to_string_lossy()],
                ).unwrap();
            }
            let tick = no_inference(&db, start + elapsed);
            assert!(tick.progress);
            assert!(!tick.round_changed);
        }
        let finish_at = start + 72;
        let completed = no_inference(&db, finish_at);
        assert!(completed.round_changed);
        assert_eq!(schedule(&db).last_update_at, Some(finish_at));
        assert_eq!(schedule(&db).next_update_at, automatic.then_some(finish_at + 900));
        assert_eq!(status(&db).unwrap().unavailable, 71);
        let deferred: i64 = db.conn.lock().unwrap().query_row(
            "SELECT COUNT(*) FROM semantic_jobs WHERE status='unavailable' AND attempts=1",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(deferred, 71);

        let next_round = finish_at + 900;
        if automatic {
            assert!(matches!(completed.wake, WorkerWake::At(at) if at == next_round));
            assert!(no_inference(&db, next_round).round_changed);
        } else {
            assert!(matches!(completed.wake, WorkerWake::Command));
            assert!(!no_inference(&db, next_round).progress);
            control_at(&db, "update", next_round).unwrap();
        }
        assert!(no_inference(&db, next_round + 1).progress);
        let retried: i64 = db.conn.lock().unwrap().query_row(
            "SELECT COUNT(*) FROM semantic_jobs WHERE status='unavailable' AND attempts=2",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(retried, 1);
    }
}

#[test]
fn unapplied_preferences_block_a_late_index_commit_and_preserve_the_manual_round() {
    let dir = tempfile::tempdir().unwrap();
    let settings_path = dir.path().join("settings.json");
    let settings = SettingsState::init(settings_path.clone()).unwrap();
    let path = dir.path().join("image.png");
    image::RgbImage::from_pixel(2, 2, image::Rgb([10, 20, 30]))
        .save(&path)
        .unwrap();
    let db = db();
    let start = 70_000;
    let manual = control_at(&db, "update", start).unwrap().operation_id;
    db.conn.lock().unwrap().execute(
        "INSERT INTO assets(id,name,ext,store_path,created_at) VALUES('image','image','png',?1,1)",
        [path.to_string_lossy()],
    ).unwrap();
    let vector = || {
        let mut values = vec![0.0; DIMENSIONS];
        values[0] = 1.0;
        values
    };
    let tick = run_one_guarded(&db, Some(&settings), || start + 1, |_| {
        settings.update_with(|current| {
            current.semantic_index_automatic = false;
            current.semantic_index_include_generated = false;
        }).unwrap();
        db.conn.lock().unwrap().execute_batch(
            "CREATE TEMP TRIGGER reject_preference_mirror BEFORE UPDATE ON semantic_index_preferences
             BEGIN SELECT RAISE(ABORT,'test mirror write failure'); END;",
        ).unwrap();
        assert!(schedule::reconcile(&db, || settings.semantic_index_preferences(), start + 1).is_err());
        Ok(vector())
    }).unwrap();
    assert!(!tick.progress);
    assert_eq!(status(&db).unwrap().indexed, 0);
    assert_eq!(status(&db).unwrap().operation_id, manual);
    let reopened = SettingsState::init(settings_path).unwrap();
    assert!(!reopened.semantic_index_preferences().include_generated);
    let idle = run_one_guarded(&db, Some(&reopened), || start + 5, |_| {
        panic!("an unapplied scope must not claim an image")
    }).unwrap();
    assert!(!idle.progress);

    db.conn.lock().unwrap().execute_batch("DROP TRIGGER reject_preference_mirror").unwrap();
    schedule::reconcile(&db, || reopened.semantic_index_preferences(), start + 6).unwrap();
    assert_eq!(schedule(&db).round_started_at, Some(start));
    run_one_guarded(&db, Some(&reopened), || start + 6, |_| Ok(vector())).unwrap();
    assert_eq!(status(&db).unwrap().indexed, 1);
    assert_eq!(status(&db).unwrap().operation_id, manual);
}
