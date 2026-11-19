use super::*;

fn event(seq: i64, kind: &str, data: Value) -> Value {
    json!({"event":{"seq":seq,"type":kind,"data":data,"time":0}})
}

// Run alone with the installed DSH, a fresh DSH_HOME, isolated application data
// and a loopback Messages SSE fixture. The fixture emits a single extra brace.
#[tokio::test]
#[ignore = "requires an isolated real DSH installation test environment"]
async fn dsh_auto_installed_host_creates_one_card_call_and_recovers_after_restart() {
    let app_data = crate::codex::codex_cli::app_data_dir().unwrap();
    let home = PathBuf::from(std::env::var_os("DSH_HOME").unwrap());
    let isolated = PathBuf::from(std::env::var_os("BOWERBIRD_DSH_AUTO_FIXTURE").unwrap());
    assert!(isolated.is_absolute() && isolated.starts_with(std::env::temp_dir()));
    assert!(home.starts_with(&isolated) && app_data.starts_with(&isolated));
    if let Ok(platform) = std::env::var("BOWERBIRD_DSH_ACCOUNT_FIXTURE") {
        assert!(platform.starts_with("http://127.0.0.1:"));
        assert!(std::env::var_os("DEEPSEEK_API_KEY").is_none());
        authorize_fixture_account(&platform).await;
    } else {
        assert!(std::env::var("DEEPSEEK_BASE_URL").unwrap().starts_with("http://127.0.0.1:"));
        assert_eq!(std::env::var("DEEPSEEK_API_KEY").unwrap(), "fixture");
        dsh::setup("auto", None, None).await.unwrap();
    }
    let config = dsh::active_connection().await.unwrap();
    let host = Host::connect(&config.base, config.auth.as_deref()).await.unwrap();
    let session = session_id(&uuid::Uuid::new_v4().to_string());
    let calls = Arc::new(Mutex::new(Vec::new()));
    let received = calls.clone();
    let router = axum::Router::new().route("/cards", axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
        received.lock().unwrap().push(body);
        async { axum::Json(json!({"success":true})) }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    handshake_add(&session, &format!("http://{}/cards", listener.local_addr().unwrap()), "fixture").unwrap();
    let gateway = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let preset = current_preset_id().unwrap();
    let created = host.rpc(ROUTE_CREATE, json!({"request":{"sessionId":session,"agentPreset":preset,"cwd":home}})).await.unwrap();
    assert_eq!(created["agentPreset"], preset);
    let (mut peer_process, peer_config) = dsh::unmodified_peer().await.unwrap();
    let peer = Host::connect(&peer_config.base, peer_config.auth.as_deref()).await.unwrap();
    assert_other_writer(&peer, &session).await;
    let other = session_id(&uuid::Uuid::new_v4().to_string());
    host.rpc(ROUTE_CREATE, json!({"request":{"sessionId":other,"agentPreset":preset,"cwd":home}})).await.unwrap();
    let pending = Pending { version: 1, base: config.base.clone(), session: session.clone(), rpc_id: "fixture".into(), after: -1, questions_enabled: true };
    let accepted = host.rpc(ROUTE_PROMPT, json!({"request":{"sessionId":session,"mode":"queue","requestId":pending.rpc_id,
        "content":[{"type":"text","text":"/fixture-card Create the fixture card using the skill's title."}]}})).await.unwrap();
    assert_eq!(accepted["accepted"], true);
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let reply = fold_history(&host.events(&pending).await.unwrap(), &pending.rpc_id, -1).unwrap();
            if let Some(status) = reply.status().unwrap() {
                assert_eq!(status, "done");
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }).await.unwrap();
    handshake_remove(&session);
    gateway.abort();
    // Keep the initiating process alive. Another official host sharing this DSH_HOME
    // must be able to acquire the writer and continue the same durable conversation.
    let continuation = Pending { version: 1, base: peer_config.base, session: session.clone(),
        rpc_id: "peer-continuation".into(), after: peer.continuation_cursor(&session).await.unwrap(), questions_enabled: true };
    let accepted = peer.rpc(ROUTE_PROMPT, json!({"request":{"sessionId":session,"mode":"queue",
        "requestId":continuation.rpc_id,"content":[{"type":"text","text":"Continue this conversation."}]}})).await.unwrap();
    assert_eq!(accepted["accepted"], true);
    tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            let events = host.events(&pending).await.unwrap();
            let next = fold_history(&peer.events(&continuation).await.unwrap(), &continuation.rpc_id, continuation.after).unwrap();
            if next.status().unwrap() == Some("done") {
                assert_eq!(next.text, "done");
                assert_eq!(fold_history(&events, &pending.rpc_id, -1).unwrap().status().unwrap(), Some("done"));
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }).await.unwrap();
    assert_other_writer(&peer, &other).await;
    peer_process.kill().await.unwrap();
    dsh::stop_owned().await;
    let restored = dsh::recovery_connection(&serde_json::to_string(&pending).unwrap()).await.unwrap();
    assert_eq!(restored.base, config.base);
    let host = Host::connect(&restored.base, restored.auth.as_deref()).await.unwrap();
    let reply = fold_history(&host.events(&pending).await.unwrap(), &pending.rpc_id, -1).unwrap();
    assert_eq!(reply.status().unwrap(), Some("done"));
    dsh::stop_owned().await;
    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["sessionId"], session);
    assert_eq!(calls[0]["callId"], "original-1");
    assert_eq!(calls[0]["arguments"]["cards"][0]["id"], "c1");
    assert_eq!(calls[0]["arguments"]["cards"][0]["title"], "Orchid-731");
}

