//! Native browser transports shared by production capture and smoke fixtures.
use crate::error::{AppError, AppResult};
use tauri::Webview;
use super::source_browser_jobs::CaptureControl;
const MAX_BYTES: usize = 50 * 1024 * 1024;
const MAX_VIDEO_BYTES: usize = 200 * 1024 * 1024;

pub struct CaptureResource {
    pub url: String,
    pub bytes: Vec<u8>,
    pub content_type: String,
    pub total_bytes: Option<u64>,
}

impl CaptureResource {
    pub(super) fn is_manifest(&self) -> bool {
        let mime = self.content_type.to_ascii_lowercase();
        let path = tauri::Url::parse(&self.url).ok().map(|url|url.path().to_ascii_lowercase()).unwrap_or_default();
        let prefix = String::from_utf8_lossy(&self.bytes[..self.bytes.len().min(2048)]);
        let prefix = prefix.trim_start_matches('\u{feff}').trim_start();
        mime.contains("mpegurl") || mime.contains("dash+xml") || path.ends_with(".m3u8") || path.ends_with(".mpd")
            || prefix.starts_with("#EXTM3U") || prefix.starts_with("<MPD") || (prefix.starts_with("<?xml") && prefix.contains("<MPD"))
    }
}

pub(super) async fn checked<T>(control: &CaptureControl, future: impl std::future::Future<Output = AppResult<T>>) -> AppResult<T> {
    tokio::pin!(future);
    loop {
        control.check()?;
        tokio::select! {
            result = &mut future => return result,
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {}
        }
    }
}

#[cfg(windows)]
async fn evaluate(webview: &Webview, expression: &str) -> AppResult<serde_json::Value> {
    let value = cdp_timed(webview, "Runtime.evaluate", serde_json::json!({
        "expression": expression, "awaitPromise": true, "returnByValue": true,
    }), std::time::Duration::from_secs(120), "视频").await?;
    if value.get("exceptionDetails").is_some() {
        return Err(AppError::Other("浏览器未能读取当前视频，请播放视频后重试。".into()));
    }
    Ok(value["result"]["value"].clone())
}

#[cfg(target_os = "macos")]
async fn evaluate(webview: &Webview, expression: &str) -> AppResult<serde_json::Value> {
    use std::ffi::{c_char, c_void, CStr, CString};
    type Sender = tokio::sync::oneshot::Sender<AppResult<serde_json::Value>>;
    #[link(name = "bowerbird_browser_capture", kind = "static")]
    extern "C" {
        fn bb_browser_evaluate(view: *mut c_void, expression: *const c_char, context: *mut c_void,
            callback: extern "C" fn(*mut c_void, *const u8, usize, *const c_char));
    }
    extern "C" fn complete(context: *mut c_void, bytes: *const u8, len: usize, error: *const c_char) {
        let sender = *unsafe { Box::from_raw(context.cast::<Sender>()) };
        let value = if !error.is_null() {
            tracing::warn!(diagnostic=%unsafe { CStr::from_ptr(error) }.to_string_lossy(), "browser renderer read failed");
            Err(AppError::Other("浏览器未能读取当前视频，请播放视频后重试。".into()))
        } else if bytes.is_null() || len > 256 * 1024 {
            Err(AppError::Other("浏览器返回的视频数据无效。".into()))
        } else {
            serde_json::from_slice(unsafe { std::slice::from_raw_parts(bytes, len) })
                .map_err(|_| AppError::Other("浏览器返回的视频数据无效。".into()))
        };
        let _ = sender.send(value);
    }
    let expression = CString::new(expression).map_err(|_| AppError::Other("视频读取请求无效。".into()))?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview.with_webview(move |view| unsafe {
        bb_browser_evaluate(view.inner(), expression.as_ptr(), Box::into_raw(Box::new(sender)).cast(), complete);
    }).map_err(|_| AppError::Other("浏览器读取初始化失败。".into()))?;
    tokio::time::timeout(std::time::Duration::from_secs(125), receiver).await
        .map_err(|_| AppError::Other("浏览器读取视频超时，请重试。".into()))?
        .map_err(|_| AppError::Other("浏览器已关闭，请重新打开后重试。".into()))?
}

