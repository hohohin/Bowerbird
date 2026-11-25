//! axum WS server：接收浏览器扩展的采集消息，下载或接收字节后入库。
//!
//! 消息协议：
//!   `{ "type": "ping" }`                                      → `{ "ok": true, "pong": true }`
//!   `{ "type": "save", "url": "...", "page_url": "..." }`      → `{ "ok": true, "asset_id": "..." }`
//!   `{ "type": "save_batch", "items": [...] }`                    → `{ "ok": true, "results": [...] }`
//!   `{ "type": "save_blob", ... }` Text + 下一帧 Binary 图片字节 → `{ "ok": true, "asset_id": "..." }`
//!   save_blob + media_kind:"video" → 已协商的视频二进制（200 MiB），回执附 media_kind。
//!   save_blob_start → Binary 小块（逐块确认）→ save_blob_end → 视频入库回执。

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use tauri::{AppHandle, Emitter, Manager};
use super::video_blob;

use crate::core::ingest;
use crate::core::paths::LibraryPaths;
use crate::core::projects::ActiveProjectContext;
use crate::db::Database;

pub const ADDR: &str = "127.0.0.1:39871";

/// 扩展连接状态（ws_server 写、`extension_status` command 读，经 lib.rs `manage` 共享）。
#[derive(Clone)]
pub struct ExtensionStatus {
    pub(crate) pairing: Arc<super::pairing::Pairing>,
    connection: Arc<std::sync::Mutex<Connection>>,
}

#[derive(Default)]
struct Connection {
    last_seen: Option<Instant>,
    version: Option<ExtensionVersion>,
}

#[derive(Clone, serde::Serialize)]
pub struct ExtensionVersion {
    reported: Option<String>,
    expected: &'static str,
    update_required: bool,
}

#[derive(serde::Serialize)]
pub struct ExtensionConnection {
    connected: bool,
    version: Option<ExtensionVersion>,
}

fn version_parts(version: &str) -> Option<[u16; 4]> {
    let mut parts = [0; 4];
    for (index, part) in version.split('.').enumerate() {
        if part.is_empty() || part.len() > 5 || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        *parts.get_mut(index)? = part.parse().ok()?;
    }
    Some(parts)
}

impl ExtensionVersion {
    fn from_ping(version: Option<&str>) -> Self {
        static EXPECTED: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
            let manifest: serde_json::Value = serde_json::from_str(include_str!("../../../../extension/manifest.json"))
                .expect("extension manifest must be valid JSON");
            manifest["version"].as_str().expect("extension manifest version is required").to_owned()
        });
        let expected = version_parts(&EXPECTED).expect("extension manifest version is invalid");
        let reported = version.and_then(version_parts);
        Self {
            reported: version.filter(|_| reported.is_some()).map(str::to_owned),
            expected: &EXPECTED,
            update_required: reported.is_none_or(|reported| reported < expected),
        }
    }
}

impl ExtensionStatus {
    pub fn open(path: &std::path::Path) -> std::io::Result<Self> {
        Ok(Self { pairing: Arc::new(super::pairing::Pairing::open(path)?), connection: Default::default() })
    }
    /// 收到扩展任意消息（ping/save/save_batch）时调：更新 last_seen；
    /// 返回是否「刚连上」（false→true 跳变），供调用方 emit `collect://extension-connected`。
    pub fn touch(&self) -> bool {
        self.connection.lock().unwrap().last_seen.replace(Instant::now()).is_none()
    }

    fn report_version(&self, version: Option<&str>) {
        self.connection.lock().unwrap().version = Some(ExtensionVersion::from_ping(version));
    }

    pub fn snapshot(&self) -> ExtensionConnection {
        let connection = self.connection.lock().unwrap();
        ExtensionConnection { connected: connection.last_seen.is_some(), version: connection.version.clone() }
    }

    pub fn clear(&self) {
        *self.connection.lock().unwrap() = Connection::default();
    }
    /// 心跳超时检查：距上次消息超过 `timeout` 且当前 connected → 清 last_seen 并置 false，
    /// 返回是否「刚断开」（true→false 跳变），供 tick task emit `collect://extension-disconnected`。
    pub fn check_timeout(&self, timeout: Duration) -> bool {
        let mut connection = self.connection.lock().unwrap();
        if connection.last_seen.is_some_and(|time| time.elapsed() > timeout) {
            *connection = Connection::default();
            return true;
        }
        false
    }
}

