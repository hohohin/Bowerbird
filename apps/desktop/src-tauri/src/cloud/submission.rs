//! Durable request identity only. Never store request bodies, credentials or signed URLs.
use std::{io::Write, path::PathBuf};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use crate::error::AppError;

pub(crate) fn metadata(request: &reqwest::Request, request_id: &str, owner: &str) -> Option<Value> {
    if request.method() != reqwest::Method::POST { return None; }
    let body: Value = serde_json::from_slice(request.body()?.as_bytes()?).ok()?;
    if body.get("action").and_then(Value::as_str).is_some_and(|action| action != "create") { return None; }
    let key = body.get("idempotencyKey").or_else(|| body.get("idempotency_key"))?.as_str()?;
    if key.is_empty() || key.len() > 200 { return None; }
    Some(json!({ "schemaVersion": 1, "requestId": request_id,
        "accountHash": format!("{:x}", Sha256::digest(owner.as_bytes())),
        "function": request.url().path().rsplit('/').next()?, "idempotencyKey": key,
        "bodyHash": format!("{:x}", Sha256::digest(request.body()?.as_bytes()?)),
        "version": env!("CARGO_PKG_VERSION"), "startedAt": chrono::Utc::now().to_rfc3339(),
        "state": "submission_started" }))
}

pub(crate) fn persist(root: &std::path::Path, record: &Value) -> Result<PathBuf, AppError> {
    let dir = root.join("diagnostics").join("cloud-submissions");
    let result = (|| -> std::io::Result<PathBuf> {
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{}.json", record["requestId"].as_str().unwrap()));
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
        file.write_all(serde_json::to_string(record).unwrap().as_bytes())?;
        file.sync_all()?;
        Ok(path)
    })();
    result.map_err(|_| AppError::Cloud("云请求身份未能保存，本次尚未提交，请检查本机磁盘空间和权限".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_survives_restart_without_payload_or_credentials() {
        let request = reqwest::Client::new().post("https://bowerbird.cn/api/cloud/functions/v1/agent-run")
            .bearer_auth("private-token").json(&json!({"action":"create", "idempotencyKey":"original-key", "goal":"private prompt"})).build().unwrap();
        let record = metadata(&request, "01ARZ3NDEKTSV4RRFFQ69G5FAV", "private-user").unwrap();
        let root = tempfile::tempdir().unwrap();
        let path = persist(root.path(), &record).unwrap();
        let saved = std::fs::read_to_string(path).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&saved).unwrap()["idempotencyKey"], "original-key");
        for secret in ["private-token", "private prompt", "private-user", "https://"] { assert!(!saved.contains(secret)); }
        assert!(persist(root.path(), &record).is_err(), "never overwrite an earlier submission identity");
    }
}
