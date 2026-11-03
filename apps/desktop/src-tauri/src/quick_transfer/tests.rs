use super::*;
use serde_json::{json, Value};
use std::time::Duration;

fn fixture() -> (
    tempfile::TempDir,
    std::path::PathBuf,
    Arc<LibraryPaths>,
    Arc<Database>,
) {
    let root = tempfile::tempdir().unwrap();
    let receive = root.path().join("快传收件");
    std::fs::create_dir(&receive).unwrap();
    let paths = Arc::new(LibraryPaths::init(root.path().join("library")).unwrap());
    let db = Arc::new(Database::open(&paths.db).unwrap());
    db.migrate().unwrap();
    (root, receive, paths, db)
}

#[tokio::test]
async fn browser_upload_is_saved_and_indexed_before_reporting_library_success() {
    let (_root, receive, paths, db) = fixture();
    let runtime = QuickTransfer::default();
    assert!(!runtime.snapshot().active);
    let started = runtime
        .start(
            &receive,
            Ipv4Addr::LOCALHOST,
            paths,
            db.clone(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    let url = reqwest::Url::parse(started.url.as_deref().unwrap()).unwrap();
    let pin = url
        .query_pairs()
        .find(|(key, _)| key == "pin")
        .unwrap()
        .1
        .into_owned();
    assert_eq!(pin.len(), 8, "manual entry uses an eight-digit pairing code");
    assert!(pin.bytes().all(|byte| byte.is_ascii_digit()));
    let base = format!("http://{}:{}", url.host_str().unwrap(), url.port().unwrap());
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2, 2)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let png = png.into_inner();
    let prepared = client.post(format!("{base}/api/localsend/v2/prepare-upload?pin={pin}"))
        .json(&json!({"info":{"alias":"Phone","version":"2.1","deviceType":"web","fingerprint":"browser-fixture","port":0,"protocol":"http"},
            "files":{"photo":{"id":"photo","fileName":"手机原件.png","size":png.len(),"fileType":"image/png"}}}))
        .send().await.unwrap();
    assert_eq!(prepared.status(), 200);
    let ticket: Value = prepared.json().await.unwrap();
    let response = client
        .post(format!(
            "{base}/api/localsend/v2/upload?sessionId={}&fileId=photo&token={}",
            ticket["sessionId"].as_str().unwrap(),
            ticket["files"]["photo"].as_str().unwrap()
        ))
        .body(png.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let completed = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let snapshot = runtime.snapshot();
            if snapshot
                .transfers
                .first()
                .is_some_and(|file| file.status == TransferStatus::Complete)
            {
                break snapshot;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let asset = db
        .get_asset(completed.transfers[0].asset_id.as_deref().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(std::fs::read(asset.store_path.unwrap()).unwrap(), png);
    let stopped = runtime.stop().await.unwrap();
    assert!(!stopped.active);
    assert!(stopped.url.is_none());
    assert_eq!(stopped.transfers[0].status, TransferStatus::Complete);
    assert!(client.get(&base).send().await.is_err());
}

#[tokio::test]
async fn reopening_rotates_pairing_and_invalid_media_is_not_acknowledged_or_retryable() {
    let (_root, receive, paths, db) = fixture();
    let runtime = QuickTransfer::default();
    let first = runtime
        .start(
            &receive,
            Ipv4Addr::LOCALHOST,
            paths.clone(),
            db.clone(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    assert!(runtime
        .start(
            &receive,
            Ipv4Addr::LOCALHOST,
            paths.clone(),
            db.clone(),
            Arc::new(|_| {})
        )
        .await
        .is_err());
    let old_url = reqwest::Url::parse(first.url.as_deref().unwrap()).unwrap();
    let old_pin = old_url
        .query_pairs()
        .find(|(key, _)| key == "pin")
        .unwrap()
        .1
        .into_owned();
    runtime.stop().await.unwrap();
    let next = runtime
        .start(&receive, Ipv4Addr::LOCALHOST, paths, db, Arc::new(|_| {}))
        .await
        .unwrap();
    let url = reqwest::Url::parse(next.url.as_deref().unwrap()).unwrap();
    let pin = url
        .query_pairs()
        .find(|(key, _)| key == "pin")
        .unwrap()
        .1
        .into_owned();
    assert_ne!(pin, old_pin);
    let base = format!("http://{}:{}", url.host_str().unwrap(), url.port().unwrap());
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let manifest = json!({"info":{"alias":"Phone","version":"2.1","deviceType":"web","fingerprint":"fixture","port":0,"protocol":"http"},
        "files":{"file":{"id":"file","fileName":"broken.png","size":4,"fileType":"image/png"}}});
    assert_eq!(
        client
            .post(format!(
                "{base}/api/localsend/v2/prepare-upload?pin={old_pin}"
            ))
            .json(&manifest)
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let ticket: Value = client
        .post(format!("{base}/api/localsend/v2/prepare-upload?pin={pin}"))
        .json(&manifest)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let response = client
        .post(format!(
            "{base}/api/localsend/v2/upload?sessionId={}&fileId=file&token={}",
            ticket["sessionId"].as_str().unwrap(),
            ticket["files"]["file"].as_str().unwrap()
        ))
        .body("fake")
        .send()
        .await
        .unwrap();
    assert!(!response.status().is_success());
    let stopped = runtime.stop().await.unwrap();
    assert_eq!(stopped.transfers.len(), 1);
    assert_eq!(stopped.transfers[0].status, TransferStatus::Failed);
    assert!(!stopped.transfers[0].retryable);
    assert!(!receive.join("broken.png").exists());
    assert!(stopped.transfers[0].asset_id.is_none());
}

#[tokio::test]
async fn late_cancellation_keeps_durable_library_success() {
    let (_root, receive, paths, db) = fixture();
    let context = Context {
        store: Arc::new(Mutex::new(QuickTransferStore::open(&receive).unwrap())),
        paths,
        db,
        view: Arc::new(Mutex::new(Snapshot::default())),
        notify: Arc::new(|_| {}),
    };
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2, 2)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let png = png.into_inner();
    let path = context
        .prepare("closing".into(), "photo.png".into(), png.len() as u64)
        .await
        .unwrap();
    std::fs::write(path, png).unwrap();
    context.received("closing").await.unwrap();
    context.index("closing".into()).await;
    let asset_id = context.view.lock().unwrap().transfers[0]
        .asset_id
        .clone()
        .unwrap();
    // A stop signal can win the network acknowledgement while the durable write finishes.
    context.failed("closing".into(), "接收已关闭".into()).await;
    let snapshot = context.view.lock().unwrap().clone();
    assert_eq!(snapshot.transfers[0].status, TransferStatus::Complete);
    assert!(snapshot.transfers[0].error.is_none());
    assert_eq!(
        snapshot.transfers[0].asset_id.as_deref(),
        Some(asset_id.as_str())
    );
    assert!(context.db.get_asset(&asset_id).unwrap().is_some());
}

fn revision(snapshot: &Snapshot) -> u64 {
    serde_json::to_value(snapshot).unwrap()["revision"]
        .as_u64()
        .expect("every IPC/event snapshot needs an ordering revision")
}

#[tokio::test]
async fn snapshot_revision_never_resets_when_receive_session_reopens() {
    let (_root, receive, paths, db) = fixture();
    let runtime = QuickTransfer::default();
    assert_eq!(revision(&runtime.snapshot()), 0);
    let started = runtime
        .start(
            &receive,
            Ipv4Addr::LOCALHOST,
            paths.clone(),
            db.clone(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    let stopped = runtime.stop().await.unwrap();
    let reopened = runtime
        .start(&receive, Ipv4Addr::LOCALHOST, paths, db, Arc::new(|_| {}))
        .await
        .unwrap();
    assert!(revision(&started) > 0);
    assert!(revision(&stopped) > revision(&started));
    assert!(revision(&reopened) > revision(&stopped));
    assert_eq!(revision(&reopened), revision(&runtime.snapshot()));
    runtime.stop().await.unwrap();
}

#[test]
fn snapshot_revision_identifies_out_of_order_notifications() {
    let (_root, receive, paths, db) = fixture();
    let delivered = Arc::new(Mutex::new(Vec::<Snapshot>::new()));
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release_rx = Mutex::new(release_rx);
    let deliveries = delivered.clone();
    let context = Arc::new(Context {
        store: Arc::new(Mutex::new(QuickTransferStore::open(&receive).unwrap())),
        paths,
        db,
        view: Arc::new(Mutex::new(Snapshot::default())),
        notify: Arc::new(move |snapshot| {
            if snapshot.active {
                entered_tx.send(()).unwrap();
                release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
            }
            deliveries.lock().unwrap().push(snapshot.clone());
        }),
    });
    let earlier = context.clone();
    let worker = std::thread::spawn(move || earlier.update(|view| view.active = true));
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    context.update(|view| view.active = false);
    release_tx.send(()).unwrap();
    worker.join().unwrap();
    let delivered = delivered.lock().unwrap();
    assert_eq!(delivered.len(), 2);
    assert!(!delivered[0].active);
    assert!(delivered[1].active);
    assert!(revision(&delivered[0]) > revision(&delivered[1]));
    assert_eq!(
        revision(&context.view.lock().unwrap()),
        revision(&delivered[0])
    );
}
