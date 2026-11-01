//! One explicit image search; pixels stay local until delivered to Pinterest's own page.
use crate::{core::paths::LibraryPaths, db::Database, error::{AppError, AppResult}};
use base64::Engine;
use image::{ImageDecoder, ImageReader};
use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, path::Path, sync::{Arc, Mutex}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Emitter, Manager, State, Url, Webview};

const ENTRY_URL: &str = "https://www.pinterest.com/";
const SEARCH_EVENT: &str = "source-browser://pinterest-search";
const MAX_BYTES: u64 = 50 * 1024 * 1024;
const CANCEL_SCRIPT: &str = "window.__bowerbirdPinterestSearch?.cancel";

#[derive(Clone, Debug, Serialize)]
struct SearchImage { base64: String, mime: &'static str, name: &'static str }

#[derive(Default)]
struct Searches { pending: Option<Pending>, bridge_token: Option<String>, recent_requests: VecDeque<String> }
struct Pending { request_id: String, image: Option<SearchImage>, document_after: Option<u64> }

#[derive(Default)]
pub struct PinterestSearchState(Mutex<Searches>);

impl Searches {
    fn begin(&mut self, request_id: &str) -> bool {
        if self.matches(request_id) || self.recent_requests.iter().any(|id| id == request_id) { return false; }
        self.remember(request_id);
        self.pending = Some(Pending { request_id: request_id.into(), image: None, document_after: None });
        true
    }
    fn prepare(&mut self, request_id: &str, image: SearchImage) -> bool {
        let Some(pending) = self.pending.as_mut().filter(|p| p.request_id == request_id) else { return false; };
        pending.image = Some(image);
        true
    }
    fn cancel(&mut self, request_id: &str) -> bool {
        self.remember(request_id);
        if !self.matches(request_id) { return false; }
        self.pending = None;
        true
    }
    fn matches(&self, request_id: &str) -> bool {
        self.pending.as_ref().is_some_and(|p| p.request_id == request_id)
    }
    fn navigate(&mut self, request_id: &str, document_after: u64) -> bool {
        let Some(pending) = self.pending.as_mut().filter(|p| p.request_id == request_id && p.image.is_some()) else { return false; };
        pending.document_after = Some(document_after);
        true
    }
    fn remember(&mut self, request_id: &str) {
        if self.recent_requests.iter().any(|id| id == request_id) { return; }
        self.recent_requests.push_back(request_id.into());
        if self.recent_requests.len() > 128 { self.recent_requests.pop_front(); }
    }
}

fn pinterest_origin(url: &Url) -> bool {
    url.scheme() == "https" && url.port_or_known_default() == Some(443)
        && matches!(url.host_str(), Some("pinterest.com" | "www.pinterest.com"))
        && url.username().is_empty() && url.password().is_none()
}

fn allowed_image(path: &Path) -> bool {
    matches!(path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "heic" | "heif")
}

