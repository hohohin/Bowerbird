use super::*;

fn event(seq: i64, kind: &str, data: Value) -> Value {
    json!({"event":{"seq":seq,"type":kind,"data":data,"time":0}})
}

#[test]
fn dsh_local_reply_correlates_request_and_omits_reasoning_and_other_turns() {
    let events = vec![
        event(1, "turn/start", json!({"turn":1})),
        event(2, "user/message", json!({"source":{"rpcId":"other"}})),
        event(
            3,
            "assistant/message",
            json!({"turn":1,"step":1,"message":{"content":[{"type":"text","text":"foreign"}]}}),
        ),
        event(
            4,
            "turn/end",
            json!({"turn":1,"reason":{"kind":"completed"}}),
        ),
        event(5, "turn/start", json!({"turn":2})),
        event(6, "user/message", json!({"source":{"rpcId":"wanted"}})),
        event(
            7,
            "assistant/chunk",
            json!({"turn":2,"step":1,"chunk":{"type":"text-delta","text":"你好"}}),
        ),
        event(
            8,
            "assistant/chunk",
            json!({"turn":2,"step":1,"chunk":{"type":"reasoning-delta","text":"private"}}),
        ),
        event(
            9,
            "assistant/message",
            json!({"turn":2,"step":1,"message":{"content":[{"type":"text","text":"你好。"},{"type":"reasoning","text":"private"}]}}),
        ),
        event(
            10,
            "turn/end",
            json!({"turn":2,"reason":{"kind":"completed"}}),
        ),
    ];
    let reply = fold_history(&events, "wanted", 0).unwrap();
    assert_eq!(reply.text, "你好。");
    assert_eq!(reply.status().unwrap(), Some("done"));
    assert_eq!(
        fold_history(&events, "missing", 0)
            .unwrap()
            .status()
            .unwrap(),
        None
    );
    assert_eq!(fold_history(&events, "wanted", 10).unwrap().text, "");
}

#[test]
fn dsh_local_retains_partial_reply_but_never_calls_error_completed() {
    let events = vec![
        event(1, "turn/start", json!({"turn":3})),
        event(2, "user/message", json!({"source":{"rpcId":"wanted"}})),
        event(
            3,
            "assistant/chunk",
            json!({"turn":3,"step":1,"chunk":{"type":"text-delta","text":"保留"}}),
        ),
        event(
            4,
            "turn/end",
            json!({"turn":3,"reason":{"kind":"error","error":{"message":"private details"}}}),
        ),
    ];
    let reply = fold_history(&events, "wanted", 0).unwrap();
    assert_eq!(reply.text, "保留");
    assert!(reply.status().unwrap_err().to_string().contains("本机 DSH"));
    assert!(!reply.status().unwrap_err().to_string().contains("private"));
}

#[test]
fn dsh_local_cancellation_needs_correlated_terminal_event() {
    let mut events = vec![
        event(1, "turn/start", json!({"turn":3})),
        event(2, "user/message", json!({"source":{"rpcId":"wanted"}})),
    ];
    assert_eq!(
        fold_history(&events, "wanted", 0)
            .unwrap()
            .status()
            .unwrap(),
        None
    );
    events.push(event(
        3,
        "turn/end",
        json!({"turn":3,"reason":{"kind":"aborted"}}),
    ));
    assert_eq!(
        fold_history(&events, "wanted", 0)
            .unwrap()
            .status()
            .unwrap(),
        Some("stopped")
    );
}

#[test]
fn dsh_local_session_identity_is_stable_and_per_turn() {
    assert_eq!(session_id("chat-a"), session_id("chat-a"));
    assert_ne!(session_id("chat-a"), session_id("chat-b"));
    assert!(session_id("chat-a").starts_with("session-bowerbird-chat-"));
}

#[test]
fn dsh_local_preset_is_private_to_turn_and_cleanup_preserves_other_files() {
    let root = tempfile::tempdir().unwrap();
    let turn = ulid::Ulid::new().to_string();
    let preset = prepare_preset(
        root.path(),
        &turn,
        "http://127.0.0.1:1/cards",
        "fixture",
        "session",
    )
    .unwrap();
    let directory = preset.directory.clone();
    let composition: Value =
        serde_json::from_slice(&std::fs::read(directory.join("agent.cordis.yml")).unwrap())
            .unwrap();
    assert_eq!(composition.as_array().unwrap().len(), 2);
    assert_eq!(composition[0]["config"]["complete"], true);
    assert!(prepare_preset(
        root.path(),
        &turn,
        "http://127.0.0.1:1/cards",
        "replacement",
        "session"
    )
    .is_err());
    std::fs::write(directory.join("keep.txt"), "user file").unwrap();
    drop(preset);
    assert!(!directory.join("agent.cordis.yml").exists());
    assert!(!directory.join("bowerbird-tools.mjs").exists());
    assert_eq!(
        std::fs::read_to_string(directory.join("keep.txt")).unwrap(),
        "user file"
    );
}

async fn fake_host(
    legacy_status: u16,
) -> (
    Host,
    Arc<Mutex<Vec<(String, Value)>>>,
    tokio::task::JoinHandle<()>,
) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let state = calls.clone();
    let router = axum::Router::new().fallback(axum::routing::post(
        move |uri: axum::http::Uri, axum::Json(body): axum::Json<Value>| {
            let state = state.clone();
            async move {
                state.lock().unwrap().push((uri.path().to_owned(), body));
                let status = if uri.path().contains('.') {
                    legacy_status
                } else {
                    200
                };
                (
                    axum::http::StatusCode::from_u16(status).unwrap(),
                    axum::Json(json!({"result":{"ok":true,"value":{"accepted":true}}})),
                )
            }
        },
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (Host::connect(&base, None).await.unwrap(), calls, task)
}

#[tokio::test]
async fn dsh_local_missing_route_uses_new_wire_without_changing_request_identity() {
    let (host, calls, server) = fake_host(404).await;
    let rpc = uuid::Uuid::new_v4().to_string();
    let result = host
        .call(
            "session.prompt",
            json!({"sessionId":"owned","mode":"queue","content":[]}),
            &rpc,
        )
        .await
        .unwrap();
    assert_eq!(result["accepted"], true);
    let requests = calls.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].0, "/api/session.prompt");
    assert_eq!(requests[1].0, "/api/session/prompt");
    assert_eq!(requests[0].1["rpcId"], rpc);
    assert_eq!(
        requests[1].1["payload"]["args"]["request"]["requestId"],
        rpc
    );
    server.abort();
}

#[tokio::test]
async fn dsh_local_uncertain_prompt_is_never_resent() {
    let (host, calls, server) = fake_host(500).await;
    assert!(host
        .call("session.prompt", json!({"sessionId":"owned"}), "fixture")
        .await
        .is_err());
    assert_eq!(calls.lock().unwrap().len(), 1);
    server.abort();
}

#[test]
fn dsh_local_rejects_remote_host_and_credential_urls() {
    for url in [
        "https://example.com",
        "http://user:secret@127.0.0.1:3080",
        "http://127.0.0.1:3080/?token=secret",
        "http://127.0.0.1:3080/api",
    ] {
        assert!(local_base(url).is_err());
    }
    assert_eq!(
        local_base("http://127.0.0.1:3080/").unwrap(),
        "http://127.0.0.1:3080"
    );
}
