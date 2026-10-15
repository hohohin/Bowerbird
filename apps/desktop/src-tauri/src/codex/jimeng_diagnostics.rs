//! Read-only task diagnostics. Never submits, downloads, or changes task status.
use std::{ffi::OsString, io::{Read, Seek, SeekFrom}, path::Path, time::Duration};
use serde_json::{json, Value};
use super::jimeng::dreamina_command;

pub(crate) fn redact_text(text: &str) -> String {
    text.lines().map(|line| {
        let lower = line.to_ascii_lowercase();
        if ["authorization", "bearer ", "access_token", "refresh_token", "cookie", "password"].iter().any(|key| lower.contains(key)) {
            return "[认证信息已隐藏]".to_string();
        }
        line.split_whitespace().map(|word| if word.contains("https://") || word.contains("http://") { "[链接已隐藏]" } else { word }).collect::<Vec<_>>().join(" ")
    }).collect::<Vec<_>>().join("\n")
}

pub(crate) fn sanitize(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.iter().map(|(key, value)| {
            let lower = key.to_ascii_lowercase();
            let private = ["token", "secret", "password", "cookie", "authorization", "prompt", "url"].iter().any(|part| lower.contains(part));
            (key.clone(), if private { json!("[已隐藏]") } else { sanitize(value) })
        }).collect()),
        Value::Array(items) => Value::Array(items.iter().map(sanitize).collect()),
        Value::String(text) => {
            // queue_info.debug_info and some provider errors contain serialized JSON.
            if text.trim_start().starts_with(['{', '[']) {
                if let Ok(nested) = serde_json::from_str::<Value>(text) { return sanitize(&nested); }
            }
            json!(redact_text(text))
        }
        _ => value.clone(),
    }
}

pub(crate) async fn query(binary: &str, args: &[OsString]) -> Value {
    let command = args.first().and_then(|s| s.to_str()).unwrap_or("query");
    match tokio::time::timeout(Duration::from_secs(35), dreamina_command(binary).args(args).kill_on_drop(true).output()).await {
        Err(_) => json!({"command":command,"query_error":"查询超时，远端状态未确认"}),
        Ok(Err(error)) => json!({"command":command,"query_error":redact_text(&error.to_string())}),
        Ok(Ok(out)) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let value = stdout.find(['{', '[']).and_then(|start| serde_json::Deserializer::from_str(&stdout[start..]).into_iter::<Value>().next()).and_then(Result::ok);
            json!({"command":command,"exit_code":out.status.code(),"response":value.as_ref().map(sanitize),
                "stdout_unparsed":if value.is_none() { Some(redact_text(&stdout)) } else { None },
                "stderr":redact_text(&String::from_utf8_lossy(&out.stderr))})
        }
    }
}

fn log_evidence(root: &Path, submit_id: &str) -> Value {
    let mut files: Vec<_> = std::fs::read_dir(root).into_iter().flatten().flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("dreamina.log."))
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file())).collect();
    files.sort_by_key(|entry| std::cmp::Reverse(entry.file_name()));
    let mut entries = Vec::new();
    // Bounded tail scan; an absent entry does not imply that the remote task is absent.
    for entry in files.into_iter().take(24) {
        let Ok(mut file) = std::fs::File::open(entry.path()) else { continue };
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        let _ = file.seek(SeekFrom::Start(size.saturating_sub(512 * 1024)));
        let mut bytes = Vec::new();
        if file.take(512 * 1024).read_to_end(&mut bytes).is_err() { continue; }
        for line in String::from_utf8_lossy(&bytes).lines().rev() {
            if !line.split_whitespace().any(|word| word == format!("submit_id={submit_id}")) { continue; }
            let history = line.split_once("[QueryResult] history:").and_then(|(_, raw)| serde_json::from_str::<Value>(raw).ok());
            if let Some(value) = history {
                entries.push(json!({"file":entry.file_name().to_string_lossy(),"history":sanitize(&value)}));
            } else {
                entries.push(json!({"file":entry.file_name().to_string_lossy(),"message":redact_text(line)}));
            }
            if entries.len() >= 60 { return json!({"entries":entries,"limit_reached":true}); }
        }
    }
    json!({"entries":entries,"limit_reached":false,"scan_limit":"最近 24 个日志文件，每个末尾 512 KiB"})
}

pub(crate) async fn collect(binary: &str, submit_id: &str) -> Value {
    let query_args = ["query_result".into(), "--submit_id".into(), submit_id.into()];
    let list_args = ["list_task".into(), "--submit_id".into(), submit_id.into(), "--limit".into(), "1".into()];
    let (result, list) = tokio::join!(
        query(binary, &query_args), query(binary, &list_args)
    );
    let id = submit_id.to_string();
    let logs = tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        let root = crate::cli_credentials::root().join("dreamina/.dreamina_cli/logs");
        #[cfg(not(target_os = "windows"))]
        let root = std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_default().join(".dreamina_cli/logs");
        log_evidence(&root, &id)
    }).await.unwrap_or_else(|error| json!({"read_error":error.to_string()}));
    json!({"submit_id":submit_id,"queried_at":chrono::Utc::now().to_rfc3339(),
        "query_result":result,"list_task":list,"local_cli_logs":logs,
        "notice":"仅查询原任务。未返回具体错误码时，不能据通用失败判断尺寸、审核或余额；credit_count 不等同扣费/退款流水。提示词、链接及认证字段已隐藏。"})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "explicit read-only query of an existing user task; requires application login"]
    async fn live_existing_task_diagnostic() {
        let id = std::env::var("BOWERBIRD_DIAGNOSTIC_SUBMIT_ID").expect("explicit existing task ID required");
        let report = crate::commands::dreamina_account::dreamina_task_diagnostics(id.clone()).await.unwrap();
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
        assert_eq!(report["query_result"]["response"]["submit_id"], id);
        assert_eq!(report["query_result"]["exit_code"], 0);
        assert!(Path::new(report["saved_path"].as_str().unwrap()).is_file());
    }
    #[test]
    fn diagnostics_preserve_nested_errors_and_remove_credentials() {
        let result = sanitize(&json!({"logid":"log-123","error":{"code":42,"message":"failed"},
            "prompt":"private prompt","debug_info":"{\"status\":30,\"access_token\":\"private\"}","url":"https://example.com?signed=private"}));
        assert_eq!(result["error"]["code"],42);
        assert_eq!(result["logid"],"log-123");
        assert_eq!(result["debug_info"]["status"],30);
        assert!(!result.to_string().contains("private"));
        assert_eq!(sanitize(&json!("12345678901234567890")), json!("12345678901234567890"));
    }
    #[test]
    fn log_scan_matches_exact_task_and_keeps_history_error_fields() {
        let root = std::env::temp_dir().join(format!("bb-diagnostic-{}",ulid::Ulid::new()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("dreamina.log.test"), "Info submit_id=mine-other [QueryResult] history: {\"task\":{\"status\":50}}\nError submit_id=mine backend_code=17\nInfo submit_id=mine [QueryResult] history: {\"task\":{\"status\":30,\"error_code\":17}}\n").unwrap();
        let report=log_evidence(&root,"mine");
        assert_eq!(report["entries"].as_array().unwrap().len(),2);
        assert_eq!(report["entries"][0]["history"]["task"]["error_code"],17);
        assert!(report["entries"][1]["message"].as_str().unwrap().contains("backend_code=17"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
