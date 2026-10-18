//! A single speculative drag shares the classifier gate with normal scans.
//! Only the main-webview capture can bind it to an asset and commit its result.
use super::{jev, pipeline::PendingClassification, LocalClassifier, Status};
use crate::{core::{paths::LibraryPaths, settings::{AppSettings, SettingsState}}, db::Database};
use std::sync::{Arc, Mutex};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, watch, OwnedMutexGuard};
use base64::Engine;

type ImageResult = Option<Result<Arc<Vec<u8>>, String>>;
type AnalysisResult = Option<Result<PendingClassification, String>>;

struct Preview {
    id: String,
    image_url: String,
    page_url: String,
    claimed: bool,
    asset: Option<String>,
    bytes: watch::Receiver<ImageResult>,
    result: watch::Receiver<AnalysisResult>,
    task: tauri::async_runtime::JoinHandle<()>,
    classifier: Arc<LocalClassifier>,
    lease: oneshot::Receiver<Result<ClassificationLease, String>>,
}

impl Drop for Preview {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct ClassificationLease {
    classifier: Arc<LocalClassifier>,
    _gate: OwnedMutexGuard<()>,
}

impl Drop for ClassificationLease {
    fn drop(&mut self) {
        self.classifier.cancel();
        let mut status = self.classifier.status.lock().unwrap();
        status.busy = false;
        status.current_asset = None;
        if status.phase != "error" {
            status.phase = "idle".into();
            status.message.clear();
        }
    }
}

// A queued drag must neither cancel nor overwrite the status of the current
// classifier. Only the lease owner changes global cancellation/status.
struct ForegroundRequest(Arc<LocalClassifier>);
impl ForegroundRequest {
    fn new(classifier: Arc<LocalClassifier>) -> Self {
        classifier.foreground_requests.fetch_add(1, Ordering::Relaxed);
        Self(classifier)
    }
}
impl Drop for ForegroundRequest {
    fn drop(&mut self) { self.0.foreground_requests.fetch_sub(1, Ordering::Relaxed); }
}

async fn wait_for_turn(classifier: Arc<LocalClassifier>, allowed: impl Fn() -> bool) -> Result<ClassificationLease, String> {
    let lock = classifier.gate.clone().lock_owned();
    tokio::pin!(lock);
    let deadline = tokio::time::sleep(Duration::from_secs(180));
    tokio::pin!(deadline);
    loop {
        if !allowed() { return Err("自动处理已关闭或分类配置已更改".into()); }
        tokio::select! {
            gate = &mut lock => {
                if !allowed() { return Err("自动处理已关闭或分类配置已更改".into()); }
                classifier.cancel.store(false, Ordering::Relaxed);
                return Ok(ClassificationLease { classifier, _gate: gate });
            },
            _ = tokio::time::sleep(Duration::from_millis(100)) => {},
            _ = &mut deadline => return Err("等待分类任务超时，图片已保留，请稍后重试".into()),
        }
    }
}

#[derive(Default)]
pub struct ExplorerAnalysis(Mutex<Option<Preview>>);

pub fn handle_notice(app: &AppHandle, start: bool, notice: crate::commands::source_browser::DragNotice) {
    if start {
        if let (Some(image), Some(page)) = (notice.image_url, notice.page_url) {
            let _ = app.state::<ExplorerAnalysis>().begin(app, notice.id, image, page);
        }
    } else {
        // Native dragend and main-webview drop IPC can arrive in either order.
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            app.state::<ExplorerAnalysis>().end(&notice.id);
        });
    }
}

fn classification_key(settings: &AppSettings, automatic: bool) -> Result<String, String> {
    if !automatic { return Err("自动处理新素材已关闭".into()); }
    if !settings.jev_image_classification_enabled {
        return Err("请先在自动分类中应用 Jev 云端分类".into());
    }
    settings.jev_api_key.clone().filter(|key| !key.trim().is_empty())
        .ok_or_else(|| "请先在自动分类中保存 Jev API Key".into())
}

fn enabled(app: &AppHandle) -> Result<String, String> {
    let automatic = app.state::<Arc<Database>>().local_enabled().map_err(|e| e.to_string())?;
    classification_key(&app.state::<SettingsState>().get(), automatic)
}

async fn receive<T: Clone>(rx: &mut watch::Receiver<Option<Result<T, String>>>) -> Result<T, String> {
    loop {
        if let Some(result) = rx.borrow().clone() { return result; }
        rx.changed().await.map_err(|_| "预分析已结束".to_string())?;
    }
}

