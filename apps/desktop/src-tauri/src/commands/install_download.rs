//! Resumable transport for the H3 and voice installers. Each caller verifies
//! the finished partial against its own pinned digest before publishing it.
use std::{
    future::Future,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant, SystemTime},
};

use reqwest::{header, StatusCode};
use tokio::io::{AsyncWriteExt, BufWriter};

use crate::error::{AppError, AppResult};

const MAX_FAILURES: u32 = 4;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);
const MAX_RETRY_AFTER: Duration = Duration::from_secs(30);

struct Retry {
    reason: String,
    after: Option<Duration>,
}

fn retry_after(headers: &header::HeaderMap, now: SystemTime) -> Option<Duration> {
    let raw = headers.get(header::RETRY_AFTER)?.to_str().ok()?.trim();
    let wait = if !raw.is_empty() && raw.bytes().all(|byte| byte.is_ascii_digit()) {
        Duration::from_secs(raw.parse::<u64>().unwrap_or(u64::MAX))
    } else {
        httpdate::parse_http_date(raw).ok()?.duration_since(now).unwrap_or_default()
    };
    Some(wait.min(MAX_RETRY_AFTER))
}

pub(super) enum TransferProgress {
    Downloading(u64),
    Reconnecting(u64),
}

fn fail(message: impl Into<String>) -> AppError {
    AppError::Other(message.into())
}

pub(super) async fn wait_cancel(cancel: &AtomicBool) {
    while !cancel.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn cancelled() -> AppError {
    fail("下载已暂停，已下载内容保留")
}

fn network_error(error: &reqwest::Error) -> &'static str {
    // Do not format the reqwest error or its sources: it may include a signed URL.
    if error.is_timeout() {
        "下载连接超时"
    } else if error.is_connect() {
        "无法连接下载服务器"
    } else {
        "下载连接中断"
    }
}

pub(super) async fn transfer<F, Fut>(
    http: &reqwest::Client,
    part: &Path,
    size: u64,
    cancel: &AtomicBool,
    mut source: F,
    mut progress: impl FnMut(TransferProgress),
) -> AppResult<()>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = AppResult<String>>,
{
    let mut offset = match tokio::fs::metadata(part).await {
        Ok(file) => file.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error.into()),
    };
    if offset > size {
        return Err(fail("断点文件大小异常，请更换安装位置"));
    }
    let mut furthest = offset;
    let mut failures = 0;
    while offset < size {
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        let retry = download_attempt(
            http,
            part,
            size,
            &mut offset,
            cancel,
            source(),
            &mut progress,
        )
        .await?;
        if offset == size {
            break;
        }
        // An origin may ignore Range and restart at zero. Only net progress
        // beyond the previous high-water mark resets the failure budget.
        if offset > furthest {
            furthest = offset;
            failures = 0;
        } else {
            failures += 1;
        }
        if failures >= MAX_FAILURES {
            return Err(fail(format!("{}，已保留下载进度，请稍后重试", retry.reason)));
        }
        progress(TransferProgress::Reconnecting(offset));
        let delay = retry.after.unwrap_or_else(|| Duration::from_secs(2_u64.pow(failures.max(1))));
        tokio::select! {
            _ = wait_cancel(cancel) => return Err(cancelled()),
            _ = tokio::time::sleep(delay) => {}
        }
    }
    Ok(())
}