#[cfg(not(any(windows, target_os = "macos")))]
async fn evaluate(_: &Webview, _: &str) -> AppResult<serde_json::Value> {
    Err(AppError::Other("此平台暂不支持浏览器视频采集。".into()))
}

fn renderer_expression(method: &str, args: serde_json::Value) -> String {
    format!("(async()=>{{try{{return {{value:await window.__bbSourceVideo.{method}(...{args})}}}}catch(error){{return {{error:String(error?.message||'')}}}}}})()")
}

async fn renderer_call(webview: &Webview, method: &str, args: serde_json::Value) -> AppResult<serde_json::Value> {
    let result = evaluate(webview, &renderer_expression(method, args)).await?;
    if let Some(message) = result["error"].as_str() {
        tracing::warn!(diagnostic=message, "source video renderer rejected request");
        // Page content cannot supply arbitrary user-facing errors or internal URLs.
        let known = ["来源页面或视频已切换，请重新拖入。", "此视频受播放保护，无法采集。", "视频超过大小限制。",
            "当前页面无法读取该网络资源。",
            "此笔记包含多个视频，暂时无法确认本次拖动的视频。", "网页提供了多个视频来源，暂时无法确认本次拖动的视频。",
            "检测到多个分段清单，暂时无法确认本次拖动的视频。", "尚未找到当前视频的分段清单，请播放视频后重新拖入。",
            "网站未返回完整视频内容，请重新拖入。", "网站未返回完整视频内容。"];
        return Err(AppError::Other(if known.contains(&message) { message } else { "浏览器未能读取当前视频，请播放视频后重试。" }.into()));
    }
    Ok(result["value"].clone())
}

pub async fn resolve_video_source(webview: &Webview, source: &str, page_url: &str, control: &CaptureControl) -> AppResult<String> {
    let value = checked(control, renderer_call(webview, "resolve", serde_json::json!([source, page_url]))).await?;
    let source = value.as_str().filter(|source| source.len() <= 8192)
        .ok_or_else(|| AppError::Other("无法确认当前视频来源，请重新拖入。".into()))?;
    let parsed = tauri::Url::parse(source).map_err(|_| AppError::Other("视频来源地址无效。".into()))?;
    if !matches!(parsed.scheme(), "http" | "https" | "blob") || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AppError::Other("视频来源地址无效。".into()));
    }
    Ok(source.into())
}

pub async fn browser_capture_resource(webview: &Webview, url: &str, max_bytes: usize, control: &CaptureControl) -> AppResult<CaptureResource> {
    capture_resource(webview, url, max_bytes, control, true).await
}

pub async fn browser_capture_resource_silent(webview: &Webview, url: &str, max_bytes: usize, control: &CaptureControl) -> AppResult<CaptureResource> {
    capture_resource(webview, url, max_bytes, control, false).await
}

async fn capture_resource(webview: &Webview, url: &str, max_bytes: usize, control: &CaptureControl, report: bool) -> AppResult<CaptureResource> {
    control.check()?;
    if max_bytes == 0 || max_bytes > MAX_VIDEO_BYTES { return Err(AppError::Other("视频大小限制无效。".into())); }
    let parsed = tauri::Url::parse(url).map_err(|_| AppError::Other("视频地址无效。".into()))?;
    if parsed.scheme() == "blob" {
        return renderer_resource(webview, url, max_bytes, control, report).await;
    }
    if !matches!(parsed.scheme(), "http" | "https") || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AppError::Other("视频地址无效。".into()));
    }
    #[cfg(windows)]
    {
        // The renderer supplies the final response URL for relative manifest references.
        if webview.url().ok().is_some_and(|page| page.origin() == parsed.origin()) {
            match renderer_resource(webview, url, max_bytes, control, report).await {
                Ok(resource) => return Ok(resource),
                Err(AppError::Other(message)) if message == "当前页面无法读取该网络资源。" => control.check()?,
                Err(error) => return Err(error),
            }
        }
        capture_network_resource(webview, url, max_bytes, control, report).await
    }
    #[cfg(target_os = "macos")]
    { capture_mac_resource(webview, url, max_bytes, control, report).await }
    #[cfg(not(any(windows, target_os = "macos")))]
    { renderer_resource(webview, url, max_bytes, control, report).await }
}

