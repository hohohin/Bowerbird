//! Capture through the embedded browser network stack: proxy, cookies and cache
//! stay in WebView2. No cookie export or remote-page IPC capability is required.
use crate::{
    core::{ingest, library::Asset, paths::LibraryPaths},
    db::Database,
    error::{AppError, AppResult},
};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, Webview};
use crate::core::local_classification::explorer::ExplorerAnalysis;

fn capture_url(raw: &str) -> AppResult<tauri::Url> {
    let url = super::source_browser::parse_http_source_url(raw)?;
    if raw.len() > 8192 {
        return Err(AppError::Other("图片地址过长".into()));
    }
    Ok(url)
}

use super::source_browser_network::{browser_capture_resource, checked, CaptureResource, SOURCE_ORIGIN_CHANGED};
use super::source_browser_jobs::CaptureControl;
use super::source_browser::{DragNotice, SourceMediaKind};

#[path = "source_browser_admission.rs"]
mod admission;
pub(crate) use admission::CaptureAdmissions;

pub(crate) fn handle_drag_notice(app: &AppHandle, start: bool, notice: DragNotice) {
    if start {
        if let Some(browser) = app.get_webview("source-discovery") {
            if let Ok(current) = browser.url() {
                app.state::<CaptureAdmissions>().remember(&notice, &current);
            }
        }
    }
    if !start || notice.media_kind != Some(SourceMediaKind::Video) {
        crate::core::local_classification::explorer::handle_notice(app, start, notice);
    }
}

#[tauri::command]
pub fn authorize_source_browser_capture(
    webview: Webview,
    admissions: State<'_, CaptureAdmissions>,
    image_url: String,
    page_url: String,
    drag_id: String,
    media_kind: Option<SourceMediaKind>,
) -> AppResult<Option<String>> {
    if webview.label() != "main" {
        return Err(AppError::Other("只允许主窗口确认采集".into()));
    }
    Ok(admissions.authorize(&drag_id, &image_url, &page_url, media_kind.unwrap_or(SourceMediaKind::Image)))
}

fn import_capture(
    paths: &LibraryPaths,
    db: &Database,
    bytes: &[u8],
    page_url: &str,
    project_id: Option<&str>,
    skip_classification: bool,
) -> AppResult<Asset> {
    // The drop's project ID is frozen; switching projects never retargets a download.
    if let Some(id) = project_id {
        if db.get_project(id)?.is_none() {
            return Err(AppError::Other("采集目标项目已被删除，未导入图片".into()));
        }
    }
    let paths = paths.for_project(db, project_id)?;
    let asset = ingest::ingest_from_bytes_with_classification(&paths, db, bytes, page_url, None, None, "extension", !skip_classification)?;
    if let Some(id) = project_id {
        db.add_assets_to_project(id, std::slice::from_ref(&asset.id))?;
    } else {
        db.link_external_to_library(&asset.id)?;
    }
    Ok(asset)
}

fn import_video_capture(paths: &LibraryPaths, db: &Database, bytes: &[u8], media_url: &str, page_url: &str, project_id: Option<&str>) -> AppResult<Asset> {
    let file_name = tauri::Url::parse(media_url).ok().and_then(|url| url.path_segments().and_then(|mut segments| segments.next_back()).map(str::to_owned));
    crate::collect::video_blob::save(paths, db, bytes, &serde_json::json!({
        "media_kind":"video", "requested_url":media_url, "page_url":page_url, "file_name":file_name,
    }), project_id).map_err(|error| {
        tracing::warn!(code=error.code, diagnostic=%error.diagnostic, "explorer video capture failed");
        AppError::Other(error.message.into())
    })
}

fn video_capture_url(raw: &str) -> AppResult<tauri::Url> {
    if let Some(source) = raw.strip_prefix("blob:") {
        capture_url(source)?;
        return tauri::Url::parse(raw).map_err(|_| AppError::Other("视频地址无效，请重新拖入".into()));
    }
    capture_url(raw)
}

