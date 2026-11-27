use super::*;

#[test]
fn incomplete_commit_keeps_upload_error_but_an_advanced_job_can_resume() {
    let reply = |status| json!({"job_id": "original", "status": status});
    let upload_error = || Err(err("原任务的上传地址无效"));
    for response in [
        Ok((StatusCode::ACCEPTED, reply("uploading"))),
        Ok((StatusCode::BAD_GATEWAY, reply("queued"))),
        Ok((
            StatusCode::ACCEPTED,
            json!({"job_id": "other", "status": "queued"}),
        )),
        Err(err("提交断线")),
    ] {
        let error = committed_proxy(upload_error(), response, "original").unwrap_err();
        assert!(error.to_string().contains("原任务的上传地址无效"));
    }
    for status in ["queued", "running", "leased", "processing", "succeeded"] {
        let value = reply(status);
        assert_eq!(
            committed_proxy(
                upload_error(),
                Ok((StatusCode::ACCEPTED, value.clone())),
                "original"
            )
            .unwrap(),
            value
        );
    }
    let value = reply("uploading");
    assert_eq!(
        committed_proxy(
            Ok(()),
            Ok((StatusCode::ACCEPTED, value.clone())),
            "original"
        )
        .unwrap(),
        value
    );
}

#[test]
fn polling_distinguishes_upload_retry_unknown_outcome_and_failure() {
    let mut queue_status = "running".to_owned();
    for status in ["queued", "running", "leased", "processing"] {
        let value = json!({"status": status});
        assert!(poll_pending(&value, &mut queue_status, true).is_ok());
        assert!(poll_pending(&value, &mut queue_status, false)
            .unwrap_err()
            .to_string()
            .contains("超时"));
    }
    for (value, message, expected_status) in [
        (json!({"status": "uploading"}), "重试上传", "running"),
        (
            json!({"status": "outcome_unknown"}),
            "镜头结果待核对",
            "running",
        ),
        (json!({"status": "unknown"}), "无法识别", "running"),
        (json!({"status": "failed"}), "此镜头任务失败", "failed"),
        (
            json!({"status": "failed", "error": {"message": "镜头任务内容已过期"}}),
            "镜头任务内容已过期",
            "failed",
        ),
        (
            json!({"status": "failed", "charge": {"refunded": true}}),
            "原预留已退回",
            "failed",
        ),
    ] {
        queue_status = "running".into();
        assert!(poll_pending(&value, &mut queue_status, true)
            .unwrap_err()
            .to_string()
            .contains(message));
        assert_eq!(queue_status, expected_status);
    }
}

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