#[cfg(target_os = "macos")]
async fn capture_mac_resource(webview: &Webview, url: &str, maximum: usize, control: &CaptureControl, report: bool) -> AppResult<CaptureResource> {
    use std::ffi::{c_char, c_void, CStr, CString};
    type Sender = (tokio::sync::oneshot::Sender<AppResult<CaptureResource>>, usize);
    if report { control.report("downloading", 0, None, None, None); }
    #[link(name = "bowerbird_browser_capture", kind = "static")]
    extern "C" {
        fn bb_browser_capture_resource(view: *mut c_void, url: *const c_char, maximum: usize, request_id: *const c_char,
            context: *mut c_void, callback: extern "C" fn(*mut c_void, *const u8, usize, *const c_char, *const c_char));
        fn bb_browser_cancel_resource(request_id: *const c_char);
    }
    extern "C" fn complete(context: *mut c_void, bytes: *const u8, len: usize, metadata: *const c_char, error: *const c_char) {
        let (sender, maximum) = *unsafe { Box::from_raw(context.cast::<Sender>()) };
        let result = if !error.is_null() {
            Err(AppError::Other(unsafe { CStr::from_ptr(error) }.to_string_lossy().into_owned()))
        } else if bytes.is_null() || len == 0 || len > maximum || metadata.is_null() {
            Err(AppError::Other("浏览器返回的媒体为空或超过大小限制。".into()))
        } else {
            serde_json::from_slice::<serde_json::Value>(unsafe { CStr::from_ptr(metadata) }.to_bytes())
                .map_err(|_| AppError::Other("浏览器返回的媒体信息无效。".into()))
                .map(|value| CaptureResource {url:value["url"].as_str().unwrap_or("").into(), bytes:unsafe { std::slice::from_raw_parts(bytes, len) }.to_vec(),
                    content_type:value["contentType"].as_str().unwrap_or("").into(),total_bytes:value["totalBytes"].as_u64()})
        };
        let _ = sender.send(result);
    }
    let url = CString::new(url).map_err(|_| AppError::Other("媒体地址无效。".into()))?;
    let id = CString::new(uuid::Uuid::new_v4().to_string()).unwrap();
    let native_id = id.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview.with_webview(move |view| unsafe {
        bb_browser_capture_resource(view.inner(), url.as_ptr(), maximum, native_id.as_ptr(), Box::into_raw(Box::new((sender,maximum))).cast(), complete);
    }).map_err(|_| AppError::Other("浏览器读取初始化失败。".into()))?;
    let result = checked(control, async {
        tokio::time::timeout(std::time::Duration::from_secs(125), receiver).await
            .map_err(|_| AppError::Other("浏览器读取超时，请重试。".into()))?
            .map_err(|_| AppError::Other("浏览器已关闭，请重试。".into()))?
    }).await;
    if result.is_err() { let _ = webview.with_webview(move |_| unsafe { bb_browser_cancel_resource(id.as_ptr()); }); }
    if let Ok(resource) = &result { if report { control.report("downloading",resource.bytes.len() as u64,resource.total_bytes,None,None); } }
    result
}

