use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use reqwest::{header, StatusCode};
use tokio::io::AsyncWriteExt;

use crate::core::local_classification::vector::{cancellable, download_with_io, verify};

use super::artifacts::{storage_error, Artifact};

const CHUNK_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ATTEMPTS: usize = 4;

/// The text tower exceeds one gigabyte. Re-resolve the pinned public artifact
/// after a broken connection and keep the bytes already written to disk.
pub(super) async fn download_text(
    directory: &Path,
    url: &str,
    item: &Artifact,
    cancel: &AtomicBool,
    progress: &impl Fn(&str, u64, u64),
) -> Result<(), String> {
    check_cancel(cancel)?;
    let target = directory.join(item.name);
    if target.exists() {
        if checked(target.clone(), item.sha256).await? {
            progress(item.name, item.bytes, item.bytes);
            return Ok(());
        }
        tokio::fs::remove_file(&target)
            .await
            .map_err(storage_error)?;
    }
    let partial = directory.join(format!("{}.part", item.name));
    let mut offset = tokio::fs::metadata(&partial)
        .await
        .map_or(0, |file| file.len());
    if offset > item.bytes {
        tokio::fs::remove_file(&partial)
            .await
            .map_err(storage_error)?;
        offset = 0;
    }
    if offset > 0 {
        progress(item.name, offset, item.bytes);
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| error.to_string())?;
    while offset < item.bytes {
        let end = offset.saturating_add(CHUNK_BYTES).min(item.bytes) - 1;
        for _ in 0..MAX_ATTEMPTS {
            if offset > end {
                break;
            }
            check_cancel(cancel)?;
            let request = client
                .get(url)
                .header(header::RANGE, format!("bytes={offset}-{end}"));
            let mut response = match cancellable(cancel, request.send()).await {
                Ok(response) => response,
                Err(_) => continue,
            };
            if response.status() == StatusCode::OK {
                // An origin without Range support can still use the existing
                // bounded whole-file downloader and its digest check.
                drop(response);
                return download_with_io(
                    directory,
                    &[url],
                    (item.name, item.sha256, item.bytes),
                    cancel,
                    progress,
                    storage_error,
                )
                .await;
            }
            if response.status() != StatusCode::PARTIAL_CONTENT {
                continue;
            }
            let expected = format!("bytes {offset}-{end}/{}", item.bytes);
            if response
                .headers()
                .get(header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                != Some(expected.as_str())
            {
                return Err("语义搜索模型的下载范围不正确，请重试。".into());
            }
            let mut file = tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&partial)
                .await
                .map_err(storage_error)?;
            while let Ok(Some(chunk)) = cancellable(cancel, response.chunk()).await {
                if chunk.len() as u64 > end + 1 - offset {
                    return Err("语义搜索模型的下载内容超过预期范围，请重试。".into());
                }
                file.write_all(&chunk).await.map_err(storage_error)?;
                offset += chunk.len() as u64;
                progress(item.name, offset, item.bytes);
            }
            file.sync_all().await.map_err(storage_error)?;
            check_cancel(cancel)?;
        }
        if offset <= end {
            return Err("语义搜索模型下载中断，已保留进度。请检查网络后重试。".into());
        }
    }
    if !checked(partial.clone(), item.sha256).await? {
        tokio::fs::remove_file(&partial)
            .await
            .map_err(storage_error)?;
        return Err("语义搜索模型下载校验失败，请重新下载。".into());
    }
    check_cancel(cancel)?;
    tokio::fs::rename(partial, target)
        .await
        .map_err(storage_error)?;
    progress(item.name, item.bytes, item.bytes);
    Ok(())
}

async fn checked(path: PathBuf, sha256: &'static str) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || verify(&path, sha256).is_ok())
        .await
        .map_err(|error| error.to_string())
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        Err("已停止下载语义搜索模型。".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    const SMALL: Artifact = Artifact {
        name: "fixture.onnx",
        bytes: 6,
        sha256: "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721",
    };

    #[tokio::test]
    async fn resumes_interrupted_artifact_and_checks_final_digest() {
        let directory = tempfile::tempdir().unwrap();
        tokio::fs::write(directory.path().join("fixture.onnx.part"), b"abc")
            .await
            .unwrap();
        let (url, request) = server("bytes 3-5/6", b"def").await;
        download_text(
            directory.path(),
            &url,
            &SMALL,
            &AtomicBool::new(false),
            &|_, _, _| {},
        )
        .await
        .unwrap();
        assert!(request
            .await
            .unwrap()
            .to_ascii_lowercase()
            .contains("range: bytes=3-5"));
        assert_eq!(
            tokio::fs::read(directory.path().join(SMALL.name))
                .await
                .unwrap(),
            b"abcdef"
        );
    }

    #[tokio::test]
    async fn rejects_inconsistent_ranges_without_overwriting_partial_file() {
        let directory = tempfile::tempdir().unwrap();
        let partial = directory.path().join("fixture.onnx.part");
        tokio::fs::write(&partial, b"abc").await.unwrap();
        let (url, request) = server("bytes 0-2/6", b"def").await;
        assert!(download_text(
            directory.path(),
            &url,
            &SMALL,
            &AtomicBool::new(false),
            &|_, _, _| {}
        )
        .await
        .is_err());
        request.await.unwrap();
        assert_eq!(tokio::fs::read(partial).await.unwrap(), b"abc");
        assert!(!directory.path().join(SMALL.name).exists());
    }

    async fn server(
        range: &'static str,
        data: &'static [u8],
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/model", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut connection, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            let size = connection.read(&mut buffer).await.unwrap();
            let headers = format!("HTTP/1.1 206 Partial Content\r\nContent-Range: {range}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", data.len());
            connection.write_all(headers.as_bytes()).await.unwrap();
            connection.write_all(data).await.unwrap();
            String::from_utf8(buffer[..size].to_vec()).unwrap()
        });
        (url, task)
    }
}
