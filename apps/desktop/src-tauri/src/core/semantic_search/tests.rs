use std::{
    fs,
    path::Path,
    sync::{atomic::AtomicBool, Arc},
    time::{Duration, Instant},
};

use rusqlite::params;

use crate::{
    core::{catalog_browser::CatalogFilter, paths::LibraryPaths},
    db::{migrations::migrations, Database},
};

use super::{
    embedding::{Embedding, DIMENSIONS},
    index,
    model::MODEL_ID,
    query, source,
};

fn axis(first: f32, second: f32) -> Vec<f32> {
    let mut vector = vec![0.0; DIMENSIONS];
    vector[0] = first;
    vector[1] = second;
    vector
}

fn png(path: &Path, red: u8) {
    image::RgbImage::from_pixel(16, 16, image::Rgb([red, 8, 24]))
        .save(path)
        .unwrap();
}

fn insert_asset(db: &Database, id: &str, path: &Path) {
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO assets(id,name,ext,store_path,created_at) VALUES(?1,?1,'png',?2,1)",
            params![id, path.to_string_lossy()],
        )
        .unwrap();
}

fn stored(db: &Database, id: &str) -> String {
    db.conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT content_sha256 FROM semantic_vectors WHERE asset_id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
}

fn run(db: &Database) -> bool {
    index::run_one(db, |_| Ok(axis(1.0, 0.0))).unwrap().progress
}

#[test]
fn migration_0060_keeps_legacy_rows_and_indexes_existing_and_new_images() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("asset.png");
    png(&path, 5);
    let db = Database::open(&temp.path().join("library.db")).unwrap();
    migrations()
        .to_version(&mut db.conn.lock().unwrap(), 59)
        .unwrap();
    insert_asset(&db, "old", &path);
    db.migrate().unwrap();
    assert_eq!(index::status(&db).unwrap().indexed, 0);
    index::control(&db, "start").unwrap();
    assert!(run(&db));
    assert_eq!(stored(&db, "old"), source::digest_at_path(&path).unwrap());
    insert_asset(&db, "new", &path);
    assert_eq!(index::status(&db).unwrap().pending, 1);
    assert!(run(&db));
    assert_eq!(index::status(&db).unwrap().indexed, 2);
    db.conn
        .lock()
        .unwrap()
        .execute("DELETE FROM assets WHERE id='new'", [])
        .unwrap();
    assert_eq!(index::status(&db).unwrap().indexed, 1);
    let db = db.conn.lock().unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM semantic_vectors", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn pause_revokes_inference_commit_and_restart_preserves_pause() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("asset.png");
    png(&path, 7);
    let file = temp.path().join("library.db");
    let db = Database::open(&file).unwrap();
    db.migrate().unwrap();
    insert_asset(&db, "image", &path);
    index::control(&db, "start").unwrap();
    index::run_one(&db, |_| {
        index::control(&db, "pause").unwrap();
        Ok(axis(1.0, 0.0))
    })
    .unwrap();
    assert_eq!(index::status(&db).unwrap().indexed, 0);
    drop(db);

    let db = Database::open(&file).unwrap();
    index::recover(&db).unwrap();
    assert_eq!(index::status(&db).unwrap().index_state, "paused");
    assert!(!run(&db));
    index::control(&db, "resume").unwrap();
    assert!(run(&db));
    assert_eq!(index::status(&db).unwrap().indexed, 1);
}

