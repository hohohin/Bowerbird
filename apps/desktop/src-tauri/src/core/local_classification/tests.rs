use super::data::*;
use crate::db::Database;

fn db() -> Database {
    let db = Database::open_in_memory().unwrap();
    db.migrate().unwrap();
    db.conn.lock().unwrap().execute_batch("INSERT INTO assets(id,name,ext,thumb_path,created_at) VALUES('a','a','png','a.png',1),('b','b','png','b.png',2);").unwrap();
    db
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
        },
        Label {
            id: "animal".into(),
            name: "野生动物".into(),
            description: "自然环境中的动物".into(),
            enabled: true,
            count: 0,
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