async fn renderer_resource(webview: &Webview, url: &str, max_bytes: usize, control: &CaptureControl, report: bool) -> AppResult<CaptureResource> {
    // Native chooses the ID before starting fetch, so cancellation can abort even
    // while the response headers have not arrived yet.
    let id = uuid::Uuid::new_v4().to_string();
    let result = async {
        let opened = checked(control, renderer_call(webview, "open", serde_json::json!([url, max_bytes, id]))).await?;
        let total = opened["totalBytes"].as_u64();
        let mut bytes = Vec::new();
        loop {
            let value = checked(control, renderer_call(webview, "read", serde_json::json!([id]))).await?;
            let chunk = decode_chunk(&serde_json::json!({"data":value["data"],"base64Encoded":true}))?;
            if bytes.len() + chunk.len() > max_bytes { return Err(AppError::Other("视频超过大小限制。".into())); }
            bytes.extend(chunk);
            if report { control.report("downloading", bytes.len() as u64, total, None, None); }
            if value["eof"].as_bool() == Some(true) { break; }
        }
        if bytes.is_empty() || total.is_some_and(|value| value != bytes.len() as u64) {
            return Err(AppError::Other("网站未返回完整视频内容。".into()));
        }
        Ok(CaptureResource {url:opened["url"].as_str().unwrap_or(url).into(), bytes,
            content_type:opened["contentType"].as_str().unwrap_or("").into(), total_bytes:total})
    }.await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), renderer_call(webview, "close", serde_json::json!([id]))).await;
    result
}

#[cfg(windows)]
async fn confirm_manifest_base(webview: &Webview, url: &str, include_credentials: bool, control: &CaptureControl) -> AppResult<()> {
    let id = uuid::Uuid::new_v4().to_string();
    let result = checked(control, renderer_call(webview, "manifestBase", serde_json::json!([url, id, include_credentials]))).await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), renderer_call(webview, "close", serde_json::json!([id]))).await;
    control.check()?;
    let value = result.unwrap_or_default();
    match value["type"].as_str() {
        Some("basic" | "cors") if value["ok"].as_bool() == Some(true) => Ok(()),
        Some("opaqueredirect") => Err(AppError::Other("视频清单发生跳转，无法确认分片来源，已停止采集。".into())),
        _ => Err(AppError::Other("无法确认视频清单的真实地址，已停止采集，请刷新网页后重试。".into())),
    }
}

fn include_media_credentials(page: &tauri::Url, media: &tauri::Url) -> bool {
    // Pinterest's public video CDN rejects credentialed CORS requests. Keep the
    // byte fetch and redirect guard on the same policy; never prove an anonymous
    // URL and then download a potentially different authenticated response.
    !(page.scheme() == "https" && matches!(page.host_str(), Some("pinterest.com" | "www.pinterest.com"))
        && media.scheme() == "https"
        && media.host_str().is_some_and(|host| host == "pinimg.com" || host.ends_with(".pinimg.com")))
}

#[cfg(windows)]
async fn capture_network_resource(webview: &Webview, url: &str, max_bytes: usize, control: &CaptureControl, report: bool) -> AppResult<CaptureResource> {
    use serde_json::json;
    let include_credentials = match (webview.url(), tauri::Url::parse(url)) {
        (Ok(page), Ok(media)) => include_media_credentials(&page, &media),
        _ => true,
    };
    let tree = checked(control, cdp(webview, "Page.getFrameTree", json!({}))).await?;
    let frame = tree["frameTree"]["frame"]["id"].as_str().ok_or_else(|| AppError::Other("网页尚未就绪。".into()))?;
    let response = checked(control, cdp_timed(webview, "Network.loadNetworkResource", json!({
        "frameId":frame, "url":url, "options":{"disableCache":false,"includeCredentials":include_credentials}
    }), std::time::Duration::from_secs(120), "视频")).await?;
    let resource = &response["resource"];
    let stream = resource["stream"].as_str();
    let result = async {
        control.check()?;
        if resource["success"].as_bool() != Some(true) || resource["httpStatusCode"].as_u64().is_none_or(|status| !(200..300).contains(&status) || status == 206) {
            return Err(AppError::Other("网站未返回完整视频内容，请重新拖入。".into()));
        }
        let header = |name: &str| resource["headers"].as_object().and_then(|headers| headers.iter().find(|(key,_)| key.eq_ignore_ascii_case(name))).and_then(|(_,value)| value.as_str());
        let encoded = header("content-encoding").is_some_and(|value| !value.eq_ignore_ascii_case("identity"));
        let total = if encoded { None } else { header("content-length").map(str::parse::<u64>).transpose().map_err(|_| AppError::Other("视频大小无效。".into()))? };
        if total.is_some_and(|value| value > max_bytes as u64) { return Err(AppError::Other("视频超过大小限制。".into())); }
        let stream = stream.ok_or_else(|| AppError::Other("网站没有返回视频内容。".into()))?;
        let mut bytes = Vec::new();
        loop {
            let chunk = checked(control, cdp_timed(webview, "IO.read", json!({"handle":stream,"size":64*1024}), std::time::Duration::from_secs(120), "视频")).await?;
            let data = decode_chunk(&chunk)?;
            if bytes.len() + data.len() > max_bytes { return Err(AppError::Other("视频超过大小限制。".into())); }
            bytes.extend(data);
            if report { control.report("downloading", bytes.len() as u64, total, None, None); }
            if chunk["eof"].as_bool() == Some(true) { break; }
        }
        if bytes.is_empty() || total.is_some_and(|value| value != bytes.len() as u64) { return Err(AppError::Other("网站未返回完整视频内容。".into())); }
        let captured = CaptureResource {url:url.into(),bytes,content_type:header("content-type").unwrap_or("").into(),total_bytes:total};
        // CDP omits the final response URL. Never resolve relative fragments
        // against an unverified pre-redirect URL, even if those files exist.
        if captured.is_manifest() { confirm_manifest_base(webview, url, include_credentials, control).await?; }
        Ok(captured)
    }.await;
    if let Some(stream) = stream { let _ = cdp_timed(webview, "IO.close", json!({"handle":stream}), std::time::Duration::from_secs(2), "视频").await; }
    result
}

