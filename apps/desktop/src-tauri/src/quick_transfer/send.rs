//! Explicitly selected originals only; LocalSend owns browser authentication and HTTP.
use localsend::{
    http::{server::{start_with_ipv4, web::{WebConfig, WebI18n, WebPages, WebSendConfig, WebSendEvent}}, state::ClientInfo},
    model::transfer::{FileContent, FileDto},
};
use serde::Serialize;
use std::{collections::HashMap, net::Ipv4Addr, path::PathBuf, sync::Arc, time::{Duration, SystemTime}};
use tokio::{io::AsyncReadExt, sync::{mpsc, oneshot, watch}, task::JoinSet};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendSnapshot {
    pub url: String,
    pub files: Vec<SendFile>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SendFile {
    pub id: String,
    pub name: String,
    pub size: u64,
}

struct Original {
    path: PathBuf,
    modified: SystemTime,
    size: u64,
}

pub struct SendHandle {
    pub snapshot: SendSnapshot,
    stop: watch::Sender<bool>,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl SendHandle {
    pub async fn stop(mut self) {
        let _ = self.stop.send(true);
        if let Some(task) = self.task.take() { let _ = task.await; }
    }
}
impl Drop for SendHandle {
    fn drop(&mut self) { let _ = self.stop.send(true); }
}

async fn selected_files(paths: Vec<PathBuf>) -> Result<(Vec<SendFile>, HashMap<String, Original>), String> {
    if paths.is_empty() || paths.len() > 100 { return Err("请选择 1–100 个文件".into()); }
    let mut files = Vec::new();
    let mut originals = HashMap::new();
    let mut seen = std::collections::HashSet::new();
    let mut total = 0_u64;
    for path in paths {
        let path = tokio::fs::canonicalize(path).await.map_err(|_| "文件不可用，请重新选择")?;
        if !seen.insert(path.clone()) { continue; }
        let metadata = tokio::fs::metadata(&path).await.map_err(|_| "无法读取所选文件")?;
        if !metadata.is_file() || metadata.len() > 2 * 1024 * 1024 * 1024 {
            return Err("请选择普通文件，单个文件不能超过 2 GiB".into());
        }
        total += metadata.len();
        if total > 10 * 1024 * 1024 * 1024 { return Err("本次发送总大小不能超过 10 GiB".into()); }
        let name = path.file_name().ok_or("文件名不可用")?.to_string_lossy().into_owned();
        let id = uuid::Uuid::new_v4().to_string();
        files.push(SendFile { id: id.clone(), name, size: metadata.len() });
        originals.insert(id, Original { path, modified: metadata.modified().map_err(|_| "无法读取文件修改时间")?, size: metadata.len() });
    }
    Ok((files, originals))
}

pub async fn start(ip: Ipv4Addr, paths: Vec<PathBuf>, on_stopped: Arc<dyn Fn() + Send + Sync>) -> Result<SendHandle, String> {
    if !(super::addresses::available_ipv4_addresses().contains(&ip) || cfg!(test) && ip.is_loopback()) {
        return Err("请选择本机有效的局域网地址".into());
    }
    let (files, originals) = selected_files(paths).await?;
    let pin = format!("{:08}", uuid::Uuid::new_v4().as_u128() % 100_000_000);
    let (events, mut rx) = mpsc::channel(32);
    let (stop_server, stopped) = oneshot::channel();
    let server = start_with_ipv4(ip, 0, None, ClientInfo {
        alias: "Bowerbird".into(), version: "2.2".into(), device_model: None,
        device_type: None, token: uuid::Uuid::new_v4().to_string(),
    }, None, None, Some(WebConfig {
        send: Some(WebSendConfig {
            files: files.iter().map(|file| (file.id.clone(), FileDto {
                id: file.id.clone(), file_name: file.name.clone(), size: file.size,
                file_type: "application/octet-stream".into(), sha256: None, preview: None, metadata: None,
            })).collect(), pin: Some(pin.clone()), event_tx: events,
        }), upload: false, i18n: WebI18n::default(),
        pages: WebPages { download_html: Some(include_str!("download.html").into()), ..Default::default() },
    }), stopped).await.map_err(|_| "未能开启发送，请检查网络后重试")?;
    let snapshot = SendSnapshot { url: format!("http://{ip}:{}/?pin={pin}", server.port()), files };
    let (stop, mut shutdown) = watch::channel(false);
    let task = tokio::spawn(async move {
        let originals = Arc::new(originals);
        let mut downloads = JoinSet::new();
        loop {
            tokio::select! {
                biased;
                _ = shutdown.changed() => break,
                _ = downloads.join_next(), if !downloads.is_empty() => {},
                event = rx.recv() => match event {
                    Some(WebSendEvent::PrepareDownload { decision_tx, .. }) => { let _ = decision_tx.send(true); },
                    Some(WebSendEvent::FileDownload { file_id, content_tx, .. }) => {
                        if downloads.len() >= 4 { continue; }
                        let files = originals.clone();
                        let cancel = shutdown.clone();
                        downloads.spawn(async move {
                            if let Some(original) = files.get(&file_id) { stream_original(original, content_tx, cancel).await; }
                        });
                    },
                    None => break,
                }
            }
        }
        // Stop socket tasks before waiting on file producers; neither outlives the switch.
        let _ = stop_server.send(());
        downloads.abort_all();
        while downloads.join_next().await.is_some() {}
        server.wait_stopped().await;
        on_stopped();
    });
    Ok(SendHandle { snapshot, stop, task: Some(task) })
}

async fn open_original(original: &Original) -> Option<tokio::fs::File> {
    if tokio::fs::canonicalize(&original.path).await.ok()? != original.path { return None; }
    let file = tokio::fs::File::open(&original.path).await.ok()?;
    let metadata = file.metadata().await.ok()?;
    (metadata.is_file() && metadata.len() == original.size && metadata.modified().ok()? == original.modified).then_some(file)
}

async fn stream_original(original: &Original, content: oneshot::Sender<FileContent>, mut shutdown: watch::Receiver<bool>) {
    let Some(file) = open_original(original).await else { return; };
    let mut file = file.take(original.size);
    let (tx, rx) = mpsc::channel(2);
    if content.send(FileContent::Stream(rx)).is_err() { return; }
    loop {
        let mut buffer = vec![0; 256 * 1024];
        let result = tokio::select! {
            biased;
            _ = shutdown.changed() => return,
            result = tokio::time::timeout(Duration::from_secs(60), file.read(&mut buffer)) => result,
        };
        let Ok(Ok(size)) = result else { return; };
        if size == 0 { return; }
        buffer.truncate(size);
        tokio::select! {
            biased;
            _ = shutdown.changed() => return,
            result = tokio::time::timeout(Duration::from_secs(60), tx.send(buffer.into())) => {
                if !matches!(result, Ok(Ok(()))) { return; }
            }
        }
    }
}

#[cfg(test)]
#[path = "send_tests.rs"]
mod tests;
