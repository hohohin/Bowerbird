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
            match ingest::ingest_from_url(&state.paths, &state.db, url).await {
                Ok(a) => {
                    // 后台命名 + 反推（非阻塞，约定 7 离线降级；完成后再 emit 一次刷新名）。
                    crate::core::autoname::spawn_auto_analyze(
                        state.app.clone(),
                        state.db.clone(),
                        a.clone(),
                    );
                    // 通知前端刷新（扩展批量采集时会连发多条，前端去抖合并）。
                    let _ = state.app.emit("library://assets-changed", ());
                    serde_json::json!({
                        "ok": true,
                        "asset_id": a.id,
                        "name": a.name,
                    })
                    .to_string()
                }
                Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
            }
        }
        _ => r#"{"ok":false,"error":"unknown type"}"#.to_string(),
    }
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