#[test]
fn same_length_corrupt_model_leaves_images_pending_and_repair_resumes_the_queue() {
    let temp = tempfile::tempdir().unwrap();
    let image = temp.path().join("asset.png");
    png(&image, 12);
    let tower = temp.path().join("vision.onnx");
    let good = b"synthetic model bytes for the checksum guard";
    fs::write(&tower, good).unwrap();
    let pinned = source::digest_at_path(&tower).unwrap();
    let mut changed = *good;
    changed[3] ^= 1;
    fs::write(&tower, changed).unwrap();
    assert_eq!(fs::metadata(&tower).unwrap().len(), good.len() as u64);

    let db = Database::open_in_memory().unwrap();
    db.migrate().unwrap();
    insert_asset(&db, "image-a", &image);
    insert_asset(&db, "image-b", &image);
    index::control(&db, "start").unwrap();
    let encode = |_: &image::DynamicImage| {
        crate::core::local_classification::vector::verify(&tower, &pinned)
            .map_err(index::EncodeFailure::Model)?;
        Ok(axis(1.0, 0.0))
    };
    let tick = index::run_one(&db, encode).unwrap();
    assert!(tick.model_failed);
    let status = index::status(&db).unwrap();
    assert_eq!((status.pending, status.indexed, status.failed), (2, 0, 0));
    assert_eq!(status.last_error, None);
    {
        let conn = db.conn.lock().unwrap();
        let (attempts, leased): (i64, i64) = conn
            .query_row(
                "SELECT SUM(attempts),COUNT(lease) FROM semantic_jobs",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((attempts, leased), (0, 0));
        // Libraries created by an earlier implementation may already have a
        // terminal inference record. Repair must recover it without a rebuild.
        conn.execute("UPDATE semantic_jobs SET status='failed',attempts=3,error_code='inference_failed' WHERE asset_id='image-b'", []).unwrap();
    }
    index::control(&db, "pause").unwrap();
    fs::write(&tower, good).unwrap();
    index::retry_model_failures(&db).unwrap();
    assert_eq!(index::status(&db).unwrap().index_state, "paused");
    assert!(!index::run_one(&db, encode).unwrap().progress);
    index::control(&db, "resume").unwrap();
    assert!(!index::run_one(&db, encode).unwrap().model_failed);
    assert!(!index::run_one(&db, encode).unwrap().model_failed);
    let repaired = index::status(&db).unwrap();
    assert_eq!(
        (repaired.indexed, repaired.pending, repaired.failed),
        (2, 0, 0)
    );
}

#[test]
fn source_replacement_during_inference_cannot_commit() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("asset.png");
    png(&path, 5);
    let db = Database::open_in_memory().unwrap();
    db.migrate().unwrap();
    insert_asset(&db, "image", &path);
    index::control(&db, "start").unwrap();
    index::run_one(&db, |_| {
        png(&path, 12);
        Ok(axis(1.0, 0.0))
    })
    .unwrap();
    let status = index::status(&db).unwrap();
    assert_eq!(status.indexed, 0);
    assert_eq!(status.last_error.as_deref(), Some("source_changed"));
}

#[test]
fn index_status_keeps_visibility_and_progress_categories_consistent() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("asset.png");
    png(&path, 12);
    let db = Database::open_in_memory().unwrap();
    db.migrate().unwrap();
    insert_asset(&db, "a-auditing", &path);
    insert_asset(&db, "b-offline-cached", &path);
    index::control(&db, "start").unwrap();
    assert!(run(&db));
    assert!(run(&db));
    for id in [
        "c-pending",
        "d-offline",
        "e-failed",
        "f-unsupported",
        "g-hidden",
        "h-trashed",
    ] {
        insert_asset(&db, id, &path);
    }
    db.conn.lock().unwrap().execute_batch("UPDATE semantic_jobs SET status='pending' WHERE asset_id='a-auditing';
        UPDATE semantic_jobs SET status='unavailable' WHERE asset_id IN ('b-offline-cached','d-offline');
        UPDATE semantic_jobs SET status='failed' WHERE asset_id='e-failed';
        UPDATE semantic_jobs SET status='unsupported' WHERE asset_id='f-unsupported';
        UPDATE assets SET library_hidden=1 WHERE id='g-hidden';
        INSERT INTO trashed_asset_originals(asset_id,path,fingerprint) VALUES('h-trashed','h','');").unwrap();
    let counts = index::status(&db).unwrap();
    assert_eq!(
        (counts.eligible, counts.indexed, counts.auditing),
        (5, 2, 1)
    );
    assert_eq!(
        (
            counts.pending,
            counts.unavailable,
            counts.failed,
            counts.unsupported
        ),
        (1, 1, 1, 1)
    );
    assert_eq!(
        counts.eligible,
        counts.indexed + counts.pending + counts.unavailable + counts.failed
    );
}

