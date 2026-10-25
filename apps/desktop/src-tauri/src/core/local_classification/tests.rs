use super::data::*;
use crate::db::Database;

fn db() -> Database {
    let db = Database::open_in_memory().unwrap();
    db.migrate().unwrap();
    db.conn.lock().unwrap().execute_batch("INSERT INTO assets(id,name,ext,thumb_path,created_at) VALUES('a','a','png','a.png',1),('b','b','png','b.png',2);").unwrap();
    db
}

#[test]
fn automatic_classification_only_accepts_inserts_during_current_opt_in() {
    let db = db();
    let model = super::jev::OBSERVATION_MODEL;
    db.set_local_enabled(true).unwrap();
    assert!(db.local_auto_targets(model).unwrap().is_empty(), "old unclassified assets are not new");
    assert_eq!(db.local_targets_for_model(true, model).unwrap(), vec!["a", "b"], "manual scan still sees old assets");
    let add = |id: &str| { db.conn.lock().unwrap().execute(
        "INSERT INTO assets(id,name,ext,created_at) VALUES(?1,?1,'png',0)", [id]).unwrap(); };
    add("new");
    assert!(db.local_auto_targets(model).unwrap().is_empty(), "wait for thumbnail");
    db.conn.lock().unwrap().execute("UPDATE assets SET thumb_path='ready.png'", []).unwrap();
    assert_eq!(db.local_auto_targets(model).unwrap(), vec!["new"], "actual insert order, not file timestamps");
    db.set_local_enabled(true).unwrap();
    assert_eq!(db.local_auto_targets(model).unwrap(), vec!["new"], "idempotent enable preserves new arrivals");
    db.stop_local_auto_pending(None).unwrap();
    assert!(db.local_enabled().unwrap());
    assert!(db.local_auto_targets(model).unwrap().is_empty(), "stop and reopening cannot resume the backlog");
    add("after-stop");
    db.conn.lock().unwrap().execute("UPDATE assets SET thumb_path='ready.png'", []).unwrap();
    assert_eq!(db.local_auto_targets(model).unwrap(), vec!["after-stop"]);
    db.conn.lock().unwrap().execute("INSERT INTO local_visual_observations VALUES('after-stop',?1,'done',0)", [model]).unwrap();
    db.conn.lock().unwrap().execute("DELETE FROM local_visual_observations", []).unwrap();
    assert!(db.local_auto_targets(model).unwrap().is_empty(), "reset does not requeue old imports");
    db.save_local_label(None, "新规则", "", true).unwrap();
    assert!(db.local_auto_targets(model).unwrap().is_empty(), "label jobs do not enqueue old images");
    db.set_local_enabled(false).unwrap();
    add("disabled");
    db.set_local_enabled(true).unwrap();
    db.conn.lock().unwrap().execute("UPDATE assets SET thumb_path='ready.png'", []).unwrap();
    assert!(db.local_auto_targets(model).unwrap().is_empty(), "reenabling excludes images added while disabled");
}

#[test]
fn stopping_project_preserves_other_new_assets_and_future_imports() {
    let db = db();
    db.set_local_enabled(true).unwrap();
    db.conn.lock().unwrap().execute_batch(
        "INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',0);
         INSERT INTO assets(id,name,ext,thumb_path) VALUES('inside','inside','png','ready.png'),('outside','outside','png','ready.png');
         INSERT INTO project_assets(project_id,asset_id,created_at) VALUES('p','inside',0);"
    ).unwrap();
    db.stop_local_auto_pending(Some("p")).unwrap();
    assert_eq!(db.local_auto_targets(MODEL_ID).unwrap(), vec!["outside"]);
    db.conn.lock().unwrap().execute_batch(
        "INSERT INTO assets(id,name,ext,thumb_path) VALUES('future','future','png','ready.png');
         INSERT INTO project_assets(project_id,asset_id,created_at) VALUES('p','future',0);"
    ).unwrap();
    let targets = db.local_auto_targets(MODEL_ID).unwrap();
    assert_eq!(targets.len(), 2);
    assert!(targets.contains(&"future".to_string()));
    assert!(db.local_enabled().unwrap());
}

#[test]
fn automatic_classification_upgrade_and_reopen_do_not_backfill() {
    let path = std::env::temp_dir().join(format!("auto-classification-{}.db", ulid::Ulid::new()));
    {
        let db = Database::open(&path).unwrap();
        crate::db::migrations::migrations().to_version(&mut db.conn.lock().unwrap(), 41).unwrap();
        db.conn.lock().unwrap().execute_batch("UPDATE local_classification_state SET enabled=1; INSERT INTO assets(id,name,ext,thumb_path) VALUES('old','old','png','old.png');").unwrap();
        db.migrate().unwrap();
        assert!(db.local_auto_targets(MODEL_ID).unwrap().is_empty());
        db.conn.lock().unwrap().execute_batch("INSERT INTO assets(id,name,ext,thumb_path) VALUES('new','new','png','new.png');").unwrap();
    }
    {
        let db = Database::open(&path).unwrap();
        db.migrate().unwrap();
        assert_eq!(db.local_auto_targets(MODEL_ID).unwrap(), vec!["new"], "new arrivals survive restart; old assets stay excluded");
        db.stop_local_auto_pending(None).unwrap();
    }
    {
        let db = Database::open(&path).unwrap();
        assert!(db.local_enabled().unwrap());
        assert!(db.local_auto_targets(MODEL_ID).unwrap().is_empty(), "stopped work stays stopped after restart");
    }
    std::fs::remove_file(path).unwrap();
}