#[cfg(windows)]
pub(crate) async fn cdp(
    webview: &Webview,
    method: &str,
    params: serde_json::Value,
) -> AppResult<serde_json::Value> {
    cdp_timed(webview, method, params, std::time::Duration::from_secs(45), "图片").await
}

#[cfg(windows)]
async fn cdp_timed(webview: &Webview, method: &str, params: serde_json::Value, timeout: std::time::Duration, media: &'static str) -> AppResult<serde_json::Value> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::HSTRING;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let method = method.to_string();
    let resource_request = method == "Network.loadNetworkResource";
    let params = params.to_string();
    webview
        .with_webview(move |view| {
            unsafe {
                if let Ok(core) = view.controller().CoreWebView2() {
                    let cleanup_core = core.clone();
                    // A timed-out resource load may complete later. Close its
                    // browser-owned stream even when its receiver has gone away.
                    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                        move |status, result| {
                            if let Err(Ok(raw)) = tx.send(status.map(|_| result).map_err(|error| error.to_string())) {
                                if resource_request {
                                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                                        if let Some(stream) = value["resource"]["stream"].as_str() {
                                            let close = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
                                            let _ = cleanup_core.CallDevToolsProtocolMethod(
                                                &HSTRING::from("IO.close"), &HSTRING::from(serde_json::json!({"handle":stream}).to_string()), &close,
                                            );
                                        }
                                    }
                                }
                            }
                            Ok(())
                        },
                    ));
                    let _ = core.CallDevToolsProtocolMethod(
                        &HSTRING::from(method),
                        &HSTRING::from(params),
                        &handler,
                    );
                }
            }
        })
        .map_err(|e| AppError::Other(format!("浏览器取图初始化失败：{e}")))?;
    let raw = tokio::time::timeout(timeout, rx)
        .await
        .map_err(|_| AppError::Other(format!("浏览器读取{media}超时，请重试")))?
        .map_err(|_| AppError::Other(format!("浏览器已关闭，无法读取{media}")))?
        .map_err(|error| {
            tracing::warn!(diagnostic=%error, "native browser media request failed");
            AppError::Other(format!("浏览器无法读取{media}，请刷新网页后重试"))
        })?;
    serde_json::from_str(&raw).map_err(|_| AppError::Other(format!("浏览器{media}响应无效")))
}