impl ExplorerAnalysis {
    pub fn begin(&self, app: &AppHandle, id: String, image_url: String, page_url: String) -> Result<(), String> {
        let db = app.state::<Arc<Database>>().inner().clone();
        let key = enabled(app)?;
        let mut slot = self.0.lock().unwrap();
        if slot.as_ref().is_some_and(|p| p.id == id) { return Ok(()); }
        if slot.as_ref().is_some_and(|p| p.claimed) { return Err("分类任务忙，请稍后重试".into()); }
        // A newer real drag replaces an abandoned, unclaimed preview.
        slot.take();
        let classifier = app.state::<Arc<LocalClassifier>>().inner().clone();
        let browser = app.get_webview("source-discovery").ok_or_else(|| "探索浏览器尚未打开".to_string())?;
        let page = tauri::Url::parse(&page_url).map_err(|_| "来源页面地址无效".to_string())?;
        if browser.url().ok().is_none_or(|url| url.origin() != page.origin()) {
            return Err("来源页面已切换，请重新拖入图片".into());
        }
        let library = app.state::<Arc<LibraryPaths>>().inner().clone();
        let (bytes_tx, bytes_rx) = watch::channel(None);
        let (result_tx, result_rx) = watch::channel(None);
        let (lease_tx, lease_rx) = oneshot::channel();
        let demand = ForegroundRequest::new(classifier.clone());
        let worker = classifier.clone();
        let source = image_url.clone();
        let preview_app = app.clone();
        let preview_id = id.clone();
        let task = tauri::async_runtime::spawn(async move {
            let mut demand = Some(demand);
            let mut lease_tx = Some(lease_tx);
            let result = async {
                let bytes = crate::commands::source_browser_network::browser_bytes(&browser, &source)
                    .await.map(Arc::new).map_err(|e| e.to_string());
                let _ = bytes_tx.send(Some(bytes.clone()));
                let bytes = bytes?;
                let image = tokio::task::spawn_blocking(move || jev::preview_image(&bytes))
                    .await.map_err(|e| e.to_string())??;
                // Only the trusted main view receives thumbnails and library labels.
                // Never inject private label names into a third-party source page.
                {
                    let _ = preview_app.emit_to(tauri::EventTarget::webview("main"), "source-browser://drag-preview", serde_json::json!({
                        "id": preview_id, "thumbnail": format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(&image)),
                    }));
                }
                let lease = wait_for_turn(worker.clone(), || enabled(&preview_app).is_ok()).await?;
                worker.update(&preview_app, |s| *s = Status {
                    busy: true, phase: "classifying".into(), model: jev::OBSERVATION_MODEL.into(),
                    message: "正在预分析探索图片…".into(), ..Status::default()
                });
                lease_tx.take().unwrap().send(Ok(lease)).map_err(|_| "采集已取消".to_string())?;
                drop(demand.take());
                let revision = db.local_revision().map_err(|e| e.to_string())?;
                let labels: Vec<_> = db.local_labels().map_err(|e| e.to_string())?
                    .into_iter().filter(|l| l.enabled).collect();
                let pending = worker.prepare_jev_image(&jev::Judge::new(key)?, &db, &library, "", revision, &labels, true, image).await?;
                if !worker.cancel.load(Ordering::Relaxed) && enabled(&preview_app).is_ok() {
                    let _ = preview_app.emit_to(tauri::EventTarget::webview("main"), "source-browser://drag-preview", serde_json::json!({
                        "id": preview_id, "labels": pending.preview,
                    }));
                }
                Ok(pending)
            }.await;
            if let Some(sender) = lease_tx {
                let _ = sender.send(Err(result.as_ref().err().cloned().unwrap_or_else(|| "预分析已结束".into())));
            }
            let _ = result_tx.send(Some(result));
        });
        *slot = Some(Preview { id: id.clone(), image_url, page_url, claimed: false, asset: None,
            bytes: bytes_rx, result: result_rx, task, classifier, lease: lease_rx });
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(180)).await;
            app.state::<ExplorerAnalysis>().release(&id);
        });
        Ok(())
    }

    pub fn claim(&self, id: &str, image: &str, page: &str) -> bool {
        let mut slot = self.0.lock().unwrap();
        let Some(p) = slot.as_mut().filter(|p| p.id == id && p.image_url == image && p.page_url == page) else { return false; };
        p.claimed = true;
        true
    }

    pub fn release(&self, id: &str) {
        let mut slot = self.0.lock().unwrap();
        if slot.as_ref().is_some_and(|p| p.id == id) { slot.take(); }
    }

    pub fn end(&self, id: &str) {
        let mut slot = self.0.lock().unwrap();
        if slot.as_ref().is_some_and(|p| p.id == id && !p.claimed) { slot.take(); }
    }

    pub async fn bytes(&self, id: &str, image: &str, page: &str) -> Result<Option<Arc<Vec<u8>>>, String> {
        let value = {
            let slot = self.0.lock().unwrap();
            slot.as_ref().filter(|p| p.id == id && p.claimed && p.image_url == image && p.page_url == page)
                .map(|p| p.bytes.clone())
        };
        let Some(mut rx) = value else { return Ok(None); };
        receive(&mut rx).await.map(Some)
    }

    pub fn bind(&self, id: &str, asset: &str) {
        if let Some(p) = self.0.lock().unwrap().as_mut().filter(|p| p.id == id && p.claimed) {
            p.asset = Some(asset.into());
        }
    }

    pub async fn finish(&self, app: &AppHandle, id: &str, asset: &str) -> Result<Vec<String>, String> {
        let preview = {
            let mut slot = self.0.lock().unwrap();
            if slot.as_ref().is_some_and(|p| p.id == id && p.asset.as_deref() == Some(asset)) { slot.take() } else { None }
        };
        let Some(mut preview) = preview else { return Err("预分析已失效，图片已保留".into()); };
        let _lease = (&mut preview.lease).await.map_err(|_| "预分析已结束，图片已保留".to_string())??;
        let db = app.state::<Arc<Database>>();
        enabled(app)?;
        let result: Result<Vec<String>, String> = async {
            let mut pending = receive(&mut preview.result).await?;
            enabled(app)?;
            if preview.classifier.cancel.load(Ordering::Relaxed) { return Err("已停止分类".into()); }
            pending.id = asset.into();
            let cloud = crate::codex::understand::CloudUnderstandProvider::new(
                app.state::<crate::cloud::CloudClient>().inner().clone(),
                app.state::<crate::cloud::AuthClient>().inner().clone(),
            );
            preview.classifier.finish_jev(&db, Some(&cloud), pending).await?;
            let tags = db.list_asset_tags(asset).map_err(|e| e.to_string())?
                .into_iter().map(|t| t.name).collect();
            let _ = app.emit("library://assets-changed", ());
            Ok(tags)
        }.await;
        if let Err(error) = &result {
            // Mirror the automatic scan's failure policy: do not silently submit
            // another paid request for this still-pending asset every 15 seconds.
            if !preview.classifier.cancel.load(Ordering::Relaxed) && enabled(app).is_ok() {
                let _ = db.set_local_enabled(false);
                preview.classifier.update(app, |s| {
                    s.phase = "error".into(); s.last_error = error.clone();
                    s.message = format!("{error}；图片已保留，自动处理已暂停");
                });
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn busy_classifier_queues_drag_then_transfers_exclusive_ownership() {
        let classifier = Arc::new(LocalClassifier::new(std::path::PathBuf::new()));
        classifier.background.store(true, Ordering::Relaxed);
        let background = classifier.gate.clone().lock_owned().await;
        let request = ForegroundRequest::new(classifier.clone());
        assert!(classifier.should_yield());
        let turn = wait_for_turn(classifier.clone(), || true);
        tokio::pin!(turn);
        tokio::select! {
            _ = &mut turn => panic!("must queue behind the active scan"),
            _ = tokio::time::sleep(Duration::from_millis(10)) => {},
        }
        assert!(!classifier.cancel.load(Ordering::Relaxed), "queueing must not cancel active API requests");
        drop(background);
        let lease = turn.await.unwrap();
        drop(request);
        assert!(!classifier.should_yield());
        assert!(classifier.gate.try_lock().is_err());
        drop(lease);
        assert!(classifier.gate.try_lock().is_ok());
    }

    #[tokio::test]
    async fn cancelled_waiter_preserves_background_owner_and_clears_priority() {
        let classifier = Arc::new(LocalClassifier::new(std::path::PathBuf::new()));
        classifier.background.store(true, Ordering::Relaxed);
        let _background = classifier.gate.clone().lock_owned().await;
        let request = ForegroundRequest::new(classifier.clone());
        let enabled = std::sync::atomic::AtomicBool::new(true);
        let turn = wait_for_turn(classifier.clone(), || enabled.load(Ordering::Relaxed));
        tokio::pin!(turn);
        tokio::select! {
            _ = &mut turn => panic!("must wait"),
            _ = tokio::time::sleep(Duration::from_millis(10)) => {},
        }
        enabled.store(false, Ordering::Relaxed);
        assert!(turn.await.is_err());
        drop(request);
        assert!(!classifier.should_yield());
        assert!(!classifier.cancel.load(Ordering::Relaxed));
        assert!(classifier.gate.try_lock().is_err());
        classifier.background.store(false, Ordering::Relaxed);
        let _request = ForegroundRequest::new(classifier.clone());
        assert!(!classifier.should_yield(), "explicit manual scans do not yield halfway");
    }

    #[test]
    fn explorer_requires_automatic_processing_image_consent_and_key() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.set_local_enabled(false).unwrap();
        let mut settings = AppSettings::default();
        settings.jev_api_key = Some("test-key".into());
        assert!(classification_key(&settings, true).unwrap_err().contains("应用 Jev"));
        settings.jev_image_classification_enabled = true;
        assert!(classification_key(&settings, db.local_enabled().unwrap()).unwrap_err().contains("已关闭"));
        db.set_local_enabled(true).unwrap();
        assert_eq!(classification_key(&settings, db.local_enabled().unwrap()).unwrap(), "test-key");
        db.set_local_enabled(false).unwrap();
        assert!(classification_key(&settings, db.local_enabled().unwrap()).is_err());
        settings.jev_api_key = Some("  ".into());
        assert!(classification_key(&settings, true).unwrap_err().contains("API Key"));
    }

    fn preview(id: &str) -> Preview {
        let classifier = Arc::new(LocalClassifier::new(std::path::PathBuf::new()));
        let guard = classifier.gate.clone().try_lock_owned().unwrap();
        let (lease_tx, lease) = oneshot::channel();
        let _ = lease_tx.send(Ok(ClassificationLease { classifier: classifier.clone(), _gate: guard }));
        let (_, bytes) = watch::channel(Some(Ok(Arc::new(vec![1, 2, 3]))));
        let (_, result) = watch::channel(None);
        Preview { id: id.into(), image_url: "https://image.test/a.png".into(), page_url: "https://page.test/pin".into(),
            claimed: false, asset: None, bytes, result,
            task: tauri::async_runtime::spawn(std::future::pending()), classifier, lease }
    }

    #[tokio::test]
    async fn claimed_drag_survives_dragend_and_reuses_exact_bytes() {
        let state = ExplorerAnalysis(Mutex::new(Some(preview("first"))));
        assert!(!state.claim("other", "https://image.test/a.png", "https://page.test/pin"));
        assert!(!state.claim("first", "https://image.test/b.png", "https://page.test/pin"));
        assert!(state.bytes("first", "https://image.test/a.png", "https://page.test/pin").await.unwrap().is_none());
        assert!(state.claim("first", "https://image.test/a.png", "https://page.test/pin"));
        state.end("first");
        assert_eq!(state.bytes("first", "https://image.test/a.png", "https://page.test/pin").await.unwrap().unwrap().as_slice(), &[1, 2, 3]);
        state.bind("other", "wrong");
        assert!(state.0.lock().unwrap().as_ref().unwrap().asset.is_none());
        state.bind("first", "captured");
        assert_eq!(state.0.lock().unwrap().as_ref().unwrap().asset.as_deref(), Some("captured"));
        state.release("first");
        assert!(state.0.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn cancellation_releases_gate_and_old_end_cannot_cancel_new_drag() {
        let state = ExplorerAnalysis(Mutex::new(Some(preview("new"))));
        let classifier = state.0.lock().unwrap().as_ref().unwrap().classifier.clone();
        assert!(classifier.gate.try_lock().is_err());
        state.end("old");
        assert!(state.0.lock().unwrap().is_some());
        state.end("new");
        assert!(state.0.lock().unwrap().is_none());
        assert!(classifier.cancel.load(Ordering::Relaxed));
        assert!(classifier.gate.try_lock().is_ok());
        let (_, mut pending) = watch::channel::<Option<Result<(), String>>>(None);
        assert!(receive(&mut pending).await.is_err());
    }

    #[test]
    fn preview_image_rejects_non_images_and_pads_without_cropping() {
        assert!(jev::preview_image(b"<html>login</html>").is_err());
        let source = image::RgbImage::from_pixel(100, 200, image::Rgb([255, 0, 0]));
        let mut bytes = std::io::Cursor::new(Vec::new());
        source.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        let result = image::load_from_memory(&jev::preview_image(bytes.get_ref()).unwrap()).unwrap().to_rgb8();
        assert_eq!(result.dimensions(), (512, 512));
        assert!(result.get_pixel(0, 0).0.iter().all(|v| *v > 240));
        assert!(result.get_pixel(256, 256).0[0] > 240);
        assert!(result.get_pixel(256, 256).0[1] < 15);
    }
}
