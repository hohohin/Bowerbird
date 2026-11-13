use super::*;
use crate::cloud::config::CloudConfig;

fn cloud_turn() -> (Database, String, String) {
    cloud_turn_for("deepseek-cloud")
}

pub(in crate::commands::local_chat) fn cloud_turn_for(provider: &str) -> (Database, String, String) {
    use crate::core::project_canvas::{ProjectCanvasMaterializeInput, ProjectTitleSource};
    let db = Database::open_in_memory().unwrap();
    db.migrate().unwrap();
    db.materialize_project_canvas(
        &ProjectCanvasMaterializeInput {
            project_id: "cloud-p".into(),
            name: "Cloud".into(),
            workspace_path: "blank:cloud".into(),
            workspace_key: "blank:cloud".into(),
            kind: "blank".into(),
            title_source: ProjectTitleSource::Default,
            draft_json: r#"{"schema_version":1}"#.into(),
        },
        &[],
        &[],
        None,
    )
    .unwrap();
    let input: ChatSendInput = serde_json::from_value(json!({"projectId":"cloud-p","provider":provider,"requestId":"cloud-request","text":"请整理创作方向"})).unwrap();
    let started = db.begin_local_chat(&input).unwrap();
    (db, started.conversation.summary.id, started.turn_id)
}

#[test]
fn local_chat_cloud_context_never_uploads_reference_ids_paths_or_old_pixels() {
    let (db, id, turn) = cloud_turn();
    let mut chat = db.get_local_chat(&id).unwrap().unwrap();
    chat.messages[0].reference_asset_ids = vec!["local-sensitive-file-id".into()];
    let context = messages(&chat, &turn, true).unwrap();
    let encoded = serde_json::to_string(&context).unwrap();
    assert!(encoded.contains("image1"));
    assert!(encoded.contains("未上传任何图片像素"));
    assert!(!encoded.contains("local-sensitive-file-id"));
    assert_eq!(context.len(), 1);
    assert_eq!(context[0]["role"], "user");
}

#[test]
fn local_chat_cloud_history_preserves_long_messages() {
    let (db, id, turn) = cloud_turn();
    let mut chat = db.get_local_chat(&id).unwrap().unwrap();
    let mut old = chat.messages[0].clone(); old.turn_id = "previous".into(); old.text = "历史长文🙂".repeat(100000);
    let mut reply = old.clone(); reply.role = "assistant".into(); reply.text = "收到".into();
    chat.messages.insert(0, reply);
    chat.messages.insert(0, old.clone());
    let context = messages(&chat, &turn, true).unwrap();
    assert_eq!(context.len(), 3); assert_eq!(context[0]["content"], old.text);
}

#[test]
fn local_chat_cloud_history_uses_complete_prior_turns_and_preserves_the_current_question() {
    let (db, id, turn) = cloud_turn();
    let mut chat = db.get_local_chat(&id).unwrap().unwrap();
    let current = chat.messages.clone();
    chat.messages.clear();
    for i in 1..=40 {
        for role in ["user","assistant"] {
            let mut m = current[0].clone();
            m.turn_id = format!("old-{i}"); m.role = role.into(); m.text = format!("{role}-{i}");
            chat.messages.push(m);
        }
    }
    let mut bad = chat.messages[0].clone(); bad.turn_id = "failed-turn".into(); bad.text = "失败轮问题".into();
    chat.messages.push(bad.clone()); bad.role = "assistant".into(); bad.status = "failed".into();
    chat.messages.push(bad);
    chat.messages.extend(current.clone());
    let mut later = current[0].clone(); later.turn_id = "later".into(); later.text = "未来消息".into();
    chat.messages.push(later);
    let context = messages(&chat,&turn,true).unwrap();
    assert_eq!(context.len(), 79);
    for (pair,index) in context[..78].chunks_exact(2).zip(2..=40) {
        assert_eq!(pair[0]["content"], format!("user-{index}"));
        assert_eq!(pair[1]["content"], format!("assistant-{index}"));
    }
    assert!(context.last().unwrap()["content"].as_str().unwrap().starts_with(&current[0].text));
    assert_eq!(messages(&chat,&turn,false).unwrap(),context[78..]);
}