#[tauri::command]
pub async fn capture_source_browser_image(
    app: AppHandle,
    webview: Webview,
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    image_url: String,
    page_url: String,
    project_id: Option<String>,
    drag_id: Option<String>,
    media_kind: Option<SourceMediaKind>,
    capture_id: Option<String>,
    skip_classification: Option<bool>,
    admission: Option<String>,
) -> AppResult<Asset> {
    if webview.label() != "main" {
        return Err(AppError::Other("只允许从素材库接收拖入图片".into()));
    }
    let original_image = image_url.clone();
    let original_page = page_url.clone();
    let media_kind = media_kind.unwrap_or(SourceMediaKind::Image);
    let is_video = media_kind == SourceMediaKind::Video;
    let skip_classification = skip_classification.unwrap_or(false);
    let image_url = if is_video { video_capture_url(&image_url)? } else { capture_url(&image_url)? };
    let page_url = capture_url(&page_url)?;
    if image_url.scheme() == "blob" && image_url.origin() != page_url.origin() {
        return Err(AppError::Other("视频来源与当前网页不一致，请重新拖入".into()));
    }
    let browser = app
        .get_webview("source-discovery")
        .ok_or_else(|| AppError::Other("探索浏览器尚未打开".into()))?;
    let in_source_origin = browser
        .url()
        .map_err(|e| AppError::Other(e.to_string()))?
        .origin()
        == page_url.origin();
    let approved = admission.as_deref().zip(drag_id.as_deref()).is_some_and(|(proof, drag_id)| {
        app.state::<CaptureAdmissions>().verify(proof, drag_id, &original_image, &original_page, media_kind)
    });
    if !in_source_origin {
        allow_detached_capture(&image_url, is_video, approved)?;
    }
    if let Some(id) = &project_id {
        if db.get_project(id)?.is_none() {
            return Err(AppError::Other("采集目标项目已不存在".into()));
        }
    }
    let control = CaptureControl::begin(app.clone(), capture_id)?;
    control.report("resolving", 0, None, None, None);
    if is_video {
        let bytes = capture_from_source(&image_url, true, in_source_origin, approved, &control, async {
            super::source_browser_stream::capture_video(&browser, image_url.as_str(), page_url.as_str(), &control).await
        }).await?;
        control.start_saving()?;
        let paths = paths.inner().clone();
        let db = db.inner().clone();
        let asset = tokio::task::spawn_blocking(move || import_video_capture(
            &paths, &db, &bytes, image_url.as_str(), page_url.as_str(), project_id.as_deref(),
        )).await.map_err(|error| AppError::Other(error.to_string()))??;
        let _ = app.emit("library://assets-changed", ());
        for path in [asset.store_path.as_ref(), asset.thumb_path.as_ref()].into_iter().flatten() {
            if let Err(error) = app.asset_protocol_scope().allow_file(path) {
                // The asset is already saved: return it for canvas delivery instead
                // of encouraging a second collection after a preview-only failure.
                tracing::warn!(asset_id=%asset.id, diagnostic=%error, "saved explorer video preview unavailable");
            }
        }
        return Ok(asset);
    }
    let analysis = app.state::<ExplorerAnalysis>();
    if skip_classification {
        if let Some(id) = &drag_id { analysis.release(id); }
    }
    let preview = if skip_classification || !in_source_origin { None } else if let Some(id) = &drag_id {
        analysis.claim(id, &original_image, &original_page);
        super::source_browser_network::checked(&control, async {
            Ok(analysis.bytes(id, &original_image, &original_page).await.ok().flatten())
        }).await?
    } else { None };
    let bytes = match preview {
        Some(bytes) => bytes,
        None => Arc::new(capture_from_source(&image_url, false, in_source_origin, approved, &control, async {
            Ok(browser_capture_resource(&browser, image_url.as_str(), &page_url, 50 * 1024 * 1024, "图片", &control).await?.bytes)
        }).await?),
    };
    control.start_saving()?;
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    let import_db = db.clone();
    let asset = tokio::task::spawn_blocking(move || {
        import_capture(
            &paths,
            &import_db,
            bytes.as_slice(),
            page_url.as_str(),
            project_id.as_deref(),
            skip_classification,
        )
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    if !skip_classification && in_source_origin {
        if let Some(id) = &drag_id { analysis.bind(id, &asset.id); }
    }
    crate::core::autoname::spawn_auto_analyze(app.clone(), db, asset.clone());
    let _ = app.emit("library://assets-changed", ());
    Ok(asset)
}

const SOURCE_DOCUMENT_REQUIRED: &str = "此视频需要原网页，切站后请返回来源并重新拖入。";

async fn capture_from_source(
    url: &tauri::Url,
    is_video: bool,
    in_source_origin: bool,
    approved: bool,
    control: &CaptureControl,
    source: impl std::future::Future<Output = AppResult<Vec<u8>>>,
) -> AppResult<Vec<u8>> {
    if in_source_origin {
        match source.await {
            Err(AppError::Other(message)) if message == SOURCE_ORIGIN_CHANGED => {}
            result => return result,
        }
    }
    allow_detached_capture(url, is_video, approved)?;
    let max_bytes = if is_video { 200 } else { 50 } * 1024 * 1024;
    public_capture_bytes(url.as_str(), max_bytes, is_video, control).await
}

fn allow_detached_capture(url: &tauri::Url, is_video: bool, approved: bool) -> AppResult<()> {
    let path = url.path().to_ascii_lowercase();
    if url.scheme() == "blob" || (is_video && (path.ends_with(".m3u8") || path.ends_with(".mpd"))) {
        return Err(AppError::Other(SOURCE_DOCUMENT_REQUIRED.into()));
    }
    if !approved {
        return Err(AppError::Other("来源页面已切换，请返回来源并重新拖入。".into()));
    }
    Ok(())
}

async fn public_capture_bytes(url: &str, max_bytes: usize, is_video: bool, control: &CaptureControl) -> AppResult<Vec<u8>> {
    // Independent of the new page: no browser session, cookies, persistent
    // proxy, or source Referer. The existing client checks and pins public DNS
    // addresses again at every redirect.
    let response = checked(control, ingest::download_response(url, None, "*/*")).await?;
    read_public_capture(response, max_bytes, is_video, control).await
}

async fn read_public_capture(response: reqwest::Response, max_bytes: usize, is_video: bool, control: &CaptureControl) -> AppResult<Vec<u8>> {
    use futures_util::StreamExt;
    let media = if is_video { "视频" } else { "图片" };
    if !response.status().is_success() || response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(AppError::Other(format!("无法公开下载此{media}，请返回来源网页后重试。")));
    }
    let mut resource = CaptureResource {
        url: response.url().to_string(),
        bytes: Vec::new(),
        content_type: response.headers().get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()).unwrap_or_default().into(),
        total_bytes: response.content_length(),
    };
    if is_video && resource.is_manifest() {
        return Err(AppError::Other(SOURCE_DOCUMENT_REQUIRED.into()));
    }
    let too_large = || AppError::Other(format!("{media}超过采集大小限制。"));
    if resource.total_bytes.is_some_and(|total| total > max_bytes as u64) {
        return Err(too_large());
    }
    control.report("downloading", 0, resource.total_bytes, None, None);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = checked(control, async {
        stream.next().await.transpose().map_err(|error| {
            tracing::warn!(diagnostic=%error.without_url(), "explorer public media download interrupted");
            AppError::Other(format!("{media}下载中断，请重试。"))
        })
    }).await? {
        if resource.bytes.len() + chunk.len() > max_bytes {
            return Err(too_large());
        }
        let reading_prefix = resource.bytes.len() < 2048;
        resource.bytes.extend_from_slice(&chunk);
        if is_video && reading_prefix && resource.is_manifest() {
            return Err(AppError::Other(SOURCE_DOCUMENT_REQUIRED.into()));
        }
        control.report("downloading", resource.bytes.len() as u64, resource.total_bytes, None, None);
    }
    if resource.bytes.is_empty() || resource.total_bytes.is_some_and(|total| resource.bytes.len() as u64 != total) {
        return Err(AppError::Other(format!("网站未返回完整{media}，请重试。")));
    }
    Ok(resource.bytes)
}

