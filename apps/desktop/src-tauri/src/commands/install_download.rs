//! Resumable transport for the H3 and voice installers. Each caller verifies
//! the finished partial against its own pinned digest before publishing it.
use std::{
    future::Future,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use reqwest::{header, StatusCode};
use tokio::io::AsyncWriteExt;

use crate::error::{AppError, AppResult};

const MAX_FAILURES: u32 = 4;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

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
        let failure = download_attempt(
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
            return Err(fail(format!("{failure}，已保留下载进度，请稍后重试")));
        }
        progress(TransferProgress::Reconnecting(offset));
        tokio::select! {
            _ = wait_cancel(cancel) => return Err(cancelled()),
            _ = tokio::time::sleep(Duration::from_secs(u64::from(failures.max(1)))) => {}
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
) -> AppResult<String> {
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
            Err(error) => return Ok(network_error(&error).into()),
        },
    };
    let status = response.status();
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
        status if matches!(status.as_u16(), 401 | 403 | 408 | 429 | 500..=599) => {
            return Ok(format!("下载服务返回 HTTP {}", status.as_u16()));
        }
        _ => {
            return Err(fail(format!(
                "下载服务返回 HTTP {}，请检查网络后重试",
                status.as_u16()
            )))
        }
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(*offset == 0)
        .append(*offset > 0)
        .open(part)
        .await?;
    let mut published = Instant::now();
    let reason = loop {
        let next = tokio::select! {
            _ = wait_cancel(cancel) => { file.sync_all().await?; return Err(cancelled()); },
            result = response.chunk() => result,
        };
        match next {
            Ok(Some(chunk)) => {
                if chunk.len() as u64 > size - *offset {
                    return Err(fail("下载文件超过已知大小"));
                }
                file.write_all(&chunk).await?;
                *offset += chunk.len() as u64;
                if published.elapsed() >= PROGRESS_INTERVAL {
                    progress(TransferProgress::Downloading(*offset));
                    published = Instant::now();
                }
            }
            Ok(None) => break "下载连接提前关闭",
            Err(error) => break network_error(&error),
        }
    };
    file.sync_all().await?;
    Ok(reason.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router};
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

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
            Duration::from_secs(10),
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
