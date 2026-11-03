#[path = "../../../src-tauri/src/quick_transfer/transport.rs"]
mod transport;
#[path = "../../../src-tauri/src/quick_transfer/addresses.rs"]
mod addresses;

use std::{collections::HashMap, net::Ipv4Addr, sync::Arc};
use tokio::sync::{mpsc, Mutex};
use transport::{StartConfig, TransportEvent};

#[tokio::test]
async fn mobile_page_uses_real_localsend_http() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().to_path_buf();
    let receipts = Arc::new(Mutex::new(Vec::new()));
    let recorded = receipts.clone();
    let (tx, mut rx) = mpsc::channel(64);
    let consumer = tokio::spawn(async move {
        let mut names = HashMap::new();
        while let Some(event) = rx.recv().await {
            match event {
                TransportEvent::Prepare { id, file_name, reply, .. } => {
                    let result = if file_name == "拒绝.png" {
                        Err("Test-only receiver refusal".into())
                    } else {
                        names.insert(id.clone(), file_name);
                        Ok(root.join(id))
                    };
                    let _ = reply.send(result);
                }
                TransportEvent::Received { id, reply } => {
                    let name = names.get(&id).unwrap().clone();
                    let bytes = tokio::fs::read(root.join(id)).await.unwrap();
                    let recorded = recorded.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        if name == "校验失败.png" {
                            let _ = reply.send(Err("Test-only receipt rejection".into()));
                        } else {
                            recorded.lock().await.push((name, bytes));
                            let _ = reply.send(Ok(()));
                        }
                    });
                }
                TransportEvent::Stopped => break,
                _ => {}
            }
        }
    });
    let page_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../src-tauri/src/quick_transfer/upload.html");
    let page = std::fs::read_to_string(page_path).ok();
    let bind_ip = std::env::var("BOWERBIRD_TEST_BIND_IP")
        .map(|value| value.parse::<Ipv4Addr>().expect("valid test bind IP"))
        .unwrap_or(Ipv4Addr::LOCALHOST);
    let pairing_pin = "01234567";
    let handle = transport::start(StartConfig {
        bind_ip,
        port: 0,
        session_secret: pairing_pin.into(),
        upload_page: page,
        allowed_extensions: ["png", "mp4", "txt", "mp3"].map(String::from).to_vec(),
    }, tx).await.unwrap();
    let address = handle.address();
    let stop_path = directory.path().join("close-listener.signal");
    let signal = stop_path.clone();
    let stopper = tokio::spawn(async move {
        while !signal.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        handle.stop().await;
    });
    let result = tokio::process::Command::new("node")
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/../../quick-transfer-mobile.test.mjs"))
        .arg(format!("http://{address}/?pin={pairing_pin}"))
        .arg(&stop_path)
        .output().await.unwrap();
    std::fs::write(stop_path, "stop").unwrap();
    stopper.await.unwrap();
    consumer.await.unwrap();
    println!("{}", String::from_utf8_lossy(&result.stdout));
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    let records = receipts.lock().await;
    let originals: Vec<_> = records.iter().filter(|(name, _)| name == "山间晨雾.png").collect();
    assert_eq!(originals.len(), 2, "only explicit re-selection sends a file twice");
    assert!(originals.iter().all(|(_, bytes)| bytes == b"browser-upload"));
    assert!(!records.iter().any(|(name, _)| name == "拒绝.png" || name == "校验失败.png"));
    assert_eq!(records.iter().filter(|(name, _)| name == "回执丢失.png").count(), 1);
}
