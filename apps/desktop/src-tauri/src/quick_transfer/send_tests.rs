use super::*;
use localsend::reqwest;
use serde_json::Value;

async fn fixture() -> (tempfile::TempDir, SendHandle, reqwest::Client) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("照片 原件.heic");
    tokio::fs::write(&path, b"original-bytes\0\xff").await.unwrap();
    let handle = start(Ipv4Addr::LOCALHOST, vec![path], Arc::new(|| {})).await.unwrap();
    (dir, handle, reqwest::Client::builder().no_proxy().build().unwrap())
}

async fn pair(handle: &SendHandle, client: &reqwest::Client) -> Value {
    let url = reqwest::Url::parse(&handle.snapshot.url).unwrap();
    client.post(format!("{}api/localsend/v2/prepare-download?{}", url.join("/").unwrap(), url.query().unwrap()))
        .send().await.unwrap().error_for_status().unwrap().json().await.unwrap()
}

#[tokio::test]
async fn downloads_multiple_chunks_and_empty_files_without_conversion() {
    let dir = tempfile::tempdir().unwrap();
    let data: Vec<u8> = (0..3 * 1024 * 1024 + 7).map(|index| (index % 251) as u8).collect();
    let binary = dir.path().join("原件.bin");
    let empty = dir.path().join("empty.txt");
    tokio::fs::write(&binary, &data).await.unwrap();
    tokio::fs::write(&empty, b"").await.unwrap();
    let handle = start(Ipv4Addr::LOCALHOST, vec![binary, empty], Arc::new(|| {})).await.unwrap();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let ticket = pair(&handle, &client).await;
    assert_eq!(ticket["files"].as_object().unwrap().len(), 2);
    for file in &handle.snapshot.files {
        let mut url = reqwest::Url::parse(&handle.snapshot.url).unwrap().join("api/localsend/v2/download").unwrap();
        url.query_pairs_mut().append_pair("sessionId", ticket["sessionId"].as_str().unwrap()).append_pair("fileId", &file.id);
        let response = client.get(url).send().await.unwrap().error_for_status().unwrap();
        assert_eq!(response.content_length().unwrap(), file.size);
        let bytes = response.bytes().await.unwrap();
        let expected = if file.size == 0 { &[][..] } else { &data[..] };
        assert_eq!(bytes.as_ref(), expected);
    }
    handle.stop().await;
}

#[tokio::test]
async fn selected_original_download_authentication_and_stop() {
    let (_dir, handle, client) = fixture().await;
    let base = reqwest::Url::parse(&handle.snapshot.url).unwrap().join("/").unwrap();
    assert_eq!(client.get(base.clone()).send().await.unwrap().status(), 200);
    let prepare = base.join("api/localsend/v2/prepare-download").unwrap();
    assert_eq!(client.post(prepare).send().await.unwrap().status(), 401);
    let pair = pair(&handle, &client).await;
    let id = &handle.snapshot.files[0].id;
    let mut download = base.join("api/localsend/v2/download").unwrap();
    download.query_pairs_mut().append_pair("sessionId", pair["sessionId"].as_str().unwrap()).append_pair("fileId", id);
    let response = client.get(download.clone()).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert!(response.headers()["content-disposition"].to_str().unwrap().contains("filename*=UTF-8''"));
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.bytes().await.unwrap().as_ref(), b"original-bytes\0\xff");
    assert_eq!(client.get(download.clone()).header("Origin", "http://other.invalid").send().await.unwrap().status(), 403);
    assert_eq!(client.get(download.clone()).header("Host", "other.invalid").send().await.unwrap().status(), 403);
    let old_session = pair["sessionId"].as_str().unwrap();
    let current_session = super::tests::pair(&handle, &client).await;
    assert_ne!(old_session, current_session["sessionId"].as_str().unwrap());
    assert_eq!(client.get(download.clone()).send().await.unwrap().status(), 403, "re-pairing revokes the previous session");
    download.set_query(Some("sessionId=127.0.0.1&fileId=anything"));
    assert_eq!(client.get(download).send().await.unwrap().status(), 403);
    assert_eq!(client.post(base.join("api/localsend/v2/prepare-upload").unwrap()).send().await.unwrap().status(), 404);
    assert_eq!(client.get(base.join("../../secret").unwrap()).send().await.unwrap().status(), 404);
    handle.stop().await;
    assert!(client.get(base).send().await.is_err());
}