async fn download_attempt(
    http: &reqwest::Client,
    part: &Path,
    size: u64,
    offset: &mut u64,
    cancel: &AtomicBool,
    source: impl Future<Output = AppResult<String>>,
    progress: &mut impl FnMut(TransferProgress),
) -> AppResult<Retry> {
    let url = tokio::select! {
        _ = wait_cancel(cancel) => return Err(cancelled()),
        result = source => result?,
    };
    let mut request = http.get(url);
    if *offset > 0 {
        request = request.header(header::RANGE, format!("bytes={offset}-"));
    }
    let mut response = tokio::select! {
        _ = wait_cancel(cancel) => return Err(cancelled()),
        result = request.send() => match result {
            Ok(response) => response,
            Err(error) => return Ok(Retry { reason: network_error(&error).into(), after: None }),
        },
    };
    let status = response.status();
    let after = retry_after(response.headers(), SystemTime::now());
    match status {
        StatusCode::PARTIAL_CONTENT => {
            let expected = format!("bytes {offset}-{}/{}", size - 1, size);
            if response
                .headers()
                .get(header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                != Some(expected.as_str())
            {
                return Err(fail("下载服务器返回了错误的断点范围"));
            }
        }
        StatusCode::OK => *offset = 0,
        StatusCode::RANGE_NOT_SATISFIABLE if *offset > 0 => {
            tokio::fs::OpenOptions::new().write(true).truncate(true).open(part).await?.sync_all().await?;
            *offset = 0;
            return Ok(Retry { reason: "下载服务器已拒绝旧断点".into(), after });
        }
        status if matches!(status.as_u16(), 401 | 403 | 408 | 429 | 500..=599) => {
            return Ok(Retry { reason: format!("下载服务返回 HTTP {}", status.as_u16()), after });
        }
        _ => {
            return Err(fail(format!(
                "下载服务返回 HTTP {}，请检查网络后重试",
                status.as_u16()
            )))
        }
    }
    let file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(*offset == 0)
        .append(*offset > 0)
        .open(part)
        .await?;
    let mut writer = BufWriter::with_capacity(1024 * 1024, file);
    let mut published = Instant::now();
    let result = loop {
        let next = tokio::select! {
            biased;
            _ = wait_cancel(cancel) => break Err(cancelled()),
            result = response.chunk() => result,
        };
        match next {
            Ok(Some(chunk)) => {
                if chunk.len() as u64 > size - *offset {
                    break Err(fail("下载文件超过已知大小"));
                }
                if let Err(error) = writer.write_all(&chunk).await {
                    break Err(error.into());
                }
                *offset += chunk.len() as u64;
                if published.elapsed() >= PROGRESS_INTERVAL {
                    progress(TransferProgress::Downloading(*offset));
                    published = Instant::now();
                }
            }
            Ok(None) => break Ok(Retry { reason: "下载连接提前关闭".into(), after: None }),
            Err(error) => break Ok(Retry { reason: network_error(&error).into(), after: None }),
        }
    };
    // Nothing can claim a resumable offset until buffered data has reached disk.
    writer.flush().await?;
    writer.get_ref().sync_all().await?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, response::Response, routing::get, Router};
    use futures_util::{stream, StreamExt};
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/file?signature=test-secret", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap(); });
        (url, server)
    }

    #[test]
    fn retry_after_accepts_both_http_forms_and_bounds_the_delay() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000_000);
        let mut headers = header::HeaderMap::new();
        headers.insert(header::RETRY_AFTER, "1000000000000000000000".parse().unwrap());
        assert_eq!(retry_after(&headers, now), Some(Duration::from_secs(30)));
        headers.insert(header::RETRY_AFTER, httpdate::fmt_http_date(now + Duration::from_secs(8)).parse().unwrap());
        assert_eq!(retry_after(&headers, now), Some(Duration::from_secs(8)));
        headers.insert(header::RETRY_AFTER, "invalid".parse().unwrap());
        assert_eq!(retry_after(&headers, now), None);
    }

    #[tokio::test]
    async fn rejected_range_restarts_with_a_truncated_partial() {
        let ranges = Arc::new(std::sync::Mutex::new(Vec::new()));
        let server = Router::new().route("/file", get({
            let ranges = ranges.clone();
            move |headers: header::HeaderMap| async move {
                let range = headers.get(header::RANGE).and_then(|value| value.to_str().ok()).map(str::to_owned);
                let status = if range.is_some() { StatusCode::RANGE_NOT_SATISFIABLE } else { StatusCode::OK };
                ranges.lock().unwrap().push(range);
                (status, "fresh-data")
            }
        }));
        let (url, server) = serve(server).await;
        let root = tempfile::tempdir().unwrap();
        let part = root.path().join("fixture.part");
        std::fs::write(&part, b"stale").unwrap();
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let result = transfer(&http, &part, 10, &AtomicBool::new(false), || std::future::ready(Ok(url.clone())), |_| {}).await;
        server.abort();
        result.unwrap();
        assert_eq!(*ranges.lock().unwrap(), [Some("bytes=5-".into()), None]);
        assert_eq!(std::fs::read(part).unwrap(), b"fresh-data");
    }

    #[tokio::test]
    async fn download_retries_throttling_and_service_failure_with_retry_after() {
        let server = Router::new().route("/file", get({
            let count = Arc::new(AtomicUsize::new(0));
            move || async move {
                let status = match count.fetch_add(1, Ordering::Relaxed) {
                    0 => StatusCode::TOO_MANY_REQUESTS,
                    1 => StatusCode::SERVICE_UNAVAILABLE,
                    _ => StatusCode::OK,
                };
                (status, [(header::RETRY_AFTER, "0")], "abc")
            }
        }));
        let (url, server) = serve(server).await;
        let root = tempfile::tempdir().unwrap();
        let part = root.path().join("fixture.part");
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        // The default two successive retry delays exceed this budget.
        let result = tokio::time::timeout(Duration::from_millis(2500),
            transfer(&http, &part, 3, &AtomicBool::new(false), || std::future::ready(Ok(url.clone())), |_| {})).await;
        server.abort();
        result.expect("server Retry-After takes precedence").unwrap();
        assert_eq!(std::fs::read(part).unwrap(), b"abc");
    }

    #[tokio::test]
    async fn cancelling_a_stream_flushes_the_received_bytes() {
        let server = Router::new().route("/file", get(|| async {
            let chunks = stream::once(async {
                tokio::time::sleep(Duration::from_millis(350)).await;
                Ok::<_, std::io::Error>(axum::body::Bytes::from_static(b"abc"))
            }).chain(stream::pending());
            Response::new(Body::from_stream(chunks))
        }));
        let (url, server) = serve(server).await;
        let root = tempfile::tempdir().unwrap();
        let part = root.path().join("fixture.part");
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let cancel = AtomicBool::new(false);
        let result = tokio::time::timeout(Duration::from_secs(5),
            transfer(&http, &part, 6, &cancel, || std::future::ready(Ok(url.clone())), |state| {
                if matches!(state, TransferProgress::Downloading(3)) { cancel.store(true, Ordering::Relaxed); }
            })).await;
        server.abort();
        assert!(result.unwrap().unwrap_err().to_string().contains("下载已暂停"));
        assert_eq!(std::fs::read(part).unwrap(), b"abc");
    }

    #[tokio::test]
    async fn alternating_short_whole_responses_cannot_reset_failure_budget() {
        let requests = Arc::new(AtomicUsize::new(0));
        let observed = requests.clone();
        let server = Router::new().route(
            "/file",
            get(move || {
                let requests = requests.clone();
                async move {
                    let request = requests.fetch_add(1, Ordering::Relaxed);
                    if request % 2 == 0 {
                        "abc"
                    } else {
                        "abcd"
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, server).await.unwrap();
        });
        let root = tempfile::tempdir().unwrap();
        let part = root.path().join("fixture.part");
        std::fs::write(&part, b"abcd").unwrap();
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(25),
            transfer(
                &http,
                &part,
                6,
                &AtomicBool::new(false),
                || std::future::ready(Ok(format!("http://{address}/file?signature=test-secret"))),
                |_| {},
            ),
        )
        .await
        .unwrap();
        server.abort();
        let error = result.unwrap_err().to_string();
        assert!(error.contains("下载连接提前关闭"));
        assert!(!error.contains("test-secret"));
        assert_eq!(observed.load(Ordering::Relaxed), 4);
        assert_eq!(std::fs::read(&part).unwrap(), b"abcd");
    }
}
