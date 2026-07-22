//! axum WS server：接收浏览器扩展的采集消息，下载入库。
//!
//! 消息协议（JSON）：
//!   `{ "type": "ping" }`                                    → `{ "ok": true, "pong": true }`
//!   `{ "type": "save", "url": "...", "page_url": "..." }`    → `{ "ok": true, "asset_id": "..." }`

use std::sync::Arc;

use axum::extract::State;
use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use tauri::{AppHandle, Emitter};

use crate::core::ingest;
use crate::core::paths::LibraryPaths;
use crate::db::Database;

pub const ADDR: &str = "127.0.0.1:39871";

#[derive(Clone)]
struct AppState {
    paths: Arc<LibraryPaths>,
    db: Arc<Database>,
    app: AppHandle,
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: axum::extract::ws::WebSocket, state: AppState) {
    let mut pending_upload: Option<serde_json::Value> = None;
    while let Some(Ok(msg)) = socket.recv().await {
        match msg {
            Message::Text(text) => {
                let parsed = serde_json::from_str::<serde_json::Value>(&text).ok();
                if parsed.as_ref().and_then(|v| v.get("type")).and_then(|v| v.as_str()) == Some("save_blob") {
                    pending_upload = parsed;
                } else {
                    let resp = handle_message(&text, &state).await;
                    let _ = socket.send(Message::Text(resp)).await;
                }
            }
            Message::Binary(bytes) => {
                let resp = match pending_upload.take() {
                    Some(meta) => handle_blob(bytes.as_ref(), &meta, &state),
                    None => serde_json::json!({ "ok": false, "error": "binary payload without save_blob metadata" }).to_string(),
                };
                let _ = socket.send(Message::Text(resp)).await;
            }
            _ => {}
        }
    }
}

fn handle_blob(bytes: &[u8], meta: &serde_json::Value, state: &AppState) -> String {
    let url = meta.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let file_name = meta.get("file_name").and_then(|v| v.as_str());
    let content_type = meta.get("content_type").and_then(|v| v.as_str());
    if url.is_empty() {
        return serde_json::json!({ "ok": false, "error": "empty source url" }).to_string();
    }
    match ingest::ingest_from_bytes(&state.paths, &state.db, bytes, url, file_name, content_type) {
        Ok(asset) => save_succeeded(asset, state),
        Err(error) => serde_json::json!({ "ok": false, "error": error.to_string() }).to_string(),
    }
}

fn save_succeeded(a: crate::core::library::Asset, state: &AppState) -> String {
    crate::core::autoname::spawn_auto_analyze(state.app.clone(), state.db.clone(), a.clone());
    let _ = state.app.emit(
        "library://assets-changed",
        serde_json::json!({ "asset_id": a.id.clone(), "name": a.name.clone() }),
    );
    serde_json::json!({ "ok": true, "asset_id": a.id, "name": a.name }).to_string()
}

async fn handle_message(text: &str, state: &AppState) -> String {
    let v: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return r#"{"ok":false,"error":"bad json"}"#.to_string(),
    };
    let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match kind {
        "ping" => {
            let _ = state.app.emit("collect://extension-connected", ());
            r#"{"ok":true,"pong":true}"#.to_string()
        }
        "save" => {
            let url = v.get("url").and_then(|u| u.as_str()).unwrap_or("");
            let page_url = v.get("page_url").and_then(|u| u.as_str());
            if url.is_empty() {
                return r#"{"ok":false,"error":"empty url"}"#.to_string();
            }
            let _ = state.app.emit("collect://extension-connected", ());
            match ingest::ingest_from_url(&state.paths, &state.db, url, page_url).await {
                Ok(a) => {
                    save_succeeded(a, state)
                }
                Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
            }
        }
        // 主线扩展（含小红书结构化采集）批量提交走 save_batch：逐项 URL 下载入库。
        // 与 save_blob 不同：那条通路靠浏览器上传字节保留登录态；这条由桌面端直接下载，
        // 适用于 xhscdn 等公开图床。两条并存，按扩展协议自动分流。
        "save_batch" => {
            let _ = state.app.emit("collect://extension-connected", ());
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
                    match ingest_one(state, url, source_url).await {
                        Ok(asset) => {
                            saved += 1;
                            let _ = state.app.emit(
                                "library://assets-changed",
                                serde_json::json!({ "asset_id": asset.id, "name": asset.name }),
                            );
                            serde_json::json!({ "ok": true, "asset_id": asset.id, "name": asset.name })
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

async fn ingest_one(
    state: &AppState,
    url: &str,
    source_url: Option<&str>,
) -> crate::error::AppResult<crate::core::library::Asset> {
    let asset = ingest::ingest_from_url(&state.paths, &state.db, url, source_url).await?;
    crate::core::autoname::spawn_auto_analyze(state.app.clone(), state.db.clone(), asset.clone());
    Ok(asset)
}

pub async fn start(
    paths: Arc<LibraryPaths>,
    db: Arc<Database>,
    app: AppHandle,
) -> Result<(), std::io::Error> {
    let state = AppState { paths, db, app };
    let app = Router::new().route("/ws", get(ws_handler)).with_state(state);
    let listener = tokio::net::TcpListener::bind(ADDR).await?;
    tracing::info!("collect ws server listening on ws://{ADDR}/ws");
    axum::serve(listener, app).await?;
    Ok(())
}
