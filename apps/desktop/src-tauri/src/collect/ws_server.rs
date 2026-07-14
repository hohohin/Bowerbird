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

#[derive(Clone)]
struct AppState {
    paths: Arc<LibraryPaths>,
    db: Arc<Database>,
    app: AppHandle,
    client: reqwest::Client,
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: axum::extract::ws::WebSocket, state: AppState) {
    while let Some(Ok(msg)) = socket.recv().await {
        if let Message::Text(text) = msg {
            let resp = handle_message(&text, &state).await;
            let _ = socket.send(Message::Text(resp)).await;
        }
    }
}

async fn handle_message(text: &str, state: &AppState) -> String {
    let v: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return r#"{"ok":false,"error":"bad json"}"#.to_string(),
    };
    let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
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
    let asset =
        ingest::ingest_from_url(&state.client, &state.paths, &state.db, url, source_url).await?;
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
) -> Result<(), std::io::Error> {
    let client = ingest::download_client().map_err(std::io::Error::other)?;
    let state = AppState {
        paths,
        db,
        app,
        client,
    };
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(ADDR).await?;
    tracing::info!("collect ws server listening on ws://{ADDR}/ws");
    axum::serve(listener, app).await?;
    Ok(())
}