#[test]
fn playback_records_committed_tags_and_failures_without_candidate_leakage() {
    let db = db();
    let classifier = super::LocalClassifier::new(std::env::temp_dir().join("classification-playback-test"));
    let tag = db.save_local_label(None, "已保存类别", "", true).unwrap();
    db.local_example(&tag, &["a".into()], true).unwrap();
    classifier.status.lock().unwrap().done = 1;
    classifier.record_classification_result(&db, "a", &Ok(()));
    classifier.status.lock().unwrap().done = 2;
    classifier.record_classification_result(&db, "b", &Err("请求失败".into()));
    let status = classifier.status.lock().unwrap();
    assert_eq!(status.recent_results[0].tags, vec!["已保存类别"]);
    assert_eq!(status.recent_results[1].sequence, 2);
    assert!(status.recent_results[1].tags.is_empty());
    assert_eq!(status.recent_results[1].error.as_deref(), Some("请求失败"));
    drop(status);
    for sequence in 3..=80 {
        classifier.status.lock().unwrap().done = sequence;
        classifier.record_classification_result(&db, "b", &Ok(()));
    }
    let status = classifier.status.lock().unwrap();
    assert_eq!(status.recent_results.len(), 64);
    assert_eq!(status.recent_results.first().unwrap().sequence, 17);
    assert_eq!(status.recent_results.last().unwrap().sequence, 80);
}

#[test]
fn full_rescan_resets_scoped_automatic_results_and_keeps_human_rules() {
    let db = db();
    let old = db.save_local_label(None, "旧自动A", "保留词表定义", false).unwrap();
    let next = db.save_local_label(None, "新分类B", "", true).unwrap();
    let manual = db.save_local_label(None, "人工C", "", true).unwrap();
    let legacy_manual = db.save_local_label(None, "旧人工D", "", true).unwrap();
    let rejected = db.save_local_label(None, "排除E", "", true).unwrap();
    db.local_example(&manual, &["b".into()], true).unwrap();
    db.local_example(&rejected, &["a".into()], false).unwrap();
    {
        let conn = db.conn.lock().unwrap();
        // A label's creator cannot tell us who assigned a legacy association.
        conn.execute("UPDATE tags SET source='auto' WHERE id=?1 OR id=?2", rusqlite::params![old,legacy_manual]).unwrap();
        conn.execute("INSERT INTO asset_tags VALUES('a',?1,'local'),('b',?1,'local')", [&old]).unwrap();
        conn.execute("INSERT INTO asset_tags VALUES('a',?1,'local')", [&next]).unwrap();
        conn.execute("INSERT INTO asset_tags VALUES('a',?1,'legacy')", [&legacy_manual]).unwrap();
        conn.execute_batch("INSERT INTO local_visual_observations VALUES('a','old','old',1),('b','old','old',1)").unwrap();
    }
    let old_revision = db.local_revision().unwrap();
    assert_eq!(db.reset_classification_results(&[], old_revision).unwrap(), (old_revision, vec![]));
    let (revision, targets) = db.reset_classification_results(&["a".into()], old_revision).unwrap();
    assert_eq!(targets, vec!["a"]);
    let names: Vec<_> = db.list_asset_tags("a").unwrap().into_iter().map(|t| t.name).collect();
    assert_eq!(names, vec!["旧人工D"]);
    assert_eq!(db.list_asset_tags("b").unwrap().len(), 2);
    assert_eq!(db.local_examples(&manual, "").unwrap(), vec![("b".into(), true)]);
    assert_eq!(db.local_examples(&rejected, "").unwrap(), vec![("a".into(), false)]);
    assert_eq!(db.local_targets_for_model(true, "old").unwrap(), vec!["a"]);
    assert_eq!(db.local_labels().unwrap().iter().find(|l| l.id==old).unwrap().description, "保留词表定义");
    let prediction = Prediction { description:"new".into(), matches:vec![next, rejected], tags:vec![] };
    assert!(!db.apply_local_prediction("a", old_revision, &prediction, true, &[]).unwrap());
    assert!(db.apply_local_prediction("a", revision, &prediction, true, &[]).unwrap());
    let names: Vec<_> = db.list_asset_tags("a").unwrap().into_iter().map(|t| t.name).collect();
    assert_eq!(names.len(), 2);
    assert!(names.contains(&"新分类B".into()));
    assert!(!names.contains(&"旧自动A".into()) && !names.contains(&"排除E".into()));
    assert!(db.local_targets_for_model(true, MODEL_ID).unwrap().iter().all(|id| id != "a"));
}

