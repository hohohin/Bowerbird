use super::*;

fn model(name: &str, default: bool) -> Value {
    json!({"id":format!("id-{name}"),"model":name,"displayName":name,"isDefault":default,
        "defaultReasoningEffort":"medium","supportedReasoningEfforts":[
            {"reasoningEffort":"medium","description":"balanced"},
            {"reasoningEffort":"high","description":"thorough"}]})
}

#[tokio::test]
async fn local_chat_models_pages_and_sends_selected_options_on_start_resume_and_turn() {
    let (client, server) = tokio::io::duplex(16000);
    let (read, mut write) = tokio::io::split(client);
    let mut read = BufReader::new(read);
    let server = tokio::spawn(async move {
        let (read, mut write) = tokio::io::split(server);
        let mut read = BufReader::new(read);
        for page in 0..2 {
            let request = read_message(&mut read).await.unwrap();
            assert_eq!(request["method"], "model/list");
            assert_eq!(request["params"]["includeHidden"], false);
            assert_eq!(
                request["params"]["cursor"],
                if page == 0 {
                    Value::Null
                } else {
                    json!("next")
                }
            );
            write_message(&mut write, json!({"id":request["id"],"result":{"data":[model(if page == 0 {"first"} else {"second"}, page == 0)],"nextCursor":if page == 0 {json!("next")} else {Value::Null}}})).await.unwrap();
        }
        for method in ["thread/start", "thread/resume", "turn/start"] {
            let request = read_message(&mut read).await.unwrap();
            assert_eq!(request["method"], method);
            assert_eq!(request["params"]["model"], "second");
            if method == "turn/start" {
                assert_eq!(request["params"]["effort"], "high");
            } else {
                assert_eq!(
                    request["params"]["config"]["model_reasoning_effort"],
                    "high"
                );
                assert_eq!(request["params"]["approvalPolicy"], "never");
                assert_eq!(request["params"]["sandbox"], "read-only");
            }
            write_message(&mut write, json!({"id":request["id"],"result":{}}))
                .await
                .unwrap();
        }
    });
    let models = catalog(&mut read, &mut write).await.unwrap();
    assert_eq!(models.len(), 2);
    let options = resolve(
        &ChatCodexOptions {
            model: Some("second".into()),
            reasoning_effort: Some("high".into()),
        },
        &models,
    )
    .unwrap();
    for (index, method) in ["thread/start", "thread/resume", "turn/start"]
        .into_iter()
        .enumerate()
    {
        let mut params = json!({"config":{},"approvalPolicy":"never","sandbox":"read-only"});
        if method == "turn/start" {
            apply_turn(&mut params, &options);
        } else {
            apply_thread(&mut params, &options);
        }
        rpc(&mut read, &mut write, index as u32, method, params)
            .await
            .unwrap();
    }
    server.await.unwrap();
}

#[test]
fn local_chat_models_default_reset_and_model_changes_use_catalog_not_previous_effort() {
    let models: Vec<CodexChatModel> = serde_json::from_value(json!([
        model("current-default", true),
        model("other", false)
    ]))
    .unwrap();
    let defaults = ChatCodexOptions {
        model: None,
        reasoning_effort: None,
    };
    assert_eq!(
        resolve(&defaults, &models).unwrap(),
        ChatCodexOptions {
            model: Some("current-default".into()),
            reasoning_effort: Some("medium".into())
        }
    );
    assert_eq!(
        resolve(
            &ChatCodexOptions {
                model: Some("other".into()),
                reasoning_effort: None
            },
            &models
        )
        .unwrap()
        .reasoning_effort
        .as_deref(),
        Some("medium")
    );
    assert!(resolve(
        &ChatCodexOptions {
            model: Some("id-other".into()),
            reasoning_effort: None
        },
        &models
    )
    .is_err());
    assert!(resolve(
        &ChatCodexOptions {
            model: None,
            reasoning_effort: Some("unavailable".into())
        },
        &models
    )
    .is_err());
}

#[tokio::test]
async fn local_chat_models_rejects_repeated_pagination_instead_of_partial_catalog() {
    let response = json!({"data":[model("only",true)],"nextCursor":"same"});
    let bytes = format!(
        "{}\n{}\n",
        json!({"id":100,"result":response}),
        json!({"id":101,"result":response})
    );
    let mut reader = BufReader::new(bytes.as_bytes());
    assert!(catalog(&mut reader, &mut Vec::new())
        .await
        .unwrap_err()
        .to_string()
        .contains("分页重复"));
}
