//! Bounded Douyin download shared by the importer and isolated native verification.
use crate::error::{AppError, AppResult};
use futures_util::StreamExt;
use std::{
    net::{IpAddr, SocketAddr},
    path::Path,
    time::Duration,
};
use tauri::Url;
use tokio::io::AsyncWriteExt;
fn error(message: &str) -> AppError {
    AppError::Other(message.into())
}

const MEDIA_HOSTS: &[&str] = &[
    "douyinvod.com",
    "douyin.com",
    "amemv.com",
    "snssdk.com",
    "bytecdn.cn",
    "bytecdn.com",
];
pub(super) fn secure(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
}
pub(super) fn domain(host: &str, allowed: &[&str]) -> bool {
    allowed
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}
pub(super) fn media_url(raw: &str) -> AppResult<Url> {
    let raw = if raw.starts_with("//") {
        format!("https:{raw}")
    } else {
        raw.to_owned()
    };
    let url = Url::parse(&raw).map_err(|_| error("视频地址无效"))?;
    if raw.len() > 8192 || !secure(&url) || !domain(url.host_str().unwrap_or(""), MEDIA_HOSTS) {
        return Err(error("视频地址不在支持的抖音媒体域名中"));
    }
    Ok(url)
}
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || a == 0
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 198 && (b == 18 || b == 19))
                || (a == 192 && b == 0 && c == 0))
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                public_ip(IpAddr::V4(v4))
            } else {
                let s = ip.segments();
                (s[0] & 0xe000) == 0x2000 && !(s[0] == 0x2001 && (s[1] == 0xdb8 || s[1] < 0x200))
            }
        }
    }
}
pub(super) async fn download(
    window: &tauri::WebviewWindow,
    raw: &str,
    target: &Path,
    canonical: &str,
    user_agent: &str,
    mut progress: impl FnMut(u64,Option<u64>),
) -> AppResult<()> {
    let mut url = media_url(raw)?;
    for _ in 0..6 {
        let host = url.host_str().unwrap();
        let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, 443))
            .await
            .map_err(|_| error("无法解析抖音媒体地址"))?
            .collect();
        if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
            return Err(error("媒体地址未指向公网服务"));
        }
        // Ask the isolated browser for cookies scoped to EACH checked redirect URL.
        // Keep them in memory; never persist or send application credentials.
        let browser = window.clone();
        let cookie_url = url.clone();
        let cookies = tokio::task::spawn_blocking(move || browser.cookies_for_url(cookie_url))
            .await
            .map_err(|_| error("读取抖音登录状态失败"))?
            .map_err(|_| error("抖音获取窗口已关闭，请重试"))?;
        let cookie = cookies
            .iter()
            .map(|c| format!("{}={}", c.name(), c.value()))
            .collect::<Vec<_>>()
            .join("; ");
        // Pin vetted public addresses, including after redirects.
        let client = reqwest::Client::builder()
            .no_proxy()
            .resolve_to_addrs(host, &addresses)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|_| error("无法初始化视频下载"))?;
        let mut request = client
            .get(url.clone())
            .header("Referer", canonical)
            .header("User-Agent", user_agent);
        if !cookie.is_empty() {
            request = request.header(reqwest::header::COOKIE, cookie);
        }
        let response = request
            .send()
            .await
            .map_err(|_| error("视频下载网络中断，请重试"))?;
        if response.status().is_redirection() {
            let next = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| error("视频重定向无效"))?;
            url = media_url(
                url.join(next)
                    .map_err(|_| error("视频重定向无效"))?
                    .as_str(),
            )?;
            continue;
        }
        if response.status() != reqwest::StatusCode::OK {
            return Err(error(
                "抖音未允许下载此视频，请登录验证后重试或选择本地视频",
            ));
        }
        if response.content_length().unwrap_or(0) > 200 * 1024 * 1024
            || response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .contains("text/html")
        {
            return Err(error("视频超过 200 MiB 或返回了验证页面"));
        }
        let total = response.content_length();
        progress(0,total);
        let mut last = std::time::Instant::now();
        let mut file = tokio::fs::File::create(target).await?;
        let mut stream = response.bytes_stream();
        let mut size = 0usize;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| error("视频下载中断"))?;
            size += chunk.len();
            if size > 200 * 1024 * 1024 {
                return Err(error("参考视频超过 200 MiB"));
            }
            file.write_all(&chunk).await?;
            if last.elapsed() >= Duration::from_millis(400) {
                progress(size as u64,total); last = std::time::Instant::now();
            }
        }
        if size == 0 || total.is_some_and(|expected| expected != size as u64) {
            return Err(error("视频下载不完整，请重新获取"));
        }
        progress(size as u64,total);
        file.sync_all().await?;
        return Ok(());
    }
    Err(error("视频重定向次数过多"))
}
