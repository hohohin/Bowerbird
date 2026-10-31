use super::*;
use crate::cloud::config::CloudConfig;

fn cloud_turn() -> (Database, String, String) {
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
    let input: ChatSendInput = serde_json::from_value(json!({"projectId":"cloud-p","provider":"deepseek-cloud","requestId":"cloud-request","text":"请整理创作方向"})).unwrap();
    let started = db.begin_local_chat(&input).unwrap();
    (db, started.conversation.summary.id, started.turn_id)
}

#[test]
fn local_chat_cloud_context_never_uploads_reference_ids_paths_or_old_pixels() {
    let (db, id, turn) = cloud_turn();
    let mut chat = db.get_local_chat(&id).unwrap().unwrap();
    chat.messages[0].reference_asset_ids = vec!["local-sensitive-file-id".into()];
    let context = messages(&chat, &turn).unwrap();
    let encoded = serde_json::to_string(&context).unwrap();
    assert!(encoded.contains("image1"));
    assert!(encoded.contains("未上传任何图片像素"));
    assert!(!encoded.contains("local-sensitive-file-id"));
    assert_eq!(context.len(), 1);
    assert_eq!(context[0]["role"], "user");
}

#[tokio::test]
async fn local_chat_cloud_recovery_uses_saved_key_without_recreating_or_executing_tools() {
    use axum::{routing::post, Json, Router};
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (db, id, turn) = cloud_turn();
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
    assert!(completion(&json!({"status":"outcome_unknown"}))
        .unwrap_err()
        .to_string()
        .contains("未自动重发"));
    assert!(
        completion(&json!({"status":"succeeded","message":{"role":"user","content":"fake"}}))
            .is_err()
    );
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