fn decode_chunk(value: &serde_json::Value) -> AppResult<Vec<u8>> {
    use base64::Engine;
    let data = value["data"]
        .as_str()
        .ok_or_else(|| AppError::Other("图片数据为空".into()))?;
    if value["base64Encoded"].as_bool().unwrap_or(false) {
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| AppError::Other("图片数据编码无效".into()))
    } else {
        Ok(data.as_bytes().to_vec())
    }
}

#[cfg(windows)]
pub(crate) async fn browser_bytes(webview: &Webview, url: &str) -> AppResult<Vec<u8>> {
    browser_resource(webview, url, false).await
}

#[cfg(windows)]
pub(crate) async fn browser_video_bytes(webview: &Webview, url: &str) -> AppResult<Vec<u8>> {
    browser_resource(webview, url, true).await
}

fn video_response_length(resource: &serde_json::Value) -> AppResult<Option<usize>> {
    if resource["httpStatusCode"].as_u64() == Some(206) {
        return Err(AppError::Other("网站只返回了部分视频，无法采集；请使用完整视频文件链接。".into()));
    }
    let headers = resource["headers"].as_object();
    let header = |name: &str| headers.and_then(|values| values.iter().find(|(key, _)| key.eq_ignore_ascii_case(name))).and_then(|(_, value)| value.as_str());
    let mime = header("content-type").unwrap_or("").to_ascii_lowercase();
    if mime.contains("mpegurl") || mime.contains("dash+xml") {
        return Err(AppError::Other("此视频使用分段播放，暂不支持拖入采集；请使用完整视频文件链接。".into()));
    }
    if mime.contains("html") {
        return Err(AppError::Other("网站返回了网页，请确认视频可播放后重新拖入。".into()));
    }
    let encoded = header("content-encoding").is_some_and(|value| !value.eq_ignore_ascii_case("identity"));
    let length = if encoded { None } else { header("content-length").map(|value| value.parse::<usize>().map_err(|_| AppError::Other("网站返回的视频大小无效，请重新拖入。".into()))).transpose()? };
    if length.is_some_and(|value| value > MAX_VIDEO_BYTES) {
        return Err(AppError::Other("视频超过 200 MiB 上限".into()));
    }
    Ok(length)
}

#[cfg(windows)]
async fn capture_cdp(webview: &Webview, method: &str, params: serde_json::Value, deadline: Option<tokio::time::Instant>) -> AppResult<serde_json::Value> {
    match deadline {
        Some(deadline) => cdp_timed(webview, method, params, deadline.saturating_duration_since(tokio::time::Instant::now()), "视频").await,
        None => cdp(webview, method, params).await,
    }
}