fn prepare_image(paths: &LibraryPaths, db: &Database, asset_id: &str) -> AppResult<SearchImage> {
    let asset = db.get_asset(asset_id)?.ok_or_else(|| AppError::Other("素材已不存在，请重新选择图片".into()))?;
    let original = asset.store_path.as_deref().map(Path::new)
        .filter(|path| allowed_image(path)).ok_or_else(|| AppError::Other("请选择 PNG、JPEG、WebP、GIF、BMP 或 HEIC 图片".into()))?;
    let before = std::fs::metadata(original).map_err(|_| AppError::Other("原图片不可用，请重新定位后再搜图".into()))?;
    if !before.is_file() || before.len() > MAX_BYTES {
        return Err(AppError::Other("搜图图片不能超过 50 MB，请缩小后重试".into()));
    }
    let path = super::library::readable_image_path(paths, db, &original.to_string_lossy())?;
    let mut reader = ImageReader::open(path)?.with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder()?;
    let orientation = decoder.orientation()?;
    let mut image = image::DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    let mut out = std::io::Cursor::new(Vec::new());
    image.thumbnail(1600, 1600).write_to(&mut out, image::ImageFormat::Png)?;
    let after = std::fs::metadata(original)?;
    if before.len() != after.len() || before.modified()? != after.modified()? {
        return Err(AppError::Other("图片正在变化，请稍后重新搜图".into()));
    }
    Ok(SearchImage { base64: base64::engine::general_purpose::STANDARD.encode(out.into_inner()), mime: "image/png", name: "search.png" })
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum SearchStatus { Preparing, WaitingLogin, Searching, Submitted, Error }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Notice { request_id: String, status: SearchStatus, message: Option<String> }

fn emit(app: &AppHandle, request_id: &str, status: SearchStatus, message: Option<&str>) {
    let _ = app.emit_to("main", SEARCH_EVENT, serde_json::json!({ "requestId": request_id, "status": status, "message": message }));
}

fn main_only(webview: &Webview) -> AppResult<()> {
    if webview.label() != "main" { return Err(AppError::Other("请从素材详情或素材菜单发起搜图".into())); }
    Ok(())
}

fn cancel_script(app: &AppHandle, request_id: &str) {
    if let Some(browser) = app.get_webview("source-discovery") {
        if !browser.url().is_ok_and(|url| pinterest_origin(&url)) { return; }
        let id = serde_json::to_string(request_id).expect("string serialization");
        let _ = browser.eval(&format!("if (location.origin === 'https://www.pinterest.com' || location.origin === 'https://pinterest.com') {{ {CANCEL_SCRIPT}({id}); }}"));
    }
}

fn finish_error(app: &AppHandle, request_id: &str, message: &str) {
    if app.state::<PinterestSearchState>().0.lock().unwrap().cancel(request_id) {
        cancel_script(app, request_id);
        emit(app, request_id, SearchStatus::Error, Some(message));
    }
}

#[tauri::command]
pub fn cancel_pinterest_image_search(app: AppHandle, webview: Webview, request_id: String) -> AppResult<()> {
    main_only(&webview)?;
    if request_id.is_empty() || request_id.len() > 128 { return Ok(()); }
    app.state::<PinterestSearchState>().0.lock().unwrap().cancel(&request_id);
    cancel_script(&app, &request_id);
    Ok(())
}

#[tauri::command]
pub async fn start_pinterest_image_search(
    app: AppHandle, webview: Webview, db: State<'_, Arc<Database>>, paths: State<'_, Arc<LibraryPaths>>,
    asset_id: String, request_id: String,
) -> AppResult<()> {
    main_only(&webview)?;
    if request_id.is_empty() || request_id.len() > 128 || asset_id.len() > 128 {
        return Err(AppError::Other("搜图请求无效，请重新选择图片".into()));
    }
    let previous = {
        let state = app.state::<PinterestSearchState>();
        let mut searches = state.0.lock().unwrap();
        let previous = searches.pending.as_ref().map(|p| p.request_id.clone());
        if !searches.begin(&request_id) { return Ok(()); }
        previous
    };
    if let Some(previous) = previous { cancel_script(&app, &previous); }
    emit(&app, &request_id, SearchStatus::Preparing, None);
    expire_later(app.clone(), request_id.clone());
    let db = db.inner().clone(); let paths = paths.inner().clone();
    let result = tokio::task::spawn_blocking(move || prepare_image(&paths, &db, &asset_id)).await;
    let image = match result {
        Ok(Ok(image)) => image,
        error => {
            tracing::warn!(?error, "Pinterest image preparation failed");
            finish_error(&app, &request_id, "无法读取这张图片，请确认原文件可用，或转换为 PNG、JPEG 后重试");
            return Ok(());
        }
    };
    if !app.state::<PinterestSearchState>().0.lock().unwrap().prepare(&request_id, image) { return Ok(()); }
    dispatch(app, request_id);
    Ok(())
}

fn expire_later(app: AppHandle, request_id: String) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(600)).await;
        finish_error(&app, &request_id, "搜图等待已结束，请重新选择图片后重试");
    });
}

fn dispatch(app: AppHandle, request_id: String) {
    let scheduled = app.clone();
    let failed_id = request_id.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if !scheduled.state::<PinterestSearchState>().0.lock().unwrap().matches(&request_id) { return; }
        let Some(browser) = scheduled.get_webview("source-discovery") else {
            finish_error(&scheduled, &request_id, "探索页尚未打开，请重新搜图"); return;
        };
        let document_after = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        if !scheduled.state::<PinterestSearchState>().0.lock().unwrap().navigate(&request_id, document_after) { return; }
        // Pinterest's uploader can ignore change events while an older upload is in flight.
        // Each explicit search gets a fresh document; a late old Finished event is guarded in JS.
        if let Err(error) = browser.navigate(Url::parse(ENTRY_URL).expect("fixed Pinterest URL")) {
            tracing::warn!(%error, "Pinterest navigation failed");
            finish_error(&scheduled, &request_id, "无法打开搜图网页，请检查网络后重试");
        }
    }) {
        tracing::warn!(%error, "Pinterest dispatch failed");
        finish_error(&app, &failed_id, "无法打开搜图网页，请稍后重试");
    }
}

