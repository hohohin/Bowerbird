use crate::{
    db::Database,
    error::{AppError, AppResult},
};
use rusqlite::params;
use serde_json::{json, Value};

pub async fn track_attempt<T>(
    db: &Database,
    attempt: &str,
    job_id: &str,
    work: impl std::future::Future<Output = AppResult<T>>,
) -> AppResult<T> {
    let result = work.await;
    let error = result.as_ref().err().map(ToString::to_string);
    // Do not turn a completed, possibly paid generation into a retryable logging error.
    if let Err(log_error) = db.finish_generation_diagnostic(attempt, job_id, error.as_deref()) {
        tracing::error!(job_id, "生成诊断收尾写入失败: {log_error}");
    }
    result
}

impl Database {
    pub fn begin_generation_diagnostic(&self, request: &Value) -> AppResult<String> {
        let job_id = request["jobId"]
            .as_str()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| AppError::Other("生成诊断缺少会话 ID".into()))?;
        let attempt = ulid::Ulid::new().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        self.conn.lock().unwrap().execute(
            "INSERT INTO generation_diagnostics(attempt_id,job_id,turn_key,request_json,phase,status,created_at,updated_at) VALUES(?1,?2,?3,?4,'ipc','received',?5,?5)",
            params![attempt, job_id, request["turnKey"].as_str(), request.to_string(), now])?;
        Ok(attempt)
    }

    pub fn generation_diagnostic_phase(
        &self,
        attempt: &str,
        job_id: &str,
        phase: &str,
        references: Option<&[String]>,
    ) -> AppResult<()> {
        let refs = references.map(|paths| Value::Array(paths.iter().map(|path| {
            let file = std::path::Path::new(path);
            json!({"path":path,"extension":file.extension().and_then(|ext|ext.to_str()),"exists":file.is_file()})
        }).collect()).to_string());
        let changed = self.conn.lock().unwrap().execute(
            "UPDATE generation_diagnostics SET phase=?3,status='running',resolved_references_json=COALESCE(?4,resolved_references_json),updated_at=?5 WHERE attempt_id=?1 AND job_id=?2 AND status IN ('received','running')",
            params![attempt, job_id, phase, refs, chrono::Utc::now().timestamp_millis()])?;
        if changed != 1 {
            return Err(AppError::Other(
                "生成诊断记录不存在、已结束或会话 ID 不匹配".into(),
            ));
        }
        Ok(())
    }

    pub fn finish_generation_diagnostic(
        &self,
        attempt: &str,
        job_id: &str,
        error: Option<&str>,
    ) -> AppResult<()> {
        // A late IPC response must not overwrite a terminal outcome already recorded by native code.
        self.conn.lock().unwrap().execute(
            "UPDATE generation_diagnostics SET status=?3,error=?4,updated_at=?5 WHERE attempt_id=?1 AND job_id=?2 AND status IN ('received','running')",
            params![attempt, job_id, if error.is_some() {"failed"} else {"done"}, error, chrono::Utc::now().timestamp_millis()])?;
        Ok(())
    }

    pub fn generation_diagnostics(&self, job_id: &str) -> AppResult<Vec<Value>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT attempt_id,turn_key,request_json,resolved_references_json,phase,status,error,created_at,updated_at FROM generation_diagnostics WHERE job_id=?1 ORDER BY rowid")?;
        let rows = stmt.query_map([job_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, i64>(8)?,
            ))
        })?;
        rows.map(|row| {
            let (id,turn,request,refs,phase,status,error,created,updated)=row?;
            Ok(json!({"attemptId":id,"jobId":job_id,"turnKey":turn,"request":serde_json::from_str::<Value>(&request)?,
                "resolvedReferences":refs.map(|v|serde_json::from_str::<Value>(&v)).transpose()?,
                "phase":phase,"status":status,"error":error,"createdAt":created,"updatedAt":updated}))
        }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejected_request_survives_reopen_without_becoming_a_runnable_task() {
        let dir = std::env::temp_dir().join(format!(
            "bowerbird-generation-diagnostics-{}",
            ulid::Ulid::new()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("library.db");
        let db = Database::open(&path).unwrap();
        db.migrate().unwrap();
        let request = json!({"jobId":"failed-before-task","turnKey":"first","media":"image","referenceImages":["frame.png","product.png"]});
        let id = db.begin_generation_diagnostic(&request).unwrap();
        db.generation_diagnostic_phase(
            &id,
            "failed-before-task",
            "preflight",
            Some(&["frame.png".into(), "product.png".into()]),
        )
        .unwrap();
        db.finish_generation_diagnostic(&id, "failed-before-task", Some("preflight rejected"))
            .unwrap();
        drop(db);
        let db = Database::open(&path).unwrap();
        let report = db.generation_diagnostics("failed-before-task").unwrap();
        assert_eq!(report[0]["error"], "preflight rejected");
        assert_eq!(report[0]["phase"], "preflight");
        assert_eq!(report[0]["request"], request);
        assert_eq!(report[0]["resolvedReferences"][0]["extension"], "png");
        assert!(
            crate::core::task_queue::Task::by_id(&db, "failed-before-task")
                .unwrap()
                .is_none()
        );
        drop(db);
        std::fs::remove_dir_all(&dir).unwrap();
    }
    #[tokio::test]
    async fn early_return_is_recorded_without_a_frontend_or_task_row() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        let id = db
            .begin_generation_diagnostic(&json!({"jobId":"early"}))
            .unwrap();
        let result: AppResult<()> = track_attempt(&db, &id, "early", async {
            db.generation_diagnostic_phase(&id, "early", "reference_resolution", None)?;
            Err(AppError::NotFound("reference image".into()))?;
            Ok(())
        })
        .await;
        assert!(result.is_err());
        let rows = db.generation_diagnostics("early").unwrap();
        assert_eq!(rows[0]["phase"], "reference_resolution");
        assert_eq!(rows[0]["error"], "not found: reference image");
        assert_eq!(rows[0]["status"], "failed");
    }
    #[test]
    fn attempts_keep_distinct_errors_and_ipc_cannot_overwrite_native_outcome() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        let first = db
            .begin_generation_diagnostic(&json!({"jobId":"same","turnKey":"one"}))
            .unwrap();
        db.finish_generation_diagnostic(&first, "same", Some("first failure"))
            .unwrap();
        db.finish_generation_diagnostic(&first, "same", None)
            .unwrap();
        let next = db
            .begin_generation_diagnostic(&json!({"jobId":"same","turnKey":"two"}))
            .unwrap();
        assert!(db
            .generation_diagnostic_phase(&next, "other", "provider", None)
            .is_err());
        db.generation_diagnostic_phase(&next, "same", "provider", None)
            .unwrap();
        db.finish_generation_diagnostic(&next, "same", None)
            .unwrap();
        let rows = db.generation_diagnostics("same").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["error"], "first failure");
        assert_eq!(rows[1]["status"], "done");
        assert!(db.generation_diagnostics("missing").unwrap().is_empty());
    }
}
