//! axum WS server：接收浏览器扩展的采集消息，下载入库。
//!
//! 消息协议（JSON）：
//!   `{ "type": "ping" }`                                    → `{ "ok": true, "pong": true }`
//!   `{ "type": "save", "url": "...", "page_url": "..." }`    → `{ "ok": true, "asset_id": "..." }`
//!   `{ "type": "save_batch", "items": [...] }`                    → `{ "ok": true, "results": [...] }`

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use tauri::{AppHandle, Emitter};

use crate::core::ingest;
use crate::core::paths::LibraryPaths;
use crate::db::Database;

pub const ADDR: &str = "127.0.0.1:39871";

/// 扩展连接状态（ws_server 写、`extension_status` command 读，经 lib.rs `manage` 共享）。
/// 内部 Arc，Clone 共享同一份 last_seen / connected。
#[derive(Clone, Default)]
pub struct ExtensionStatus {
    last_seen: Arc<std::sync::Mutex<Option<std::time::Instant>>>,
    connected: Arc<std::sync::atomic::AtomicBool>,
}

impl ExtensionStatus {
    pub fn new() -> Self {
        Self::default()
    }
    /// 收到扩展任意消息（ping/save/save_batch）时调：更新 last_seen；
    /// 返回是否「刚连上」（false→true 跳变），供调用方 emit `collect://extension-connected`。
    pub fn touch(&self) -> bool {
        *self.last_seen.lock().unwrap() = Some(std::time::Instant::now());
        !self.connected.swap(true, std::sync::atomic::Ordering::Relaxed)
    }
    pub fn is_connected(&self) -> bool {
        self.connected.load(std::sync::atomic::Ordering::Relaxed)
    }
    /// 心跳超时检查：距上次消息超过 `timeout` 且当前 connected → 清 last_seen 并置 false，
    /// 返回是否「刚断开」（true→false 跳变），供 tick task emit `collect://extension-disconnected`。
    pub fn check_timeout(&self, timeout: std::time::Duration) -> bool {
        let mut guard = self.last_seen.lock().unwrap();
        if let Some(t) = *guard {
            if t.elapsed() > timeout {
                *guard = None;
                drop(guard);
                return self
                    .connected
                    .swap(false, std::sync::atomic::Ordering::Relaxed);
            }
        }
        false
    }
}

#[derive(Clone)]
struct AppState {
    paths: Arc<LibraryPaths>,
    db: Arc<Database>,
    app: AppHandle,
    client: reqwest::Client,
    status: ExtensionStatus,
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: axum::extract::ws::WebSocket, state: AppState) {
    tracing::debug!("collect ws: connection opened");
    // save_blob 两帧协议：先 Text metadata，再 Binary 图片字节（浏览器 background fetch，带 Cookie/代理）。
    let mut pending_upload: Option<serde_json::Value> = None;
    while let Some(Ok(msg)) = socket.recv().await {
        match msg {
            Message::Text(text) => {
                // 任意消息（ping / save / save_batch / save_blob metadata）= 扩展在线。
                if state.status.touch() {
                    let _ = state.app.emit("collect://extension-connected", ());
                }
                if text.len() > 64 * 1024 {
                    let _ = socket
                        .send(Message::Text(
                            serde_json::json!({ "ok": false, "error": "metadata exceeds 64 KiB limit" })
                                .to_string(),
                        ))
                        .await;
                    continue;
                }
                let parsed = serde_json::from_str::<serde_json::Value>(&text).ok();
                if parsed
                    .as_ref()
                    .and_then(|v| v.get("type"))
                    .and_then(|v| v.as_str())
                    == Some("save_blob")
                {
                    if pending_upload.is_some() {
                        let _ = socket
                            .send(Message::Text(
                                serde_json::json!({ "ok": false, "error": "save_blob metadata already pending" })
                                    .to_string(),
                            ))
                            .await;
                        continue;
                    }
                    tracing::info!("collect ws recv: kind=save_blob");
                    pending_upload = parsed;
                } else {
                    let resp = handle_message(&text, &state).await;
                    let _ = socket.send(Message::Text(resp)).await;
                }
            }
            Message::Binary(bytes) => {
                let resp = match pending_upload.take() {
                    Some(meta) if bytes.len() <= 50 * 1024 * 1024 => {
                        handle_blob(bytes.as_ref(), &meta, &state)
                    }
                    Some(_) => serde_json::json!({
                        "ok": false,
                        "error": "binary payload exceeds 50 MiB limit"
                    })
                    .to_string(),
                    None => serde_json::json!({
                        "ok": false,
                        "error": "binary payload without save_blob metadata"
                    })
                    .to_string(),
                };
                let _ = socket.send(Message::Text(resp)).await;
            }
            _ => {}
        }
    }
    tracing::debug!("collect ws: connection closed");
}

