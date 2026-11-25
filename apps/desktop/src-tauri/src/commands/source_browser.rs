use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl,
};
use tokio::sync::{watch, Mutex};

use crate::error::{AppError, AppResult};

#[path = "source_browser_overlay.rs"]
mod overlay;

const MAIN_WEBVIEW_LABEL: &str = "main";
const SOURCE_BROWSER_LABEL: &str = "source-discovery";
const SOURCE_BROWSER_STATUS_EVENT: &str = "source-browser://status";
const SOURCE_BROWSER_LOCATION_EVENT: &str = "source-browser://location";
const SOURCE_BROWSER_TITLE_EVENT: &str = "source-browser://title";
const SOURCE_BROWSER_NEW_WINDOW_EVENT: &str = "source-browser://new-window";
static SOURCE_BROWSER_DIMMED: AtomicBool = AtomicBool::new(false);

#[path = "source_browser_site_rules.rs"]
pub(crate) mod site_rules;

#[derive(Default)]
struct SourceBrowserLifecycle(Mutex<Weak<SourceBrowserVisibility>>);

#[derive(Clone, Copy, PartialEq, Eq)]
enum SourceBrowserActivity { Visible, Hidden, Closed }

struct SourceBrowserVisibility(watch::Sender<SourceBrowserActivity>);
impl tauri::Resource for SourceBrowserVisibility {}

fn source_browser_lifecycle(app: &AppHandle) -> tauri::State<'_, SourceBrowserLifecycle> {
    if app.try_state::<SourceBrowserLifecycle>().is_none() {
        app.manage(SourceBrowserLifecycle::default());
    }
    app.state()
}

fn set_source_browser_activity(signal: &Weak<SourceBrowserVisibility>, activity: SourceBrowserActivity) {
    if let Some(signal) = signal.upgrade() {
        signal.0.send_if_modified(|current| {
            let changed = *current != activity;
            *current = activity;
            changed
        });
    }
}

// Optional hooks keep the isolated explorer fixture independent of the library.
pub struct SourcePinterestHooks {
    pub loaded: fn(&tauri::Webview, &Url, &str),
    pub notice: fn(&AppHandle, &Url, &str),
}

fn spotlight_script() -> String {
    include_str!("source_browser_spotlight.js").replace(
        "__BOWERBIRD_DIMMED__",
        if SOURCE_BROWSER_DIMMED.load(Ordering::Relaxed) { "true" } else { "false" },
    )
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceBrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    overlay: Option<overlay::OverlayBounds>,
}

#[derive(Clone, Debug, Serialize)]
struct SourceBrowserStatus {
    url: String,
    loading: bool,
}

pub(super) fn parse_http_source_url(raw: &str) -> AppResult<Url> {
    let url = Url::parse(raw.trim())
        .map_err(|_| AppError::Other("来源网址无效，无法在应用内打开".to_string()))?;
    if !navigation_allowed(&url) {
        return Err(AppError::Other(
            "素材发现只允许打开不含登录凭据的 HTTP(S) 来源网页".to_string(),
        ));
    }
    Ok(url)
}

fn navigation_allowed(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

fn validate_bounds(bounds: SourceBrowserBounds) -> AppResult<SourceBrowserBounds> {
    let values = [bounds.x, bounds.y, bounds.width, bounds.height];
    if values.iter().any(|value| !value.is_finite())
        || bounds.x < 0.0
        || bounds.y < 0.0
        || !(240.0..=10_000.0).contains(&bounds.width)
        || !(180.0..=10_000.0).contains(&bounds.height)
    {
        return Err(AppError::Other("素材发现面板尺寸无效".to_string()));
    }
    if bounds.overlay.is_some_and(|rect| !rect.valid(bounds.width, bounds.height)) {
        return Err(AppError::Other("素材发现面板尺寸无效".into()));
    }
    Ok(bounds)
}

async fn set_bounds(webview: &tauri::Webview, bounds: SourceBrowserBounds) -> AppResult<()> {
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|error| tauri_error("定位素材发现面板失败", error))?;
    webview
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|error| tauri_error("调整素材发现面板失败", error))?;
    overlay::apply(webview, bounds).await
}

