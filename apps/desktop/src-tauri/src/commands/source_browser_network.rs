//! Windows WebView2 transport shared by production capture and the native smoke fixture.
use crate::error::{AppError, AppResult};
use tauri::Webview;
const MAX_BYTES: usize = 50 * 1024 * 1024;

#[cfg(windows)]
async fn cdp(
    webview: &Webview,
    method: &str,
    params: serde_json::Value,
) -> AppResult<serde_json::Value> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::HSTRING;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let method = method.to_string();
    let params = params.to_string();
    webview
        .with_webview(move |view| {
            // Setup failures drop the sender; COM response failures carry their error.
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |status, result| {
                    let _ = tx.send(status.map(|_| result).map_err(|error| error.to_string()));
                    Ok(())
                },
            ));
            unsafe {
                if let Ok(core) = view.controller().CoreWebView2() {
                    let _ = core.CallDevToolsProtocolMethod(
                        &HSTRING::from(method),
                        &HSTRING::from(params),
                        &handler,
                    );
                }
            }
        })
        .map_err(|e| AppError::Other(format!("浏览器取图初始化失败：{e}")))?;
    let raw = tokio::time::timeout(std::time::Duration::from_secs(45), rx)
        .await
        .map_err(|_| AppError::Other("浏览器读取图片超时，请重试".into()))?
        .map_err(|_| AppError::Other("浏览器已关闭，无法读取图片".into()))?
        .map_err(|_| AppError::Other("浏览器无法读取这张图片，请刷新网页后重试".into()))?;
    serde_json::from_str(&raw).map_err(|_| AppError::Other("浏览器图片响应无效".into()))
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
pub(super) async fn browser_bytes(webview: &Webview, url: &str) -> AppResult<Vec<u8>> {
    use serde_json::json;
    let tree = cdp(webview, "Page.getFrameTree", json!({})).await?;
    let frame = tree["frameTree"]["frame"]["id"]
        .as_str()
        .ok_or_else(|| AppError::Other("网页尚未就绪".into()))?;
    let resource = cdp(
        webview,
        "Network.loadNetworkResource",
        json!({
            "frameId": frame, "url": url,
            "options": { "disableCache": false, "includeCredentials": true }
        }),
    )
    .await?;
    let resource = &resource["resource"];
    if resource["success"].as_bool() != Some(true) {
        return Err(AppError::Other(format!(
            "网站未允许读取图片（HTTP {}），请确认已登录或刷新网页",
            resource["httpStatusCode"]
        )));
    }
    let stream = resource["stream"]
        .as_str()
        .ok_or_else(|| AppError::Other("网站没有返回图片内容".into()))?;
    let result = async {
        let mut bytes = Vec::new();
        loop {
            let chunk = cdp(
                webview,
                "IO.read",
                json!({ "handle": stream, "size": 256 * 1024 }),
            )
            .await?;
            let data = decode_chunk(&chunk)?;
            if bytes.len() + data.len() > MAX_BYTES {
                return Err(AppError::Other("图片超过 50 MiB 上限".into()));
            }
            bytes.extend(data);
            if chunk["eof"].as_bool() == Some(true) {
                break;
            }
            if bytes.is_empty() {
                return Err(AppError::Other("网站返回了空图片".into()));
            }
        }
        // Reject HTML/login responses and files unsupported by the existing image importer.
        image::guess_format(&bytes)
            .map_err(|_| AppError::Other("网站返回的内容不是可识别图片".into()))?;
        Ok(bytes)
    }
    .await;
    let _ = cdp(webview, "IO.close", json!({ "handle": stream })).await;
    result
}

#[cfg(not(windows))]
pub(super) async fn browser_bytes(_: &Webview, _: &str) -> AppResult<Vec<u8>> {
    Err(AppError::Other(
        "内置浏览器拖图采集目前支持 Windows；此平台可使用浏览器扩展采集".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
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