/// 浏览器 background 已在登录态/系统代理环境内 fetch 图片；收到二进制后直接按真实字节入库。
fn handle_blob(bytes: &[u8], meta: &serde_json::Value, state: &AppState) -> String {
    let requested_url = meta
        .get("requested_url")
        .or_else(|| meta.get("url"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let effective_url = meta
        .get("effective_url")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .unwrap_or(requested_url);
    let page_url = meta
        .get("page_url")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty());
    let file_name = meta.get("file_name").and_then(|v| v.as_str());
    let content_type = meta.get("content_type").and_then(|v| v.as_str());
    if requested_url.is_empty() {
        return serde_json::json!({ "ok": false, "error": "empty source url" }).to_string();
    }
    // 追溯优先页面 URL（如 Pinterest pin），无则最终图片 URL。
    let source_url = page_url.unwrap_or(effective_url);
    match ingest::ingest_from_bytes(
        &state.paths,
        &state.db,
        bytes,
        source_url,
        file_name,
        content_type,
    ) {
        Ok(asset) => {
            tracing::info!(
                "collect ws save_blob ok: {} -> {}",
                redact_url(requested_url),
                asset.id
            );
            crate::core::autoname::spawn_auto_analyze(
                state.app.clone(),
                state.db.clone(),
                asset.clone(),
            );
            let _ = state.app.emit("library://assets-changed", ());
            asset_result(&asset).to_string()
        }
        Err(error) => {
            tracing::warn!(
                "collect ws save_blob fail: {} | {error}",
                redact_url(requested_url)
            );
            serde_json::json!({ "ok": false, "error": error.to_string() }).to_string()
        }
    }
}

fn redact_url(value: &str) -> String {
    match reqwest::Url::parse(value) {
        Ok(mut url) => {
            url.set_query(None);
            url.set_fragment(None);
            url.to_string()
        }
        Err(_) => value.chars().take(200).collect(),
    }
}

async fn handle_message(text: &str, state: &AppState) -> String {
    let v: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return r#"{"ok":false,"error":"bad json"}"#.to_string(),
    };
    let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if kind != "ping" {
        tracing::info!("collect ws recv: kind={kind}");
    }
    match kind {
        "ping" => r#"{"ok":true,"pong":true}"#.to_string(),
        "save" => {
            let url = v.get("url").and_then(|u| u.as_str()).unwrap_or("");
            if url.is_empty() {
                return r#"{"ok":false,"error":"empty url"}"#.to_string();
            }
            let source_url = v
                .get("source_url")
                .or_else(|| v.get("page_url"))
                .and_then(|value| value.as_str());
            match save_one(state, url, source_url).await {
                Ok(a) => {
                    let _ = state.app.emit("library://assets-changed", ());
                    asset_result(&a).to_string()
                }
                Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
            }
        }
        "save_batch" => {
            let Some(items) = v.get("items").and_then(|items| items.as_array()) else {
                return r#"{"ok":false,"error":"items must be an array","results":[]}"#.to_string();
            };
            if items.is_empty() {
                return r#"{"ok":false,"error":"empty items","results":[]}"#.to_string();
            }
            if items.len() > 100 {
                return r#"{"ok":false,"error":"batch limit is 100","results":[]}"#.to_string();
            }

            let mut results = Vec::with_capacity(items.len());
            let mut saved = 0usize;
            for item in items {
                let url = item
                    .get("media_url")
                    .or_else(|| item.get("url"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let source_url = item
                    .get("source_url")
                    .or_else(|| v.get("source_url"))
                    .or_else(|| v.get("page_url"))
                    .and_then(|value| value.as_str());
                let mut result = if url.is_empty() {
                    serde_json::json!({ "ok": false, "error": "empty media_url" })
                } else {
                    match save_one(state, url, source_url).await {
                        Ok(asset) => {
                            saved += 1;
                            asset_result(&asset)
                        }
                        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
                    }
                };
                if let Some(object) = result.as_object_mut() {
                    for key in ["source_id", "index", "media_kind"] {
                        if let Some(value) = item.get(key) {
                            object.insert(key.to_string(), value.clone());
                        }
                    }
                }
                results.push(result);
            }
            if saved > 0 {
                let _ = state.app.emit("library://assets-changed", ());
            }
            serde_json::json!({
                "ok": saved == items.len(),
                "saved": saved,
                "total": items.len(),
                "results": results,
            })
            .to_string()
        }
        _ => r#"{"ok":false,"error":"unknown type"}"#.to_string(),
    }
}

async fn save_one(
    state: &AppState,
    url: &str,
    source_url: Option<&str>,
) -> crate::error::AppResult<crate::core::library::Asset> {
    let asset = match ingest::ingest_from_url(&state.client, &state.paths, &state.db, url, source_url).await {
        Ok(a) => {
            tracing::info!("collect ws save_one ok: {url} -> {}", a.id);
            a
        }
        Err(e) => {
            tracing::warn!("collect ws save_one fail: {url} | {e}");
            return Err(e);
        }
    };
    // 后台命名 + 基础分析（非阻塞；完成后 autoname 再 emit 刷新）。
    crate::core::autoname::spawn_auto_analyze(state.app.clone(), state.db.clone(), asset.clone());
    Ok(asset)
}

fn asset_result(asset: &crate::core::library::Asset) -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "asset_id": asset.id,
        "name": asset.name,
    })
}

pub async fn start(
    paths: Arc<LibraryPaths>,
    db: Arc<Database>,
    app: AppHandle,
    status: ExtensionStatus,
) -> Result<(), std::io::Error> {
    let client = ingest::download_client().map_err(std::io::Error::other)?;
    let state = AppState {
        paths,
        db,
        app: app.clone(),
        client,
        status: status.clone(),
    };
    // 心跳超时 tick：每 5s 检查，距上次消息 > 30s（错过 1 个 15s 心跳）→ emit disconnected。
    // 让前端状态指示器在扩展被 disable / 卸载后及时变灰，而非永久卡绿。
    let tick_status = status.clone();
    let tick_app = app.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
        let timeout = std::time::Duration::from_secs(30);
        loop {
            interval.tick().await;
            if tick_status.check_timeout(timeout) {
                let _ = tick_app.emit("collect://extension-disconnected", ());
            }
        }
    });
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(ADDR).await?;
    tracing::info!("collect ws server listening on ws://{ADDR}/ws");
    axum::serve(listener, app).await?;
    Ok(())
}