#[tokio::test]
async fn wrong_pin_locks_out_and_reopen_revokes_old_tickets() {
    let (dir, handle, client) = fixture().await;
    let base = reqwest::Url::parse(&handle.snapshot.url).unwrap().join("/").unwrap();
    let pin = reqwest::Url::parse(&handle.snapshot.url).unwrap().query_pairs().next().unwrap().1.into_owned();
    let wrong = if pin == "00000000" { "11111111" } else { "00000000" };
    for _ in 0..3 {
        assert_eq!(client.post(base.join(&format!("api/localsend/v2/prepare-download?pin={wrong}")).unwrap()).send().await.unwrap().status(), 401);
    }
    assert_eq!(client.post(base.join(&format!("api/localsend/v2/prepare-download?pin={pin}")).unwrap()).send().await.unwrap().status(), 429);
    let path = dir.path().join(&handle.snapshot.files[0].name);
    handle.stop().await;
    let reopened = start(Ipv4Addr::LOCALHOST, vec![path], Arc::new(|| {})).await.unwrap();
    let paired = pair(&reopened, &client).await;
    assert!(paired["files"].as_object().unwrap().len() == 1);
    reopened.stop().await;
}

#[tokio::test]
async fn slow_stream_is_bounded_and_cancel_releases_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("large.bin");
    tokio::fs::write(&path, vec![42_u8; 4 * 1024 * 1024]).await.unwrap();
    let (_, originals) = selected_files(vec![path.clone()]).await.unwrap();
    let original = originals.into_values().next().unwrap();
    let (reply, content) = oneshot::channel();
    let (stop, shutdown) = watch::channel(false);
    let task = tokio::spawn(async move { stream_original(&original, reply, shutdown).await; });
    let mut chunks = content.await.unwrap().into_receiver();
    assert_eq!(chunks.recv().await.unwrap().len(), 256 * 1024);
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!task.is_finished(), "bounded producer waits for the client");
    stop.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(2), task).await.unwrap().unwrap();
    assert!(chunks.len() <= 2);
    tokio::fs::remove_file(path).await.unwrap();
}

#[tokio::test]
async fn selection_limits_deduplication_and_changed_original() {
    assert!(selected_files(Vec::new()).await.is_err());
    assert!(selected_files(vec![PathBuf::from("unused"); 101]).await.is_err());
    let (dir, handle, client) = fixture().await;
    assert!(selected_files(vec![dir.path().into()]).await.is_err());
    let path = dir.path().join(&handle.snapshot.files[0].name);
    assert_eq!(selected_files(vec![path.clone(), path.clone()]).await.unwrap().0.len(), 1);
    let paired = pair(&handle, &client).await;
    tokio::fs::write(&path, b"changed").await.unwrap();
    let mut download = reqwest::Url::parse(&handle.snapshot.url).unwrap().join("api/localsend/v2/download").unwrap();
    download.query_pairs_mut().append_pair("sessionId", paired["sessionId"].as_str().unwrap()).append_pair("fileId", &handle.snapshot.files[0].id);
    assert_eq!(client.get(download).send().await.unwrap().status(), 500);
    handle.stop().await;
}

#[tokio::test]
async fn browser_downloads_original_files() {
    let (_dir, handle, _) = fixture().await;
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let desktop = manifest.ancestors().find(|path| path.file_name().is_some_and(|name| name == "desktop")).unwrap();
    let result = tokio::process::Command::new("node")
        .arg(desktop.join("scripts/quick-transfer-download.test.mjs"))
        .arg(&handle.snapshot.url).output().await.unwrap();
    handle.stop().await;
    assert!(result.status.success(), "{}\n{}", String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr));
    println!("{}", String::from_utf8_lossy(&result.stdout));
}