async fn assert_other_writer(peer: &Host, session: &str) {
    let request_id = uuid::Uuid::new_v4().to_string();
    let busy: Value = peer.client.post(format!("{}/api/{ROUTE_PROMPT}", peer.base)).json(&json!({
        "type":"client-request","method":ROUTE_PROMPT,"rpcId":request_id,"payload":{"args":{"request":{
            "sessionId":session,"mode":"queue","requestId":request_id,"content":[{"type":"text","text":"busy check"}]
        }}}
    })).send().await.unwrap().json().await.unwrap();
    assert_eq!(busy["result"]["error"]["code"], "session/writer-held", "{busy}");
}

#[tokio::test]
#[ignore = "requires the isolated native DSH smoke fixture"]
async fn dsh_native_question_survives_host_crash() {
    let fixture = PathBuf::from(std::env::var_os("BOWERBIRD_DSH_AUTO_FIXTURE").unwrap());
    let home = PathBuf::from(std::env::var_os("DSH_HOME").unwrap());
    assert!(fixture.starts_with(std::env::temp_dir()) && home.starts_with(&fixture));
    assert!(crate::codex::codex_cli::app_data_dir().unwrap().starts_with(&fixture));
    assert_eq!(std::env::var("DEEPSEEK_API_KEY").unwrap(), "fixture");
    assert!(std::env::var("DEEPSEEK_BASE_URL").unwrap().starts_with("http://127.0.0.1:"));
    dsh::setup("auto", None, None).await.unwrap();
    dsh::stop_owned().await;

    let profile = home.join("profiles/web");
    let source = preset_source(&handshake_path().unwrap());
    let module = module_name(&source);
    let preset = "bowerbird-question-fixture";
    let block = preset_block_template(&module, preset);
    write_private(&profile.join(module), &source).unwrap();
    write_private(&profile.join("cordis.patch.yml"), &block).unwrap();

    for case in ["live", "cold", "deadline"] {
        let (mut process, connection) = dsh::unmodified_peer().await.unwrap();
        let host = Host::connect(&connection.base, connection.auth.as_deref()).await.unwrap();
        let session = session_id(&uuid::Uuid::new_v4().to_string());
        let (db, conversation, turn) = cloud_chat::tests::cloud_turn_for("dsh-local");
        let db = Arc::new(db);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (card_db, card_chat, card_turn, card_session, captured) =
            (db.clone(), conversation.clone(), turn.clone(), session.clone(), calls.clone());
        let server = axum::Router::new().route("/cards", axum::routing::post(
            move |axum::Json(body): axum::Json<Value>| {
                assert_eq!(body["sessionId"], card_session);
                let call_id = body["callId"].as_str().unwrap();
                card_db.create_local_chat_cards(&card_chat, &card_turn, call_id, &body["arguments"]).unwrap();
                captured.lock().unwrap().push(call_id.to_owned());
                async { axum::Json(json!({"status":"fixture-card-created"})) }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let cards_url = format!("http://{}/cards", listener.local_addr().unwrap());
        let gateway = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
        handshake_add(&session, &cards_url, "fixture").unwrap();
        let created = host.rpc(ROUTE_CREATE, json!({"request":{"sessionId":session,"agentPreset":preset,"cwd":home}})).await.unwrap();
        assert_eq!(created["agentPreset"], preset);
        // The desktop only connects a question stream while sending an answer.
        let mut events = if case == "live" { None } else { Some(open_question_events(&connection).await.0) };
        let pending = Pending { version: 1, base: connection.base.clone(), session: session.clone(), rpc_id: "question-fixture".into(), after: -1, questions_enabled: true };
        let text = if case == "deadline" { "Bowerbird question fixture with deadline" } else { "Bowerbird question fixture" };
        let accepted = host.rpc(ROUTE_PROMPT, json!({"request":{"sessionId":session,"mode":"queue","requestId":pending.rpc_id,
            "content":[{"type":"text","text":text}]}})).await.unwrap();
        assert_eq!(accepted["accepted"], true);
        let call = "audience-call";
        if let Some(events) = &mut events {
            let request = read_question_event(events).await;
            assert_eq!(request["agentId"], session);
            assert_eq!(request["request"]["wait"]["callId"], call);
        }
        let bridge = questions::QuestionTurn::fixture(host.clone(), pending.clone(), turn.clone());
        db.set_local_chat_provider_turn(&turn, &bridge.checkpoint).unwrap();
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let batches = bridge.batches().await.unwrap();
                if batches.first().is_some_and(|batch| batch.call_id == call) { break; }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }).await.unwrap();
        let before = host.events(&pending).await.unwrap();
        assert!(before.iter().any(|entry| entry["event"]["type"] == "tool/call" && entry["event"]["data"]["callId"] == call));
        let waiting = fold_history(&before, &pending.rpc_id, -1).unwrap();
        assert_eq!(waiting.status().unwrap(), None);
        assert!(host.has_pending_questions(&session, &waiting).await.unwrap());
        assert_eq!(db.get_local_chat(&conversation).unwrap().unwrap().actions.len(), 1);
        let answer = json!({"answers":[{"id":"audience","selected":["亲子家庭"]}]});
        let answers = serde_json::from_value::<Vec<questions::Answer>>(answer["answers"].clone()).unwrap();
        bridge.validate(call, &answers).await.unwrap();
        if case == "cold" {
            process.kill().await.unwrap();
            drop(events);
            db.finish_local_chat(&conversation, &turn, "interrupted", None).unwrap();
            let (stored_turn, checkpoint) = db.local_chat_dsh_question_checkpoint(&conversation).unwrap().unwrap();
            assert_eq!(stored_turn, turn);
            let resumed = db.resume_local_dsh_question(&conversation, &stored_turn, &checkpoint).unwrap();
            assert_eq!(resumed.summary.turn_count, 1);
            assert_eq!(resumed.summary.status, "running");
            let (new_process, connection) = dsh::unmodified_peer().await.unwrap();
            process = new_process;
            let restored = Host::connect(&connection.base, connection.auth.as_deref()).await.unwrap();
            let args = json!({"agentId":session,"callId":call,"answer":answer});
            let (first, second) = tokio::join!(
                restored.rpc("userQuestions/answer", args.clone()),
                restored.rpc("userQuestions/answer", args),
            );
            let accepted = [first, second].into_iter().filter(|reply| matches!(reply, Ok(value) if value == true)).count();
            assert_eq!(accepted, 1);
            await_question_completion(&restored, &pending).await;
            assert_eq!(restored.rpc("userQuestions/answer", json!({"agentId":session,"callId":call,"answer":answer})).await.unwrap(), false);
            let history = restored.events(&pending).await.unwrap();
            assert!(history.iter().any(|entry| entry["event"]["type"] == "tool/result" &&
                entry["event"]["data"]["message"]["toolCallId"] == call &&
                entry["event"]["data"]["error"]["code"] == "TOOL_OUTCOME_UNKNOWN"));
            assert_eq!(history.iter().filter(|entry| entry["event"]["type"] == "user/message" &&
                entry["event"]["data"]["source"]["kind"] == "user-question-reply" &&
                entry["event"]["data"]["source"]["callId"] == call).count(), 1);
        } else if case == "live" {
            bridge.answer(call, &answers).await.unwrap();
            await_question_completion(&host, &pending).await;
        } else {
            tokio::time::timeout(Duration::from_secs(20), async {
                loop {
                    let events = host.events(&pending).await.unwrap();
                    let reply = fold_history(&events, &pending.rpc_id, pending.after).unwrap();
                    if reply.status().unwrap() == Some("done") && reply.text == "PREMATURE_OUTPUT" {
                        assert!(host.has_pending_questions(&session, &reply).await.unwrap());
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }).await.unwrap();
            let accepted = host.rpc("userQuestions/answer", json!({"agentId":session,"callId":call,"answer":answer})).await.unwrap();
            assert_eq!(accepted, true);
            await_question_completion(&host, &pending).await;
        }
        process.kill().await.unwrap();
        handshake_remove(&session);
        gateway.abort();
        assert_eq!(&*calls.lock().unwrap(), &["content-call"]);
        let actions = db.get_local_chat(&conversation).unwrap().unwrap().actions;
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].cards.len(), 1);
        println!("native question: {case} answer reached original step; one content card");
    }
}

#[test]
fn dsh_local_history_follows_only_an_answer_to_the_original_turns_question() {
    let mut events = vec![
        event(1, "turn/start", json!({"turn":1})),
        event(2, "user/message", json!({"source":{"requestId":"original"}})),
        event(3, "tool/call", json!({"name":"ask_user_question","callId":"ours"})),
        event(4, "turn/end", json!({"turn":1,"reason":{"kind":"interrupted"}})),
        event(5, "turn/start", json!({"turn":2})),
        event(6, "user/message", json!({"source":{"kind":"user-question-reply","callId":"someone-elses"}})),
        event(7, "turn/end", json!({"turn":2,"reason":{"kind":"completed"}})),
    ];
    assert_eq!(fold_history(&events, "original", -1).unwrap().target, Some(1));
    events.extend([
        event(8, "turn/start", json!({"turn":3})),
        event(9, "user/message", json!({"source":{"kind":"user-question-reply","callId":"ours"}})),
        event(10, "assistant/message", json!({"turn":3,"step":1,"message":{"content":[{"type":"text","text":"最终结果"}]}})),
        event(11, "turn/end", json!({"turn":3,"reason":{"kind":"completed"}})),
    ]);
    let reply = fold_history(&events, "original", -1).unwrap();
    assert_eq!(reply.target, Some(3));
    assert_eq!(reply.status().unwrap(), Some("done"));
    assert_eq!(reply.text, "最终结果");
}

type QuestionSocket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn open_question_events(config: &dsh::LocalConnection) -> (QuestionSocket, String) {
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
    let auth = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy()
        .build().unwrap().get(config.auth.as_deref().unwrap()).send().await.unwrap();
    assert_eq!(auth.status(), reqwest::StatusCode::SEE_OTHER);
    let cookie = auth.headers().get_all(reqwest::header::SET_COOKIE).iter()
        .filter_map(|header| header.to_str().ok()?.split(';').next())
        .filter(|cookie| cookie.starts_with("dsh-auth-")).collect::<Vec<_>>().join("; ");
    assert!(!cookie.is_empty());
    let ws = format!("{}/api/remote.mux", config.base.replacen("http://", "ws://", 1));
    let mut request = ws.into_client_request().unwrap();
    request.headers_mut().insert("cookie", cookie.parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    socket.send(Message::Text(json!({"type":"open","streamId":"questions","endpoint":"$events","payload":{"args":{}}}).to_string())).await.unwrap();
    let ready = read_question_event(&mut socket).await;
    assert_eq!(ready["type"], "ready");
    (socket, ready["clientId"].as_str().unwrap().to_owned())
}

async fn read_question_event(socket: &mut QuestionSocket) -> Value {
    use futures_util::StreamExt;
    tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            let message = socket.next().await.unwrap().unwrap();
            if !message.is_text() { continue; }
            let frame: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
            assert_ne!(frame["type"], "error");
            let value = &frame["value"];
            if value["type"] == "ready" || value["event"] == "user-questions/request" { return value.clone(); }
        }
    }).await.unwrap()
}