#[tauri::command]
pub fn claim_source_browser_analysis(
    app: AppHandle, webview: Webview, analysis: State<'_, ExplorerAnalysis>, drag_id: String, image_url: String, page_url: String,
) -> AppResult<bool> {
    if webview.label() != "main" { return Err(AppError::Other("只允许主窗口确认采集".into())); }
    capture_url(&image_url)?;
    let page = capture_url(&page_url)?;
    if !app.state::<Arc<Database>>().local_enabled()? {
        analysis.release(&drag_id);
        return Ok(false);
    }
    // A missed/expired dragstart must not silently turn off classification.
    if app.get_webview("source-discovery").and_then(|browser| browser.url().ok())
        .is_none_or(|current| current.origin() != page.origin()) {
        analysis.release(&drag_id);
        return Ok(false);
    }
    if !analysis.claim(&drag_id, &image_url, &page_url) {
        analysis.begin(&app, drag_id.clone(), image_url.clone(), page_url.clone()).map_err(AppError::Other)?;
    }
    Ok(analysis.claim(&drag_id, &image_url, &page_url))
}

#[tauri::command]
pub fn release_source_browser_analysis(webview: Webview, analysis: State<'_, ExplorerAnalysis>, drag_id: String) -> AppResult<()> {
    if webview.label() != "main" { return Err(AppError::Other("只允许主窗口取消采集".into())); }
    analysis.release(&drag_id);
    Ok(())
}

