//! Model-cache coordination for H3 image and video submissions on a local ComfyUI service.
use std::{collections::HashMap, sync::{Arc, LazyLock, Mutex}, time::Duration};
use serde_json::{json, Value};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

#[derive(Default)]
pub(crate) struct ModelCache {
    last_weights: Option<&'static str>,
    release_pending: bool,
}

static CACHES: LazyLock<Mutex<HashMap<String, Arc<AsyncMutex<ModelCache>>>>> = LazyLock::new(Default::default);

async fn service_cache(base: &str) -> OwnedMutexGuard<ModelCache> {
    // localhost and 127.0.0.1 address the same managed IPv4 listener.
    let key = base.replacen("http://localhost", "http://127.0.0.1", 1);
    let lock = CACHES.lock().unwrap().entry(key).or_default().clone();
    lock.lock_owned().await
}

pub(crate) async fn before_submit(http: &reqwest::Client, base: &str, weights: &'static str) -> OwnedMutexGuard<ModelCache> {
    let mut cache = service_cache(base).await;
    if cache.release_pending || cache.last_weights.is_some_and(|previous| previous != weights) {
        cache.release_pending = !release_idle_models(http, base).await;
    }
    cache
}

impl ModelCache {
    pub(crate) fn submitted(&mut self, weights: &'static str) { self.last_weights = Some(weights); }
}

async fn release_idle_models(http: &reqwest::Client, base: &str) -> bool {
    let timeout = Duration::from_secs(3);
    let Ok(queue) = super::comfy_video::json_response(http.get(format!("{base}/queue")).timeout(timeout)).await else { return false; };
    if !["queue_running", "queue_pending"].into_iter().all(|key| queue[key].as_array().is_some_and(Vec::is_empty)) {
        return false;
    }
    // ComfyUI accepts this request asynchronously and releases resources on its worker.
    match http.post(format!("{base}/free")).timeout(timeout)
        .json(&json!({"unload_models": true, "free_memory": true})).send().await
    {
        Ok(response) if response.status().is_success() => true,
        response => {
            tracing::debug!(%base, ?response, "ComfyUI did not accept a model cache release");
            false
        }
    }
}

fn is_host_buffer_error(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("hostbuffer.read_file_slice") || message.contains("hostbuf_read_file_slice")
}

pub(crate) async fn host_buffer_guidance(base: &str, message: &str) -> Option<&'static str> {
    if !is_host_buffer_error(message) { return None; }
    tracing::warn!(%base, %message, "ComfyUI model weight read failed");
    service_cache(base).await.release_pending = true;
    Some("本机读取大模型失败，系统内存或锁页缓冲可能不足。请关闭占用内存的应用，或重启本机 ComfyUI 后重试。如果模型在外接盘，请确认连接稳定。")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, routing::{get, post}};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed};

    #[tokio::test]
    async fn releases_only_when_needed_and_the_service_is_idle() {
        let busy = Arc::new(AtomicBool::new(false));
        let releases = Arc::new(AtomicUsize::new(0));
        let router = Router::new()
            .route("/queue", get({
                let busy = busy.clone();
                move || async move {
                    let pending = if busy.load(Relaxed) { json!([[0, "other-task"]]) } else { json!([]) };
                    Json(json!({"queue_running": [], "queue_pending": pending}))
                }
            }))
            .route("/free", post({
                let releases = releases.clone();
                move |Json(flags): Json<Value>| async move {
                    assert_eq!(flags, json!({"unload_models": true, "free_memory": true}));
                    releases.fetch_add(1, Relaxed);
                }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap(); });
        let http = super::super::comfy_video::client().unwrap();

        before_submit(&http, &base, "frames").await.submitted("frames");
        before_submit(&http, &base, "frames").await.submitted("frames");
        assert_eq!(releases.load(Relaxed), 0);
        before_submit(&http, &base, "reference").await.submitted("reference");
        assert_eq!(releases.load(Relaxed), 1);
        busy.store(true, Relaxed);
        before_submit(&http, &base, "frames").await.submitted("frames");
        assert_eq!(releases.load(Relaxed), 1);
        busy.store(false, Relaxed);
        before_submit(&http, &base, "frames").await.submitted("frames");
        assert_eq!(releases.load(Relaxed), 2);
        assert!(host_buffer_guidance(&base, "RuntimeError: HostBuffer.read_file_slice failed").await.unwrap().contains("请关闭占用内存的应用"));
        assert!(is_host_buffer_error("hostbuf_read_file_slice failed"));
        assert!(host_buffer_guidance(&base, "CUDA out of memory").await.is_none());
        before_submit(&http, &base, "frames").await.submitted("frames");
        assert_eq!(releases.load(Relaxed), 3);
        server.abort();
    }
}