#[derive(Clone)]
struct AppState {
    paths: Arc<LibraryPaths>,
    db: Arc<Database>,
    app: AppHandle,
    status: ExtensionStatus,
    active_project: ActiveProjectContext,
    sockets: Arc<tokio::sync::Semaphore>,
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>, headers: axum::http::HeaderMap) -> axum::response::Response {
    let Ok(permit) = state.sockets.clone().try_acquire_owned() else {
        return axum::http::StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let Some(grant) = state.status.pairing.grant(&headers) else {
        return axum::http::StatusCode::FORBIDDEN.into_response();
    };
    ws.max_message_size(video_blob::MAX_BYTES).max_frame_size(video_blob::MAX_BYTES)
        .protocols([super::pairing::PROTOCOL])
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            handle_socket(socket, state, grant).await;
        })
}

async fn handle_socket(mut socket: axum::extract::ws::WebSocket, state: AppState, grant: super::pairing::Grant) {
    tracing::debug!("collect ws: connection opened");
    // save_blob 两帧协议：先 Text metadata，再 Binary 图片字节（浏览器 background fetch，带 Cookie/代理）。
    let mut pending_upload: Option<(serde_json::Value, Option<String>)> = None;
    let mut pending_stream: Option<video_blob::StreamUpload> = None;
    while let Ok(Some(Ok(msg))) = tokio::time::timeout(std::time::Duration::from_secs(180), socket.recv()).await {
        // A bounded stream is one upload, but every chunk still checks that the grant remains valid.
        let cost = usize::from(!(pending_stream.is_some() && matches!(&msg, Message::Binary(_))));
        if !state.status.pairing.allow_action(&grant, cost) { break; }
        match msg {
            Message::Text(text) => {
                // 任意消息（ping / save / save_batch / save_blob metadata）= 扩展在线。
                if state.status.touch() {
                    let _ = state.app.emit("collect://extension-connected", ());
                }
                if text.len() > 64 * 1024 {
                    pending_upload = None;
                    pending_stream = None;
                    let _ = socket
                        .send(Message::Text(
                            serde_json::json!({ "ok": false, "error": "metadata exceeds 64 KiB limit" })
                                .to_string(),
                        ))
                        .await;
                    continue;
                }
                let parsed = serde_json::from_str::<serde_json::Value>(&text).ok();
                let kind = parsed.as_ref().and_then(|v| v["type"].as_str());
                if grant.upload_only && !matches!(kind, Some("save_blob" | "save_blob_start" | "save_blob_end" | "ping")) { break; }
                if kind == Some("ping") && !grant.upload_only {
                    state.status.report_version(parsed.as_ref().and_then(|v| v["extension_version"].as_str()));
                }
                // A second upload or command invalidates the pending pair. Never let
                // its next Binary frame acquire the first upload's provenance/project.
                if (pending_upload.is_some() && kind != Some("ping"))
                    || (pending_stream.is_some() && !matches!(kind, Some("save_blob_end" | "ping")))
                {
                    pending_upload = None;
                    pending_stream = None;
                    let _ = socket.send(Message::Text(protocol_error())).await;
                    continue;
                }
                if kind == Some("save_blob_start") {
                    let meta = parsed.unwrap();
                    let reply = match video_blob::StreamUpload::start(&state.paths, meta, state.active_project.get()).await {
                        Ok(upload) => {
                            pending_stream = Some(upload);
                            serde_json::json!({"ok":true,"received":0}).to_string()
                        }
                        Err(error) => video_error(error),
                    };
                    if socket.send(Message::Text(reply)).await.is_err() { break; }
                } else if kind == Some("save_blob_end") {
                    let reply = match pending_stream.take() {
                        Some(upload) => {
                            let length = parsed.as_ref().and_then(|value| value["byte_length"].as_u64());
                            video_save_reply(upload.finish(state.paths.clone(), state.db.clone(), length).await, &state)
                        }
                        None => protocol_error(),
                    };
                    if socket.send(Message::Text(reply)).await.is_err() || grant.upload_only { break; }
                } else if kind == Some("save_blob") {
                    if let Some(meta) = &parsed {
                        if meta["media_kind"] == "video" {
                            if let Err(error) = video_blob::validate_metadata(meta) {
                                let _ = socket.send(Message::Text(video_error(error))).await;
                                continue;
                            }
                        } else if meta.get("media_kind").is_some_and(|kind| kind != "image") {
                            let _ = socket.send(Message::Text(serde_json::json!({"ok":false,"code":"invalid_metadata","error":"暂不支持这种采集类型，请更新插件后重试。"}).to_string())).await;
                            continue;
                        }
                    }
                    tracing::info!("collect ws recv: kind=save_blob");
                    pending_upload = parsed.map(|meta| (meta, state.active_project.get()));
                } else {
                    if kind == Some("save_batch") {
                        let count = parsed.as_ref().and_then(|v| v["items"].as_array()).map_or(0, Vec::len);
                        if !state.status.pairing.allow_action(&grant, count) { break; }
                    }
                    let resp = handle_message(&text, &state).await;
                    let _ = socket.send(Message::Text(resp)).await;
                }
            }
            Message::Binary(bytes) => {
                if let Some(stream) = &mut pending_stream {
                    state.status.touch();
                    let reply = match stream.write(bytes.as_ref()).await {
                        Ok(received) => serde_json::json!({"ok":true,"received":received}).to_string(),
                        Err(error) => {
                            pending_stream = None;
                            video_error(error)
                        }
                    };
                    if socket.send(Message::Text(reply)).await.is_err() || (pending_stream.is_none() && grant.upload_only) {
                        break;
                    }
                    continue;
                }
                let resp = match pending_upload.take() {
                    Some((meta, project_id)) if meta["media_kind"] == "video" => {
                        let state = state.clone();
                        // Metadata probe, poster and filesystem work must not block the
                        // async socket executor while another client sends its heartbeat.
                        tokio::task::spawn_blocking(move || {
                            let result = video_blob::save(&state.paths, &state.db, bytes.as_ref(), &meta, project_id.as_deref());
                            video_save_reply(result, &state)
                        }).await
                            .unwrap_or_else(|error| { tracing::error!("video upload worker: {error}"); serde_json::json!({"ok":false,"code":"save_failed","error":"视频未能保存，请稍后重试。"}).to_string() })
                    }
                    Some((meta, project_id)) if bytes.len() <= 50 * 1024 * 1024 => {
                        handle_blob(bytes.as_ref(), &meta, project_id.as_deref(), &state)
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
                if grant.upload_only { break; }
            }
            _ => {}
        }
    }
    tracing::debug!("collect ws: connection closed");
}

fn protocol_error() -> String {
    serde_json::json!({"ok":false,"code":"protocol_error","error":"采集消息顺序异常，请重新采集。"}).to_string()
}

fn video_error(error: video_blob::UploadError) -> String {
    tracing::warn!("extension video {}: {}", error.code, error.diagnostic);
    serde_json::json!({"ok":false,"code":error.code,"error":error.message}).to_string()
}

fn video_save_reply(result: Result<crate::core::library::Asset, video_blob::UploadError>, state: &AppState) -> String {
    match result {
        Ok(asset) => {
            let _ = state.app.emit("library://assets-changed", ());
            for path in [&asset.store_path, &asset.thumb_path].into_iter().flatten() {
                if let Err(error) = state.app.asset_protocol_scope().allow_file(path) {
                    tracing::warn!("video saved but media permission failed: {error}");
                    return serde_json::json!({"ok":false,"saved":true,"asset_id":asset.id,"name":asset.name,"media_kind":"video","code":"preview_unavailable","error":"视频已保存，但暂时无法预览，请在素材库中重新打开。"}).to_string();
                }
            }
            serde_json::json!({"ok":true,"asset_id":asset.id,"name":asset.name,"media_kind":"video"}).to_string()
        }
        Err(error) => video_error(error),
    }
}

/// 浏览器 background 已在登录态/系统代理环境内 fetch 图片；收到二进制后直接按真实字节入库。
fn handle_blob(
    bytes: &[u8],
    meta: &serde_json::Value,
    project_id: Option<&str>,
    state: &AppState,
) -> String {
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
    let paths = match state.paths.for_project(&state.db, project_id) {
        Ok(paths) => paths,
        Err(error) => return serde_json::json!({ "ok": false, "error": error.to_string() }).to_string(),
    };
    match ingest::ingest_from_bytes(
        &paths,
        &state.db,
        bytes,
        source_url,
        file_name,
        content_type,
        "extension",
    ) {
        Ok(asset) => {
            if let Err(error) = finish_image_capture(&state.db, project_id, &asset) {
                tracing::warn!("link collected asset {} failed: {error}", asset.id);
                let _ = state.app.emit("library://assets-changed", ());
                return serde_json::json!({"ok":false,"saved":true,"error":"图片已保存，但素材归属未能登记，请重试。"}).to_string();
            }
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
    let project_id = state.active_project.get();
    let v: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return r#"{"ok":false,"error":"bad json"}"#.to_string(),
    };
    let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if kind != "ping" {
        tracing::info!("collect ws recv: kind={kind}");
    }
    match kind {
        "current_project" => match project_id.as_deref().map(|id| state.db.get_project(id)).transpose() {
            Ok(project) => serde_json::json!({"ok":true,"name":project.flatten().map(|p| p.name)}).to_string(),
            Err(_) => serde_json::json!({"ok":false,"error":"project unavailable"}).to_string(),
        },
        "ping" => {
            let _ = state.app.emit("collect://extension-connected", state.status.snapshot().version);
            serde_json::json!({"ok":true,"pong":true,"capabilities":{"video_blob":true,"video_stream_upload":true,"video_max_bytes":video_blob::MAX_BYTES}}).to_string()
        }
        "save" => {
            if v["media_kind"] == "video" {
                return serde_json::json!({"ok":false,"code":"video_upload_required","error":"视频需要由浏览器上传文件内容，请更新插件后重试。"}).to_string();
            }
            let _ = state.app.emit("collect://extension-connected", ());
            let url = v.get("url").and_then(|u| u.as_str()).unwrap_or("");
            if url.is_empty() {
                return r#"{"ok":false,"error":"empty url"}"#.to_string();
            }
            let source_url = v
                .get("source_url")
                .or_else(|| v.get("page_url"))
                .and_then(|value| value.as_str());
            match save_one(state, url, source_url, project_id.as_deref()).await {
                Ok(a) => {
                    save_succeeded(a, state).to_string()
                }
                Err(error) => {
                    serde_json::json!({ "ok": false, "error": error.to_string() }).to_string()
                }
            }
        }
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
                let mut result = if item["media_kind"] == "video" {
                    serde_json::json!({"ok":false,"code":"video_upload_required","error":"视频需要由浏览器上传文件内容，请更新插件后重试。"})
                } else if url.is_empty() {
                    serde_json::json!({ "ok": false, "error": "empty media_url" })
                } else {
                    match save_one(state, url, source_url, project_id.as_deref()).await {
                        Ok(asset) => {
                            saved += 1;
                            save_succeeded(asset, state)
                        }
                        Err(error) => {
                            serde_json::json!({ "ok": false, "error": error.to_string() })
                        }
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

async fn save_one(
    state: &AppState,
    url: &str,
    source_url: Option<&str>,
    project_id: Option<&str>,
) -> crate::error::AppResult<crate::core::library::Asset> {
    let paths = state.paths.for_project(&state.db, project_id)?;
    let asset = match ingest::ingest_from_url(
        &paths,
        &state.db,
        url,
        source_url,
    )
    .await
    {
        Ok(a) => {
            tracing::info!("collect ws save_one ok: {url} -> {}", a.id);
            a
        }
        Err(e) => {
            tracing::warn!("collect ws save_one fail: {url} | {e}");
            return Err(e);
        }
    };
    finish_image_capture(&state.db, project_id, &asset)?;
    Ok(asset)
}

fn finish_image_capture(db: &Database, project_id: Option<&str>, asset: &crate::core::library::Asset) -> crate::error::AppResult<()> {
    if let Some(project_id) = project_id {
        db.place_collected_image(project_id, asset)
    } else {
        // An explicit global capture gives a reused project original an independent library use.
        db.link_external_to_library(&asset.id).map(|_| ())
    }
}

#[cfg(test)]
mod capture_tests {
    use super::*;
    use crate::core::file_workspace::FileWorkspace;
    use std::{fs, path::Path};

    #[test]
    fn global_capture_retains_project_original_as_an_independent_library_member() {
        for uploaded in [true, false] {
            let temporary = tempfile::tempdir().unwrap();
            let mut paths = LibraryPaths::init(temporary.path().join("cache")).unwrap();
            paths.files = Some(Arc::new(FileWorkspace::open(
                temporary.path().join("files.json"), temporary.path().join("BowerbirdLibrary"),
            ).unwrap()));
            let db = Database::open_in_memory().unwrap();
            db.migrate().unwrap();
            for id in ["origin", "other"] { db.create_project(id,id,"",id,"blank").unwrap(); }
            let fixture = crate::media::phash::testutil::make_photo_file(temporary.path(),"capture.png",320,7);
            let bytes = fs::read(&fixture).unwrap();
            let capture = |paths: &LibraryPaths| {
                if uploaded { ingest::ingest_from_bytes(paths, &db, &bytes, "https://example.com/image",
                    Some("capture.png"), Some("image/png"), "extension").unwrap() }
                else { ingest::ingest_new_file(paths, &db, &fixture).unwrap() }
            };
            let project_paths = paths.for_project(&db, Some("origin")).unwrap();
            let first = capture(&project_paths);
            finish_image_capture(&db, Some("origin"), &first).unwrap();
            assert!(Path::new(first.store_path.as_ref().unwrap()).starts_with(project_paths.destination.as_ref().unwrap()));
            let global_uses = || db.conn.lock().unwrap().query_row(
                "SELECT COUNT(*) FROM independent_library_assets WHERE asset_id=?1", [&first.id], |row| row.get::<_,i64>(0),
            ).unwrap();
            assert_eq!(global_uses(), 0);
            let another_project = capture(&paths.for_project(&db,Some("other")).unwrap());
            finish_image_capture(&db,Some("other"),&another_project).unwrap();
            assert_eq!(another_project.id,first.id);
            assert_eq!(global_uses(),0);
            let global = capture(&paths);
            assert_eq!(global.id, first.id);
            let before_link = serde_json::to_value(db.get_asset(&global.id).unwrap()).unwrap();
            finish_image_capture(&db,None,&global).unwrap();
            finish_image_capture(&db,None,&global).unwrap();
            assert_eq!(global_uses(),1);
            assert_eq!(serde_json::to_value(db.get_asset(&global.id).unwrap()).unwrap(), before_link);
            assert_eq!(fs::read(global.store_path.as_ref().unwrap()).unwrap(),bytes);
            for project in ["origin","other"] {
                let canvas = db.project_canvas_snapshot(project).unwrap();
                assert_eq!(canvas.nodes.iter().filter(|node| node.asset_id.as_deref()==Some(first.id.as_str())).count(),1);
            }
        }
    }
}

fn asset_result(asset: &crate::core::library::Asset) -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "asset_id": asset.id,
        "name": asset.name,
    })
}

fn save_succeeded(asset: crate::core::library::Asset, state: &AppState) -> serde_json::Value {
    crate::core::autoname::spawn_auto_analyze(state.app.clone(), state.db.clone(), asset.clone());
    let _ = state.app.emit(
        "library://assets-changed",
        serde_json::json!({ "asset_id": asset.id.clone(), "name": asset.name.clone() }),
    );
    serde_json::json!({ "ok": true, "asset_id": asset.id, "name": asset.name })
}

pub async fn start(
    paths: Arc<LibraryPaths>,
    db: Arc<Database>,
    app: AppHandle,
    status: ExtensionStatus,
    active_project: ActiveProjectContext,
) -> Result<(), std::io::Error> {
    let listener = tokio::net::TcpListener::bind(ADDR).await?;
    serve_listener(listener, paths, db, app, status, active_project).await
}

/// Production and isolated acceptance fixtures share the same server; callers own the listener.
pub async fn serve_listener(
    listener: tokio::net::TcpListener,
    paths: Arc<LibraryPaths>,
    db: Arc<Database>,
    app: AppHandle,
    status: ExtensionStatus,
    active_project: ActiveProjectContext,
) -> Result<(), std::io::Error> {
    let state = AppState {
        paths,
        db,
        app: app.clone(),
        status: status.clone(),
        active_project,
        sockets: Arc::new(tokio::sync::Semaphore::new(4)),
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
        .route("/pairing-session", get(|State(state): State<AppState>| async move {
            // Public challenge only. Authorization still requires the current private key.
            (axum::http::StatusCode::NO_CONTENT, [
                ("cache-control", "no-store".to_owned()),
                ("x-bowerbird-session", state.status.pairing.session().simple().to_string()),
            ])
        }))
        .route("/ws", get(ws_handler))
        .with_state(state);
    tracing::info!("collect ws server listening on ws://{}/ws", listener.local_addr()?);
    axum::serve(listener, app).await?;
    Ok(())
}
