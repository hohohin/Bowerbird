use super::super::cloud_chat::tests::cloud_turn_for;
use super::*;
use axum::{routing::post, Json, Router};
use std::sync::atomic::{AtomicUsize, Ordering};

async fn gateway(handler: Router) -> (CloudClient, AuthClient, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let cloud = CloudClient::new(crate::cloud::config::CloudConfig {
        supabase_url: Some(format!("http://{}", listener.local_addr().unwrap())),
        supabase_publishable_key: Some("public".into()),
        account_api_url: None,
    })
    .unwrap();
    let auth = AuthClient::with_test_session(cloud.clone());
    let server = tokio::spawn(async move { axum::serve(listener, handler).await.unwrap() });
    (cloud, auth, server)
}
fn args() -> Value {
    json!({"cards":[{"id":"note","kind":"content","title":"本机私有标题","text":"文案"}]})
}
fn pending_tool() -> Value {
    json!({"job_id":"original","status":"running","pending_tool":{"id":"card_1","name":"create_canvas_cards","arguments":args()}})
}
fn done() -> Value {
    json!({"job_id":"original","status":"succeeded","message":{"role":"assistant","content":"最终回复"}})
}

#[tokio::test]
async fn local_chat_vps_one_create_and_idempotent_tool_ack_after_disconnect() {
    let (db, id, turn) = cloud_turn_for("dsh-cloud");
    let pending = Pending::new(&turn, "test-user".into());
    let create = create_body(&db, &id, &turn, &pending.key, None).unwrap();
    assert_eq!(create["conversation_id"],format!("c-{id}"));
    let log = Arc::new(Mutex::new(Vec::new()));
    let observed = log.clone();
    let handler = Router::new().route("/functions/v1/chat-proxy",post(move |Json(body):Json<Value>| {
        let log = observed.clone();
        async move {
            let mut log = log.lock().unwrap(); log.push(body.clone());
            let acks = log.iter().filter(|v| v["action"] == "tool_result").count();
            let response = match body["action"].as_str().unwrap() {
                "create" => {
                    assert_eq!(body["engine"],ENGINE); assert_eq!(body["tools_enabled"],true);
                    assert_eq!(body["messages"].as_array().unwrap().len(),1);
                    json!({"job_id":"original","status":"queued"})
                }
                "get" if acks < 2 => pending_tool(),
                "get" => done(),
                "tool_result" => {
                    assert_eq!(body, json!({"action":"tool_result","job_id":"original","call_id":"card_1","result":{"success":true,"created_count":1}}));
                    if acks == 1 { return (axum::http::StatusCode::BAD_GATEWAY, Json(json!({"error":{"message":"模拟回执丢失"}}))); }
                    json!({"ok":true})
                }
                other => panic!("unexpected {other}"),
            };
            (axum::http::StatusCode::OK,Json(response))
        }
    }));
    let (cloud, auth, server) = gateway(handler).await;
    let (_stop, cancel) = watch::channel(false);
    let executions = AtomicUsize::new(0);
    let apply = |call: String, args: Value| {
        executions.fetch_add(1, Ordering::SeqCst);
        std::future::ready(
            db.create_local_chat_cards(&id, &turn, &call, &args)
                .map(|a| card_receipt(&a)),
        )
    };
    assert!(drive(
        &db,
        &cloud,
        &auth,
        &id,
        &turn,
        pending,
        Some(create),
        cancel.clone(),
        apply
    )
    .await
    .is_err());
    db.finish_local_chat(&id, &turn, "interrupted", None)
        .unwrap();
    let (_, saved) = db.local_chat_recovery(&id).unwrap();
    let pending = Pending::parse(&turn, &saved).unwrap().unwrap();
    assert_eq!(
        pending.receipt.as_ref().unwrap().result,
        json!({"success":true,"created_count":1})
    );
    db.resume_vps_chat(&id, &turn, &saved).unwrap();
    assert_eq!(
        drive(&db, &cloud, &auth, &id, &turn, pending, None, cancel, apply)
            .await
            .unwrap(),
        "done"
    );
    db.finish_local_chat(&id, &turn, "done", None).unwrap();
    let chat = db.get_local_chat(&id).unwrap().unwrap();
    assert_eq!(chat.messages.last().unwrap().text, "最终回复");
    assert_eq!(chat.actions.len(), 1);
    assert_eq!(executions.load(Ordering::SeqCst), 1);
    assert_eq!(
        log.lock()
            .unwrap()
            .iter()
            .filter(|v| v["action"] == "create")
            .count(),
        1
    );
    server.abort();
}