fn emit_status(app: &AppHandle, url: &Url, loading: bool) {
    let _ = app.emit_to(
        MAIN_WEBVIEW_LABEL,
        SOURCE_BROWSER_STATUS_EVENT,
        SourceBrowserStatus {
            url: url.to_string(),
            loading,
        },
    );
}

// SPA history changes do not emit page-load events. Read the native location
// without granting the remote page IPC or changing the loading indicator.
fn watch_source_location(
    app: AppHandle,
    resource: tauri::ResourceId,
    owner: Weak<SourceBrowserVisibility>,
    mut activity: watch::Receiver<SourceBrowserActivity>,
) {
    tauri::async_runtime::spawn(async move {
        let mut previous = None;
        loop {
            let current = *activity.borrow_and_update();
            match current {
                SourceBrowserActivity::Closed => break,
                SourceBrowserActivity::Hidden => {
                    if activity.changed().await.is_err() { break; }
                    continue;
                }
                SourceBrowserActivity::Visible => {}
            }
            let Some(webview) = app.get_webview(SOURCE_BROWSER_LABEL) else { break; };
            let identity = webview.resources_table().get::<SourceBrowserVisibility>(resource);
            if !identity.is_ok_and(|signal| owner.ptr_eq(&Arc::downgrade(&signal))) { break; }
            let Ok(url) = webview.url() else { break; };
            drop(webview);
            if *activity.borrow() == SourceBrowserActivity::Visible
                && previous.as_ref() != Some(&url) && navigation_allowed(&url)
            {
                let _ = app.emit_to(MAIN_WEBVIEW_LABEL, SOURCE_BROWSER_LOCATION_EVENT, url.as_str());
                previous = Some(url);
            }
            tokio::select! {
                biased;
                changed = activity.changed() => if changed.is_err() { break; },
                _ = tokio::time::sleep(Duration::from_millis(500)) => {},
            }
        }
    });
}

fn tauri_error(context: &str, error: tauri::Error) -> AppError {
    AppError::Other(format!("{context}: {error}"))
}