#[tauri::command]
pub async fn finish_source_browser_analysis(
    app: AppHandle, webview: Webview, analysis: State<'_, ExplorerAnalysis>, drag_id: String, asset_id: String,
) -> AppResult<Vec<String>> {
    if webview.label() != "main" { return Err(AppError::Other("只允许主窗口完成采集".into())); }
    analysis.finish(&app, &drag_id, &asset_id).await.map_err(AppError::Other)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn source_browser_detached_fetch_requires_admission_and_public_addresses() {
        let control = CaptureControl::detached();
        let private = capture_url("http://127.0.0.1/photo.jpg").unwrap();
        let source = || async { Err(AppError::Other(SOURCE_ORIGIN_CHANGED.into())) };
        let error = capture_from_source(&private, false, true, false, &control, source()).await.unwrap_err();
        assert!(error.to_string().contains("请返回来源"), "{error}");
        let error = capture_from_source(&private, false, true, true, &control, source()).await.unwrap_err();
        assert!(error.to_string().contains("unsafe or invalid download url"), "{error}");
    }

    #[tokio::test]
    async fn source_browser_public_response_can_save_exact_image_bytes_to_frozen_project() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::init(temp.path().join("library")).unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.create_project("original", "Original", "", "original", "blank").unwrap();
        db.create_project("later", "Later", "", "later", "blank").unwrap();
        let photo = crate::media::phash::testutil::make_photo_file(temp.path(), "photo.png", 32, 18);
        let bytes = std::fs::read(photo).unwrap();
        let response = tauri::http::Response::builder()
            .header(reqwest::header::CONTENT_TYPE, "image/png")
            .body(bytes.clone()).unwrap().into();
        let control = CaptureControl::detached();
        let downloaded = read_public_capture(response, bytes.len(), false, &control).await.unwrap();
        control.start_saving().unwrap();
        let asset = import_capture(&paths, &db, &downloaded, "https://example.com/pin", Some("original"), true).unwrap();
        assert_eq!(std::fs::read(asset.store_path.unwrap()).unwrap(), bytes);
        assert_eq!(db.get_project("original").unwrap().unwrap().asset_count, 1);
        assert_eq!(db.get_project("later").unwrap().unwrap().asset_count, 0);
    }

    #[tokio::test]
    async fn source_browser_public_response_rejects_an_extensionless_video_manifest() {
        let response = tauri::http::Response::new("#EXTM3U\n#EXTINF:1.0,\nclip.ts".to_string()).into();
        let error = read_public_capture(response, 1024, true, &CaptureControl::detached()).await.unwrap_err();
        assert_eq!(error.to_string(), SOURCE_DOCUMENT_REQUIRED);
    }

    #[test]
    fn source_browser_detached_fetch_never_replays_blob_or_playlists() {
        for raw in ["blob:https://example.com/id", "https://example.com/stream.M3U8", "https://example.com/stream.mpd"] {
            let url = video_capture_url(raw).unwrap();
            assert_eq!(allow_detached_capture(&url, true, true).unwrap_err().to_string(), SOURCE_DOCUMENT_REQUIRED);
        }
        let direct = video_capture_url("https://example.com/clip.mp4").unwrap();
        assert!(allow_detached_capture(&direct, true, true).is_ok());
    }
    #[test]
    fn global_explorer_capture_reuses_a_project_file_and_persists_a_missing_recapture() {
        let temporary = tempfile::tempdir().unwrap();
        let mut paths = LibraryPaths::init(temporary.path().join("cache")).unwrap();
        paths.files = Some(Arc::new(crate::core::file_workspace::FileWorkspace::open(
            temporary.path().join("files.json"),temporary.path().join("BowerbirdLibrary"),
        ).unwrap()));
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.create_project("p","Project","","p","blank").unwrap();
        let photo = crate::media::phash::testutil::make_photo_file(temporary.path(),"photo.png",320,7);
        let bytes = std::fs::read(photo).unwrap();
        let capture = |project| import_capture(&paths,&db,&bytes,"https://example.com/photo",project,false).unwrap();
        let first = capture(Some("p"));
        let global = capture(None);
        assert_eq!(global.id,first.id);
        let independent: bool = db.conn.lock().unwrap().query_row(
            "SELECT EXISTS(SELECT 1 FROM independent_library_assets WHERE asset_id=?1)",[&global.id],|row| row.get(0),
        ).unwrap();
        assert!(independent);
        std::fs::remove_file(first.store_path.as_ref().unwrap()).unwrap();
        let recaptured = capture(None);
        assert_ne!(recaptured.id,first.id);
        assert!(std::path::Path::new(recaptured.store_path.as_ref().unwrap()).starts_with(
            paths.files.as_ref().unwrap().ensure_root().unwrap().join("收集箱")));
        assert_eq!(std::fs::read(recaptured.store_path.as_ref().unwrap()).unwrap(),bytes);
    }

    #[test]
    fn source_browser_video_capture_saves_real_video_to_frozen_project() {
        let temporary = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::init(temporary.path().to_owned()).unwrap();
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.create_project("original", "Original", "", "original", "blank").unwrap();
        db.create_project("later", "Later", "", "later", "blank").unwrap();
        let bytes = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/media/fragmented.mp4")).unwrap();
        let media = "https://cdn.example.com/clip.mp4";
        let page = "https://example.com/watch/1";
        let asset = import_video_capture(&paths, &db, &bytes, media, page, Some("original")).expect("dragging a real video must save video bytes");
        assert_eq!(asset.ext.as_deref(), Some("mp4"));
        assert!(asset.width.unwrap_or(0) > 0 && asset.height.unwrap_or(0) > 0 && asset.duration.unwrap_or(0.0) > 0.0);
        assert_eq!(std::fs::read(asset.store_path.as_ref().unwrap()).unwrap(), bytes);
        assert_eq!(asset.source.as_deref(), Some("extension"));
        assert_eq!(asset.source_url.as_deref(), Some(page));
        assert!(asset.origin_path.is_none());
        assert_eq!(db.get_project("original").unwrap().unwrap().asset_count, 1);
        assert_eq!(db.get_project("later").unwrap().unwrap().asset_count, 0);
        let repeated = import_video_capture(&paths, &db, &bytes, media, page, Some("original")).unwrap();
        assert_eq!(repeated.id, asset.id);
        let conn = db.conn.lock().unwrap();
        let captured: String = conn.query_row("SELECT payload FROM analyses WHERE asset_id=?1 AND kind='extension_capture'", [&asset.id], |row| row.get(0)).unwrap();
        let captured: serde_json::Value = serde_json::from_str(&captured).unwrap();
        assert_eq!(captured["requested_url"], media);
        assert_eq!(captured["page_url"], page);
    }

    #[test]
    fn source_browser_video_capture_rejects_posters_and_deleted_projects() {
        let temporary = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::init(temporary.path().to_owned()).unwrap();
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        let image = crate::media::phash::testutil::make_photo_file(temporary.path(), "poster.png", 32, 42);
        let bytes = std::fs::read(image).unwrap();
        for bytes in [bytes, b"<html>Login</html>".to_vec(), b"#EXTM3U\nclip.ts".to_vec()] {
            assert!(import_video_capture(&paths, &db, &bytes, "https://cdn.example/clip.mp4", "https://example/watch", None).is_err());
        }
        let video = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/media/fragmented.mp4")).unwrap();
        assert!(import_video_capture(&paths, &db, &video, "https://cdn.example/clip.mp4", "https://example/watch", Some("deleted")).is_err());
        assert_eq!(db.count_assets(None).unwrap(), 0);
    }

    #[test]
    fn source_browser_video_url_accepts_owned_media_schemes_only() {
        for raw in ["file:///clip.mp4", "https://user:pw@example.com/clip.mp4", "blob:file:///clip", "blob:https://user:pw@example.com/clip", "blob:null/id"] {
            assert!(video_capture_url(raw).is_err(), "{raw}");
        }
        assert!(video_capture_url("https://cdn.example.com/media?id=1").is_ok());
        for raw in ["blob:https://example.com/clip", "https://example.com/list.M3U8?token=x", "https://example.com/list.mpd"] {
            assert!(video_capture_url(raw).is_ok(), "{raw}");
        }
    }
    #[test]
    fn explicit_tag_capture_skips_auto_queue_for_new_and_duplicate_images() {
        let temporary = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::init(temporary.path().to_owned()).unwrap();
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.set_local_enabled(true).unwrap();
        let url = "https://example.com/pin/123";
        let ordinary_bytes = std::fs::read(crate::media::phash::testutil::make_photo_file(temporary.path(), "ordinary.png", 128, 42)).unwrap();
        let tagged_bytes = std::fs::read(crate::media::phash::testutil::make_photo_file(temporary.path(), "tagged.png", 128, 98)).unwrap();
        let ordinary = import_capture(&paths, &db, &ordinary_bytes, url, None, false).unwrap();
        let tagged = import_capture(&paths, &db, &tagged_bytes, url, None, true).unwrap();
        assert_ne!(ordinary.id, tagged.id);
        assert_eq!(db.local_auto_targets("test").unwrap(), vec![ordinary.id.clone()]);
        let pending: Vec<String> = db.conn.lock().unwrap().prepare("SELECT asset_id FROM local_auto_classification_pending").unwrap()
            .query_map([], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(pending, vec![ordinary.id.clone()], "manual capture is never queued before tag delivery");
        let tag = db.save_local_label(None, "指定标签", "", true).unwrap();
        db.local_example(&tag, std::slice::from_ref(&tagged.id), true).unwrap();
        let origin: String = db.conn.lock().unwrap().query_row("SELECT origin FROM asset_tags WHERE asset_id=?1 AND tag_id=?2",
            rusqlite::params![tagged.id, tag], |row| row.get(0)).unwrap();
        assert_eq!(origin, "manual");
        let repeated = import_capture(&paths, &db, &ordinary_bytes, url, None, true).unwrap();
        assert_eq!(repeated.id, ordinary.id);
        assert!(db.local_auto_targets("test").unwrap().is_empty());
        assert!(db.local_enabled().unwrap(), "a tag drop does not change the global opt-in");
    }

    #[test]
    fn capture_import_preserves_extension_provenance_and_project_membership() {
        let root = std::env::temp_dir().join(format!("bb-explorer-test-{}", ulid::Ulid::new()));
        let paths = LibraryPaths::init(root.clone()).unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.create_project("target", "target", "", "target", "blank")
            .unwrap();
        db.create_project("other", "other", "", "other", "blank")
            .unwrap();
        let image = crate::media::phash::testutil::make_photo_file(&root, "fixture.png", 128, 42);
        let bytes = std::fs::read(image).unwrap();
        let url = "https://example.com/pin/123";
        assert!(import_capture(&paths, &db, &bytes, url, Some("deleted"), false).is_err());
        assert_eq!(db.count_assets(None).unwrap(), 0);
        let asset = import_capture(&paths, &db, &bytes, url, Some("target"), false).unwrap();
        assert_eq!(asset.source.as_deref(), Some("extension"));
        assert_eq!(asset.source_url.as_deref(), Some(url));
        assert_eq!(asset.origin_path, None);
        assert!(asset
            .thumb_path
            .as_deref()
            .is_some_and(|path| std::path::Path::new(path).is_file()));
        assert_eq!(db.get_project("target").unwrap().unwrap().asset_count, 1);
        assert_eq!(db.get_project("other").unwrap().unwrap().asset_count, 0);
        let repeated = import_capture(&paths, &db, &bytes, url, Some("target"), false).unwrap();
        assert_eq!(repeated.id, asset.id);
        assert_eq!(db.count_assets(None).unwrap(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn capture_rejects_privileged_urls_and_credentials() {
        for url in [
            "file:///c:/secret",
            "javascript:alert(1)",
            "https://user:pw@example.com/a",
            "data:image/png;base64,a",
        ] {
            assert!(capture_url(url).is_err());
        }
        assert!(capture_url("https://i.pinimg.com/image.png?token=x").is_ok());
    }
}
