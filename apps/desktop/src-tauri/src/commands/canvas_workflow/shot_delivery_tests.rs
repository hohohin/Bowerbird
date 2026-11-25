use super::*;

fn shot(start: i64, end: i64) -> DeliveryShot {
    DeliveryShot {
        start,
        end,
        texts: ["画面".into(), "首帧".into(), "动态".into()],
    }
}
fn project(db: &Database) {
    db.conn.lock().unwrap().execute_batch("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1);
        INSERT INTO project_canvases(project_id,created_at,updated_at) VALUES('p',1,1);
        INSERT INTO assets(id,name,ext,created_at) VALUES('frame','first','jpg',1);").unwrap();
}
fn frame(id: &str) -> NewCanvasNode {
    serde_json::from_value(json!({"id":id,"projectId":"p","kind":"asset","role":"reference","assetId":"frame",
        "payloadJson":json!({"schema_version":1,"snapshot":{"name":"镜头首帧","width":80,"height":64}}).to_string(),"x":24,"y":24,"width":168,"height":106,"zIndex":1,"positionLocked":false})).unwrap()
}
fn generation(id: &str, reference: Value) -> Value {
    json!({"id":id,"kind":"generation","action":"describe","x":230,"y":24,"prompt":"初稿","provider":"jimeng","trigger":false,
        "inputs":{"image":[reference]},"outputs":{},"outputPorts":[]})
}
fn count(db: &Database, sql: &str) -> i64 {
    db.conn
        .lock()
        .unwrap()
        .query_row(sql, [], |r| r.get(0))
        .unwrap()
}

#[test]
fn shot_delivery_survives_retry_and_does_not_overwrite_canvas_edits() {
    let (_dir, db, _path, hash) = video_shots::tests::fixture();
    project(&db);
    for (s, e) in [(0, 15000), (15000, 30000)] {
        video_shots::apply_result(
            &db,
            "v",
            &hash,
            &format!("{s}-{e}"),
            &format!("task-{s}"),
            shot(s, e).texts,
            None,
        )
        .unwrap();
    }
    let send = |key: char, revision: i64, second: bool| {
        let suffix = if second { "two" } else { "one" };
        let image = format!("shot-image-{suffix}");
        let reference = format!("shot-frame-{suffix}");
        let rows = if second {
            vec![shot(0, 15000), shot(15000, 30000)]
        } else {
            vec![shot(0, 15000)]
        };
        commit_delivery(
            &db,
            "p".into(),
            "v".into(),
            hash.clone(),
            key.to_string().repeat(64),
            "shot-image-one".into(),
            revision,
            rows,
            vec![frame(&reference)],
            vec![
                generation(&image, json!({"assetId":"frame","assetNodeId":reference})),
                generation(
                    &format!("shot-video-{suffix}"),
                    json!({"nodeId":image,"portId":"image"}),
                ),
            ],
        )
    };
    assert_eq!(send('a', 0, false).unwrap(), "shot-image-one");
    let conn = db.conn.lock().unwrap();
    conn.execute("UPDATE canvas_workflows SET revision=2,document_json=json_set(document_json,'$.nodes[0].prompt','手改') WHERE project_id='p'",[]).unwrap();
    drop(conn);
    assert_eq!(send('a', 0, false).unwrap(), "shot-image-one");
    assert!(send('b', 1, true).is_err());
    assert_eq!(count(&db, "SELECT count(*) FROM canvas_nodes"), 1);
    assert_eq!(send('b', 2, true).unwrap(), "shot-image-one");
    assert_eq!(count(&db, "SELECT count(*) FROM canvas_nodes"), 2);
    assert_eq!(count(&db, "SELECT count(*) FROM video_shot_deliveries"), 2);
    assert_eq!(
        count(
            &db,
            "SELECT json_array_length(document_json,'$.nodes') FROM canvas_workflows"
        ),
        4
    );
    assert_eq!(count(&db,"SELECT count(*) FROM canvas_workflows WHERE json_extract(document_json,'$.nodes[0].prompt')='手改'"),1);
}

#[test]
fn shot_note_checks_the_shot_revision_and_rolls_back_partial_writes() {
    let (_dir, db, path, hash) = video_shots::tests::fixture();
    project(&db);
    video_shots::apply_result(
        &db,
        "v",
        &hash,
        "0-15000",
        "task",
        shot(0, 15000).texts,
        None,
    )
    .unwrap();
    let key = "a".repeat(64);
    let note_id = format!("shot-note-{key}");
    let send = |key: String, focus: &str, edited: bool| {
        let mut card = frame(&format!("shot-note-{key}"));
        card.kind = CreativeNodeKind::Note;
        card.role = None;
        card.asset_id = None;
        card.payload_json=json!({"schema_version":1,"note_type":"text","text":"","title":"分镜卡","cells":[[{"text":"","bold":false,"italic":false,"align":"left","content_type":"image","image_refs":[{"asset_id":"frame","token":"@图片1"}]}]]}).to_string();
        let mut row = shot(0, 15000);
        if edited {
            row.texts[0] = "过期草稿".into();
        }
        commit_delivery(
            &db,
            "p".into(),
            "v".into(),
            hash.clone(),
            key,
            focus.into(),
            0,
            vec![row],
            vec![card],
            vec![],
        )
    };
    assert!(send(key.clone(), &note_id, true).is_err());
    // This fails after staging both the frame membership and the note row.
    assert!(send(key.clone(), "absent-node", false).is_err());
    for sql in [
        "SELECT count(*) FROM canvas_nodes",
        "SELECT count(*) FROM project_assets",
        "SELECT count(*) FROM video_shot_deliveries",
    ] {
        assert_eq!(count(&db, sql), 0);
    }
    send(key.clone(), &note_id, false).unwrap();
    db.conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE canvas_nodes SET payload_json=json_set(payload_json,'$.title','用户改名')",
            [],
        )
        .unwrap();
    send(key.clone(), &note_id, false).unwrap();
    assert_eq!(count(&db,"SELECT count(*) FROM canvas_nodes WHERE json_extract(payload_json,'$.title')='用户改名'"),1);
    std::fs::write(path, b"other media").unwrap();
    assert!(send(
        "b".repeat(64),
        &format!("shot-note-{}", "b".repeat(64)),
        false
    )
    .is_err());
    assert_eq!(count(&db, "SELECT count(*) FROM video_shot_deliveries"), 1);
}
