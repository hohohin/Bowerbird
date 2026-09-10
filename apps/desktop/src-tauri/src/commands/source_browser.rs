use serde::{Deserialize, Serialize};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl,
};

use crate::error::{AppError, AppResult};

const MAIN_WEBVIEW_LABEL: &str = "main";
const SOURCE_BROWSER_LABEL: &str = "source-discovery";
const SOURCE_BROWSER_STATUS_EVENT: &str = "source-browser://status";
const SOURCE_BROWSER_TITLE_EVENT: &str = "source-browser://title";
const SOURCE_BROWSER_NEW_WINDOW_EVENT: &str = "source-browser://new-window";

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceBrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
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
    Ok(bounds)
}

fn set_bounds(webview: &tauri::Webview, bounds: SourceBrowserBounds) -> AppResult<()> {
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|error| tauri_error("定位素材发现面板失败", error))?;
    webview
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|error| tauri_error("调整素材发现面板失败", error))?;
    Ok(())
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

    if let Some(webview) = app.get_webview(SOURCE_BROWSER_LABEL) {
        set_bounds(&webview, bounds)?;
        // Reopening resumes the live document. Explicit navigation has its own command.
        webview
            .show()
            .map_err(|error| tauri_error("显示素材发现面板失败", error))?;
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
    let builder = WebviewBuilder::new(SOURCE_BROWSER_LABEL, WebviewUrl::External(url))
        .data_directory(data_directory)
        .disable_drag_drop_handler()
        .initialization_script(include_str!("../../../../extension/candidate-utils.js"))
        .initialization_script(include_str!("source_browser_drag.js"))
        .on_navigation(move |url| {
            let allowed = navigation_allowed(url);
            if allowed {
                emit_status(&navigation_app, url, true);
            }
            allowed
        })
        .on_page_load(move |_, payload| {
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
    webview
        .set_focus()
        .map_err(|error| tauri_error("聚焦素材发现面板失败", error))?;
    Ok(())
}

#[tauri::command]
pub async fn resize_source_browser(app: AppHandle, bounds: SourceBrowserBounds, visible: Option<bool>) -> AppResult<()> {
    let bounds = validate_bounds(bounds)?;
    if let Some(webview) = app.get_webview(SOURCE_BROWSER_LABEL) {
        set_bounds(&webview, bounds)?;
        if let Some(visible) = visible {
            if visible { webview.show() } else { webview.hide() }
                .map_err(|error| tauri_error("更新探索面板显示失败", error))?;
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
    if let Some(webview) = app.get_webview(SOURCE_BROWSER_LABEL) {
        webview
            .eval("history.back()")
            .map_err(|error| tauri_error("返回上一页失败", error))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn source_browser_forward(app: AppHandle) -> AppResult<()> {
    if let Some(webview) = app.get_webview(SOURCE_BROWSER_LABEL) {
        webview
            .eval("history.forward()")
            .map_err(|error| tauri_error("前往下一页失败", error))?;
    }
    Ok(())
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
    if let Some(webview) = app.get_webview(SOURCE_BROWSER_LABEL) {
        webview
            .hide()
            .map_err(|error| tauri_error("关闭素材发现面板失败", error))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
