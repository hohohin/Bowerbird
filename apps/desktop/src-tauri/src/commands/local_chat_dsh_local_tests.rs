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
fn dsh_local_names_a_malformed_tool_call_and_hides_host_internals() {
    let events = vec![
        event(1, "turn/start", json!({"turn":1})),
        event(
            2,
            "agent/inbox/spliced",
            json!({"inserted":[{"source":{"kind":"user","rpcId":"wanted"}}]}),
        ),
        event(
            3,
            "assistant/message",
            json!({"turn":1,"step":1,"message":{"content":[{"type":"text","text":"前半段"}]}}),
        ),
        event(
            4,
            "turn/end",
            json!({"turn":1,"reason":{"kind":"error","error":{"code":"MALFORMED_RESPONSE","message":"DeepSeek Messages stream: tool input is invalid JSON"}}}),
        ),
    ];
    let reply = fold_history(&events, "wanted", 0).unwrap();
    assert_eq!(reply.text, "前半段");
    let detail = reply.status().unwrap_err().to_string();
    assert!(detail.contains("卡片工具参数不是合法 JSON"), "{detail}");
    assert!(detail.contains("已保留收到的内容"), "{detail}");
    assert!(!detail.contains("DeepSeek Messages"), "{detail}");
    // Underscore tokens make the desktop replace the whole line with a fallback message.
    assert!(!detail.contains("MALFORMED_RESPONSE"), "{detail}");

    let upstream = fold_history(
        &[
            event(1, "turn/start", json!({"turn":1})),
            event(
                2,
                "agent/inbox/spliced",
                json!({"inserted":[{"source":{"kind":"user","rpcId":"wanted"}}]}),
            ),
            event(
                3,
                "turn/end",
                json!({"turn":1,"reason":{"kind":"error","error":{"code":"UPSTREAM_500","message":"secret upstream body"}}}),
            ),
        ],
        "wanted",
        0,
    )
    .unwrap();
    let text = upstream.status().unwrap_err().to_string();
    assert!(text.contains("本机 DSH 本轮失败"), "{text}");
    assert!(text.contains("可重跑"), "{text}");
    assert!(text.contains("重跑前请确认本轮已创建的卡片"), "{text}");
    assert!(!text.contains("UPSTREAM_500"), "{text}");
    assert!(!text.contains("secret upstream body"), "{text}");
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
fn dsh_local_live_reply_correlates_the_queued_inbox_turn() {
    let events = vec![
        event(
            1,
            "agent/inbox/spliced",
            json!({"target":"next-turn","start":0,"inserted":[{"content":[{"type":"text","text":"问题"}],"source":{"kind":"user","rpcId":"wanted"},"role":"user"}]}),
        ),
        event(2, "turn/start", json!({"turn":1})),
        event(
            3,
            "assistant/message",
            json!({"turn":1,"step":1,"message":{"content":[{"type":"text","text":"回答"}]}}),
        ),
        event(
            4,
            "turn/end",
            json!({"turn":1,"reason":{"kind":"completed"}}),
        ),
    ];
    let reply = fold_history(&events, "wanted", 0).unwrap();
    assert_eq!(reply.text, "回答");
    assert_eq!(reply.status().unwrap(), Some("done"));
    assert_eq!(
        fold_history(&events, "other", 0).unwrap().status().unwrap(),
        None
    );
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

#[test]
fn dsh_local_profile_patch_is_appended_once_and_rewritten_in_place() {
    let block = preset_block("bowerbird-chat-deadbeef0000.mjs");
    assert_eq!(merge_patch("", &block), block);
    let empty = merge_patch("[]\n", &block);
    assert_eq!(empty.matches(PRESET_BEGIN).count(), 1);
    assert!(!empty.contains("[]"));

    let user = "- id: tool-bash\n  disabled: true\n";
    let merged = merge_patch(user, &block);
    assert!(merged.starts_with(user.trim_end()));
    assert_eq!(merged.matches(PRESET_BEGIN).count(), 1);
    assert_eq!(merged.matches("- insert:").count(), 1);

    // Connecting again replaces the managed block and keeps the user's own rows.
    let again = merge_patch(&merged, &block);
    assert_eq!(again, merged);
    assert!(again.starts_with(user.trim_end()));
}

#[test]
fn dsh_local_profile_preset_names_an_immutable_module() {
    let block = preset_block("bowerbird-chat-deadbeef0000.mjs");
    assert!(block.contains("id: bowerbird-chat\n"));
    assert!(block.contains("name: '@deepseek-ai/dsh-agent-preset'"));
    assert!(block.contains("name: ./bowerbird-chat-deadbeef0000.mjs"));
    assert!(block.contains("prefix: |-"));
    assert!(block.trim_end().ends_with(PRESET_END));

    let source = preset_source(std::path::Path::new("C:/tmp/.bowerbird/current.json"));
    let module = module_name(&source);
    assert!(module.starts_with(TOOL_PREFIX));
    assert!(module.ends_with(".mjs"));
    assert_eq!(module, module_name(&source));
    assert!(source.contains("node:fs"));
    assert!(source.contains("current.json"));
    assert!(!source.contains("__TOOL__"));
    assert!(!source.contains("__STATE__"));
}

async fn scripted_host(
    presets: Value,
    events: Vec<Value>,
    legacy: bool,
) -> (
    Host,
    Arc<Mutex<Vec<(String, Value)>>>,
    tokio::task::JoinHandle<()>,
) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let state = calls.clone();
    let pages = Arc::new(Mutex::new(events));
    let router = axum::Router::new().fallback(axum::routing::post(
        move |uri: axum::http::Uri, axum::Json(body): axum::Json<Value>| {
            let state = state.clone();
            let pages = pages.clone();
            let presets = presets.clone();
            async move {
                let path = uri.path().to_owned();
                state.lock().unwrap().push((path.clone(), body));
                let value = if path.ends_with("agentPresets/list") {
                    if legacy {
                        return (
                            axum::http::StatusCode::NOT_FOUND,
                            axum::Json(json!({"error":"not found"})),
                        );
                    }
                    json!({ "presets": presets })
                } else if path.ends_with("agentPreset.list") {
                    json!({ "presets": [], "authorable": true })
                } else if path.ends_with("session/events") {
                    let mut pages = pages.lock().unwrap();
                    if pages.is_empty() {
                        json!({"records": [], "hasMore": false})
                    } else {
                        pages.remove(0)
                    }
                } else {
                    json!({ "accepted": true })
                };
                (
                    axum::http::StatusCode::OK,
                    axum::Json(json!({"result":{"ok":true,"value":value}})),
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
async fn dsh_local_inspect_reads_the_live_preset_roster() {
    let (host, _, server) = scripted_host(json!([{"id":"standard"},{"id":PRESET_ID}]), vec![], false).await;
    let health = inspect_host(&host).await.unwrap();
    assert!(health.live);
    assert!(health.preset);
    server.abort();

    let (host, _, server) = scripted_host(json!([{"id":"standard"}]), vec![], false).await;
    let health = inspect_host(&host).await.unwrap();
    assert!(health.live);
    assert!(!health.preset);
    server.abort();
}

#[tokio::test]
async fn dsh_local_inspect_falls_back_to_the_legacy_preset_api() {
    let (host, _, server) = scripted_host(json!([]), vec![], true).await;
    let health = inspect_host(&host).await.unwrap();
    assert!(!health.live);
    assert!(health.preset);
    server.abort();
}

#[tokio::test]
async fn dsh_local_live_calls_name_the_endpoint_and_wrap_the_request() {
    let (host, calls, server) = scripted_host(json!([{"id":PRESET_ID}]), vec![], false).await;
    let _ = host
        .rpc(
            "session/create",
            json!({"request":{"sessionId":"owned","agentPreset":PRESET_ID}}),
        )
        .await
        .unwrap();
    let calls = calls.lock().unwrap();
    let (path, body) = calls
        .iter()
        .find(|(path, _)| path == "/api/session/create")
        .unwrap();
    assert_eq!(path, "/api/session/create");
    assert_eq!(body["method"], "session/create");
    assert_eq!(body["payload"]["args"]["request"]["sessionId"], "owned");
    server.abort();
}

#[tokio::test]
async fn dsh_local_live_events_page_backwards_to_the_saved_turn() {
    let first = json!({
        "records": [{"type":"event","event":{"seq":60,"type":"turn/start","data":{"turn":2}}}],
        "hasMore": true,
        "cursor": 60
    });
    let second = json!({
        "records": [{"type":"event","event":{"seq":5,"type":"turn/start","data":{"turn":1}}}],
        "hasMore": false,
        "cursor": 5
    });
    let (host, calls, server) = scripted_host(json!([]), vec![first, second], false).await;
    let pending = Pending {
        version: 1,
        base: host.base.clone(),
        session: "owned".into(),
        rpc_id: "wanted".into(),
        after: -1,
    };
    let entries = host.events(&pending).await.unwrap();
    assert_eq!(entries.len(), 2);
    let calls = calls.lock().unwrap();
    let pages: Vec<_> = calls
        .iter()
        .filter(|(path, _)| path == "/api/session/events")
        .collect();
    assert_eq!(pages.len(), 2);
    assert_eq!(pages[0].1["payload"]["args"]["request"]["address"]["sessionId"], "owned");
    assert!(pages[0].1["payload"]["args"]["request"].get("throughSeq").is_none());
    assert_eq!(pages[1].1["payload"]["args"]["request"]["throughSeq"], 59);
    server.abort();
}