fn inject(browser: &Webview) {
    let app = browser.app_handle();
    let state = app.state::<PinterestSearchState>();
    let searches = state.0.lock().unwrap();
    let Some(pending) = &searches.pending else { return; };
    let Some(image) = &pending.image else { return; };
    let Some(document_after) = pending.document_after else { return; };
    let Some(token) = &searches.bridge_token else { return; };
    if !browser.url().is_ok_and(|url| pinterest_origin(&url)) { return; }
    let payload = serde_json::json!({"requestId": pending.request_id, "base64": image.base64, "mime": image.mime, "name": image.name, "documentAfter": document_after});
    let script = include_str!("source_browser_pinterest.js")
        .replace("__BOWERBIRD_PINTEREST_REQUEST__", &payload.to_string())
        .replace("__BOWERBIRD_PINTEREST_BRIDGE__", &format!("bowerbird-pinterest://{token}"));
    if let Err(error) = browser.eval(&script) {
        let request_id = pending.request_id.clone();
        drop(searches);
        tracing::warn!(%error, "Pinterest injection failed");
        finish_error(app, &request_id, "无法发送搜图图片，请稍后重试");
    }
}

pub fn on_page_finished(browser: &Webview, url: &Url, token: &str) {
    browser.app_handle().state::<PinterestSearchState>().0.lock().unwrap().bridge_token = Some(token.into());
    if pinterest_origin(url) { inject(browser); }
}

fn parse_notice(url: &Url, token: &str) -> Option<Notice> {
    if url.scheme() != "bowerbird-pinterest" || url.host_str() != Some(token) || url.path() != "/status" || url.as_str().len() > 4096 { return None; }
    let data = url.query_pairs().find(|(key, _)| key == "data")?.1;
    let notice: Notice = serde_json::from_str(&data).ok()?;
    (!matches!(notice.status, SearchStatus::Preparing)).then_some(notice)
}