#[tokio::test]
async fn local_chat_cloud_recovery_uses_saved_key_without_recreating_or_executing_tools() {
    use axum::{routing::post, Json, Router};
    use std::sync::atomic::{AtomicUsize, Ordering};
    for provider in ["deepseek-cloud", "dsh-cloud"] {
    let (db, id, turn) = cloud_turn_for(provider);
    let pending = Pending {
        key: "chat-lost-ack-0".into(),
        job: None,
        account: "test-user".into(),
        text: "已保留前文".into(),
    };
    db.set_local_chat_provider_turn(&turn, &serde_json::to_string(&pending).unwrap())
        .unwrap();
    db.finish_local_chat(&id, &turn, "interrupted", None)
        .unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let observed = requests.clone();
    let app = Router::new().route("/functions/v1/chat-proxy",post(move |Json(body):Json<Value>| {
        let observed=observed.clone();
        async move {
            observed.fetch_add(1,Ordering::SeqCst);
            assert_eq!(body,json!({"action":"get","idempotency_key":"chat-lost-ack-0"}));
            Json(json!({"job_id":"original-job","status":"succeeded","message":{"role":"assistant","content":"准备创建参考卡","tool_calls":[{"id":"call-original","type":"function","function":{"name":"create_canvas_cards","arguments":"{\"cards\":[{\"id\":\"one\",\"kind\":\"content\",\"title\":\"不得自动创建\",\"text\":\"content\"}]}"}}]}}))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let cloud = CloudClient::new(CloudConfig {
        supabase_url: Some(format!("http://{}", listener.local_addr().unwrap())),
        supabase_publishable_key: Some("public".into()),
        account_api_url: None,
    })
    .unwrap();
    let auth = AuthClient::with_test_session(cloud.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    recover(&db, &cloud, &auth, &id).await.unwrap();
    recover(&db, &cloud, &auth, &id).await.unwrap();
    let chat = db.get_local_chat(&id).unwrap().unwrap();
    assert_eq!(chat.summary.status, "interrupted");
    assert!(chat.actions.is_empty());
    assert_eq!(chat.messages[1].text.matches("已保留前文").count(), 1);
    assert_eq!(chat.messages[1].text.matches("准备创建参考卡").count(), 1);
    assert!(chat.messages[1].text.contains("未继续执行工具"));
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    let wrong = AuthClient::new(cloud.clone());
    assert!(recover(&db, &cloud, &wrong, &id).await.is_err());
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    server.abort();
    let _ = server.await;
    }
}

#[test]
fn local_chat_cloud_accepts_only_scoped_card_calls_and_terminal_messages() {
    let message = json!({"role":"assistant","content":"准备创建","tool_calls":[{"id":"call1","type":"function","function":{"name":"create_canvas_cards","arguments":"{\"cards\":[]}"}}]});
    let parsed = completion(&json!({"status":"succeeded","message":message}))
        .unwrap()
        .unwrap();
    assert_eq!(
        calls(&parsed).unwrap(),
        vec![("call1".into(), json!({"cards":[]}))]
    );
    let mut foreign = parsed.clone();
    foreign["tool_calls"][0]["function"]["name"] = json!("shell");
    assert!(calls(&foreign).is_err());
    foreign = parsed.clone();
    foreign["tool_calls"]
        .as_array_mut()
        .unwrap()
        .push(parsed["tool_calls"][0].clone());
    assert!(calls(&foreign).is_err());
    assert!(completion(&json!({"status":"running"})).unwrap().is_none());
    assert!(completion(&json!({"status":"uploading"}))
        .unwrap()
        .is_none());
    assert!(completion(&json!({"status":"succeeded","error":{"code":"content_expired","message":"原对话回复已过期"}})).unwrap_err().to_string().contains("已过期"));
    for status in ["failed", "cancelled", "outcome_unknown"] {
        let old = completion(&json!({"status":status,"error":{"message":"请稍后查看原任务"}})).unwrap_err();
        assert!(matches!(old, AppError::ChatNoReply(ref text) if text.contains("没有可取回") && !text.contains("稍后")));
    }
    let http = completion(&json!({"status":"outcome_unknown","error":{"message":"上游模型服务返回 HTTP 502。本轮云端任务已结束，没有可取回的回复。","recoverable":false}})).unwrap_err();
    assert!(matches!(http, AppError::ChatNoReply(ref text) if text.contains("HTTP 502")));
    assert!(
        completion(&json!({"status":"succeeded","message":{"role":"user","content":"fake"}}))
            .is_err()
    );
}

#[tokio::test]
async fn local_chat_cloud_recovery_records_terminal_result_without_overwriting_partial_text_or_newer_turn() {
    use axum::{routing::post, Json, Router};
    let (db, id, turn) = cloud_turn();
    let saved = json!({"key":"original","job":null,"account":"test-user","text":"保留原文"}).to_string();
    db.set_local_chat_provider_turn(&turn, &saved).unwrap();
    db.update_local_chat_text(&id, &turn, "保留原文").unwrap();
    db.finish_local_chat(&id, &turn, "interrupted", None).unwrap();
    let handler = Router::new().route("/functions/v1/chat-proxy", post(|Json(input): Json<Value>| async move {
        assert_eq!(input,json!({"action":"get","idempotency_key":"original"}));
        Json(json!({"status":"outcome_unknown","error":{"code":"chat_reply_format","message":"上游模型返回的回复格式无效。本轮云端任务已结束，没有可取回的回复。","recoverable":false}}))
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let cloud = CloudClient::new(CloudConfig { supabase_url: Some(format!("http://{}",listener.local_addr().unwrap())), supabase_publishable_key: Some("public".into()), account_api_url: None }).unwrap();
    let auth = AuthClient::with_test_session(cloud.clone());
    let server = tokio::spawn(async move { axum::serve(listener, handler).await.unwrap() });
    recover(&db, &cloud, &auth, &id).await.unwrap();
    let chat = db.get_local_chat(&id).unwrap().unwrap();
    assert!(chat.summary.error.unwrap().starts_with("chat_no_reply: 上游模型返回的回复格式无效"));
    assert_eq!(chat.messages[1].text, "保留原文");
    let input = serde_json::from_value(json!({"projectId":"cloud-p","conversationId":id,"requestId":"later","text":"接续","provider":"deepseek-cloud"})).unwrap();
    db.begin_local_chat(&input).unwrap();
    assert!(db.record_local_chat_recovery_error(&id, &turn, &saved, "过期回执").is_err());
    assert!(db.get_local_chat(&id).unwrap().unwrap().summary.error.is_none());
    server.abort();
}

#[tokio::test]
async fn local_chat_cloud_uses_authenticated_gateway_and_preserves_zero_quote() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let cloud = CloudClient::new(CloudConfig {
        supabase_url: Some(url),
        supabase_publishable_key: Some("public-test".into()),
        account_api_url: None,
    })
    .unwrap();
    let auth = AuthClient::with_test_session(cloud.clone());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut input = String::new();
        loop {
            let mut chunk = [0; 8192];
            let count = stream.read(&mut chunk).await.unwrap();
            assert!(count > 0);
            input.push_str(&String::from_utf8_lossy(&chunk[..count]));
            if input.contains("\"action\":\"quote\"") {
                break;
            }
        }
        assert!(input.starts_with("POST /functions/v1/chat-proxy?"));
        assert!(input
            .to_lowercase()
            .contains("authorization: bearer test-user-session"));
        assert!(input.contains("\"action\":\"quote\""));
        let body = r#"{"provider":"deepseek-cloud","available":true,"unit_cost":0,"currency":"Bcoin","pricing_version":"test-zero"}"#;
        stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
    });
    let quote = request(&cloud, &auth, json!({"action":"quote"}))
        .await
        .unwrap();
    assert_eq!(quote["unit_cost"], 0);
    assert_eq!(quote["provider"], "deepseek-cloud");
    server.await.unwrap();
}
