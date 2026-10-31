//! Native browser transports shared by production capture and smoke fixtures.
use crate::error::{AppError, AppResult};
use tauri::Webview;
const MAX_BYTES: usize = 50 * 1024 * 1024;
const MAX_VIDEO_BYTES: usize = 200 * 1024 * 1024;

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
    let length = header("content-length").map(|value| value.parse::<usize>().map_err(|_| AppError::Other("网站返回的视频大小无效，请重新拖入。".into()))).transpose()?;
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
