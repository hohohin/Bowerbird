use localsend::{http::{server::{start_with_ipv4, web::{WebConfig, WebSendConfig, WebPages, WebI18n, WebSendEvent}}, state::ClientInfo}, reqwest};
use std::{collections::HashMap, net::Ipv4Addr};
use tokio::sync::{mpsc, oneshot};

#[tokio::test]
async fn scoped_browser_download_can_pair_without_enabling_upload() {
    let (events, mut rx) = mpsc::channel(8);
    let (stop, stopped) = oneshot::channel();
    let server = start_with_ipv4(Ipv4Addr::LOCALHOST, 0, None, ClientInfo {
        alias: "Bowerbird".into(), version: "2.2".into(), device_model: None,
        device_type: None, token: "test".into(),
    }, None, None, Some(WebConfig {
        send: Some(WebSendConfig { files: HashMap::new(), pin: Some("01234567".into()), event_tx: events }),
        upload: false, i18n: WebI18n::default(), pages: WebPages::default(),
    }), stopped).await.unwrap();
    let consumer = tokio::spawn(async move {
        while let Some(WebSendEvent::PrepareDownload { decision_tx, .. }) = rx.recv().await {
            let _ = decision_tx.send(true);
        }
    });
    let base = format!("http://127.0.0.1:{}", server.port());
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let paired = client.post(format!("{base}/api/localsend/v2/prepare-download?pin=01234567")).send().await.unwrap().status();
    let upload = client.post(format!("{base}/api/localsend/v2/prepare-upload?pin=01234567")).send().await.unwrap().status();
    stop.send(()).unwrap(); server.wait_stopped().await; consumer.abort();
    assert_eq!(paired, 200, "send mode must expose authenticated browser downloads");
    assert_eq!(upload, 404, "send mode must not accept uploads");
}