#[tokio::test]
async fn local_chat_vps_recovery_replays_only_local_commits_and_never_creates_cards() {
    for committed in [false, true] {
        let (db, id, turn) = cloud_turn_for("dsh-cloud");
        let mut pending = Pending::new(&turn, "test-user".into());
        pending.engine = "dsh-vps-v1".into(); // Old jobs continue against get/tool_result.
        pending.job = Some("original".into());
        pending.save(&db, &turn).unwrap();
        if committed {
            db.create_local_chat_cards(&id, &turn, "card_1", &args())
                .unwrap();
        }
        db.finish_local_chat(&id, &turn, "interrupted", None)
            .unwrap();
        let (_, saved) = db.local_chat_recovery(&id).unwrap();
        db.resume_vps_chat(&id, &turn, &saved).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let reached = calls.clone();
        let handler = Router::new().route(
            "/functions/v1/chat-proxy",
            post(move |Json(body): Json<Value>| {
                let step = reached.fetch_add(1, Ordering::SeqCst);
                async move {
                    Json(match step {
                        0 => {
                            assert_eq!(body, json!({"action":"get","job_id":"original"}));
                            pending_tool()
                        }
                        1 => {
                            assert_eq!(
                                body["result"],
                                if committed {
                                    json!({"success":true,"created_count":1})
                                } else {
                                    json!({"success":false,"error":"card_creation_failed"})
                                }
                            );
                            json!({"ok":true})
                        }
                        _ => done(),
                    })
                }
            }),
        );
        let (cloud, auth, server) = gateway(handler).await;
        let (_stop, cancel) = watch::channel(false);
        assert_eq!(
            drive(
                &db,
                &cloud,
                &auth,
                &id,
                &turn,
                pending,
                None,
                cancel,
                |_, _| async { panic!("recovery must not execute card creation") }
            )
            .await
            .unwrap(),
            "done"
        );
        assert_eq!(
            db.get_local_chat(&id).unwrap().unwrap().actions.len(),
            usize::from(committed)
        );
        server.abort();
    }
}

#[tokio::test]
async fn local_chat_vps_cancellation_selects_only_the_original_job_or_key() {
    for job in [None, Some("original".to_owned())] {
        let (db, id, turn) = cloud_turn_for("dsh-cloud");
        let mut pending = Pending::new(&turn, "test-user".into());
        if job.is_none() { pending.engine = "dsh-vps-v1".into(); }
        pending.job = job.clone();
        pending.cancel_requested = true;
        let expected = match job {
            Some(job) => json!({"action":"cancel","job_id":job}),
            None => json!({"action":"cancel","idempotency_key":pending.key}),
        };
        let handler = Router::new().route("/functions/v1/chat-proxy",post(move |Json(body):Json<Value>| {
            let expected = expected.clone();
            async move {
                assert_eq!(body,expected);
                Json(json!({"job_id":"original","status":"outcome_unknown","error":{"code":"chat_cancelled"}}))
            }
        }));
        let (cloud, auth, server) = gateway(handler).await;
        let (_stop, cancel) = watch::channel(false);
        assert_eq!(
            drive(
                &db,
                &cloud,
                &auth,
                &id,
                &turn,
                pending,
                None,
                cancel,
                |_, _| async { panic!("no tools while cancelling") }
            )
            .await
            .unwrap(),
            "stopped"
        );
        server.abort();
    }
}

#[test]
fn local_chat_vps_v2_sends_one_message_on_turn_41_with_80_prior_messages() {
    let (db, id, mut turn) = cloud_turn_for("deepseek-cloud");
    let original = create_body(&db, &id, &turn, "first", None).unwrap();
    for index in 1..=40 {
        db.update_local_chat_text(&id, &turn, &format!("历史回复-{index}")).unwrap();
        db.finish_local_chat(&id, &turn, "done", None).unwrap();
        let next = serde_json::from_value(json!({
            "projectId": "cloud-p", "conversationId": id,
            "requestId": format!("request-{}", index + 1), "text": format!("问题-{}", index + 1),
        })).unwrap();
        turn = db.begin_local_chat(&next).unwrap().turn_id;
    }
    let chat = db.get_local_chat(&id).unwrap().unwrap();
    assert_eq!(chat.summary.turn_count, 41);
    assert_eq!(chat.messages.iter().filter(|m| m.turn_id != turn && m.status == "done").count(), 80);
    let current = create_body(&db, &id, &turn, "current", None).unwrap();
    assert_eq!(current["engine"], "dsh-vps-v2");
    assert_eq!(current["conversation_id"], original["conversation_id"]);
    assert_eq!(current["messages"], json!([{"role":"user","content":cloud_chat::current_text("问题-41",0)}]));
}