#[cfg(windows)]
async fn browser_resource(webview: &Webview, url: &str, video: bool) -> AppResult<Vec<u8>> {
    use serde_json::json;
    let deadline = video.then(|| tokio::time::Instant::now() + std::time::Duration::from_secs(120));
    let media = if video { "视频" } else { "图片" };
    let maximum = if video { MAX_VIDEO_BYTES } else { MAX_BYTES };
    let tree = capture_cdp(webview, "Page.getFrameTree", json!({}), deadline).await?;
    let frame = tree["frameTree"]["frame"]["id"]
        .as_str()
        .ok_or_else(|| AppError::Other("网页尚未就绪".into()))?;
    let resource = capture_cdp(
        webview,
        "Network.loadNetworkResource",
        json!({
            "frameId": frame, "url": url,
            "options": { "disableCache": false, "includeCredentials": true }
        }),
        deadline,
    )
    .await?;
    let resource = &resource["resource"];
    if resource["success"].as_bool() != Some(true) {
        if let Some(stream) = resource["stream"].as_str() {
            let _ = cdp_timed(webview, "IO.close", json!({"handle":stream}), std::time::Duration::from_secs(2), media).await;
        }
        tracing::warn!(net_error=?resource["netError"], diagnostic=?resource["netErrorName"], "native browser resource rejected");
        return Err(AppError::Other(format!(
            "网站未允许读取{media}（HTTP {}），请确认已登录或刷新网页",
            resource["httpStatusCode"]
        )));
    }
    let stream = resource["stream"]
        .as_str()
        .ok_or_else(|| AppError::Other(format!("网站没有返回{media}内容")))?;
    let result = async {
        let expected = if video { video_response_length(resource)? } else { None };
        let mut bytes = Vec::new();
        loop {
            let chunk = capture_cdp(
                webview,
                "IO.read",
                json!({ "handle": stream, "size": 256 * 1024 }),
                deadline,
            )
            .await?;
            let data = decode_chunk(&chunk).map_err(|error| {
                if video {
                    tracing::warn!(diagnostic=%error, "invalid browser video chunk");
                    AppError::Other("浏览器返回的视频数据无效，请重新拖入。".into())
                } else { error }
            })?;
            if bytes.len() + data.len() > maximum {
                return Err(AppError::Other(if video { "视频超过 200 MiB 上限" } else { "图片超过 50 MiB 上限" }.into()));
            }
            bytes.extend(data);
            if chunk["eof"].as_bool() == Some(true) {
                break;
            }
            if bytes.is_empty() {
                return Err(AppError::Other(format!("网站返回了空{media}")));
            }
        }
        // Reject HTML/login responses and files unsupported by the existing image importer.
        if video {
            if bytes.is_empty() || expected.is_some_and(|length| length != bytes.len()) {
                return Err(AppError::Other("网站未返回完整视频，请确认视频可播放后重新拖入。".into()));
            }
        } else {
            image::guess_format(&bytes)
                .map_err(|_| AppError::Other("网站返回的内容不是可识别图片".into()))?;
        }
        Ok(bytes)
    }
    .await;
    let _ = cdp_timed(webview, "IO.close", json!({ "handle": stream }), std::time::Duration::from_secs(2), media).await;
    result
}

#[cfg(target_os = "macos")]
pub(crate) async fn browser_bytes(webview: &Webview, url: &str) -> AppResult<Vec<u8>> {
    mac_browser_resource(webview, url, false).await
}

#[cfg(target_os = "macos")]
pub(crate) async fn browser_video_bytes(webview: &Webview, url: &str) -> AppResult<Vec<u8>> {
    mac_browser_resource(webview, url, true).await
}