/// 在主窗口的工作区中创建或复用一个无 Bowerbird IPC 权限的原生子 WebView。
///
/// 远程页面只能导航 HTTP(S)。下载与原生弹窗均被拒绝；target=_blank 的地址会交给
/// 本地 React 面板后再导航到同一子 WebView，避免逃逸成新的浏览器窗口。
#[tauri::command]
pub async fn open_source_browser(
    app: AppHandle,
    url: String,
    bounds: SourceBrowserBounds,
) -> AppResult<()> {
    let url = parse_http_source_url(&url)?;
    let bounds = validate_bounds(bounds)?;
    let lifecycle = source_browser_lifecycle(&app);
    let mut visibility = lifecycle.0.lock().await;

    if let Some(webview) = app.get_webview(SOURCE_BROWSER_LABEL) {
        set_bounds(&webview, bounds).await?;
        // Reopening resumes the live document. Explicit navigation has its own command.
        webview
            .show()
            .map_err(|error| tauri_error("显示素材发现面板失败", error))?;
        set_source_browser_activity(&visibility, SourceBrowserActivity::Visible);
        webview
            .set_focus()
            .map_err(|error| tauri_error("聚焦素材发现面板失败", error))?;
        return Ok(());
    }

    let main_window = app
        .get_window(MAIN_WEBVIEW_LABEL)
        .ok_or_else(|| AppError::Other("找不到 Bowerbird 主窗口".to_string()))?;
    let data_directory = app
        .path()
        .app_data_dir()
        .map_err(|error| tauri_error("读取应用数据目录失败", error))?
        .join("source-browser");
    #[cfg(debug_assertions)]
    let data_directory = std::env::var_os("BOWERBIRD_EXPLORER_TEST_DATA_DIR")
        .map(std::path::PathBuf::from).unwrap_or(data_directory);

    let navigation_app = app.clone();
    let page_load_app = app.clone();
    let title_app = app.clone();
    let new_window_app = app.clone();
    // A private, narrowly-scoped notification route; no remote Tauri IPC.
    let drag_token = ulid::Ulid::new().to_string().to_ascii_lowercase();
    let drag_script = site_rules::render(include_str!("source_browser_drag.js"))
        .replace("__BOWERBIRD_DRAG_BRIDGE__", &format!("bowerbird-explorer://{drag_token}"));
    let popup_drag_token = drag_token.clone();
    let page_search_token = drag_token.clone();
    let pinterest_chrome = site_rules::render(include_str!("source_browser_pinterest_chrome.js"))
        .replace("__BOWERBIRD_SCROLLBAR_RUNTIME__", include_str!("../../../src/lib/overlayScrollbars.js"))
        .replace("__BOWERBIRD_SCROLLBAR_CSS__", &serde_json::to_string(include_str!("../../../src/components/OverlayScrollbars.css")).expect("static CSS"));
    let builder = WebviewBuilder::new(SOURCE_BROWSER_LABEL, WebviewUrl::External(url))
        .data_directory(data_directory)
        .disable_drag_drop_handler()
        .initialization_script(include_str!("../../../../extension/candidate-utils.js"))
        .initialization_script(include_str!("../../../src/lib/explorerDragVisual.js"))
        .initialization_script(site_rules::render(include_str!("source_browser_video.js")))
        .initialization_script(site_rules::render(include_str!("source_browser_pinterest_layout.js")))
        .initialization_script(&pinterest_chrome)
        .initialization_script(&drag_script)
        .on_navigation(move |url| {
            if url.scheme() == "bowerbird-pinterest" {
                if let Some(hooks) = navigation_app.try_state::<SourcePinterestHooks>() {
                    (hooks.notice)(&navigation_app, url, &drag_token);
                }
                return false;
            }
            if url.scheme() == "bowerbird-explorer" {
                handle_drag_notice(&navigation_app, url, &drag_token);
                return false;
            }
            let allowed = navigation_allowed(url);
            if allowed {
                emit_status(&navigation_app, url, true);
            }
            allowed
        })
        .on_page_load(move |webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = webview.eval(&spotlight_script());
            }
            // Started is new-document ContentLoading/didCommit; Lens must not wait
            // for unrelated images to finish. The adapter polls and deduplicates.
            if let Some(hooks) = page_load_app.try_state::<SourcePinterestHooks>() {
                (hooks.loaded)(&webview, payload.url(), &page_search_token);
            }
            emit_status(
                &page_load_app,
                payload.url(),
                matches!(payload.event(), PageLoadEvent::Started),
            );
        })
        .on_document_title_changed(move |_, title| {
            let _ = title_app.emit_to(MAIN_WEBVIEW_LABEL, SOURCE_BROWSER_TITLE_EVENT, title);
        })
        .on_new_window(move |url, _| {
            if url.scheme() == "bowerbird-pinterest" {
                if let Some(hooks) = new_window_app.try_state::<SourcePinterestHooks>() {
                    (hooks.notice)(&new_window_app, &url, &popup_drag_token);
                }
                return NewWindowResponse::Deny;
            }
            if url.scheme() == "bowerbird-explorer" {
                handle_drag_notice(&new_window_app, &url, &popup_drag_token);
                return NewWindowResponse::Deny;
            }
            if navigation_allowed(&url) {
                let _ = new_window_app.emit_to(
                    MAIN_WEBVIEW_LABEL,
                    SOURCE_BROWSER_NEW_WINDOW_EVENT,
                    url.to_string(),
                );
            }
            NewWindowResponse::Deny
        })
        .on_download(|_, event| !matches!(event, DownloadEvent::Requested { .. }));

    #[cfg(debug_assertions)]
    let builder = match std::env::var("BOWERBIRD_EXPLORER_TEST_DEBUG_PORT") {
        Ok(port) if port.parse::<u16>().is_ok() => builder.additional_browser_args(
            &format!("--remote-debugging-port={port} --remote-debugging-address=127.0.0.1")
        ),
        _ => builder,
    };

    let webview = main_window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|error| tauri_error("创建素材发现面板失败", error))?;
    set_source_browser_activity(&visibility, SourceBrowserActivity::Closed);
    let (sender, receiver) = watch::channel(SourceBrowserActivity::Visible);
    let signal = Arc::new(SourceBrowserVisibility(sender));
    *visibility = Arc::downgrade(&signal);
    // The last native view handle releases the sender, including while hidden.
    let resource = webview.resources_table().add_arc(signal);
    let window_activity = visibility.clone();
    main_window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            set_source_browser_activity(&window_activity, SourceBrowserActivity::Closed);
        }
    });
    watch_source_location(app.clone(), resource, visibility.clone(), receiver);
    overlay::apply(&webview, bounds).await?;
    webview
        .set_focus()
        .map_err(|error| tauri_error("聚焦素材发现面板失败", error))?;
    Ok(())
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SourceMediaKind { Image, Video }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DragNotice {
    pub id: String,
    pub image_url: Option<String>,
    pub page_url: Option<String>,
    pub media_kind: Option<SourceMediaKind>,
    pub poster_url: Option<String>,
}