#[test]
fn full_rescan_skips_entire_manually_classified_images() {
    let db = db();
    let manual = db.save_local_label(None, "停用人工标签", "", false).unwrap();
    let automatic = db.save_local_label(None, "自动标签", "", true).unwrap();
    db.local_example(&manual, &["a".into()], true).unwrap();
    db.local_example(&manual, &["b".into()], false).unwrap();
    {
        let conn = db.conn.lock().unwrap();
        conn.execute("INSERT INTO asset_tags VALUES('a',?1,'local'),('b',?1,'local')", [&automatic]).unwrap();
        conn.execute_batch("INSERT INTO local_visual_observations VALUES('a','old','人工素材原结果',1),('b','old','old',1)").unwrap();
    }
    let revision = db.local_revision().unwrap();
    // An all-manual scope is a no-op, with no model targets or revision bump.
    assert_eq!(db.reset_classification_results(&["a".into()], revision).unwrap(), (revision, vec![]));
    let (next_revision, targets) = db.reset_classification_results(&["a".into(), "b".into()], revision).unwrap();
    assert_eq!(next_revision, revision + 1);
    assert_eq!(targets, vec!["b"]); // Negative examples alone do not exclude an image.
    assert_eq!(db.list_asset_tags("a").unwrap().len(), 2);
    assert!(db.list_asset_tags("b").unwrap().is_empty());
    assert_eq!(db.local_targets_for_model(true, "old").unwrap(), vec!["b"]);
    assert_eq!(db.local_examples(&manual, "").unwrap(), vec![("a".into(), true), ("b".into(), false)]);
    let conn = db.conn.lock().unwrap();
    let description: String = conn.query_row("SELECT description FROM local_visual_observations WHERE asset_id='a'", [], |r| r.get(0)).unwrap();
    assert_eq!(description, "人工素材原结果");
}

