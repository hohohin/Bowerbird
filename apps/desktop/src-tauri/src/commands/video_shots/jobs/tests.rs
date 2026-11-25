use super::*;
#[test]
fn durable_original_attempt_stop_and_receipt_survive_reopen() {
    let (dir, db, _, hash) = crate::commands::video_shots::tests::fixture();
    let path = dir.path().join("library.db");
    let asset = "v";
    let shot = "0-15000";
    let mut q = Queue {
        id: "one".into(),
        quote: Quote {
            source_hash: hash.clone(),
            plan_revision: 1,
            owner: "owner".into(),
            shot_ids: vec![shot.into()],
            rerun: false,
            pricing_version: 1,
            total_milli: 54,
            expires_at: 99,
        },
        items: vec![Item {
            id: shot.into(),
            start: 0,
            end: 15000,
            expected: None,
            milli: 54,
            key: "library-shot:abc".into(),
            cache: false,
            manifest: None,
            job: None,
        }],
        cursor: 0,
        status: "running".into(),
        error: None,
    };
    q.quote.plan_revision += 1;
    assert!(store::create(&db, asset, &q).is_err());
    q.quote.plan_revision -= 1;
    store::create(&db, asset, &q).unwrap();
    assert!(store::create(&db, asset, &q).is_err());
    store::stop(&db, asset, &hash).unwrap();
    drop(db);
    let db = Database::open(&path).unwrap();
    let (mut recovered, stop) = store::load(&db, asset, &hash).unwrap().unwrap();
    assert!(stop);
    assert_eq!(recovered.items[0].key, q.items[0].key);
    let result = ["camera".into(), "frame".into(), "action".into()];
    for _ in 0..2 {
        store::remember(&db, asset, &hash, shot, &q.items[0].key, &result).unwrap();
    }
    assert_eq!(
        store::cached(&db, asset, &hash, shot).unwrap().unwrap().1,
        result
    );
    assert!(store::cached(&db, asset, "replacement", shot)
        .unwrap()
        .is_none());
    recovered.status = "stopped".into();
    store::save(&db, asset, &recovered).unwrap();
    store::create(&db, asset, &q).unwrap();
}