async fn await_question_completion(host: &Host, pending: &Pending) {
    let until = Instant::now() + Duration::from_secs(20);
    loop {
        let events = host.events(pending).await.unwrap();
        let mut final_turn = None;
        for entry in &events {
            let event = &entry["event"];
            let data = &event["data"];
            if event["type"] == "assistant/message" && data["message"]["content"].as_array().is_some_and(|blocks| {
                blocks.iter().any(|block| block["type"] == "text" && block["text"] == "FINAL_AFTER_ANSWER")
            }) {
                final_turn = data["turn"].as_i64();
            }
            if event["type"] == "turn/end" && final_turn.is_some() && final_turn == data["turn"].as_i64() {
                assert_eq!(data["reason"]["kind"], "completed");
                let reply = fold_history(&events, &pending.rpc_id, pending.after).unwrap();
                assert_eq!(reply.target, final_turn);
                assert_eq!(reply.status().unwrap(), Some("done"));
                assert_eq!(reply.text, "FINAL_AFTER_ANSWER");
                assert!(!host.has_pending_questions(&pending.session, &reply).await.unwrap());
                return;
            }
        }
        assert!(Instant::now() < until, "fixture final reply not found; end reasons: {:?}",
            events.iter().filter(|entry| entry["event"]["type"] == "turn/end").map(|entry| &entry["event"]["data"]["reason"]).collect::<Vec<_>>());
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

async fn authorize_fixture_account(platform: &str) {
    let account = |action: &'static str| async move {
        serde_json::to_value(super::super::local_chat_dsh_account(action.into(), None).await.unwrap()).unwrap()
    };
    let initial = account("status").await;
    assert_eq!(initial["state"], "notInstalled");
    let mut status = account("start").await;
    tokio::time::timeout(Duration::from_secs(45), async {
        while status["authorizeUrl"].is_null() {
            assert_eq!(status["state"], "pending", "{status:?}");
            tokio::time::sleep(Duration::from_millis(300)).await;
            status = account("status").await;
        }
    }).await.unwrap();
    assert_eq!(status["authorizeUrl"], "https://platform.deepseek.com/dsh/authorize?fixture=1");
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let approval: Value = client.get(format!("{platform}/fixture/callback")).send().await.unwrap().json().await.unwrap();
    let callback = reqwest::Url::parse(approval["url"].as_str().unwrap()).unwrap();
    assert_eq!(callback.host_str(), Some("127.0.0.1"));
    assert_eq!(callback.path(), "/oauth/callback");
    assert_eq!(client.get(callback).send().await.unwrap().status(), 302);
    assert_eq!(account("status").await["state"], "verified");
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
fn dsh_local_preparation_failure_is_terminal_only_before_prompt_checkpoint() {
    for submitted in [false, true] {
        let (db, id, turn) = cloud_chat::tests::cloud_turn_for("dsh-local");
        if submitted {
            db.set_local_chat_provider_turn(&turn, r#"{"rpc_id":"original"}"#).unwrap();
        }
        db.finish_local_chat(&id, &turn, "failed", Some("连接中断")).unwrap();
        let chat = db.get_local_chat(&id).unwrap().unwrap();
        let assistant = chat.messages.iter().find(|m| m.role == "assistant").unwrap();
        assert_eq!(assistant.dsh_terminal_error.as_deref(), (!submitted).then_some("连接中断"));
        if submitted {
            assert_eq!(db.local_chat_recovery(&id).unwrap().1, r#"{"rpc_id":"original"}"#);
        }
    }
}

#[test]
fn dsh_local_unreadable_or_incomplete_patch_is_preserved() {
    let root = tempfile::tempdir().unwrap();
    let profiles = [root.path().to_owned()];
    let patch = root.path().join("cordis.patch.yml");
    let block = preset_block("test.mjs");
    for content in [vec![0xff], format!("{PRESET_BEGIN}\n- id: user-row\n").into_bytes()] {
        std::fs::write(&patch, &content).unwrap();
        assert!(write_preset(&profiles, "test.mjs", "fixture", &block).is_err());
        assert_eq!(std::fs::read(&patch).unwrap(), content);
    }
}

#[test]
fn dsh_local_confirmed_failure_persists_on_the_original_assistant_message() {
    let (db, id, turn) = cloud_chat::tests::cloud_turn_for("dsh-local");
    let pending = Pending { version: 1, base: "http://localhost:3080".into(),
        session: session_id(&turn), rpc_id: "wanted".into(), after: -1, questions_enabled: true };
    let saved = serde_json::to_string(&pending).unwrap();
    db.set_local_chat_provider_turn(&turn, &saved).unwrap();
    let reply = Reply { reason: Some("error".into()), failure: Some(("MALFORMED_RESPONSE".into(),
        "unexpected stop reason".into())), ..Default::default() };
    let detail = reply.observed_status(&db, &turn, &pending).unwrap_err().to_string();
    assert!(detail.contains("回复格式异常") && !detail.contains("卡片工具参数"));
    db.finish_local_chat(&id, &turn, "failed", Some(&detail)).unwrap();
    let (_, checkpoint) = db.local_chat_recovery(&id).unwrap();
    assert_eq!(serde_json::from_str::<Pending>(&checkpoint).unwrap().rpc_id, "wanted");
    // A cold read of the same failed session keeps the partial text and failure distinct.
    db.restore_local_chat_reply(&id, &turn, &checkpoint, "已有正文",
        RestoredChatOutcome::DshFailed { message: &detail, code: reply.failure_code() }).unwrap();
    let chat = db.get_local_chat(&id).unwrap().unwrap();
    let assistant = chat.messages.iter().find(|m| m.role == "assistant").unwrap();
    assert_eq!(assistant.status, "failed");
    assert_eq!(assistant.text, "已有正文");
    assert_eq!(assistant.dsh_failure_code.as_deref(), Some("MALFORMED_RESPONSE"));
    assert_eq!(assistant.dsh_terminal_error.as_deref(), Some(detail.as_str()));
    assert!(chat.messages.iter().filter(|m| m.role != "assistant").all(|m| m.dsh_terminal_error.is_none()));
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
    let plugins: Vec<_> = composition.as_array().unwrap().iter().map(|row| row["id"].as_str().unwrap()).collect();
    assert_eq!(plugins, ["persona", "skill-filesystem", "tool-skill", "bowerbird-cards"]);
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
    let header = "# Your patch layer for this dsh profile, applied after every bundle layer:\n\
                  # a top-level YAML array of loader patch entries (id-targeted config\n\
                  # overrides, disables, and insert lists; `!!js` expressions allowed).\n";
    let old = preset_block_template("old.mjs", "bowerbird-chat");
    for file in [format!("{header}[]\n"), format!("{header}[]\n\n{old}")] {
        let fixed = merge_patch(&file, &block);
        assert!(fixed.starts_with(header));
        assert!(!fixed.lines().any(|line| line.trim() == "[]"));
        assert_eq!(merge_patch(&fixed, &block), fixed);
        assert_eq!(fixed.matches(PRESET_BEGIN).count(), 1);
    }
    let user_lists = "# [] belongs in this comment\n- id: keep\n  config: []\n";
    assert!(merge_patch(user_lists, &block).starts_with(user_lists));

    let user = "- id: tool-bash\n  disabled: true\n";
    let merged = merge_patch(user, &block);
    assert!(merged.starts_with(user.trim_end()));
    assert_eq!(merged.matches(PRESET_BEGIN).count(), 1);
    assert_eq!(merged.matches("- insert:").count(), 1);

    // Connecting again replaces the managed block and keeps the user's own rows.
    let again = merge_patch(&merged, &block);
    assert_eq!(again, merged);
    assert!(again.starts_with(user.trim_end()));

    let previous = preset_block("bowerbird-chat-older.mjs");
    let upgraded = merge_patch(&previous, &block);
    let previous_id = managed_preset_id(&previous).unwrap();
    assert!(upgraded.contains(&format!("- id: preset-{previous_id}")));
    assert_eq!(merge_patch(&upgraded, &block), upgraded);
    let restored = merge_patch(&upgraded, &previous);
    assert_eq!(restored.matches(&format!("        id: {previous_id}\n")).count(), 1);
}

#[test]
fn dsh_local_profile_preset_names_an_immutable_module() {
    let block = preset_block("bowerbird-chat-deadbeef0000.mjs");
    assert!(block.contains(&format!("id: {}\n", preset_id("bowerbird-chat-deadbeef0000.mjs"))));
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
    let (host, _, server) = scripted_host(json!([{"id":"standard"},{"id":current_preset_id().unwrap()}]), vec![], false).await;
    let health = inspect_host(&host).await.unwrap();
    assert!(health.live);
    assert!(health.preset);
    server.abort();

    let (host, _, server) = scripted_host(json!([{"id":"standard"},{"id":"bowerbird-chat"},{"id":"bowerbird-chat-oldversion"}]), vec![], false).await;
    let health = inspect_host(&host).await.unwrap();
    assert!(health.live);
    assert!(!health.preset);
    server.abort();
}

#[tokio::test]
async fn dsh_local_profile_upgrade_requires_the_new_id_even_on_reconnect() {
    let root = tempfile::tempdir().unwrap();
    let profiles = [root.path().to_owned()];
    let handshake = root.path().join("current.json");
    let source = preset_source(&handshake);
    let module = module_name(&source);
    let id = preset_id(&module);
    let old = preset_block_template("bowerbird-chat-old.mjs", "bowerbird-chat");
    std::fs::write(root.path().join("cordis.patch.yml"), merge_patch("- id: user-row", &old)).unwrap();
    let (stale, _, server) = scripted_host(json!([{"id":"bowerbird-chat"}]), vec![], false).await;
    for _ in 0..2 {
        assert!(matches!(
            install_profile(&stale, &profiles, &handshake).await.unwrap(),
            Install::RestartRequired
        ));
    }
    server.abort();
    let patch = std::fs::read_to_string(root.path().join("cordis.patch.yml")).unwrap();
    assert!(patch.contains("- id: user-row"));
    assert!(patch.contains(&format!("id: {id}\n")));
    assert!(preset_files_current(&profiles, &module, &source, &preset_block(&module)));
    let (updated, _, server) = scripted_host(json!([{"id":id}]), vec![], false).await;
    assert!(matches!(
        install_profile(&updated, &profiles, &handshake).await.unwrap(),
        Install::Active
    ));
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
    let (host, calls, server) = scripted_host(json!([{"id":current_preset_id().unwrap()}]), vec![], false).await;
    let _ = host
        .rpc(
            "session/create",
            json!({"request":{"sessionId":"owned","agentPreset":current_preset_id().unwrap()}}),
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
        after: -1, questions_enabled: true
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
