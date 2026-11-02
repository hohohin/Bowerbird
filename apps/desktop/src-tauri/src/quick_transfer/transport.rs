//! A scoped, receive-only LocalSend v2 browser endpoint.
use localsend::{
    http::{
        server::{
            common::save::FileUploadTarget,
            start_with_ipv4,
            v2::{PrepareUploadDecisionV2, ServerEventV2, SessionEndReasonV2},
            web::{WebConfig, WebI18n, WebPages},
            ServerConfigV2, ServerHandle,
        },
        state::ClientInfo,
    },
    model::transfer::FileDto,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::{
    io::AsyncWriteExt,
    sync::{mpsc, oneshot, watch},
    task::JoinSet,
};

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_SESSION_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const MAX_SESSION_FILES: usize = 500;
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

pub struct StartConfig {
    pub bind_ip: Ipv4Addr,
    pub port: u16,
    pub session_secret: String,
    pub upload_page: Option<String>,
    pub allowed_extensions: Vec<String>,
}

#[derive(Debug)]
pub enum TransportEvent {
    Prepare {
        id: String,
        file_name: String,
        size: u64,
        reply: oneshot::Sender<Result<PathBuf, String>>,
    },
    Progress {
        id: String,
        received_bytes: u64,
    },
    Received {
        id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Failed {
        id: String,
        message: String,
    },
    Stopped,
}

pub struct TransportHandle {
    address: SocketAddr,
    shutdown: watch::Sender<bool>,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl TransportHandle {
    pub fn address(&self) -> SocketAddr {
        self.address
    }
    pub async fn stop(mut self) {
        let _ = self.shutdown.send(true);
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}
impl Drop for TransportHandle {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
    }
}

pub fn available_ipv4_addresses() -> Vec<Ipv4Addr> {
    let mut ips = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| match i.ip() {
            std::net::IpAddr::V4(ip)
                if ip.is_private() && !ip.is_loopback() && !ip.is_link_local() =>
            {
                Some(ip)
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    ips.sort();
    ips.dedup();
    ips
}

pub async fn start(
    config: StartConfig,
    events: mpsc::Sender<TransportEvent>,
) -> Result<TransportHandle, String> {
    validate_start_config(&config)?;
    let (source_tx, source_rx) = mpsc::channel(32);
    let (stop_tx, stop_rx) = oneshot::channel();
    let (shutdown, shutdown_rx) = watch::channel(false);
    let server = start_with_ipv4(
        config.bind_ip,
        config.port,
        None,
        ClientInfo {
            alias: "Bowerbird".into(),
            version: "2.2".into(),
            device_model: None,
            device_type: None,
            token: uuid::Uuid::new_v4().to_string(),
        },
        None,
        Some(ServerConfigV2 {
            pin: Some(config.session_secret),
            verify_checksums: false,
            event_tx: source_tx,
        }),
        Some(WebConfig {
            send: None,
            upload: true,
            i18n: WebI18n::default(),
            pages: WebPages {
                upload_html: config.upload_page,
                ..Default::default()
            },
        }),
        stop_rx,
    )
    .await
    .map_err(|e| e.to_string())?;
    let address = SocketAddr::new(config.bind_ip.into(), server.port());
    let receiver = Receiver {
        events,
        shutdown: shutdown_rx,
        extensions: config.allowed_extensions,
        pending: HashMap::new(),
        session_stops: HashMap::new(),
        writes: JoinSet::new(),
        used_bytes: 0,
        used_files: 0,
        activity: Instant::now(),
    };
    let task = tokio::spawn(receiver.run(source_rx, server, stop_tx));
    Ok(TransportHandle {
        address,
        shutdown,
        task: Some(task),
    })
}

fn validate_start_config(config: &StartConfig) -> Result<(), String> {
    if !(available_ipv4_addresses().contains(&config.bind_ip)
        || cfg!(test) && config.bind_ip.is_loopback())
    {
        return Err("请选择本机有效的局域网地址".into());
    }
    if config.session_secret.len() < 32
        || config.session_secret.len() > 128
        || !config
            .session_secret
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("快传配对令牌无效".into());
    }
    Ok(())
}

struct Receiver {
    events: mpsc::Sender<TransportEvent>,
    shutdown: watch::Receiver<bool>,
    extensions: Vec<String>,
    pending: HashMap<String, PendingFile>,
    session_stops: HashMap<String, watch::Sender<bool>>,
    writes: JoinSet<()>,
    used_bytes: u64,
    used_files: usize,
    activity: Instant,
}

impl Receiver {
    async fn run(
        mut self,
        mut source: mpsc::Receiver<ServerEventV2>,
        server: ServerHandle,
        stop: oneshot::Sender<()>,
    ) {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        while !*self.shutdown.borrow() {
            tokio::select! {
                biased;
                _ = self.shutdown.changed() => break,
                Some(_) = self.writes.join_next(), if !self.writes.is_empty() => {self.activity=Instant::now();},
                _ = tick.tick() => self.expire_pending(&server).await,
                event = source.recv() => {
                    let Some(event)=event else {break};
                    if !self.handle(event).await {break;}
                }
            }
        }
        for (_, cancel) in self.session_stops {
            let _ = cancel.send(true);
        }
        let _ = stop.send(());
        server.wait_stopped().await;
        while self.writes.join_next().await.is_some() {}
        for (_, file) in self.pending {
            report_failure(&self.events, file.id, "快传已关闭").await;
        }
        let _ = self.events.send(TransportEvent::Stopped).await;
    }

    async fn handle(&mut self, event: ServerEventV2) -> bool {
        match event {
            ServerEventV2::PrepareUpload {
                session_id,
                files,
                decision_tx,
                ..
            } => self.prepare(session_id, files, decision_tx).await,
            ServerEventV2::FileUpload {
                session_id,
                file_id,
                file,
                target_tx,
            } => self.start_file(&session_id, &file_id, file, target_tx),
            ServerEventV2::SessionEnd { session_id, reason } => {
                self.end_session(&session_id, reason).await
            }
            ServerEventV2::PrepareUploadAborted { session_id } => {
                self.end_session(&session_id, SessionEndReasonV2::Cancelled)
                    .await
            }
            ServerEventV2::ListenerFailed { .. } => return false,
            _ => {}
        }
        true
    }

    async fn prepare(
        &mut self,
        session_id: String,
        files: HashMap<String, FileDto>,
        reply: oneshot::Sender<PrepareUploadDecisionV2>,
    ) {
        self.activity = Instant::now();
        let prepared = prepare_files(
            &files,
            &self.extensions,
            &self.events,
            self.used_files,
            self.used_bytes,
            &mut self.shutdown,
        )
        .await;
        let Ok(prepared) = prepared else {
            let _ = reply.send(PrepareUploadDecisionV2::Decline);
            return;
        };
        let (stop, _) = watch::channel(false);
        self.session_stops.insert(session_id.clone(), stop);
        self.used_files += prepared.len();
        self.used_bytes += files.values().map(|f| f.size).sum::<u64>();
        for (file_id, file) in prepared {
            self.pending.insert(format!("{session_id}:{file_id}"), file);
        }
        let _ = reply.send(PrepareUploadDecisionV2::Accept(
            files.keys().cloned().collect(),
        ));
    }

    fn start_file(
        &mut self,
        session_id: &str,
        file_id: &str,
        file: FileDto,
        target: oneshot::Sender<FileUploadTarget>,
    ) {
        self.activity = Instant::now();
        let Some(prepared) = self.pending.remove(&format!("{session_id}:{file_id}")) else {
            return;
        };
        let Some(stop) = self.session_stops.get(session_id) else {
            return;
        };
        let (binary_tx, binary_rx) = mpsc::channel(4);
        let (result_tx, result_rx) = oneshot::channel();
        let _ = target.send(FileUploadTarget::Stream {
            binary_tx,
            result_rx,
        });
        self.writes.spawn(receive_file(
            prepared,
            file,
            binary_rx,
            result_tx,
            self.events.clone(),
            stop.subscribe(),
        ));
    }

    async fn end_session(&mut self, session_id: &str, reason: SessionEndReasonV2) {
        if reason == SessionEndReasonV2::Cancelled {
            if let Some(stop) = self.session_stops.get(session_id) {
                let _ = stop.send(true);
            }
        }
        let prefix = format!("{session_id}:");
        let keys = self
            .pending
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            if let Some(file) = self.pending.remove(&key) {
                report_failure(&self.events, file.id, "发送已中断，请重新选择文件").await;
            }
        }
    }

    async fn expire_pending(&mut self, server: &ServerHandle) {
        if !self.writes.is_empty() || self.activity.elapsed() < IDLE_TIMEOUT {
            return;
        }
        let Some(key) = self.pending.keys().next() else {
            return;
        };
        let Some((session_id, _)) = key.split_once(':') else {
            return;
        };
        let session_id = session_id.to_string();
        server.cancel_v2_session(&session_id).await;
        self.end_session(&session_id, SessionEndReasonV2::Cancelled)
            .await;
    }
}

async fn report_failure(events: &mpsc::Sender<TransportEvent>, id: String, message: &str) {
    let _ = events
        .send(TransportEvent::Failed {
            id,
            message: message.to_string(),
        })
        .await;
}

struct PendingFile {
    id: String,
    path: PathBuf,
}

fn validate_manifest(
    files: &HashMap<String, FileDto>,
    extensions: &[String],
    used_files: usize,
    used_bytes: u64,
) -> Result<(), String> {
    let total = files
        .values()
        .try_fold(used_bytes, |total, f| total.checked_add(f.size))
        .ok_or("传输总量超限")?;
    if files.is_empty()
        || files.len() > 100
        || used_files + files.len() > MAX_SESSION_FILES
        || total > MAX_SESSION_BYTES
    {
        return Err("传输数量或总量超限".into());
    }
    for (id, file) in files {
        validate_file_metadata(id, file, extensions)?;
    }
    Ok(())
}

fn validate_file_metadata(id: &str, file: &FileDto, extensions: &[String]) -> Result<(), String> {
    if id.len() > 128 || file.size == 0 || file.size > MAX_FILE_BYTES {
        return Err("文件标识或大小不支持".into());
    }
    validate_material_name(&file.file_name, extensions)
}

fn validate_material_name(name: &str, extensions: &[String]) -> Result<(), String> {
    if name.len() > 255
        || name.chars().any(|c| c.is_control() || "/\\:".contains(c))
        || name.starts_with('.')
        || name.ends_with([' ', '.'])
    {
        return Err("文件名不支持".into());
    }
    let ext = std::path::Path::new(name)
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !extensions.contains(&ext) {
        return Err("文件格式不支持".into());
    }
    Ok(())
}

async fn prepare_files(
    files: &HashMap<String, FileDto>,
    extensions: &[String],
    events: &mpsc::Sender<TransportEvent>,
    used_files: usize,
    used_bytes: u64,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<HashMap<String, PendingFile>, String> {
    validate_manifest(files, extensions, used_files, used_bytes)?;
    let mut prepared = HashMap::<String, PendingFile>::new();
    for (file_id, file) in files {
        let id = uuid::Uuid::new_v4().to_string();
        let (reply, receive) = oneshot::channel();
        let result = tokio::select! {
            biased;
            _ = shutdown.changed() => Err("快传已关闭".to_string()),
            result = async {
                events.send(TransportEvent::Prepare{id:id.clone(),file_name:file.file_name.clone(),size:file.size,reply}).await.map_err(|_| "快传接收已关闭".to_string())?;
                tokio::time::timeout(IDLE_TIMEOUT,receive).await.map_err(|_| "准备接收超时".to_string())?.map_err(|_| "接收已取消".to_string())?
            } => result,
        };
        match result {
            Ok(path) => {
                prepared.insert(file_id.clone(), PendingFile { id, path });
            }
            Err(message) => {
                let _ = events.send(TransportEvent::Failed { id, message }).await;
                for (_, previous) in prepared {
                    let _ = events
                        .send(TransportEvent::Failed {
                            id: previous.id,
                            message: "本批次未开始传输".into(),
                        })
                        .await;
                }
                return Err("无法准备接收文件".into());
            }
        }
    }
    Ok(prepared)
}

async fn receive_file(
    prepared: PendingFile,
    metadata: FileDto,
    mut chunks: mpsc::Receiver<bytes::Bytes>,
    result_tx: oneshot::Sender<Result<(), String>>,
    events: mpsc::Sender<TransportEvent>,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut result = write_chunks(&prepared, &metadata, &mut chunks, &events, &mut shutdown).await;
    // write_chunks has returned/dropped, so the file is closed before any lifecycle event.
    if result.is_ok() {
        let (reply, ack) = oneshot::channel();
        result = tokio::select! {
            biased;
            _ = shutdown.changed() => Err("快传已关闭".into()),
            result = async {
                events.send(TransportEvent::Received{id:prepared.id.clone(),reply}).await.map_err(|_| "接收已关闭".to_string())?;
                tokio::time::timeout(IDLE_TIMEOUT,ack).await.map_err(|_| "保存确认超时".to_string())?.map_err(|_| "保存确认已取消".to_string())?
            } => result,
        };
    }
    if let Err(message) = &result {
        let _ = events
            .send(TransportEvent::Failed {
                id: prepared.id,
                message: message.clone(),
            })
            .await;
    }
    let _ = result_tx.send(result);
}

async fn write_chunks(
    prepared: &PendingFile,
    metadata: &FileDto,
    chunks: &mut mpsc::Receiver<bytes::Bytes>,
    events: &mpsc::Sender<TransportEvent>,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    let file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&prepared.path)
        .await
        .map_err(|e| format!("无法创建接收文件：{e}"))?;
    let mut file = tokio::io::BufWriter::with_capacity(512 * 1024, file);
    let result = copy_chunks(&mut file, prepared, metadata, chunks, events, shutdown).await;
    let flushed = file.flush().await.map_err(|e| format!("保存文件失败：{e}"));
    let result = result.and(flushed);
    let result = if result.is_ok() {
        file.get_ref()
            .sync_all()
            .await
            .map_err(|e| format!("保存文件失败：{e}"))
    } else {
        result
    };
    // Wait for pending Tokio filesystem work and close the OS handle before notifying storage.
    drop(file.into_inner().into_std().await);
    result
}

async fn copy_chunks(
    file: &mut tokio::io::BufWriter<tokio::fs::File>,
    prepared: &PendingFile,
    metadata: &FileDto,
    chunks: &mut mpsc::Receiver<bytes::Bytes>,
    events: &mpsc::Sender<TransportEvent>,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    let mut received = 0u64;
    let mut digest = Sha256::new();
    let mut progress_at = Instant::now();
    loop {
        if *shutdown.borrow() {
            return Err("快传已关闭".into());
        }
        let chunk = tokio::select! {
            biased;
            _ = shutdown.changed() => return Err("快传已关闭".into()),
            chunk = tokio::time::timeout(IDLE_TIMEOUT,chunks.recv()) => chunk.map_err(|_| "传输中断，请保持手机页面打开后重试")?,
        };
        let Some(chunk) = chunk else { break };
        received = received
            .checked_add(chunk.len() as u64)
            .ok_or("接收大小超限")?;
        if received > metadata.size {
            return Err("接收大小超出声明长度".into());
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入文件失败：{e}"))?;
        digest.update(&chunk);
        if received == metadata.size {
            tokio::select! {
                _ = shutdown.changed() => return Err("快传已关闭".into()),
                _ = events.send(TransportEvent::Progress{id:prepared.id.clone(),received_bytes:received}) => {},
            }
        } else if progress_at.elapsed() >= Duration::from_millis(150) {
            let _ = events.try_send(TransportEvent::Progress {
                id: prepared.id.clone(),
                received_bytes: received,
            });
            progress_at = Instant::now();
        }
    }
    verify_received_file(received, metadata, digest)
}

fn verify_received_file(received: u64, metadata: &FileDto, digest: Sha256) -> Result<(), String> {
    if received != metadata.size {
        return Err("文件未传完，请重新发送".into());
    }
    if let Some(expected) = &metadata.sha256 {
        if !format!("{:x}", digest.finalize()).eq_ignore_ascii_case(expected) {
            return Err("文件校验不一致，请重新发送".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use localsend::reqwest;
    use serde_json::{json, Value};
    use std::{sync::Arc, time::Duration};
    use tokio::sync::Mutex;

    async fn fixture() -> (
        TransportHandle,
        Arc<Mutex<Vec<TransportEvent>>>,
        tempfile::TempDir,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let (tx, mut rx) = mpsc::channel(32);
        let observed = Arc::new(Mutex::new(Vec::new()));
        let saved = observed.clone();
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    TransportEvent::Prepare { id, reply, .. } => {
                        let _ = reply.send(Ok(root.join(id)));
                    }
                    TransportEvent::Received { id, reply } => {
                        let _ = reply.send(Ok(()));
                        let (unused, _) = oneshot::channel();
                        saved
                            .lock()
                            .await
                            .push(TransportEvent::Received { id, reply: unused });
                    }
                    event => saved.lock().await.push(event),
                }
            }
        });
        let handle = start(
            StartConfig {
                bind_ip: Ipv4Addr::LOCALHOST,
                port: 0,
                session_secret: "test-secret-0000000000000000000000".into(),
                upload_page: None,
                allowed_extensions: vec!["png".into()],
            },
            tx,
        )
        .await
        .unwrap();
        (handle, observed, dir)
    }

    fn manifest(size: u64, name: &str) -> Value {
        json!({ "info": { "alias":"Browser", "version":"2.1", "deviceType":"web", "fingerprint":"web-test", "port":0, "protocol":"http" },
          "files": { "f1": { "id":"f1", "fileName": name, "size":size, "fileType":"image/png" } } })
    }

    #[tokio::test]
    async fn accepts_authenticated_upload_and_reports_closed_complete_file() {
        let (handle, observed, dir) = fixture().await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let base = format!("http://{}", handle.address());
        assert_eq!(client.get(&base).send().await.unwrap().status(), 200);
        let response = client
            .post(format!(
                "{base}/api/localsend/v2/prepare-upload?pin=test-secret-0000000000000000000000"
            ))
            .json(&manifest(4, "photo.png"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let ticket: Value = response.json().await.unwrap();
        let response = client
            .post(format!(
                "{base}/api/localsend/v2/upload?sessionId={}&fileId=f1&token={}",
                ticket["sessionId"].as_str().unwrap(),
                ticket["files"]["f1"].as_str().unwrap()
            ))
            .body("test")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        tokio::time::sleep(Duration::from_millis(30)).await;
        let id = observed
            .lock()
            .await
            .iter()
            .find_map(|e| {
                if let TransportEvent::Received { id, .. } = e {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .unwrap();
        assert_eq!(std::fs::read(dir.path().join(id)).unwrap(), b"test");
        let address = handle.address();
        handle.stop().await;
        assert!(tokio::net::TcpStream::connect(address).await.is_err());
    }

    #[tokio::test]
    async fn rejects_missing_pairing_secret_and_non_material_files() {
        let (handle, _, _) = fixture().await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let url = format!(
            "http://{}/api/localsend/v2/prepare-upload",
            handle.address()
        );
        assert_eq!(
            client
                .post(&url)
                .json(&manifest(4, "photo.png"))
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        assert_eq!(
            client
                .post(format!("{url}?pin=test-secret-0000000000000000000000"))
                .json(&manifest(4, "run.exe"))
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        handle.stop().await;
    }

    #[tokio::test]
    async fn rejects_unsafe_manifest_and_oversized_metadata() {
        let (handle, observed, _dir) = fixture().await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let url = format!(
            "http://{}/api/localsend/v2/prepare-upload?pin=test-secret-0000000000000000000000",
            handle.address()
        );
        for (size, name) in [
            (4, "../escape.png"),
            (4, "x\\escape.png"),
            (MAX_FILE_BYTES + 1, "big.png"),
            (0, "empty.png"),
        ] {
            assert_eq!(
                client
                    .post(&url)
                    .json(&manifest(size, name))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                403
            );
        }
        assert_eq!(
            client
                .post(&url)
                .body(" ".repeat(256 * 1024 + 1))
                .send()
                .await
                .unwrap()
                .status(),
            400
        );
        assert!(observed.lock().await.is_empty());
        handle.stop().await;
    }

    #[tokio::test]
    async fn mismatched_size_and_checksum_never_report_received() {
        let (handle, observed, _dir) = fixture().await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let base = format!("http://{}", handle.address());
        for (size, hash) in [(3, None), (5, None), (4, Some("0".repeat(64)))] {
            let mut data = manifest(size, "photo.png");
            if let Some(hash) = hash {
                data["files"]["f1"]["sha256"] = json!(hash);
            }
            let ticket: Value = client
                .post(format!(
                    "{base}/api/localsend/v2/prepare-upload?pin=test-secret-0000000000000000000000"
                ))
                .json(&data)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let url = format!(
                "{base}/api/localsend/v2/upload?sessionId={}&fileId=f1&token={}",
                ticket["sessionId"].as_str().unwrap(),
                ticket["files"]["f1"].as_str().unwrap()
            );
            assert_eq!(
                client
                    .post(&url)
                    .body("test")
                    .send()
                    .await
                    .unwrap()
                    .status(),
                500
            );
            assert_eq!(
                client
                    .post(&url)
                    .body("test")
                    .send()
                    .await
                    .unwrap()
                    .status(),
                403
            );
        }
        handle.stop().await;
        assert!(!observed
            .lock()
            .await
            .iter()
            .any(|e| matches!(e, TransportEvent::Received { .. })));
        assert_eq!(
            observed
                .lock()
                .await
                .iter()
                .filter(|e| matches!(e, TransportEvent::Failed { .. }))
                .count(),
            3
        );
    }

    #[tokio::test]
    async fn close_cancels_pending_preparation_with_a_failure_event() {
        let (tx, mut rx) = mpsc::channel(32);
        let handle = start(
            StartConfig {
                bind_ip: Ipv4Addr::LOCALHOST,
                port: 0,
                session_secret: "test-secret-0000000000000000000000".into(),
                upload_page: None,
                allowed_extensions: vec!["png".into()],
            },
            tx,
        )
        .await
        .unwrap();
        let url = format!(
            "http://{}/api/localsend/v2/prepare-upload?pin=test-secret-0000000000000000000000",
            handle.address()
        );
        let request = tokio::spawn(async move {
            reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .post(url)
                .json(&manifest(4, "photo.png"))
                .send()
                .await
        });
        let TransportEvent::Prepare { id, reply, .. } = rx.recv().await.unwrap() else {
            panic!("expected prepare")
        };
        tokio::time::timeout(Duration::from_secs(3), handle.stop())
            .await
            .unwrap();
        assert!(matches!(rx.recv().await,Some(TransportEvent::Failed{id:failed,..}) if failed==id));
        drop(reply);
        let _ = request.await;
    }

    #[tokio::test]
    async fn close_aborts_inflight_upload_before_returning() {
        let (handle, observed, dir) = fixture().await;
        let address = handle.address();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let ticket: Value = client.post(format!("http://{address}/api/localsend/v2/prepare-upload?pin=test-secret-0000000000000000000000"))
            .json(&manifest(1_000_000,"photo.png")).send().await.unwrap().json().await.unwrap();
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        let headers = format!("POST /api/localsend/v2/upload?sessionId={}&fileId=f1&token={} HTTP/1.1\r\nHost: {address}\r\nContent-Length: 1000000\r\n\r\ntest",ticket["sessionId"].as_str().unwrap(),ticket["files"]["f1"].as_str().unwrap());
        stream.write_all(headers.as_bytes()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if std::fs::read_dir(dir.path()).unwrap().next().is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(3), handle.stop())
            .await
            .unwrap();
        assert!(!observed
            .lock()
            .await
            .iter()
            .any(|e| matches!(e, TransportEvent::Received { .. })));
        let id = observed
            .lock()
            .await
            .iter()
            .find_map(|e| {
                if let TransportEvent::Failed { id, .. } = e {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .unwrap();
        std::fs::remove_file(dir.path().join(id)).unwrap();
        assert!(tokio::net::TcpStream::connect(address).await.is_err());
    }

    #[tokio::test]
    async fn http_success_waits_for_durable_receipt_and_rejects_failed_receipt() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, mut rx) = mpsc::channel(32);
        let handle = start(
            StartConfig {
                bind_ip: Ipv4Addr::LOCALHOST,
                port: 0,
                session_secret: "test-secret-0000000000000000000000".into(),
                upload_page: None,
                allowed_extensions: vec!["png".into()],
            },
            tx,
        )
        .await
        .unwrap();
        let base = format!("http://{}", handle.address());
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let prepare = client
            .post(format!(
                "{base}/api/localsend/v2/prepare-upload?pin=test-secret-0000000000000000000000"
            ))
            .json(&manifest(4, "photo.png"));
        let preparation =
            tokio::spawn(
                async move { prepare.send().await.unwrap().json::<Value>().await.unwrap() },
            );
        let TransportEvent::Prepare { id, reply, .. } = rx.recv().await.unwrap() else {
            panic!("expected prepare")
        };
        reply.send(Ok(dir.path().join(id))).unwrap();
        let ticket = preparation.await.unwrap();
        let request = client
            .post(format!(
                "{base}/api/localsend/v2/upload?sessionId={}&fileId=f1&token={}",
                ticket["sessionId"].as_str().unwrap(),
                ticket["files"]["f1"].as_str().unwrap()
            ))
            .body("test");
        let upload = tokio::spawn(async move { request.send().await.unwrap() });
        let receipt = loop {
            if let TransportEvent::Received { reply, .. } = rx.recv().await.unwrap() {
                break reply;
            }
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !upload.is_finished(),
            "HTTP success must not precede the durable receipt"
        );
        receipt.send(Err("disk full".into())).unwrap();
        assert_eq!(upload.await.unwrap().status(), 500);
        handle.stop().await;
    }

    #[tokio::test]
    async fn rejects_cross_origin_and_routes_outside_receive_scope() {
        let (handle, _, _) = fixture().await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let base = format!("http://{}", handle.address());
        assert_eq!(
            client
                .get(&base)
                .header("Host", "foreign.example")
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        for origin in ["http://foreign.example", "null"] {
            assert_eq!(
                client
                    .post(format!("{base}/api/localsend/v2/cancel"))
                    .header("Origin", origin)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                403
            );
        }
        for route in [
            "/api/localsend/v1/info",
            "/api/localsend/v2/info",
            "/api/localsend/v3/nonce",
        ] {
            assert_eq!(
                client
                    .get(format!("{base}{route}"))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                404
            );
        }
        assert_eq!(
            client
                .post(format!("{base}/api/localsend/v2/register"))
                .body("{}")
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        assert_eq!(
            client
                .post(format!("{base}/api/localsend/v2/cancel"))
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        handle.stop().await;
    }

    #[tokio::test]
    async fn authenticated_cancel_stops_inflight_file_and_allows_new_batch() {
        let (handle, observed, dir) = fixture().await;
        let address = handle.address();
        let base = format!("http://{address}");
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let ticket: Value = client
            .post(format!(
                "{base}/api/localsend/v2/prepare-upload?pin=test-secret-0000000000000000000000"
            ))
            .json(&manifest(1000, "photo.png"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let sid = ticket["sessionId"].as_str().unwrap();
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        stream.write_all(format!("POST /api/localsend/v2/upload?sessionId={sid}&fileId=f1&token={} HTTP/1.1\r\nHost: {address}\r\nContent-Length: 1000\r\n\r\ntest",ticket["files"]["f1"].as_str().unwrap()).as_bytes()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if std::fs::read_dir(dir.path()).unwrap().next().is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(!observed
            .lock()
            .await
            .iter()
            .any(|e| matches!(e, TransportEvent::Failed { .. })));
        let response=client.post(format!("{base}/api/localsend/v2/cancel?sessionId={sid}&pin=test-secret-0000000000000000000000")).send().await.unwrap();
        assert_eq!(response.status(), 200);
        let stopped = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if observed
                    .lock()
                    .await
                    .iter()
                    .any(|e| matches!(e, TransportEvent::Failed { .. }))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        handle.stop().await;
        assert!(
            stopped.is_ok(),
            "cancel must stop writing without waiting for idle timeout"
        );
        assert!(!observed
            .lock()
            .await
            .iter()
            .any(|e| matches!(e, TransportEvent::Received { .. })));
    }
}