pub struct SourceDragHandler(pub fn(&AppHandle, bool, DragNotice));

fn parse_drag_notice(url: &Url, token: &str) -> Option<DragNotice> {
    if url.scheme() != "bowerbird-explorer" || url.host_str() != Some(token)
        || !matches!(url.path(), "/start" | "/end") || url.as_str().len() > 50_000 { return None; }
    let payload = url.query_pairs().find(|(key, _)| key == "data")?.1;
    let notice: DragNotice = serde_json::from_str(&payload).ok()?;
    if notice.id.len() != 32 || !notice.id.bytes().all(|c| c.is_ascii_hexdigit()) { return None; }
    if url.path() == "/start" {
        let media = notice.image_url.as_deref()?;
        let page = notice.page_url.as_deref()?;
        if page.len() > 8192 || parse_http_source_url(page).is_err() || media.len() > 8192 { return None; }
        // Blob metadata stays in the drag bridge; the authorized drop resolves
        // bytes or an associated manifest in its source document, never a poster.
        let checked = if notice.media_kind == Some(SourceMediaKind::Video) { media.strip_prefix("blob:").unwrap_or(media) } else { media };
        if parse_http_source_url(checked).is_err() { return None; }
        if let Some(poster) = &notice.poster_url {
            if poster.len() > 8192 || parse_http_source_url(poster).is_err() { return None; }
        }
    }
    Some(notice)
}

fn handle_drag_notice(app: &AppHandle, url: &Url, token: &str) {
    let Some(notice) = parse_drag_notice(url, token) else { return; };
    let start = url.path() == "/start";
    let _ = app.emit_to(MAIN_WEBVIEW_LABEL, "source-browser://drag", serde_json::json!({
        "phase": if start { "start" } else { "end" }, "id": notice.id,
        "imageUrl": notice.image_url,
        "mediaKind": notice.media_kind,
        "posterUrl": notice.poster_url,
    }));
    if let Some(handler) = app.try_state::<SourceDragHandler>() { (handler.0)(app, start, notice); }
}