pub fn on_notice(app: &AppHandle, url: &Url, token: &str) {
    let Some(notice) = parse_notice(url, token) else { return; };
    let Some(browser) = app.get_webview("source-discovery") else { return; };
    if !browser.url().is_ok_and(|url| pinterest_origin(&url)) { return; }
    let state = app.state::<PinterestSearchState>();
    let mut searches = state.0.lock().unwrap();
    if !searches.matches(&notice.request_id) { return; }
    if matches!(notice.status, SearchStatus::Submitted | SearchStatus::Error) { searches.cancel(&notice.request_id); }
    drop(searches);
    // Remote-page messages are untrusted diagnostics, never user-facing HTML or paths.
    let message = matches!(notice.status, SearchStatus::Error).then_some("图片搜索未完成，请重试");
    if matches!(notice.status, SearchStatus::Error) { tracing::warn!(message = ?notice.message, "Pinterest page reported failure"); }
    emit(app, &notice.request_id, notice.status, message);
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn image() -> SearchImage { SearchImage { base64: "pixels".into(), mime: "image/png", name: "search.png" } }

    #[test]
    fn newer_search_and_cancel_reject_late_preparation() {
        let mut state = Searches::default();
        assert!(state.begin("first"));
        assert!(!state.navigate("first", 1), "unprepared requests cannot navigate");
        assert!(!state.begin("first"), "same request is idempotent");
        assert!(state.begin("second"));
        assert!(!state.prepare("first", image()));
        assert!(!state.cancel("first"));
        assert!(state.prepare("second", image()));
        assert!(!state.navigate("first", 1));
        assert!(state.navigate("second", 2));
        assert_eq!(state.pending.as_ref().unwrap().document_after, Some(2));
        assert!(state.cancel("second"));
        assert!(!state.cancel("second"));
        assert!(!state.prepare("second", image()));
        assert!(!state.navigate("second", 3));
    }

    #[test]
    fn only_exact_https_pinterest_origins_receive_pixels() {
        for value in ["https://www.pinterest.com/", "https://pinterest.com/login/"] {
            assert!(pinterest_origin(&Url::parse(value).unwrap()), "{value}");
        }
        for value in ["http://www.pinterest.com/", "https://pinterest.com.evil.test/", "https://evil.test/pinterest.com", "https://www.pinterest.com:8443/", "https://user@pinterest.com/", "https://api.pinterest.com/"] {
            assert!(!pinterest_origin(&Url::parse(value).unwrap()), "{value}");
        }
    }

    #[test]
    fn cancellation_before_start_and_old_terminal_requests_cannot_restart() {
        let mut state = Searches::default();
        assert!(!state.cancel("late"));
        assert!(!state.begin("late"), "a cancelled IPC request cannot begin later");
        assert!(state.begin("one"));
        assert!(state.cancel("one"));
        assert!(state.begin("two"));
        assert!(!state.begin("one"), "an older terminal request cannot replace the current one");
        for index in 0..256 { state.cancel(&format!("cancel-{index}")); }
        assert_eq!(state.recent_requests.len(), 128, "bounded replay memory");
        assert!(!state.begin("two"), "the active request stays protected even if older than the replay window");
    }

    #[test]
    fn notice_requires_private_token_and_known_status() {
        let make = |status: &str| {
            let mut url = Url::parse("bowerbird-pinterest://private/status").unwrap();
            url.query_pairs_mut().append_pair("data", &serde_json::json!({ "requestId": "one", "status": status }).to_string());
            url
        };
        for status in ["waiting-login", "searching", "submitted", "error"] {
            assert!(parse_notice(&make(status), "private").is_some());
        }
        for status in ["preparing", "success", "cancelled", "upload-arbitrary-file"] {
            assert!(parse_notice(&make(status), "private").is_none());
        }
        assert!(parse_notice(&make("submitted"), "wrong").is_none());
        let mut wrong_route = make("submitted"); wrong_route.set_path("/start");
        assert!(parse_notice(&wrong_route, "private").is_none());
    }

    #[test]
    fn only_decodable_image_formats_are_offered() {
        for ext in ["jpg", "JPEG", "png", "webp", "gif", "bmp", "heic", "heif"] {
            assert!(allowed_image(Path::new(&format!("photo.{ext}"))));
        }
        for ext in ["mp4", "mp3", "svg", "psd", "avif", "tif", "ico", "bowerbird"] {
            assert!(!allowed_image(Path::new(&format!("photo.{ext}"))));
        }
    }

    #[test]
    fn registered_original_is_bounded_reencoded_and_never_modified() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let paths = LibraryPaths::init(root.join("library")).unwrap();
        let db = Database::open(&paths.db).unwrap(); db.migrate().unwrap();
        let original = root.join("original.png");
        image::RgbaImage::from_pixel(2048, 64, image::Rgba([12, 32, 96, 255])).save(&original).unwrap();
        let before = std::fs::read(&original).unwrap();
        let asset = db.index_connected_file(&paths, &original, None).unwrap();
        db.conn.lock().unwrap().execute("UPDATE assets SET thumb_path='wrong.png' WHERE id=?1", [&asset.id]).unwrap();
        let prepared = prepare_image(&paths, &db, &asset.id).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(&prepared.base64).unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (1600, 50));
        assert_eq!(decoded.to_rgb8().get_pixel(0, 0).0, [12, 32, 96]);
        assert_eq!(before, std::fs::read(&original).unwrap());
        assert!(prepare_image(&paths, &db, original.to_str().unwrap()).is_err(), "paths are not asset IDs");
        std::fs::remove_file(original).unwrap();
        assert!(prepare_image(&paths, &db, &asset.id).is_err());
    }

    #[test]
    fn image_preparation_rejects_oversized_dimensions_files_and_non_images() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let paths = LibraryPaths::init(root.join("library")).unwrap();
        let db = Database::open(&paths.db).unwrap(); db.migrate().unwrap();
        let original = root.join("wide.png");
        image::RgbImage::from_pixel(16385, 1, image::Rgb([12, 32, 96])).save(&original).unwrap();
        let asset = db.index_connected_file(&paths, &original, None).unwrap();
        assert!(prepare_image(&paths, &db, &asset.id).is_err(), "decoder dimension bound");
        std::fs::OpenOptions::new().write(true).open(&original).unwrap().set_len(MAX_BYTES + 1).unwrap();
        assert!(prepare_image(&paths, &db, &asset.id).unwrap_err().to_string().contains("50 MB"));
        db.conn.lock().unwrap().execute("UPDATE assets SET store_path='video.mp4' WHERE id=?1", [&asset.id]).unwrap();
        assert!(prepare_image(&paths, &db, &asset.id).is_err());
    }
}