#[cfg(target_os = "macos")]
async fn mac_browser_resource(webview: &Webview, url: &str, video: bool) -> AppResult<Vec<u8>> {
    use std::ffi::{c_char, c_void, CStr, CString};
    type Sender = (tokio::sync::oneshot::Sender<AppResult<Vec<u8>>>, bool);
    // The archive comes from build.rs; the attribute also covers targets that
    // compile this module via #[path] without linking the library crate.
    #[link(name = "bowerbird_browser_capture", kind = "static")]
    extern "C" {
        fn bb_browser_capture_media(
            view: *mut c_void,
            url: *const c_char,
            video: bool,
            context: *mut c_void,
            callback: extern "C" fn(*mut c_void, *const u8, usize, *const c_char),
        );
    }
    extern "C" fn complete(
        context: *mut c_void,
        data: *const u8,
        len: usize,
        error: *const c_char,
    ) {
        // Native code completes exactly once and keeps data alive through this callback.
        let (sender, video) = *unsafe { Box::from_raw(context.cast::<Sender>()) };
        let result = if !error.is_null() {
            Err(AppError::Other(
                unsafe { CStr::from_ptr(error) }
                    .to_string_lossy()
                    .into_owned(),
            ))
        } else if len == 0 || data.is_null() || len > if video { MAX_VIDEO_BYTES } else { MAX_BYTES } {
            Err(AppError::Other(if video { "浏览器视频为空或超过 200 MiB 上限" } else { "浏览器图片为空或超过 50 MiB 上限" }.into()))
        } else {
            Ok(unsafe { std::slice::from_raw_parts(data, len) }.to_vec())
        };
        let _ = sender.send(result);
    }
    let url = CString::new(url).map_err(|_| AppError::Other("图片地址无效".into()))?;
    let (tx, rx) = tokio::sync::oneshot::channel::<AppResult<Vec<u8>>>();
    webview
        .with_webview(move |view| unsafe {
            bb_browser_capture_media(
                view.inner(),
                url.as_ptr(),
                video,
                Box::into_raw(Box::new((tx, video))).cast(),
                complete,
            );
        })
        .map_err(|e| AppError::Other(format!("浏览器取图初始化失败：{e}")))?;
    // Native timers cancel and clean private temporary downloads at 45 / 120s.
    let bytes = tokio::time::timeout(std::time::Duration::from_secs(if video { 125 } else { 50 }), rx)
        .await
        .map_err(|_| AppError::Other(if video { "浏览器读取视频超时，请重试" } else { "浏览器读取图片超时，请重试" }.into()))?
        .map_err(|_| AppError::Other(if video { "浏览器已关闭，无法读取视频" } else { "浏览器已关闭，无法读取图片" }.into()))??;
    if !video {
        image::guess_format(&bytes)
            .map_err(|_| AppError::Other("网站返回的内容不是可识别图片".into()))?;
    }
    Ok(bytes)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) async fn browser_bytes(_: &Webview, _: &str) -> AppResult<Vec<u8>> {
    Err(AppError::Other(
        "内置浏览器拖图采集目前支持 Windows 和 macOS；此平台可使用浏览器扩展采集".into(),
    ))
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) async fn browser_video_bytes(_: &Webview, _: &str) -> AppResult<Vec<u8>> {
    Err(AppError::Other("此平台暂不支持内置浏览器拖入视频，请使用浏览器扩展采集。".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pinterest_public_media_uses_the_same_anonymous_request_policy() {
        for (page, media, expected) in [
            ("https://www.pinterest.com/pin/123/", "https://v1.pinimg.com/video.m3u8", false),
            ("https://pinterest.com/", "https://pinimg.com/video.mp4", false),
            ("https://www.pinterest.com/", "https://www.pinterest.com/resource/feed", true),
            ("https://www.pinterest.com/", "https://v1.pinimg.com.evil.test/video.m3u8", true),
            ("https://www.pinterest.com/", "https://notpinimg.com/video.mp4", true),
            ("https://www.pinterest.com/", "http://v1.pinimg.com/video.m3u8", true),
            ("http://www.pinterest.com/", "https://v1.pinimg.com/video.m3u8", true),
            ("https://www.pinterest.com.evil.test/", "https://v1.pinimg.com/video.m3u8", true),
            ("https://www.xiaohongshu.com/", "https://v1.pinimg.com/video.mp4", true),
        ] {
            assert_eq!(include_media_credentials(&page.parse().unwrap(), &media.parse().unwrap()), expected, "{page} -> {media}");
        }
    }
    #[test]
    fn source_browser_video_response_requires_complete_bounded_file() {
        use serde_json::json;
        assert_eq!(video_response_length(&json!({"httpStatusCode":200,"headers":{"Content-Type":"video/mp4","Content-Length":"209715200"}})).unwrap(), Some(MAX_VIDEO_BYTES));
        assert!(video_response_length(&json!({"httpStatusCode":200,"headers":{"content-length":"209715201"}})).unwrap_err().to_string().contains("200 MiB"));
        assert!(video_response_length(&json!({"httpStatusCode":206,"headers":{"content-type":"video/mp4"}})).unwrap_err().to_string().contains("部分视频"));
        for mime in ["text/html", "application/vnd.apple.mpegurl", "application/dash+xml"] {
            assert!(video_response_length(&json!({"httpStatusCode":200,"headers":{"content-type":mime}})).is_err());
        }
        assert_eq!(video_response_length(&json!({"httpStatusCode":200,"headers":{}})).unwrap(), None);
    }
    #[test]
    fn binary_chunks_are_decoded_without_utf8_corruption() {
        assert_eq!(
            decode_chunk(&serde_json::json!({"data":"AP+A", "base64Encoded":true})).unwrap(),
            vec![0, 255, 128]
        );
        assert!(decode_chunk(&serde_json::json!({"data":"!", "base64Encoded":true})).is_err());
        assert!(decode_chunk(&serde_json::json!({})).is_err());
    }
}