fn query_filter(project_id: Option<&str>) -> CatalogFilter {
    CatalogFilter {
        kind: "all".into(),
        media: "all".into(),
        project_id: project_id.map(str::to_owned),
        ..Default::default()
    }
}

fn search(path: &Path, filter: CatalogFilter, k: usize) -> query::SearchSnapshot {
    query::search(
        path,
        filter,
        axis(1.0, 0.0),
        k,
        false,
        Arc::new(AtomicBool::new(false)),
        Instant::now() + Duration::from_secs(10),
    )
    .unwrap()
}

#[test]
fn ranking_scopes_before_top_k_retains_group_members_and_checks_all_pages() {
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("library.db");
    let db = Database::open(&file).unwrap();
    db.migrate().unwrap();
    index::control(&db, "start").unwrap();
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction().unwrap();
    tx.execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','P','path','key',1)", []).unwrap();
    let sha = "a".repeat(64);
    for id in (0..65)
        .map(|id| format!("{id:02}"))
        .chain(["outside".to_owned()])
    {
        let in_project = id != "outside";
        let vector = Embedding::normalize(if in_project {
            axis(0.6, 0.8)
        } else {
            axis(1.0, 0.0)
        })
        .unwrap();
        tx.execute("INSERT INTO assets(id,name,ext,store_path,created_at,generation_session_id) VALUES(?1,?1,'png',?1,1,'same-gallery')", [&id]).unwrap();
        tx.execute(
            "UPDATE semantic_jobs SET status='ready',content_sha256=?2 WHERE asset_id=?1",
            params![id, sha],
        )
        .unwrap();
        tx.execute("INSERT INTO semantic_vectors(asset_id,model_key,content_sha256,dim,vec_f32le,updated_at) VALUES(?1,?2,?3,768,?4,1)",
            params![id,MODEL_ID,sha,vector.to_bytes()]).unwrap();
        if in_project {
            tx.execute(
                "INSERT INTO project_assets(project_id,asset_id,created_at) VALUES('p',?1,1)",
                [&id],
            )
            .unwrap();
        }
    }
    tx.commit().unwrap();
    drop(conn);
    let mut filter = query_filter(Some("p"));
    filter.generated = Some(true);
    let snapshot = search(&file, filter, 240);
    assert_eq!(
        (snapshot.eligible, snapshot.indexed, snapshot.len()),
        (65, 65, 65)
    );
    assert_eq!(snapshot.ids(&file, 0, 100).unwrap().last().unwrap(), "59");
    let page = serde_json::to_value(snapshot.page(&file, 60, 60).unwrap()).unwrap();
    assert_eq!(page[0]["asset"]["id"], "60");
    assert_eq!(snapshot.ids(&file, 60, 60).unwrap().first().unwrap(), "60");
    assert_eq!(
        search(&file, query_filter(None), 1)
            .ids(&file, 0, 60)
            .unwrap(),
        ["outside"]
    );
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO trashed_asset_originals(asset_id,path,fingerprint) VALUES('64','64','')",
            [],
        )
        .unwrap();
    assert_eq!(
        snapshot.ids(&file, 0, 60).unwrap_err().to_string(),
        "stale_session"
    );
}