#[tauri::command]
pub async fn resize_source_browser(app: AppHandle, bounds: SourceBrowserBounds, visible: Option<bool>, dimmed: Option<bool>) -> AppResult<()> {
    let bounds = validate_bounds(bounds)?;
    let lifecycle = source_browser_lifecycle(&app);
    let visibility = lifecycle.0.lock().await;
    if let Some(dimmed) = dimmed {
        SOURCE_BROWSER_DIMMED.store(dimmed, Ordering::Relaxed);
    }
    if let Some(webview) = app.get_webview(SOURCE_BROWSER_LABEL) {
        if dimmed.is_some() {
            webview.eval(&spotlight_script())
                .map_err(|error| tauri_error("更新探索引导遮罩失败", error))?;
        }
        set_bounds(&webview, bounds).await?;
        if let Some(visible) = visible {
            if visible { webview.show() } else { webview.hide() }
                .map_err(|error| tauri_error("更新探索面板显示失败", error))?;
            set_source_browser_activity(&visibility, if visible { SourceBrowserActivity::Visible } else { SourceBrowserActivity::Hidden });
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn navigate_source_browser(app: AppHandle, url: String) -> AppResult<()> {
    let url = parse_http_source_url(&url)?;
    let webview = app
        .get_webview(SOURCE_BROWSER_LABEL)
        .ok_or_else(|| AppError::Other("素材发现面板尚未打开".to_string()))?;
    webview
        .navigate(url)
        .map_err(|error| tauri_error("打开网址失败", error))
}

#[tauri::command]
pub async fn source_browser_back(app: AppHandle) -> AppResult<()> {
    move_source_browser_history(app, true).await
}

#[tauri::command]
pub async fn source_browser_forward(app: AppHandle) -> AppResult<()> {
    move_source_browser_history(app, false).await
}

async fn move_source_browser_history(app: AppHandle, back: bool) -> AppResult<()> {
    let Some(webview) = app.get_webview(SOURCE_BROWSER_LABEL) else { return Ok(()); };
    let action = if back { "返回上一页失败" } else { "前往下一页失败" };
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        webview.with_webview(move |view| {
            #[cfg(target_os = "windows")]
            let result = (|| unsafe {
                let browser = view.controller().CoreWebView2()?;
                let mut can_go = windows_core::BOOL::default();
                if back { browser.CanGoBack(&mut can_go)?; }
                else { browser.CanGoForward(&mut can_go)?; }
                if can_go.as_bool() {
                    if back { browser.GoBack()?; } else { browser.GoForward()?; }
                }
                Ok::<_, windows_core::Error>(can_go.as_bool())
            })().map_err(|error| AppError::Other(format!("{action}：{error}")));
            #[cfg(target_os = "macos")]
            let result: AppResult<bool> = unsafe {
                #[link(name = "bowerbird_browser_capture", kind = "static")]
                unsafe extern "C" {
                    fn bb_browser_go_history(view: *mut std::ffi::c_void, back: bool) -> bool;
                }
                Ok(bb_browser_go_history(view.inner(), back))
            };
            let _ = sender.send(result);
        }).map_err(|error| tauri_error(action, error))?;
        if !receiver.await.map_err(|_| AppError::Other("探索窗口已关闭".into()))?? {
            let message = if back { "没有可返回的上一页" } else { "没有可前往的下一页" };
            return Err(AppError::Other(message.into()));
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    webview.eval(if back { "history.back()" } else { "history.forward()" })
        .map_err(|error| tauri_error(action, error))
}

#[tauri::command]
pub async fn reload_source_browser(app: AppHandle) -> AppResult<()> {
    if let Some(webview) = app.get_webview(SOURCE_BROWSER_LABEL) {
        webview
            .reload()
            .map_err(|error| tauri_error("刷新网页失败", error))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn hide_source_browser(app: AppHandle) -> AppResult<()> {
    let lifecycle = source_browser_lifecycle(&app);
    let visibility = lifecycle.0.lock().await;
    if let Some(webview) = app.get_webview(SOURCE_BROWSER_LABEL) {
        webview
            .hide()
            .map_err(|error| tauri_error("关闭素材发现面板失败", error))?;
        set_source_browser_activity(&visibility, SourceBrowserActivity::Hidden);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_browser_video_notice_keeps_explicit_media_type() {
        let mut url = Url::parse("bowerbird-explorer://private/start").unwrap();
        url.query_pairs_mut().append_pair("data", &serde_json::json!({
            "id":"a".repeat(32), "imageUrl":"https://cdn.example.com/clip.mp4", "pageUrl":"https://example.com/watch/1",
            "mediaKind":"video", "posterUrl":"https://cdn.example.com/cover.jpg"
        }).to_string());
        let notice = parse_drag_notice(&url, "private").expect("typed video drag must reach the main view");
        assert_eq!(notice.media_kind, Some(SourceMediaKind::Video));
        assert_eq!(notice.image_url.as_deref(), Some("https://cdn.example.com/clip.mp4"));
        assert_eq!(notice.poster_url.as_deref(), Some("https://cdn.example.com/cover.jpg"));
        assert!(parse_drag_notice(&url, "wrong-token").is_none());
        for (media, poster, accepted) in [
            ("blob:https://example.com/temporary", "https://example.com/cover.jpg", true),
            ("file:///private.mp4", "https://example.com/cover.jpg", false),
            ("https://example.com/clip.mp4", "file:///private.png", false),
        ] {
            url.set_query(None);
            url.query_pairs_mut().append_pair("data", &serde_json::json!({
                "id":"a".repeat(32), "imageUrl":media, "pageUrl":"https://example.com/watch", "mediaKind":"video", "posterUrl":poster,
            }).to_string());
            assert_eq!(parse_drag_notice(&url, "private").is_some(), accepted);
        }
    }

    #[test]
    fn drag_notices_require_private_token_and_valid_http_image() {
        let make = |image: &str| {
            let mut url = Url::parse("bowerbird-explorer://private/start").unwrap();
            url.query_pairs_mut().append_pair("data", &serde_json::json!({
                "id": "a".repeat(32), "imageUrl": image, "pageUrl": "https://example.com/pin/1"
            }).to_string());
            url
        };
        assert!(parse_drag_notice(&make("https://cdn.example.com/a.jpg"), "private").is_some());
        assert!(parse_drag_notice(&make("https://cdn.example.com/a.jpg"), "wrong").is_none());
        for image in ["file:///secret", "javascript:alert(1)", "https://user:pass@example.com/a"] {
            assert!(parse_drag_notice(&make(image), "private").is_none());
        }
    }

    #[test]
    fn accepts_http_sources_and_rejects_privileged_schemes() {
        assert!(parse_http_source_url("https://www.pinterest.com/pin/123/").is_ok());
        assert!(parse_http_source_url("http://example.com/reference").is_ok());
        assert!(parse_http_source_url("file:///tmp/private.png").is_err());
        assert!(parse_http_source_url("javascript:alert(1)").is_err());
        assert!(parse_http_source_url("bowerbird://auth/callback").is_err());
    }

    #[test]
    fn rejects_urls_that_embed_credentials() {
        assert!(parse_http_source_url("https://user:secret@example.com/image").is_err());
    }

    #[test]
    fn validates_panel_bounds() {
        let valid = SourceBrowserBounds {
            x: 198.0,
            y: 112.0,
            width: 900.0,
            height: 620.0,
            overlay: None,
        };
        assert!(validate_bounds(valid).is_ok());
        assert!(validate_bounds(SourceBrowserBounds {
            width: 0.0,
            ..valid
        })
        .is_err());
        assert!(validate_bounds(SourceBrowserBounds { x: -1.0, ..valid }).is_err());
        assert!(validate_bounds(SourceBrowserBounds {
            height: f64::NAN,
            ..valid
        })
        .is_err());
    }

    #[test]
    fn only_the_local_main_webview_receives_default_capabilities() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
        let webviews = capability["webviews"].as_array().unwrap();

        assert_eq!(
            webviews,
            &[serde_json::Value::String(MAIN_WEBVIEW_LABEL.into())]
        );
        assert!(capability.get("windows").is_none());
        assert!(capability.get("remote").is_none());
    }
}
