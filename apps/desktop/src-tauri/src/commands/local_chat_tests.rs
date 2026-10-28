use super::*;

#[test]
fn local_chat_stream_is_scoped_deduplicates_completion_and_omits_reasoning() {
    let mut state = StreamState {
        provider_thread: Some("thread".into()),
        provider_turn: Some("turn".into()),
        ..Default::default()
    };
    for value in [
        json!({"method":"item/agentMessage/delta","params":{"threadId":"other","turnId":"turn","itemId":"a","delta":"FOREIGN"}}),
        json!({"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"old","itemId":"a","delta":"OLD"}}),
        json!({"method":"item/reasoning/textDelta","params":{"threadId":"thread","turnId":"turn","delta":"PRIVATE"}}),
        json!({"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"turn","itemId":"a","delta":"你"}}),
        json!({"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"turn","itemId":"a","delta":"好"}}),
        json!({"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"type":"agentMessage","id":"a","text":"你好。"}}}),
        json!({"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"type":"agentMessage","id":"b","text":"这是第二段回复。"}}}),
    ] {
        state.apply(&value).unwrap();
    }
    assert_eq!(state.text(), "你好。\n\n这是第二段回复。");
    assert_eq!(state.apply(&json!({"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed"}}})).unwrap(),Some("done"));
}

#[test]
fn local_chat_stream_accepts_notifications_before_start_ack_and_preserves_partial_failure() {
    let mut state = StreamState {
        provider_thread: Some("thread".into()),
        ..Default::default()
    };
    state
        .apply(
            &json!({"method":"turn/started","params":{"threadId":"thread","turn":{"id":"turn"}}}),
        )
        .unwrap();
    state.apply(&json!({"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"turn","itemId":"a","delta":"保留内容"}})).unwrap();
    assert!(state.apply(&json!({"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"failed","error":{"message":"offline fixture"}}}})).is_err());
    assert_eq!(state.text(), "保留内容");
}

#[test]
fn local_chat_rejects_permissions_and_unknown_requests_without_grants() {
    for method in [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
        "item/tool/call",
        "item/tool/requestUserInput",
        "unknown",
    ] {
        let response = rejection(&json!({"method":method,"id":37,"params":{}})).unwrap();
        assert_eq!(response["id"], 37);
        assert!(!response.to_string().contains("accept"));
        if method == "item/permissions/requestApproval" {
            assert_eq!(response["result"]["permissions"], json!({}));
        }
    }
    assert!(rejection(&json!({"method":"item/agentMessage/delta","params":{}})).is_none());
}

#[test]
fn local_chat_card_tool_binds_to_confirmed_current_turn_and_exact_tool() {
    let mut state = StreamState {
        provider_thread: Some("thread".into()),
        provider_turn: Some("turn".into()),
        start_confirmed: true,
        ..Default::default()
    };
    let valid = json!({"id":7,"method":"item/tool/call","params":{"threadId":"thread","turnId":"turn","callId":"call","namespace":null,"tool":"create_canvas_cards","arguments":{"cards":[]}}});
    let (call, args) = card_call(&valid, &state).unwrap();
    assert_eq!(call, "call");
    assert_eq!(args, &json!({"cards":[]}));
    for (field, replacement) in [
        ("threadId", json!("foreign")),
        ("turnId", json!("old")),
        ("namespace", json!("external")),
        ("tool", json!("run_workflow")),
        ("callId", json!("")),
        ("callId", json!("x".repeat(201))),
    ] {
        let mut request = valid.clone();
        request["params"][field] = replacement;
        assert!(card_call(&request, &state).is_err(), "{field}");
    }
    state.start_confirmed = false;
    assert!(
        card_call(&valid, &state).is_err(),
        "no effects before accepted start"
    );
    state.start_confirmed = true;
    state.provider_turn = None;
    assert!(card_call(&valid, &state).is_err());
}

#[test]
fn local_chat_card_tool_returns_structured_results_and_correctable_failures() {
    let request = json!({"id":"request-id"});
    let response = card_response(&request, Ok(json!({"id":"batch","status":"created"})));
    assert_eq!(response["id"], "request-id");
    assert_eq!(response["result"]["success"], true);
    assert_eq!(response["result"]["contentItems"][0]["type"], "inputText");
    let response = card_response(&request, Err(error("循环需要行来源")));
    assert_eq!(response["result"]["success"], false);
    assert_eq!(
        response["result"]["contentItems"][0]["text"],
        "循环需要行来源"
    );
    let tool = card_tool_spec();
    assert_eq!(tool["name"], "create_canvas_cards");
    assert_eq!(tool["inputSchema"]["properties"]["cards"]["maxItems"], 12);
    assert_eq!(tool["inputSchema"]["additionalProperties"], false);
}

#[test]
fn local_chat_h3_tool_contract_exposes_frames_and_local_options_without_endpoint_access() {
    assert!(
        CARD_TOOL_VERSION > 1,
        "existing card-tool threads must migrate"
    );
    let tool = card_tool_spec();
    let cards = tool["inputSchema"]["properties"]["cards"]["items"]["oneOf"]
        .as_array()
        .unwrap();
    let h3 = cards
        .iter()
        .find(|card| card["properties"]["kind"]["const"] == "comfy-video")
        .expect("H3 has its own native card kind");
    assert_eq!(h3["required"], json!(["id", "kind", "title", "prompt"]));
    assert_eq!(h3["additionalProperties"], false);
    let options = &h3["properties"];
    assert_eq!(options["seconds"]["minimum"], 1);
    assert_eq!(options["seconds"]["maximum"], 15);
    assert_eq!(options["seconds"]["default"], 8);
    assert_eq!(
        options["ratio"]["enum"],
        json!(["auto", "9:16", "16:9", "4:3", "3:4", "1:1"])
    );
    assert_eq!(options["resolution"]["enum"], json!([0.6, 0.8, 1]));
    for slot in ["firstFrameAlias", "lastFrameAlias"] {
        assert_eq!(options[slot]["pattern"], "^image[1-8]$");
    }
    assert!(options.get("endpoint").is_none());
    assert!(options.get("workflow").is_none());
    let inputs = tool["inputSchema"]["properties"]["connections"]["items"]["properties"]["input"]
        ["enum"]
        .as_array()
        .unwrap();
    assert!(inputs.contains(&json!("first-frame")));
    assert!(inputs.contains(&json!("last-frame")));
}

#[test]
fn local_chat_section_tool_contract_groups_current_batch_cards_without_geometry_access() {
    assert!(
        CARD_TOOL_VERSION > 2,
        "existing H3 tool threads must migrate to receive sections"
    );
    let tool = card_tool_spec();
    let schema = &tool["inputSchema"];
    assert_eq!(schema["required"], json!(["cards"]));
    assert_eq!(schema["properties"]["cards"]["maxItems"], 12);
    let sections = &schema["properties"]["sections"];
    assert_eq!(sections["type"], "array");
    assert_eq!(sections["maxItems"], 12);
    let section = &sections["items"];
    assert_eq!(section["required"], json!(["id", "title", "members"]));
    assert_eq!(section["additionalProperties"], false);
    let properties = section["properties"].as_object().unwrap();
    assert_eq!(properties.len(), 3);
    for key in ["id", "title", "members"] {
        assert!(properties.contains_key(key));
    }
    let members = &properties["members"];
    assert_eq!(members["minItems"], 1);
    assert_eq!(members["maxItems"], 12);
    assert_eq!(members["uniqueItems"], true);
    assert_eq!(members["items"]["type"], "string");
    let cards = schema["properties"]["cards"]["items"]["oneOf"]
        .as_array()
        .unwrap();
    assert!(cards
        .iter()
        .all(|card| card["properties"]["kind"]["const"] != "section"));
}

#[test]
fn local_chat_upgrade_preserves_public_history_without_replaying_current_request() {
    let chat: ChatConversation = serde_json::from_value(json!({
        "id":"chat","projectId":"project","threadId":"app-thread","nodeId":"node","title":"旧对话","provider":"codex-local","status":"running","turnCount":2,"preview":"","revision":1,"createdAt":1,"updatedAt":1,"error":null,"actions":[],
        "messages":[
            {"id":"user1","turnId":"old","role":"user","text":"原来的创意","referenceAssetIds":["asset"],"status":"done","createdAt":1,"updatedAt":1},
            {"id":"reply1","turnId":"old","role":"assistant","text":"原来的回复","referenceAssetIds":[],"status":"done","createdAt":1,"updatedAt":1},
            {"id":"user2","turnId":"current","role":"user","text":"CURRENT_REQUEST","referenceAssetIds":[],"status":"done","createdAt":2,"updatedAt":2}
        ]
    })).unwrap();
    let history = upgraded_history(&chat, "current");
    assert!(history.contains("原来的创意"));
    assert!(history.contains("原来的回复"));
    assert!(history.contains("\"imageCount\":1"));
    assert!(!history.contains("CURRENT_REQUEST"));
    assert!(!history.contains("asset"));
    assert!(history.contains("不构成现在再次创建卡片的授权"));
    assert!(history.contains("省略：false"));
    let mut long_chat = chat.clone();
    long_chat.messages[0].text = "长".repeat(100_001);
    let history = upgraded_history(&long_chat, "current");
    assert!(history.contains("省略：true"));
    assert!(history.contains("原来的回复"));
}

#[test]
fn local_chat_disables_each_inherited_mcp_entry_including_dotted_names() {
    let config=isolated_thread_config(&json!({"config":{"mcp_servers":{"workspace":{"command":"never-run"},"dotted.name":{"url":"https://unused.invalid"}}}})).unwrap();
    assert_eq!(config["mcp_servers"]["workspace"]["enabled"], false);
    assert_eq!(config["mcp_servers"]["dotted.name"]["enabled"], false);
    assert_eq!(config["mcp_servers"]["workspace"]["command"], "never-run");
    assert_eq!(config["skills.include_instructions"], false);
    assert_eq!(config["project_doc_max_bytes"], 0);
}

#[test]
fn local_chat_home_rejects_explicit_global_instructions_without_changing_them() {
    let root = tempfile::tempdir().unwrap();
    validate_chat_home(root.path()).unwrap();
    let file = root.path().join("AGENTS.md");
    std::fs::write(&file, "custom tool instructions").unwrap();
    assert!(validate_chat_home(root.path()).is_err());
    assert_eq!(
        std::fs::read_to_string(file).unwrap(),
        "custom tool instructions"
    );
}

#[tokio::test]
async fn local_chat_rpc_reads_real_json_lines_and_declines_server_requests() {
    let (client, server) = tokio::io::duplex(8192);
    let (mut client_read, mut client_write) = tokio::io::split(client);
    let (server_read, mut server_write) = tokio::io::split(server);
    let server = tokio::spawn(async move {
        let mut reader = BufReader::new(server_read);
        let request = read_message(&mut reader).await.unwrap();
        assert_eq!(request["method"], "initialize");
        write_message(
            &mut server_write,
            json!({"method":"notification","params":{}}),
        )
        .await
        .unwrap();
        write_message(
            &mut server_write,
            json!({"id":1,"result":{"version":"fixture"}}),
        )
        .await
        .unwrap();
        let request = read_message(&mut reader).await.unwrap();
        assert_eq!(request["method"], "thread/start");
        write_message(
            &mut server_write,
            json!({"id":"approval","method":"item/commandExecution/requestApproval","params":{}}),
        )
        .await
        .unwrap();
        let rejection = read_message(&mut reader).await.unwrap();
        assert_eq!(rejection["result"]["decision"], "decline");
    });
    let mut reader = BufReader::new(&mut client_read);
    assert_eq!(
        rpc(&mut reader, &mut client_write, 1, "initialize", json!({}))
            .await
            .unwrap()["version"],
        "fixture"
    );
    assert!(
        rpc(&mut reader, &mut client_write, 2, "thread/start", json!({}))
            .await
            .is_err()
    );
    server.await.unwrap();
}

#[tokio::test]
async fn local_chat_protocol_bounds_messages_and_handles_disconnection() {
    let oversized = vec![b'x'; MAX_RESPONSE + 1];
    assert!(read_message(&mut BufReader::new(oversized.as_slice()))
        .await
        .is_err());
    assert!(read_message(&mut BufReader::new(b"".as_slice()))
        .await
        .is_err());
    assert!(
        read_message(&mut BufReader::new(b"broken json\n".as_slice()))
            .await
            .is_err()
    );
}

#[test]
fn local_chat_launch_has_private_credentials_read_only_policy_and_no_operating_tools() {
    let root = std::env::temp_dir();
    let cmd = command("codex-fixture", &root);
    let args = cmd
        .as_std()
        .get_args()
        .map(|s| s.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert!(args.contains(&"app-server".into()));
    assert!(args.contains(&"approval_policy=\"never\"".into()));
    assert!(args.contains(&"sandbox_mode=\"read-only\"".into()));
    assert!(args.contains(&"features.shell_tool=false".into()));
    assert!(args.contains(&"features.plugins=false".into()));
    assert!(args.contains(&"features.multi_agent=false".into()));
    assert!(args.contains(&"features.code_mode_host=true".into()));
    assert!(args.contains(&"features.code_mode=false".into()));
    assert!(args.contains(&"agents.enabled=false".into()));
    let environment = cmd.as_std().get_envs().collect::<HashMap<_, _>>();
    assert_eq!(
        environment[std::ffi::OsStr::new("CODEX_HOME")],
        Some(crate::cli_credentials::codex_home().as_os_str())
    );
    assert_eq!(environment[std::ffi::OsStr::new("OPENAI_API_KEY")], None);
}

#[test]
fn local_chat_code_mode_transport_does_not_enable_operating_tools_on_start_or_resume() {
    let config = isolated_thread_config(
        &json!({"config":{"mcp_servers":{"configured":{"command":"never-run"}}}}),
    )
    .unwrap();
    assert_eq!(config["features.code_mode_host"], true);
    assert_eq!(
        config["agents.enabled"], false,
        "code-mode collaboration has an independent switch"
    );
    assert_eq!(
        config["features.code_mode"], false,
        "model metadata selects the transport"
    );
    for feature in [
        "shell_tool",
        "unified_exec",
        "apps",
        "plugins",
        "multi_agent",
        "browser_use",
        "computer_use",
        "image_generation",
        "workspace_dependencies",
        "request_permissions_tool",
    ] {
        assert_eq!(config[format!("features.{feature}")], false, "{feature}");
    }
    assert_eq!(config["mcp_servers"]["configured"]["enabled"], false);
    assert_eq!(config["web_search"], "disabled");
}

#[test]
fn local_chat_attachment_validation_uses_registered_images_and_rejects_other_files() {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open_in_memory().unwrap();
    db.migrate().unwrap();
    let path = root.path().join("image.png");
    image::RgbImage::new(2, 2).save(&path).unwrap();
    let wrong = root.path().join("pretend.png");
    std::fs::write(&wrong, b"not an image").unwrap();
    for (id, path) in [("image", path), ("wrong", wrong)] {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO assets(id,name,store_path,created_at) VALUES(?1,?1,?2,1)",
                rusqlite::params![id, path.to_string_lossy()],
            )
            .unwrap();
    }
    assert_eq!(reference_paths(&db, &["image".into()]).unwrap().len(), 1);
    assert!(reference_paths(&db, &["image".into(), "image".into()]).is_err());
    assert!(reference_paths(&db, &["missing".into()]).is_err());
    assert!(reference_paths(&db, &["wrong".into()]).is_err());
}

#[tokio::test]
#[ignore = "requires explicitly supplied managed CLI path; isolated fresh home, no credentials or model turn"]
async fn local_chat_managed_cli_handshake_and_effective_config() {
    let binary = std::env::var("BOWERBIRD_CHAT_PROTOCOL_BINARY")
        .expect("supply managed CLI path explicitly");
    let root = tempfile::tempdir().unwrap();
    let mut command = tokio::process::Command::new(binary);
    command
        .current_dir(root.path())
        .env("CODEX_HOME", root.path())
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY")
        .env_remove("OPENAI_BASE_URL")
        .env_remove("CODEX_AUTH_JSON")
        .args([
            "app-server",
            "--listen",
            "stdio://",
            "-c",
            "approval_policy=\"never\"",
            "-c",
            "sandbox_mode=\"read-only\"",
        ]);
    for (key, value) in chat_config().as_object().unwrap() {
        command.arg("-c").arg(format!("{key}={value}"));
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().unwrap();
    let mut writer = child.stdin.take().unwrap();
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    let result=tokio::time::timeout(Duration::from_secs(20),async {
        rpc(&mut reader,&mut writer,1,"initialize",json!({"clientInfo":{"name":"bowerbird_offline_probe","version":"1.0"},"capabilities":{"experimentalApi":true}})).await?;
        write_message(&mut writer,json!({"method":"initialized","params":{}})).await?;
        let response=rpc(&mut reader,&mut writer,2,"config/read",json!({"includeLayers":false})).await?;
        assert_eq!(response["config"]["approval_policy"],"never");assert_eq!(response["config"]["sandbox_mode"],"read-only");
        assert_eq!(response["config"]["features"]["shell_tool"],false);assert_eq!(response["config"]["features"]["plugins"],false);
        Ok::<_,AppError>(())
    }).await;
    let _ = child.kill().await;
    let _ = child.wait().await;
    result.unwrap().unwrap();
}