#[test]
fn local_chat_vps_sends_current_aliases_only_and_scopes_manual_and_automatic_memory() {
    let (db, id, first) = cloud_turn_for("dsh-cloud");
    let node = db.get_local_chat(&id).unwrap().unwrap().summary.node_id;
    db.create_local_chat_cards(&id,&first,"old_call",&args()).unwrap();
    db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,store_path,created_at) VALUES('local-private-id','隐私文件名','C:/private/file.jpg',1)",[]).unwrap();
    let mut old = Pending::new(&first,"test-user".into()); old.engine = "dsh-vps-v1".into(); old.save(&db,&first).unwrap();
    db.update_local_chat_text(&id, &first, "上一轮回复")
        .unwrap();
    db.finish_local_chat(&id, &first, "done", None).unwrap();
    let raw = json!({"projectId":"cloud-p","conversationId":id,"agentNodeId":node,"requestId":"auto","text":"自动工作流"});
    let auto = db
        .begin_local_chat(&serde_json::from_value(raw.clone()).unwrap())
        .unwrap();
    let body = create_body(&db, &id, &auto.turn_id, "key", None).unwrap();
    assert_eq!(body["conversation_id"],format!("t-{}",auto.turn_id));
    Pending::new(&auto.turn_id,"test-user".into()).save(&db,&auto.turn_id).unwrap();
    assert!(db.get_local_chat(&id).unwrap().unwrap().vps_history_start_turn_id.is_none());
    assert_eq!(body["messages"].as_array().unwrap().len(), 1);
    assert!(!body.to_string().contains("上一轮回复"));
    db.update_local_chat_text(&id, &auto.turn_id, "自动回复")
        .unwrap();
    db.finish_local_chat(&id, &auto.turn_id, "done", None)
        .unwrap();
    let mut manual_input = raw;
    manual_input["manualCardRun"] = json!(true);
    manual_input["requestId"] = json!("manual");
    manual_input["text"] = json!("手动续聊");
    manual_input["referenceAssetIds"] = json!(["local-private-id"]);
    let manual = db
        .begin_local_chat(&serde_json::from_value(manual_input).unwrap())
        .unwrap();
    let manual_body = create_body(&db, &id, &manual.turn_id, "key2", None).unwrap();
    let messages = manual_body["messages"].as_array().unwrap();
    assert_eq!(manual_body["conversation_id"],format!("c-{id}"));
    assert_eq!(messages.len(), 1);
    let text = messages[0]["content"].as_str().unwrap();
    assert!(text.starts_with("手动续聊") && text.contains("image1"));
    for hidden in ["上一轮回复","自动工作流","自动回复","本机私有标题","local-private-id","private/file"] {
        assert!(!manual_body.to_string().contains(hidden));
    }
    Pending::new(&manual.turn_id,"test-user".into()).save(&db,&manual.turn_id).unwrap();
    assert_eq!(db.get_local_chat(&id).unwrap().unwrap().vps_history_start_turn_id.as_deref(),Some(manual.turn_id.as_str()));
    db.finish_local_chat(&id,&manual.turn_id,"done",None).unwrap();
    let later = db.begin_local_chat(&serde_json::from_value(json!({"projectId":"cloud-p","conversationId":id,"requestId":"next","text":"下一句"})).unwrap()).unwrap();
    let later_body = create_body(&db,&id,&later.turn_id,"key3",None).unwrap();
    assert_eq!(later_body["conversation_id"],manual_body["conversation_id"]);
    assert_eq!(later_body["messages"].as_array().unwrap().len(),1);
    Pending::new(&later.turn_id,"test-user".into()).save(&db,&later.turn_id).unwrap();
    assert_eq!(db.get_local_chat(&id).unwrap().unwrap().vps_history_start_turn_id.as_deref(),Some(manual.turn_id.as_str()));
    db.finish_local_chat(&id,&later.turn_id,"done",None).unwrap();
    let fresh = db.new_agent_chat("cloud-p",&node,&id,None,None).unwrap().summary.id;
    let next = db.begin_local_chat(&serde_json::from_value(json!({"projectId":"cloud-p","conversationId":fresh,"requestId":"new","text":"新会话首句"})).unwrap()).unwrap();
    let new_body = create_body(&db,&fresh,&next.turn_id,"new",None).unwrap();
    assert_eq!(new_body["conversation_id"],format!("c-{fresh}"));
    assert_ne!(new_body["conversation_id"],manual_body["conversation_id"]);
    Pending::new(&next.turn_id,"test-user".into()).save(&db,&next.turn_id).unwrap();
    assert!(db.get_local_chat(&fresh).unwrap().unwrap().vps_history_start_turn_id.is_none());
    let legacy =
        json!({"account":"test-user","key":"chat-legacy-0","job":"original","text":"旧回复"})
            .to_string();
    assert!(Pending::parse(&first, &legacy).unwrap().is_none());
}