#[test]
fn a_native_data_notice_reconciles_same_size_same_mtime_connected_edits() {
    let temp = tempfile::tempdir().unwrap();
    let library = temp.path().join("library");
    let root = temp.path().join("originals");
    fs::create_dir(&root).unwrap();
    let paths = LibraryPaths::init(library).unwrap();
    let file = root.join("asset.png");
    let incoming = temp.path().join("incoming.png");
    png(&file, 1);
    png(&incoming, 230);
    let mut before = fs::read(&file).unwrap();
    let mut after = fs::read(&incoming).unwrap();
    let length = before.len().max(after.len());
    before.resize(length, 0);
    after.resize(length, 0);
    fs::write(&file, before).unwrap();
    let stamp = fs::metadata(&file).unwrap().modified().unwrap();

    let db = Database::open(&paths.db).unwrap();
    db.migrate().unwrap();
    let folder_id = connect(&db, &paths, &root);
    index::control(&db, "start").unwrap();
    assert!(run(&db));
    assert_eq!(index::status(&db).unwrap().indexed, 1);
    let prior = search(&paths.db, query_filter(None), 1);
    let asset = prior.ids(&paths.db, 0, 60).unwrap().pop().unwrap();
    let old_hash = stored(&db, &asset);

    fs::write(&file, after).unwrap();
    fs::File::options()
        .write(true)
        .open(&file)
        .unwrap()
        .set_modified(stamp)
        .unwrap();
    assert!(index::note_original_changes(&db, &[file.clone()]).unwrap());
    assert_eq!(
        prior.ids(&paths.db, 0, 60).unwrap_err().to_string(),
        "stale_session"
    );
    db.scan_connection_with_progress(&paths, &folder_id, || {})
        .unwrap();
    assert!(run(&db));
    assert_ne!(stored(&db, &asset), old_hash);
    assert_eq!(stored(&db, &asset), source::digest_at_path(&file).unwrap());
}

fn connect(db: &Database, paths: &LibraryPaths, root: &Path) -> String {
    let root = fs::canonicalize(root).unwrap();
    let id = db.connect_directory(&root, None).unwrap();
    db.scan_connection_with_progress(paths, &id, || {}).unwrap();
    id
}

#[test]
#[ignore = "local timing probe over 10,000 synthetic vectors"]
fn warm_10k_rank_page_and_ids_timing() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("library.db");
    let db = Database::open(&file).unwrap();
    db.migrate().unwrap();
    index::control(&db, "start").unwrap();
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction().unwrap();
    tx.execute_batch("WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<10000)
        INSERT INTO assets(id,name,ext,store_path,created_at,generation_session_id)
        SELECT printf('fixture-%05d',id), 'Fixture', 'png', 'fixture.png', id, printf('gallery-%03d', id%100) FROM n;").unwrap();
    let hash = "e".repeat(64);
    tx.execute("UPDATE semantic_jobs SET status='ready', content_sha256=?1", [&hash]).unwrap();
    let vector = Embedding::normalize(axis(1.0, 0.0)).unwrap().to_bytes();
    tx.execute("INSERT INTO semantic_vectors(asset_id,model_key,content_sha256,dim,vec_f32le,updated_at)
        SELECT id,?1,?2,768,?3,1 FROM assets", params![MODEL_ID,hash,vector]).unwrap();
    tx.commit().unwrap();
    drop(conn);

    for generated in [None, Some(true)] {
        let mut filter = query_filter(None);
        filter.generated = generated;
        let warm = search(&file, filter.clone(), 240);
        assert_eq!((warm.indexed, warm.eligible), (10_000, 10_000));
        warm.page(&file, 0, 60).unwrap();
        let mut ranking = Vec::new();
        let mut page = Vec::new();
        let mut ids = Vec::new();
        for _ in 0..9 {
            let time = Instant::now();
            let results = search(&file, filter.clone(), 240);
            ranking.push(time.elapsed());
            let time = Instant::now();
            results.page(&file, 60, 60).unwrap();
            page.push(time.elapsed());
            let time = Instant::now();
            results.ids(&file, 60, 60).unwrap();
            ids.push(time.elapsed());
        }
        for (name, mut times) in [("rank",ranking), ("page",page), ("ids",ids)] {
            times.sort_unstable();
            println!("10k vectors generated={generated:?} {name}: median {:?}, worst {:?}", times[4], times[8]);
        }
    }
}