#[test]
fn full_rescan_is_atomic_revision_guarded_and_keeps_fixed_provenance() {
    let db = db();
    let automatic = db.save_local_label(None, "旧自动", "", true).unwrap();
    let fixed = db.save_local_label(None, "#ai生成", "", true).unwrap();
    // clean_label strips '#'; the reserved provenance name is created by its own feature.
    {
        let conn = db.conn.lock().unwrap();
        conn.execute("UPDATE tags SET name='#ai生成' WHERE id=?1", [&fixed]).unwrap();
        conn.execute("INSERT INTO asset_tags VALUES('a',?1,'local'),('b',?1,'local')", [&automatic]).unwrap();
        conn.execute("INSERT INTO asset_tags VALUES('a',?1,'local')", [&fixed]).unwrap();
        conn.execute_batch("INSERT INTO analyses(id,asset_id,kind,payload) VALUES('provenance','a','replication_source','{}');
          CREATE TRIGGER reset_test_failure BEFORE DELETE ON asset_tags WHEN OLD.asset_id='b' BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
    }
    let revision = db.local_revision().unwrap();
    assert!(db.reset_classification_results(&["a".into()], revision-1).is_err());
    assert!(db.reset_classification_results(&["a".into(),"b".into()], revision).is_err());
    assert_eq!(db.list_asset_tags("a").unwrap().len(), 2);
    assert_eq!(db.local_revision().unwrap(), revision);
    db.reset_classification_results(&["a".into()], revision).unwrap();
    assert_eq!(db.list_asset_tags("a").unwrap()[0].name, "#ai生成");
}

#[test]
fn label_dimensions_are_cached_revision_guarded_and_invalidated_only_by_semantic_edits() {
    let db = db();
    let id = db.save_local_label(None, "梦幻", "抽象情绪", true).unwrap();
    db.local_example(&id, &["a".into()], true).unwrap();
    let labels = db.local_labels().unwrap();
    let revision = db.local_revision().unwrap();
    assert!(db.cache_label_dimensions(revision, &labels, &["mood".into()]).unwrap());
    assert_eq!(db.local_revision().unwrap(), revision);
    assert_eq!(db.local_labels().unwrap()[0].dimension.as_deref(), Some("mood"));
    assert_eq!(db.list_asset_tags("a").unwrap()[0].name, "梦幻");
    db.save_local_label(Some(&id), "梦幻", "抽象情绪", false).unwrap();
    assert_eq!(db.local_labels().unwrap()[0].dimension.as_deref(), Some("mood"));
    db.save_local_label(Some(&id), "水彩晕染", "颜料晕开的表现手法", true).unwrap();
    assert!(db.local_labels().unwrap()[0].dimension.is_none());
    assert!(!db.cache_label_dimensions(revision, &labels, &["mood".into()]).unwrap());
    assert!(db.local_labels().unwrap()[0].dimension.is_none());
    assert!(db.cache_label_dimensions(db.local_revision().unwrap(), &db.local_labels().unwrap(), &["invalid".into()]).is_err());
    assert_eq!(db.list_asset_tags("a").unwrap().len(), 1);
}

#[test]
fn flat_rules_do_not_automatically_rescan_old_paid_observations() {
    let db = db();
    db.conn.lock().unwrap().execute("INSERT INTO local_visual_observations VALUES('a','jev-choice-dimensions/cloud-discovery-v5','旧结果',1)", []).unwrap();
    assert_eq!(db.local_targets_for_model(true, super::jev::OBSERVATION_MODEL).unwrap(), vec!["b"]);
    db.conn.lock().unwrap().execute("INSERT INTO local_visual_observations VALUES('b','jev-choice-dimensions/cloud-discovery-v6','旧结果',1)", []).unwrap();
    assert!(db.local_targets_for_model(true, super::jev::OBSERVATION_MODEL).unwrap().is_empty());
    db.conn.lock().unwrap().execute("UPDATE local_visual_observations SET model='jev-choice-flat-top4-30/cloud-discovery-v7'", []).unwrap();
    assert!(db.local_targets_for_model(true, super::jev::OBSERVATION_MODEL).unwrap().is_empty());
    assert_eq!(db.local_targets_for_model(false, super::jev::OBSERVATION_MODEL).unwrap(), vec!["a", "b"]);
}

#[test]
fn old_folder_label_without_dimension_remains_readable() {
    let label: Label = serde_json::from_value(serde_json::json!({
        "id":"legacy", "name":"梦幻", "description":"情绪", "enabled":true, "count":1, "has_examples":false,
    })).unwrap();
    assert!(label.dimension.is_none());
    assert!(label.provenance.is_none());
}

#[test]
fn cloud_creation_evidence_survives_reuse_edit_rescan_and_source_deletion() {
    let db = db();
    let path = std::env::temp_dir().join(format!("classification-source-{}.jpg", ulid::Ulid::new()));
    std::fs::write(&path, b"original preview").unwrap();
    db.conn.lock().unwrap().execute("UPDATE assets SET thumb_path=?1 WHERE id='a'", [path.to_str().unwrap()]).unwrap();
    let prediction = Prediction { description: r#"{"source":"cloud","reason":"透明笔触"}"#.into(), tags: vec!["水彩".into()], matches: vec![] };
    let definition = super::cloud::NewLabel { name: "水彩".into(), definition: "透明颜料笔触".into(), english: None };
    let revision = db.local_revision().unwrap();
    assert!(!db.apply_classification_with_definitions("a", revision + 1, &prediction, true, &[], super::jev::OBSERVATION_MODEL, std::slice::from_ref(&definition)).unwrap());
    assert!(db.local_labels().unwrap().is_empty());
    assert!(db.apply_classification_with_definitions("a", revision, &prediction, true, &[], super::jev::OBSERVATION_MODEL, std::slice::from_ref(&definition)).unwrap());
    let label = db.local_labels().unwrap().remove(0);
    let origin = label.provenance.as_ref().unwrap();
    assert_eq!(origin.kind, "cloud");
    assert_eq!(origin.asset_id.as_deref(), Some("a"));
    assert_eq!(origin.asset_name.as_deref(), Some("a"));
    assert_eq!(origin.reason.as_deref(), Some("透明笔触"));
    assert_eq!(db.local_label_source(&label.id).unwrap().as_deref(), path.to_str());
    assert!(db.apply_classification_with_definitions("b", revision, &prediction, true, &[], super::jev::OBSERVATION_MODEL, &[definition]).unwrap());
    db.save_local_label(Some(&label.id), "水彩修改", "人工修改定义", true).unwrap();
    db.reset_classification_results(&["a".into(), "b".into()], db.local_revision().unwrap()).unwrap();
    assert_eq!(serde_json::to_value(&db.local_labels().unwrap()[0].provenance).unwrap(), serde_json::to_value(&label.provenance).unwrap());
    std::fs::write(&path, b"replacement preview").unwrap();
    assert!(db.local_label_source(&label.id).unwrap().is_none());
    std::fs::remove_file(path).unwrap();
    db.conn.lock().unwrap().execute("DELETE FROM assets WHERE id='a'", []).unwrap();
    assert!(db.local_label_source(&label.id).unwrap().is_none());
    assert_eq!(db.local_labels().unwrap()[0].provenance.as_ref().unwrap().asset_name.as_deref(), Some("a"));
}

#[test]
fn concurrent_cloud_same_name_reuses_label_without_changing_legacy_metadata() {
    let db = db();
    let id = db.save_local_label(None, "梦幻", "情绪", true).unwrap();
    let revision = db.local_revision().unwrap();
    db.cache_label_dimensions(revision, &db.local_labels().unwrap(), &["mood".into()]).unwrap();
    let prediction = Prediction { description: String::new(), tags: vec!["梦幻".into()], matches: vec![] };
    let definition = super::cloud::NewLabel { name: "梦幻".into(), definition: "新的类别说明".into(), english: None };
    assert!(db.apply_classification_with_definitions("a", revision, &prediction, true, &[], super::jev::OBSERVATION_MODEL, &[definition]).unwrap());
    assert_eq!(db.list_asset_tags("a").unwrap().len(), 1);
    assert_eq!(db.local_labels().unwrap()[0].description, "情绪");
    assert_eq!(db.local_labels().unwrap()[0].id, id);
    assert_eq!(db.local_labels().unwrap()[0].dimension.as_deref(), Some("mood"));
    assert!(db.local_labels().unwrap()[0].provenance.is_none(), "matching an existing label must not claim Cloud created it");
}

#[test]
fn deleting_labels_cleans_relations_but_preserves_assets_and_observations() {
    let db = db();
    let p = Prediction {
        description: "植物包装".into(),
        tags: vec!["植物".into(), "包装".into(), "保留".into()],
        matches: vec![],
    };
    db.apply_local_prediction("a", 0, &p, true, &[]).unwrap();
    let labels = db.local_labels().unwrap();
    let ids: Vec<String> = labels
        .iter()
        .filter(|l| l.name != "保留")
        .map(|l| l.id.clone())
        .collect();
    db.local_example(&ids[0], &["b".into()], true).unwrap();
    db.local_example(&ids[1], &["b".into()], false).unwrap();
    let revision = db.local_revision().unwrap();
    let mut repeated = ids.clone();
    repeated.push(ids[0].clone());
    repeated.push("missing".into());
    db.delete_local_labels(&repeated).unwrap();
    assert_eq!(db.local_revision().unwrap(), revision + 1);
    assert_eq!(db.local_labels().unwrap().len(), 1);
    assert_eq!(db.list_asset_tags("a").unwrap()[0].name, "保留");
    assert!(db.list_asset_tags("b").unwrap().is_empty());
    assert!(db.pending_local_label().unwrap().is_none());
    for id in &ids {
        assert!(db.local_examples(id, "").unwrap().is_empty());
    }
    assert_eq!(db.local_targets(false).unwrap(), vec!["a", "b"]);
    assert_eq!(db.local_targets(true).unwrap(), vec!["b"]);
    assert!(!db
        .apply_local_prediction("a", revision, &p, true, &[])
        .unwrap());
    db.delete_local_labels(&repeated).unwrap();
    db.delete_local_labels(&[]).unwrap();
    assert_eq!(db.local_revision().unwrap(), revision + 1);
}

#[test]
fn deleting_labels_is_atomic_and_refused_during_classification() {
    let db = db();
    let first = db.save_local_label(None, "第一个", "", true).unwrap();
    let second = db.save_local_label(None, "第二个", "", true).unwrap();
    let revision = db.local_revision().unwrap();
    db.conn.lock().unwrap().execute_batch(
        "CREATE TRIGGER reject_label_delete BEFORE DELETE ON tags WHEN OLD.name='第二个' BEGIN SELECT RAISE(ABORT, 'test failure'); END;"
    ).unwrap();
    assert!(db.delete_local_labels(&[first.clone(), second]).is_err());
    assert_eq!(db.local_labels().unwrap().len(), 2);
    assert_eq!(db.local_revision().unwrap(), revision);
    let classifier = super::LocalClassifier::new(std::path::PathBuf::new());
    let guard = classifier.gate.clone().try_lock_owned().unwrap();
    assert!(classifier.delete_labels(&db, &[first.clone()]).is_err());
    assert_eq!(db.local_labels().unwrap().len(), 2);
    drop(guard);
    classifier.delete_labels(&db, &[first]).unwrap();
    assert_eq!(db.local_labels().unwrap().len(), 1);
}

#[test]
fn dynamic_labels_need_no_caption_or_preset_vocabulary() {
    let db = db();
    assert!(db.local_labels().unwrap().is_empty());
    assert_eq!(db.local_targets(true).unwrap(), vec!["a", "b"]);
    let prediction = Prediction {
        description: "水彩绘制的植物".into(),
        tags: vec!["水彩植物".into(), "包装设计".into()],
        matches: vec![],
    };
    assert!(db
        .apply_local_prediction("a", 0, &prediction, true, &[])
        .unwrap());
    assert_eq!(db.list_asset_tags("a").unwrap().len(), 2);
    assert_eq!(db.local_targets(true).unwrap(), vec!["b"]);
    assert!(db.latest_caption_text("a").unwrap().is_none());
}

#[test]
fn deletion_is_remembered_and_manual_additions_survive_rescans() {
    let db = db();
    let prediction = Prediction {
        description: "植物".into(),
        tags: vec!["水彩植物".into()],
        matches: vec![],
    };
    db.apply_local_prediction("a", 0, &prediction, true, &[])
        .unwrap();
    db.edit_classification_tags("a", &[], "auto").unwrap();
    assert!(!db
        .apply_local_prediction("a", 0, &prediction, true, &[])
        .unwrap());
    db.apply_local_prediction("a", db.local_revision().unwrap(), &prediction, true, &[])
        .unwrap();
    assert!(db.list_asset_tags("a").unwrap().is_empty());
    db.edit_classification_tags("a", &["水彩植物".into()], "manual")
        .unwrap();
    db.apply_local_prediction(
        "a",
        db.local_revision().unwrap(),
        &Prediction {
            tags: vec![],
            matches: vec![],
            description: "".into(),
        },
        true,
        &[],
    )
    .unwrap();
    assert_eq!(db.list_asset_tags("a").unwrap().len(), 1);
    let tag = db.local_labels().unwrap().remove(0);
    assert_eq!(
        db.local_examples(&tag.id, "b").unwrap(),
        vec![("a".into(), true)]
    );
}

#[test]
fn new_custom_label_is_queued_and_disable_blocks_rediscovery() {
    let db = db();
    let id = db
        .save_local_label(None, "我喜欢的质感", "粗糙纸张，手工印刷", true)
        .unwrap();
    assert_eq!(db.pending_local_label().unwrap(), Some(id.clone()));
    let revision = db.local_revision().unwrap();
    db.save_local_label(Some(&id), "我喜欢的质感", "粗糙纸张，手工印刷", false)
        .unwrap();
    let p = Prediction {
        description: "".into(),
        tags: vec!["我喜欢的质感".into()],
        matches: vec![id],
    };
    assert!(!db
        .apply_local_prediction("a", revision, &p, true, &[])
        .unwrap());
    db.apply_local_prediction("a", db.local_revision().unwrap(), &p, true, &[])
        .unwrap();
    assert!(db.list_asset_tags("a").unwrap().is_empty());
}

#[test]
fn parser_rejects_unknown_ids_and_does_not_accept_prose_or_truncation() {
    assert!(parse_prediction(
        r#"{"description":"x","tags":[],"matches":["invented"]}"#,
        &[],
        true
    )
    .is_err());
    assert!(parse_prediction("分类是水彩植物", &[], true).is_err());
    assert!(parse_prediction(
        r#"{"description":"x","tags":["新类别"],"matches":[]}"#,
        &[],
        false
    )
    .is_err());
    assert!(clean_label("a\nb").is_err());
    assert!(parse_prediction(
        "```json\n{\"description\":\"植物\",\"tags\":[\"水彩植物\"],\"matches\":[]}\n```",
        &[],
        true
    )
    .is_ok());
}

#[test]
fn auto_associations_are_not_positive_training_examples() {
    let db = db();
    let p = Prediction {
        description: "".into(),
        tags: vec!["水彩植物".into()],
        matches: vec![],
    };
    db.apply_local_prediction("a", 0, &p, true, &[]).unwrap();
    let tag = db.local_labels().unwrap().remove(0);
    assert!(db.local_examples(&tag.id, "b").unwrap().is_empty());
    db.local_example(&tag.id, &["a".into()], false).unwrap();
    assert_eq!(
        db.local_examples(&tag.id, "b").unwrap(),
        vec![("a".into(), false)]
    );
}

#[test]
fn failed_manual_edit_rolls_back_all_changes() {
    let db = db();
    assert!(db
        .edit_classification_tags("missing", &["不会留下的标签".into()], "manual")
        .is_err());
    assert!(db.local_labels().unwrap().is_empty());
    assert_eq!(db.local_revision().unwrap(), 0);
}

#[test]
fn re_evaluation_removes_only_local_assignments() {
    let db = db();
    let id = db.save_local_label(None, "柔和质感", "", true).unwrap();
    let yes = Prediction {
        description: "".into(),
        tags: vec![],
        matches: vec![id.clone()],
    };
    let no = Prediction {
        description: "".into(),
        tags: vec![],
        matches: vec![],
    };
    db.apply_local_prediction(
        "a",
        db.local_revision().unwrap(),
        &yes,
        false,
        &[id.clone()],
    )
    .unwrap();
    db.local_example(&id, &["b".into()], true).unwrap();
    for asset in ["a", "b"] {
        db.apply_local_prediction(
            asset,
            db.local_revision().unwrap(),
            &no,
            false,
            &[id.clone()],
        )
        .unwrap();
    }
    assert!(db.list_asset_tags("a").unwrap().is_empty());
    assert_eq!(db.list_asset_tags("b").unwrap().len(), 1);
}

#[test]
fn upgrading_preserves_used_seeds_without_learning_from_legacy_assignments() {
    let db = Database::open_in_memory().unwrap();
    {
        let mut conn = db.conn.lock().unwrap();
        crate::db::migrations::migrations()
            .to_version(&mut conn, 25)
            .unwrap();
        conn.execute_batch("INSERT INTO assets(id,name) VALUES('a','a'); INSERT INTO asset_tags(asset_id,tag_id) VALUES('a','cat_landscape');").unwrap();
    }
    db.migrate().unwrap();
    assert_eq!(db.list_asset_tags("a").unwrap()[0].name, "风景");
    assert_eq!(db.local_labels().unwrap().len(), 1);
    assert!(db.local_examples("cat_landscape", "b").unwrap().is_empty());
}

#[test]
fn discovery_reference_samples_per_asset_not_by_usage() {
    fn labels() -> Vec<Label> {
        (0..9)
            .map(|index| Label {
                id: format!("label-{index}"),
                name: format!("标签{index}"),
                description: String::new(),
                enabled: true,
                count: 9 - index as i64,
                has_examples: false,
                dimension: None, provenance: None, english: None,
            })
            .collect()
    }
    let mut first = labels();
    super::discovery_sample(&mut first, "asset-a");
    assert_eq!(first.len(), 8);
    let mut second = labels();
    super::discovery_sample(&mut second, "asset-a");
    assert_eq!(
        first.iter().map(|l| &l.id).collect::<Vec<_>>(),
        second.iter().map(|l| &l.id).collect::<Vec<_>>()
    );
    // The rarely used label is still sampled for some assets instead of being
    // crowded out forever by the eight most-used labels.
    let mut seen_rare = false;
    for asset in [
        "asset-b", "asset-c", "asset-d", "asset-e", "asset-f", "asset-g", "asset-h", "asset-i",
    ] {
        let mut sample = labels();
        super::discovery_sample(&mut sample, asset);
        seen_rare |= sample.iter().any(|l| l.id == "label-8");
    }
    assert!(seen_rare);
}

#[test]
fn discovered_existing_names_attach_directly() {
    let labels = vec![
        Label {
            id: "plant".into(),
            name: "植物".into(),
            description: String::new(),
            enabled: true,
            count: 0,
            has_examples: false,
            dimension: None, provenance: None, english: None,
        },
        Label {
            id: "bottle".into(),
            name: "矿泉水瓶".into(),
            description: String::new(),
            enabled: true,
            count: 0,
            has_examples: false,
            dimension: None, provenance: None, english: None,
        },
    ];
    let mut prediction = Prediction {
        description: "矿泉水瓶与马蹄莲的产品渲染图".into(),
        tags: vec!["植物".into(), "水瓶设计".into()],
        matches: vec![],
    };
    super::ground_discovered_names(&labels, &mut prediction);
    assert_eq!(prediction.tags, vec!["水瓶设计".to_string()]);
    assert_eq!(prediction.matches, vec!["plant".to_string()]);
}

#[test]
fn label_example_flag_marks_what_automatic_matching_uses() {
    let db = db();
    db.apply_local_prediction(
        "a",
        0,
        &Prediction {
            description: "".into(),
            tags: vec!["水彩植物".into()],
            matches: vec![],
        },
        true,
        &[],
    )
    .unwrap();
    let tag = db.local_labels().unwrap().remove(0);
    assert_eq!(tag.count, 1);
    assert!(!tag.has_examples);
    db.local_example(&tag.id, &["b".into()], false).unwrap();
    assert!(db.local_labels().unwrap().remove(0).has_examples);
}

/// Opt-in inference against an already installed isolated pack. No network and no user library.
#[tokio::test]
#[ignore = "requires the pinned local model pack in BOWERBIRD_LOCAL_MODEL_TEST_DIR"]
async fn real_local_model_smoke() {
    use super::runtime::{image_data, Server};
    use std::sync::atomic::AtomicBool;
    let model = std::path::PathBuf::from(
        std::env::var("BOWERBIRD_LOCAL_MODEL_TEST_DIR").expect("explicit model directory required"),
    );
    let samples = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/samples");
    let image = image_data(&samples.join("preset-01.webp"), &samples).unwrap();
    std::fs::write(model.join("smoke-product-image.txt"), &image).unwrap();
    let cancel = AtomicBool::new(false);
    assert!(super::runtime::installed(&model));
    let mut server = Server::start(&model, &cancel).await.unwrap();
    println!("smoke backend: {}", server.acceleration);
    let labels = vec![
        Label {
            id: "product".into(),
            name: "产品海报".into(),
            description: "以商品为视觉中心的广告设计".into(),
            enabled: true,
            count: 0,
            has_examples: false,
            dimension: None, provenance: None, english: None,
        },
        Label {
            id: "animal".into(),
            name: "野生动物".into(),
            description: "自然环境中的动物".into(),
            enabled: true,
            count: 0,
            has_examples: false,
            dimension: None, provenance: None, english: None,
        },
    ];
    let start = std::time::Instant::now();
    let prediction = server.predict(&image, &labels, true, &[], &cancel).await;
    println!(
        "real inference: {:?}, elapsed {:?}",
        prediction,
        start.elapsed()
    );
    let matches = server.predict(&image, &labels, false, &[], &cancel).await;
    println!("real matching: {:?}", matches);
    let illustration = image_data(&samples.join("preset-02.webp"), &samples).unwrap();
    std::fs::write(model.join("smoke-illustration-image.txt"), &illustration).unwrap();
    let custom = vec![Label {
        id: "custom".into(),
        name: "东方诗意插画".into(),
        description: "中国古代人物、月亮、树木构成的平面插画".into(),
        enabled: true,
        count: 0,
        has_examples: false,
        dimension: None, provenance: None, english: None,
    }];
    let custom_negative_before = server.predict(&image, &custom, false, &[], &cancel).await;
    println!(
        "custom negative before positive: {:?}",
        custom_negative_before
    );
    let custom_match = server
        .predict(&illustration, &custom, false, &[], &cancel)
        .await;
    let custom_negative = server.predict(&image, &custom, false, &[], &cancel).await;
    println!(
        "custom positive: {:?}; negative: {:?}",
        custom_match, custom_negative
    );
    let personal = vec![Label {
        id: "personal".into(),
        name: "参考风格A".into(),
        description: "根据正例的平面插画风格判断，不要求相同主体".into(),
        enabled: true,
        count: 0,
        has_examples: false,
        dimension: None, provenance: None, english: None,
    }];
    let example_match = server
        .predict(
            &illustration,
            &personal,
            false,
            &[(illustration.clone(), true), (image.clone(), false)],
            &cancel,
        )
        .await;
    println!("with visual examples: {:?}", example_match);
    server.stop().await;
    let prediction = prediction.unwrap();
    std::fs::write(
        model.join("rust-smoke-result.json"),
        serde_json::to_string_pretty(&prediction).unwrap(),
    )
    .unwrap();
    let matches = matches.unwrap();
    assert!(matches.matches.contains(&"product".into()));
    assert!(!matches.matches.contains(&"animal".into()));
    assert!(!prediction.description.is_empty());
    assert_eq!(custom_match.unwrap().matches, vec!["custom"]);
    assert!(custom_negative_before.unwrap().matches.is_empty());
    assert!(custom_negative.unwrap().matches.is_empty());
    assert_eq!(example_match.unwrap().matches, vec!["personal"]);
}

#[test]
fn vector_uninstall_waits_for_the_busy_gate() {
    let dir = std::env::temp_dir().join(format!("vector-gate-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("vector")).unwrap();
    let classifier = super::LocalClassifier::new(dir.clone());
    let _held = classifier.gate.clone().try_lock_owned().unwrap();
    assert!(classifier.uninstall_vector().unwrap_err().contains("请先停止"));
    drop(_held);
    classifier.uninstall_vector().unwrap();
    assert!(!dir.join("vector").exists());
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Exercise full eight-label batches plus a final partial batch against the pinned runtime.
#[tokio::test]
#[ignore = "requires the pinned local model pack in BOWERBIRD_LOCAL_MODEL_TEST_DIR"]
async fn real_local_model_batch_persists_completed_assets() {
    use super::runtime::Server;
    use std::sync::atomic::AtomicBool;
    let root = std::path::PathBuf::from(std::env::var("BOWERBIRD_LOCAL_MODEL_TEST_DIR").unwrap());
    let samples = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/samples");
    let db = db();
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO assets(id,name,ext,thumb_path,created_at) VALUES('c','c','png','c.png',3)",
            [],
        )
        .unwrap();
    for name in [
        "产品海报",
        "野生动物",
        "平面插画",
        "人物",
        "建筑",
        "植物",
        "食品",
        "包装设计",
        "风景",
    ] {
        db.save_local_label(None, name, "根据图中可见内容判断", true)
            .unwrap();
    }
    let library = crate::core::paths::LibraryPaths::init(
        std::env::temp_dir().join(format!("bowerbird-batch-{}", uuid::Uuid::new_v4())),
    )
    .unwrap();
    let classifier = super::LocalClassifier::new(root.clone());
    let cancel = AtomicBool::new(false);
    let mut server = Server::start(&root, &cancel).await.unwrap();
    for (id, sample) in [
        ("a", "preset-01.webp"),
        ("b", "preset-02.webp"),
        ("c", "preset-03.webp"),
    ] {
        let path = library.root.join(sample);
        std::fs::copy(samples.join(sample), &path).unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE assets SET thumb_path=?1 WHERE id=?2",
                rusqlite::params![path.to_string_lossy(), id],
            )
            .unwrap();
        let count = db.local_labels().unwrap().len();
        classifier
            .classify_one(Some(&server), &db, &library, id, None, None, None, None, false)
            .await
            .unwrap();
        assert!(!db.local_targets(true).unwrap().contains(&id.into()));
        println!("batch classification completed: {id}, {count} labels evaluated");
    }
    server.stop().await;
    assert!(db.local_targets(true).unwrap().is_empty());
    std::fs::remove_dir_all(library.root).unwrap();
}