#[tokio::test]
async fn local_chat_vps_stop_during_admission_cancels_even_if_ack_is_lost() {
    for lost in [false, true] {
        let (db, id, turn) = cloud_turn_for("dsh-cloud");
        let pending = Pending::new(&turn, "test-user".into());
        let create = create_body(&db, &id, &turn, &pending.key, None).unwrap();
        let (stop, cancel) = watch::channel(false);
        let expected = if lost {
            json!({"action":"cancel","idempotency_key":pending.key})
        } else {
            json!({"action":"cancel","job_id":"original"})
        };
        let handler = Router::new().route("/functions/v1/chat-proxy",post(move |Json(body):Json<Value>| {
            let expected = expected.clone();
            let stop = stop.clone();
            async move {
                if body["action"] == "create" {
                    stop.send(true).unwrap();
                    if lost {return (axum::http::StatusCode::BAD_GATEWAY, Json(json!({"error":{"message":"接收回执丢失"}})));}
                    return (axum::http::StatusCode::ACCEPTED, Json(json!({"job_id":"original","status":"queued"})));
                }
                assert_eq!(body,expected);
                (axum::http::StatusCode::OK,Json(json!({"job_id":"original","status":"failed","error":{"code":"chat_cancelled"}})))
            }
        }));
        let (cloud, auth, server) = gateway(handler).await;
        assert_eq!(
            drive(
                &db,
                &cloud,
                &auth,
                &id,
                &turn,
                pending,
                Some(create),
                cancel,
                |_, _| async { panic!("no tools while cancelling") }
            )
            .await
            .unwrap(),
            "stopped"
        );
        server.abort();
    }
}

#[test]
fn local_chat_vps_skill_is_validated_per_request_and_omitted_from_later_turns() {
    use crate::core::local_chat::ChatSendInput;
    let (db, id, turn) = cloud_turn_for("dsh-cloud");
    db.finish_local_chat(&id, &turn, "done", None).unwrap();
    let query = json!({"projectId":"cloud-p","conversationId":id,"requestId":"with-skill","text":"写正文","dshSkill":{"id":"text-editor"}});
    let input: ChatSendInput = serde_json::from_value(query.clone()).unwrap();
    let started = db.begin_local_chat(&input).unwrap();
    let body = create_body(&db, &id, &started.turn_id, "key", input.dsh_skill.as_ref()).unwrap();
    assert_eq!(body["skill"], query["dshSkill"]);
    assert_eq!(body["tools_enabled"], false);
    assert!(db.local_chat_turn_has_dsh_skill(&started.turn_id).unwrap());
    db.finish_local_chat(&id, &started.turn_id, "done", None)
        .unwrap();
    let mut ordinary = input.clone();
    ordinary.dsh_skill = None;
    assert!(db.replay_local_chat(&ordinary).is_err());
    ordinary.request_id = "later".into();
    let later = db.begin_local_chat(&ordinary).unwrap();
    assert!(!db.local_chat_turn_has_dsh_skill(&later.turn_id).unwrap());
    for invalid in [
        json!({"id":"../text-editor"}),
        json!({"id":"text-editor","parameters":{}}),
        json!({"id":"text-editor","instructions":"inject"}),
    ] {
        let mut raw = query.clone();
        raw["dshSkill"] = invalid;
        assert!(serde_json::from_value::<ChatSendInput>(raw).is_err());
    }
    let params =
        json!({"mode":"frames","seconds":4,"ratio":"16:9","firstFrameCount":1,"lastFrameCount":1});
    let mut valid = json!({"id":"h3-video-prompt","parameters":params});
    serde_json::from_value::<ChatDshSkill>(valid.clone())
        .unwrap()
        .validate()
        .unwrap();
    valid["parameters"]["mode"] = json!("text");
    assert!(serde_json::from_value::<ChatDshSkill>(valid)
        .unwrap()
        .validate()
        .is_err());
    let mut wrong = input;
    wrong.conversation_id = None;
    wrong.request_id = "wrong".into();
    wrong.provider = Some(ChatProvider::DshLocal);
    assert!(db.begin_local_chat(&wrong).is_err());
}
