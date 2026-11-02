//! Short-lived capture controls; only the main webview may cancel a capture.
use crate::error::{AppError, AppResult};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, atomic::{AtomicU8, Ordering}};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Webview};

type Registry = Mutex<HashMap<String, Arc<AtomicU8>>>;
fn registry() -> &'static Registry {
    static JOBS: OnceLock<Registry> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) struct CaptureControl {
    id: Option<String>,
    app: Option<AppHandle>,
    // 0: downloading, 1: cancelled, 2: committing. Saving is not interruptible.
    state: Arc<AtomicU8>,
    deadline: Instant,
}

impl CaptureControl {
    pub(crate) fn begin(app: AppHandle, id: Option<String>) -> AppResult<Self> {
        Self::register(Some(app), id)
    }

    fn register(app: Option<AppHandle>, id: Option<String>) -> AppResult<Self> {
        let state = Arc::new(AtomicU8::new(0));
        if let Some(id) = &id {
            if id.is_empty() || id.len() > 80 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
                return Err(AppError::Other("采集任务标识无效，请重新拖入".into()));
            }
            let mut jobs = registry().lock().unwrap();
            if jobs.contains_key(id) { return Err(AppError::Other("该素材正在采集，请稍候".into())); }
            jobs.insert(id.clone(), state.clone());
        }
        Ok(Self { id, app, state, deadline: Instant::now() + Duration::from_secs(300) })
    }

    pub(crate) fn detached() -> Self { Self::register(None, None).unwrap() }

    pub(crate) fn check(&self) -> AppResult<()> {
        if self.state.load(Ordering::SeqCst) == 1 { return Err(AppError::Other("采集已取消".into())); }
        if Instant::now() >= self.deadline { return Err(AppError::Other("采集超时，请重试".into())); }
        Ok(())
    }

    pub(crate) fn start_saving(&self) -> AppResult<()> {
        self.check()?;
        self.state.compare_exchange(0, 2, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| AppError::Other("采集已取消".into()))?;
        self.report("saving", 0, None, None, None);
        Ok(())
    }

    pub(crate) fn report(&self, phase: &str, received_bytes: u64, total_bytes: Option<u64>, completed_segments: Option<u32>, total_segments: Option<u32>) {
        if self.state.load(Ordering::SeqCst) == 1 { return; }
        if let (Some(app), Some(id)) = (&self.app, &self.id) {
            let _ = app.emit_to("main", "source-browser://capture-progress", serde_json::json!({
                "captureId": id, "phase": phase, "receivedBytes": received_bytes,
                "totalBytes": total_bytes, "completedSegments": completed_segments, "totalSegments": total_segments,
            }));
        }
    }
}

impl Drop for CaptureControl {
    fn drop(&mut self) {
        if let Some(id) = &self.id { registry().lock().unwrap().remove(id); }
    }
}

fn cancel(id: &str) -> bool {
    registry().lock().unwrap().get(id).is_some_and(|state| {
        state.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst).is_ok()
    })
}

#[tauri::command]
pub fn cancel_source_browser_capture(webview: Webview, capture_id: String) -> AppResult<bool> {
    if webview.label() != "main" { return Err(AppError::Other("只允许主窗口取消采集".into())); }
    Ok(cancel(&capture_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn job() -> (String, CaptureControl) {
        let id = ulid::Ulid::new().to_string();
        let job = CaptureControl::register(None, Some(id.clone())).unwrap();
        (id, job)
    }
    #[test]
    fn cancel_stops_download_and_prevents_saving() {
        let (id, control) = job();
        assert!(cancel(&id));
        assert!(control.check().is_err());
        assert!(control.start_saving().is_err());
    }
    #[test]
    fn committing_cannot_be_reported_as_cancelled() {
        let (id, control) = job();
        control.start_saving().unwrap();
        assert!(!cancel(&id));
        assert!(control.check().is_ok());
    }
    #[test]
    fn completion_releases_registration_and_duplicates_do_not_replace_it() {
        let (id, control) = job();
        assert!(CaptureControl::register(None, Some(id.clone())).is_err());
        assert!(cancel(&id));
        assert!(control.check().is_err());
        drop(control);
        assert!(!cancel(&id));
        let next = CaptureControl::register(None, Some(id)).unwrap();
        assert!(next.check().is_ok());
    }
}
