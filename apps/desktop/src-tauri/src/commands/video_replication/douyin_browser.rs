//! Read the injected observer without relying on external-protocol navigation.
use crate::error::AppResult;
#[cfg(windows)]
use serde_json::json;
use serde_json::Value;
type Responses = tokio::sync::mpsc::Receiver<String>;

// Observe browser network responses before navigation, like the source application's
// Playwright response listener. Site scripts can replace fetch/XHR after injection.
#[cfg(windows)]
pub(super) async fn observe(window: &tauri::WebviewWindow) -> AppResult<Responses> {
    use std::sync::{Arc, Mutex};
    use tauri::Manager;
    use webview2_com::{CoTaskMemPWSTR, DevToolsProtocolEventReceivedEventHandler};
    use windows::core::{HSTRING, PWSTR, Interface};
    let (tx, rx) = tokio::sync::mpsc::channel(20);
    let (ready, registered) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |view| {
            let result = (|| unsafe {
                let core = view.controller().CoreWebView2()?;
                // Native mute also covers WebAudio and frames, including visible login windows.
                core.cast::<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8>()?.SetIsMuted(true)?;
                let pending = Arc::new(Mutex::new(std::collections::HashSet::<String>::new()));
                for event in [
                    "Network.responseReceived",
                    "Network.loadingFinished",
                    "Network.loadingFailed",
                ] {
                    let pending = pending.clone();
                    let tx = tx.clone();
                    let receiver = core.GetDevToolsProtocolEventReceiver(&HSTRING::from(event))?;
                    let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(
                        move |_, args| {
                            if let Some(args) = args {
                                let mut raw = PWSTR::null();
                                args.ParameterObjectAsJson(&mut raw)?;
                                let raw = CoTaskMemPWSTR::from(raw);
                                if let Ok(value) = serde_json::from_str::<Value>(&raw.to_string()) {
                                    let id = value["requestId"].as_str().unwrap_or("");
                                    let mut requests = pending.lock().unwrap();
                                    if event == "Network.responseReceived" {
                                        let relevant = value["response"]["url"]
                                            .as_str()
                                            .and_then(|s| tauri::Url::parse(s).ok())
                                            .is_some_and(|url| {
                                                url.scheme() == "https"
                                                    && [
                                                        Some("www.douyin.com"),
                                                        Some("www.iesdouyin.com"),
                                                    ]
                                                    .contains(&url.host_str())
                                                    && url.path() == "/aweme/v1/web/aweme/detail/"
                                            });
                                        if relevant && requests.len() < 20 {
                                            requests.insert(id.to_owned());
                                        }
                                    } else if requests.remove(id)
                                        && event == "Network.loadingFinished"
                                        && value["encodedDataLength"].as_u64().unwrap_or(0)
                                            <= 2 * 1024 * 1024
                                    {
                                        let _ = tx.try_send(id.to_owned());
                                    }
                                }
                            }
                            Ok(())
                        },
                    ));
                    let mut token = 0;
                    receiver.add_DevToolsProtocolEventReceived(&handler, &mut token)?;
                }
                Ok::<_, windows::core::Error>(())
            })();
            let _ = ready.send(result.is_ok());
        })
        .map_err(|_| crate::error::AppError::Other("无法监听抖音页面".into()))?;
    if registered.await != Ok(true) {
        return Err(crate::error::AppError::Other("无法监听抖音页面".into()));
    }
    let view = window
        .get_webview(window.label())
        .ok_or_else(|| crate::error::AppError::Other("抖音窗口已关闭".into()))?;
    crate::commands::source_browser_network::cdp(
        &view,
        "Network.enable",
        json!({"maxTotalBufferSize":4*1024*1024,"maxResourceBufferSize":2*1024*1024}),
    )
    .await?;
    Ok(rx)
}

#[cfg(not(windows))]
pub(super) async fn observe(_: &tauri::WebviewWindow) -> AppResult<Responses> {
    Ok(tokio::sync::mpsc::channel(1).1)
}

#[cfg(windows)]
pub(super) async fn captured(
    window: &tauri::WebviewWindow,
    responses: &mut Responses,
) -> AppResult<Option<Value>> {
    use tauri::Manager;
    let view = window
        .get_webview(window.label())
        .ok_or_else(|| crate::error::AppError::Other("抖音窗口已关闭".into()))?;
    while let Ok(id) = responses.try_recv() {
        use base64::Engine;
        if let Ok(body) = crate::commands::source_browser_network::cdp(
            &view,
            "Network.getResponseBody",
            json!({"requestId":id}),
        )
        .await
        {
            let text = body["body"].as_str().unwrap_or("");
            if text.len() > 3 * 1024 * 1024 {
                continue;
            }
            let bytes = if body["base64Encoded"].as_bool() == Some(true) {
                base64::engine::general_purpose::STANDARD
                    .decode(text)
                    .unwrap_or_default()
            } else {
                text.as_bytes().to_vec()
            };
            if bytes.len() > 2 * 1024 * 1024 {
                continue;
            }
            if let Ok(payload) = serde_json::from_slice::<Value>(&bytes) {
                // Reuse the exact same target/DRM/URL extraction as the page fallback.
                let _ = crate::commands::source_browser_network::cdp(
                    &view,
                    "Runtime.evaluate",
                    json!({"expression":format!("window.__bbDouyinInspect?.({})", payload)}),
                )
                .await;
            }
        }
    }
    let result = crate::commands::source_browser_network::cdp(
        &view,
        "Runtime.evaluate",
        json!({
            "expression": "JSON.stringify(window.__bbDouyinResult || null)",
            "returnByValue": true
        }),
    )
    .await?;
    let text = result["result"]["value"].as_str().unwrap_or("null");
    if text.len() > 80000 {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(text)?;
    Ok(value.is_object().then_some(value))
}

#[cfg(not(windows))]
pub(super) async fn captured(
    _: &tauri::WebviewWindow,
    _: &mut Responses,
) -> AppResult<Option<Value>> {
    Ok(None)
}
