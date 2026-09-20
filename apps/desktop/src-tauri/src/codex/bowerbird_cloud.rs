use std::path::PathBuf;
use std::time::Instant;

use async_trait::async_trait;
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use ulid::Ulid;

use crate::cloud::{AuthClient, CloudClient};
use crate::codex::cloud_image::read_cloud_jpeg;
use crate::codex::types::{Capabilities, Chunk, CodexRequest, CodexResult, GenOutcome, VideoOptions};
use crate::codex::GenProvider;
use crate::error::AppError;

/// Cloud 生图 provider：档位由云端数据驱动（entitlement.generation_services），
/// key/service 都是运行时字符串——云端上新档位无需桌面发版。
///
/// key 约定：`bowerbird-cloud-<service>`（如 `bowerbird-cloud-image_hd`）；少量遗留 key
/// （裸 `bowerbird-cloud` / `-fast` / `-lite` / `-standard`）由 [`cloud_service_for_key`] 映射。
#[derive(Clone)]
pub struct BowerbirdCloudProvider {
    cloud: CloudClient,
    auth: AuthClient,
    key: String,
    service: String,
}

impl BowerbirdCloudProvider {
    pub fn new(cloud: CloudClient, auth: AuthClient, key: String, service: String) -> Self {
        Self {
            cloud,
            auth,
            key,
            service,
        }
    }

    /// 单张云生成：提交 →（异步任务）轮询下载 /（同步响应）直接取产物。
    /// 返回（图片文件, 下载临时目录, 会话 id 提示——异步路径为远端任务 id）。
    async fn generate_image_once(
        &self,
        endpoint: &str,
        idempotency_key: &str,
        instruction: &str,
        references: &[serde_json::Value],
        ratio: Option<&str>,
        tx: &mpsc::Sender<Chunk>,
    ) -> Result<(Vec<PathBuf>, PathBuf, Option<String>), AppError> {
        let response = self
            .auth
            .send_authorized(
                self.cloud.http().post(endpoint).json(&serde_json::json!({
                    "idempotency_key": idempotency_key,
                    "media": "image",
                    "prompt": instruction,
                    "reference_images": references,
                    "ratio": ratio,
                    "service": self.service,
                })),
                "云生成请求失败",
            )
            .await?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| AppError::Cloud(format!("读取云生成响应失败: {error}")))?;
        if !status.is_success() {
            let message = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|value| {
                    value
                        .pointer("/error/message")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| format!("云生成失败（HTTP {}）", status.as_u16()));
            return Err(AppError::Cloud(message));
        }
        let result: GenerateResponse = serde_json::from_str(&body)
            .map_err(|error| AppError::Cloud(format!("解析云生成响应失败: {error}")))?;
        if matches!(
            result.status.as_str(),
            "uploading" | "queued" | "leased" | "running" | "cancel_requested"
        ) {
            let remote = result
                .remote_task_id
                .ok_or_else(|| AppError::Cloud("异步云任务缺少 remote_task_id".into()))?;
            let _ = tx
                .send(Chunk::Submit {
                    submit_id: remote.clone(),
                })
                .await;
            let (paths, temp_dir) =
                wait_for_cloud_job(&self.cloud, &self.auth, endpoint, &remote).await?;
            return Ok((paths, temp_dir, Some(remote)));
        }
        if result.status == "succeeded" {
            if let Some(artifact) = result.artifact {
                let remote = result.remote_task_id.unwrap_or_else(|| idempotency_key.to_string());
                let (paths, temp_dir) = download_artifact(&self.cloud, &remote, artifact).await?;
                acknowledge_artifact(&self.auth, &self.cloud, endpoint, &remote).await;
                return Ok((paths, temp_dir, Some(remote)));
            }
        } else if let Some(error) = result.error {
            return Err(AppError::Cloud(error.message));
        }
        let inline_images = result.images;

        let temp_dir = std::env::temp_dir().join(format!("bowerbird-cloud-{}", Ulid::new()));
        tokio::fs::create_dir_all(&temp_dir).await?;
        let mut paths = Vec::with_capacity(inline_images.len());
        for (index, image) in inline_images.into_iter().enumerate() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(image.base64)
                .map_err(|error| AppError::Cloud(format!("云图片 base64 无效: {error}")))?;
            let extension = match image.mime.as_str() {
                "image/jpeg" => "jpg",
                "image/webp" => "webp",
                _ => "png",
            };
            let path = temp_dir.join(format!("result-{}.{}", index + 1, extension));
            tokio::fs::write(&path, bytes).await?;
            paths.push(path);
        }
        if paths.is_empty() {
            return Err(AppError::Cloud("云生成未返回图片".into()));
        }
        Ok((paths, temp_dir, None))
    }
}

/// cloud provider key → generate-proxy 的计费/路由 service。
/// 新式 key 后缀即 service（`bowerbird-cloud-image_hd` → `image_hd`）；遗留 key 显式映射；
/// 非法值兜底 `image_hd`（Edge 侧仍会按 service_costs 二次校验）。
pub fn cloud_service_for_key(key: &str) -> String {
    let suffix = key
        .strip_prefix("bowerbird-cloud")
        .unwrap_or("")
        .trim_start_matches('-');
    match suffix {
        "" => "image_hd",
        "fast" => "image_fast",
        "lite" | "standard" => "image_lite",
        service => service,
    }
    .to_string()
}

#[derive(Deserialize)]
pub(crate) struct GenerateResponse {
    pub(crate) status: String,
    #[serde(default)]
    images: Vec<CloudImage>,
    pub(crate) remote_task_id: Option<String>,
    artifact: Option<CloudArtifact>,
    pub(crate) error: Option<CloudJobError>,
    #[serde(default)]
    reference_uploads: Vec<ReferenceUpload>,
}

#[derive(Deserialize)]
struct ReferenceUpload { index: usize, upload_url: String }

/// Persisted local job + turn identify exactly one Cloud video request, including recovery.
pub(crate) fn video_idempotency_key(job: &str, turn: &str) -> String {
    format!("video-{job}-{turn}")
}

pub(crate) fn video_preflight(req: &CodexRequest, options: &VideoOptions) -> Result<(), AppError> {
    if !matches!(options.video_resolution.as_str(), "480p" | "720p" | "1080p") {
        return Err(AppError::Cloud("方舟视频仅支持 480p / 720p / 1080p".into()));
    }
    // Both channels share the four reference modes. CLI's resolution guard is narrower.
    let mut common = options.clone();
    common.video_resolution = "720p".into();
    crate::codex::jimeng_video::preflight(req, &common)?;
    if req.instruction.trim().is_empty() { return Err(AppError::Cloud("请填写视频提示词".into())); }
    for path in &req.reference_images {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if crate::media::probe::is_video(&ext) && !matches!(ext.as_str(), "mp4" | "mov") {
            return Err(AppError::Cloud("方舟视频参考仅支持 MP4 / MOV".into()));
        }
        if matches!(ext.as_str(), "mp4" | "mov") && std::fs::metadata(path)?.len() > 200 * 1024 * 1024 {
            return Err(AppError::Cloud("每条参考视频不能超过 200 MiB".into()));
        }
        if !crate::media::probe::is_video(&ext) {
            let meta = crate::media::probe::probe(path)?;
            let ratio = meta.width as f64 / meta.height as f64;
            if meta.width < 300 || meta.height < 300 || !(0.4..=2.5).contains(&ratio) {
                return Err(AppError::Cloud("方舟视频参考图宽高至少 300 像素，宽高比须在 0.4–2.5 之间".into()));
            }
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct CloudImage {
    mime: String,
    base64: String,
}

#[derive(Deserialize)]
struct CloudArtifact {
    url: String,
    mime: String,
    bytes: u64,
    sha256: String,
}

#[derive(Deserialize)]
pub(crate) struct CloudJobError {
    pub(crate) message: String,
}

#[async_trait]
impl GenProvider for BowerbirdCloudProvider {
    fn name(&self) -> &str {
        &self.key
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            chat: false,
            caption: true,
            generate: true,
        }
    }

    async fn run(&self, _req: CodexRequest) -> Result<CodexResult, AppError> {
        Err(AppError::Cloud(
            "理解能力请使用 CloudUnderstandProvider".into(),
        ))
    }

    async fn generate_video(&self, req: CodexRequest, options: VideoOptions, tx: &mpsc::Sender<Chunk>, _resume_session: Option<String>) -> Result<GenOutcome, AppError> {
        video_preflight(&req, &options)?;
        if self.service != format!("video_seedance25_{}", options.video_resolution) {
            return Err(AppError::Cloud("视频服务与分辨率不匹配".into()));
        }
        let started = Instant::now();
        let endpoint = self.cloud.config().endpoint("generate-proxy").ok_or_else(|| AppError::Cloud("当前构建未配置 Bowerbird Cloud".into()))?;
        let key = req.job_id.as_deref().ok_or_else(|| AppError::Cloud("缺少视频轮次幂等键".into()))?;
        let mut images = Vec::new();
        let mut videos = Vec::new();
        let mut video_paths = Vec::new();
        for path in &req.reference_images {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            if crate::media::probe::is_video(&ext) {
                videos.push(serde_json::json!({ "object_key": "", "bytes": std::fs::metadata(path)?.len(), "mime": if ext == "mov" { "video/quicktime" } else { "video/mp4" } }));
                video_paths.push(path);
            } else { images.push(read_cloud_jpeg(path, true).await?); }
        }
        let payload = serde_json::json!({ "idempotency_key": key, "media": "video", "prompt": req.instruction, "reference_images": images, "reference_videos": videos, "video_options": options, "ratio": req.ratio, "service": self.service });
        let result = send_video_request(&self.cloud, &self.auth, &endpoint, &payload).await?;
        let remote = result.remote_task_id.ok_or_else(|| AppError::Cloud("云视频任务缺少任务 ID；不会自动重新生成".into()))?;
        let _ = tx.send(Chunk::Submit { submit_id: remote.clone() }).await;
        if !result.reference_uploads.is_empty() {
            for upload in result.reference_uploads {
                let path = video_paths.get(upload.index).ok_or_else(|| AppError::Cloud("参考视频上传序号无效".into()))?;
                if !upload.upload_url.starts_with("https://") { return Err(AppError::Cloud("参考视频上传地址无效".into())); }
                let bytes = tokio::fs::read(path).await?;
                if bytes.len() as u64 != videos[upload.index]["bytes"].as_u64().unwrap_or(0) { return Err(AppError::Cloud("参考视频在上传前已变化，请重新选择".into())); }
                let response = self.cloud.http().put(&upload.upload_url).header("content-type", videos[upload.index]["mime"].as_str().unwrap_or("video/mp4")).body(bytes).send().await.map_err(|_| AppError::Cloud("参考视频上传失败；原任务保留待恢复".into()))?;
                if !response.status().is_success() { return Err(AppError::Cloud("参考视频上传失败；原任务保留待恢复".into())); }
            }
            // Same key and exact manifest finalize uploads; this is never another provider POST.
            let finalized = send_video_request(&self.cloud, &self.auth, &endpoint, &payload).await?;
            if !finalized.reference_uploads.is_empty() { return Err(AppError::Cloud("参考视频尚未上传完整".into())); }
        }
        let (paths, temp_dir) = wait_for_cloud_job(&self.cloud, &self.auth, &endpoint, &remote).await?;
        Ok(GenOutcome { text: String::new(), session_id: Some(remote.clone()), submit_id: Some(remote), elapsed_ms: started.elapsed().as_millis() as u64, source_images: paths, temp_dir: Some(temp_dir) })
    }

    async fn generate_image(
        &self,
        req: CodexRequest,
        tx: &mpsc::Sender<Chunk>,
        resume_session: Option<String>,
    ) -> Result<GenOutcome, AppError> {
        let started = Instant::now();
        let endpoint = self
            .cloud
            .config()
            .endpoint("generate-proxy")
            .ok_or_else(|| AppError::Cloud("当前构建未配置 Bowerbird Cloud".into()))?;
        let job_id = req
            .job_id
            .clone()
            .ok_or_else(|| AppError::Cloud("云生成缺少 job id".into()))?;
        let count = req.generate_num.unwrap_or(1).clamp(1, 4) as usize;
        let mut references = Vec::with_capacity(req.reference_images.len());
        for path in &req.reference_images {
            references.push(read_cloud_jpeg(path, true).await?);
        }
        // 幂等键按轮次区分：首轮（无 resume）= job_id 原样，同键同内容可幂等重放；续轮
        // （resume）对云端是一次全新生成（prompt/参考图都不同），沿用 job_id 会撞
        // manifest hash 校验（409 幂等键已用于不同的生成内容），故每次续轮提交带 ULID
        // 后缀——与即梦每次续轮全新 submit 的语义一致。
        let base_key = match resume_session.as_deref() {
            Some(_) => format!("{job_id}-{}", Ulid::new()),
            None => job_id.clone(),
        };
        // 多张（count>1）：云端单任务即单张，逐张以独立后缀 `-nN` 提交、按张预授权积分；
        // 顺序等待前一张落地再发下一张——任一时刻至多一个在途任务，每次提交即回填 Submit
        // 的 submit_id，中断恢复仍只面对一个远端任务。任一张失败整轮失败。
        let mut source_images: Vec<PathBuf> = Vec::with_capacity(count);
        let mut temp_dir: Option<PathBuf> = None;
        let mut session: Option<String> = None;
        for index in 0..count {
            let idempotency_key = if index == 0 {
                base_key.clone()
            } else {
                format!("{base_key}-n{}", index + 1)
            };
            let (paths, one_dir, remote) = self
                .generate_image_once(
                    &endpoint,
                    &idempotency_key,
                    &req.instruction,
                    &references,
                    req.ratio.as_deref(),
                    tx,
                )
                .await?;
            session = remote.or(session);
            if count == 1 {
                source_images = paths;
                temp_dir = Some(one_dir);
                continue;
            }
            // 多张：把各次下载汇入同一临时目录，入库后由 command 层统一清理。
            if temp_dir.is_none() {
                let dir = std::env::temp_dir().join(format!("bowerbird-cloud-{}", Ulid::new()));
                tokio::fs::create_dir_all(&dir).await?;
                temp_dir = Some(dir);
            }
            let dir = temp_dir
                .as_ref()
                .ok_or_else(|| AppError::Cloud("云图片临时目录缺失".into()))?;
            for path in paths {
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .ok_or_else(|| AppError::Cloud("云图片路径无效".into()))?;
                let target = dir.join(format!("{}-{name}", index + 1));
                tokio::fs::rename(&path, &target)
                    .await
                    .map_err(|error| AppError::Cloud(format!("汇拢云图片失败: {error}")))?;
                source_images.push(target);
            }
            let _ = tokio::fs::remove_dir(&one_dir).await;
        }
        let session = session.unwrap_or_else(|| job_id.clone());
        Ok(GenOutcome {
            text: String::new(),
            session_id: Some(session.clone()),
            submit_id: Some(session),
            elapsed_ms: started.elapsed().as_millis() as u64,
            source_images,
            temp_dir,
        })
    }
}

async fn send_video_request(cloud: &CloudClient, auth: &AuthClient, endpoint: &str, payload: &serde_json::Value) -> Result<GenerateResponse, AppError> {
    let response = auth.send_authorized(cloud.http().post(endpoint).json(payload), "云视频请求失败；不会自动重新生成").await?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.map_err(|_| AppError::Cloud("云视频响应无法解析；请通过原任务恢复".into()))?;
    if !status.is_success() { return Err(AppError::Cloud(body.pointer("/error/message").and_then(|v| v.as_str()).unwrap_or("云视频请求失败").into())); }
    serde_json::from_value(body).map_err(|_| AppError::Cloud("云视频响应格式无效".into()))
}

async fn poll_remote(
    cloud: &CloudClient,
    auth: &AuthClient,
    endpoint: &str,
    remote_task_id: &str,
) -> Result<GenerateResponse, AppError> {
    let response = auth
        .send_authorized(
            cloud
                .http()
                .post(endpoint)
                .json(&serde_json::json!({ "action": "get", "job_id": remote_task_id })),
            "轮询云任务失败",
        )
        .await?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| AppError::Cloud(format!("读取云任务响应失败: {error}")))?;
    if !status.is_success() {
        let message = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .pointer("/error/message")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| format!("云任务轮询失败（HTTP {}）", status.as_u16()));
        return Err(AppError::Cloud(message));
    }
    serde_json::from_str(&body)
        .map_err(|error| AppError::Cloud(format!("解析云任务响应失败: {error}")))
}

pub(crate) async fn wait_for_cloud_job(
    cloud: &CloudClient,
    auth: &AuthClient,
    endpoint: &str,
    remote_task_id: &str,
) -> Result<(Vec<PathBuf>, PathBuf), AppError> {
    let mut transient_failures = 0_u32;
    loop {
        match poll_remote(cloud, auth, endpoint, remote_task_id).await {
            Ok(result) => {
                transient_failures = 0;
                match result.status.as_str() {
                    "uploading" => {
                        // Atomic server cleanup only closes an upload that never entered the queue.
                        // If another request finalized it meanwhile, continue retrieving that job.
                        let result = send_video_request(cloud, auth, endpoint, &serde_json::json!({
                            "action": "abandon_video_upload", "job_id": remote_task_id,
                        })).await?;
                        if result.status == "failed" {
                            return Err(AppError::Cloud("视频参考上传中断，原任务已结束并释放预留积分；请重新发起生成".into()));
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    }
                    "queued" | "leased" | "running" | "cancel_requested" => {
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    }
                    "succeeded" | "settlement_pending" => {
                        let artifact = result
                            .artifact
                            .ok_or_else(|| AppError::Cloud("云任务成功但缺少下载产物".into()))?;
                        let video = artifact.mime == "video/mp4";
                        let downloaded = download_artifact(cloud, remote_task_id, artifact).await?;
                        if !video { acknowledge_artifact(auth, cloud, endpoint, remote_task_id).await; }
                        return Ok(downloaded);
                    }
                    "failed" | "cancelled" | "outcome_unknown" | "artifact_expired" => {
                        let message =
                            result
                                .error
                                .map(|error| error.message)
                                .unwrap_or_else(|| match result.status.as_str() {
                                    "outcome_unknown" => {
                                        "请求已提交方舟，但结果状态暂时无法确认".into()
                                    }
                                    "cancelled" => "云任务已取消".into(),
                                    _ => "云生成失败".into(),
                                });
                        return Err(AppError::Cloud(message));
                    }
                    status => return Err(AppError::Cloud(format!("云任务异常状态: {status}"))),
                }
            }
            Err(error) => {
                let message = error.to_string();
                if message.contains("登录") || message.contains("请先登录") {
                    return Err(error);
                }
                transient_failures = transient_failures.saturating_add(1);
                tracing::warn!(
                    "云任务轮询暂时失败：job={} retry={}",
                    remote_task_id,
                    transient_failures
                );
                let delay = 5_u64.saturating_mul(2_u64.pow(transient_failures.min(3)));
                tokio::time::sleep(std::time::Duration::from_secs(delay.min(40))).await;
            }
        }
    }
}

async fn download_artifact(
    cloud: &CloudClient,
    remote_task_id: &str,
    artifact: CloudArtifact,
) -> Result<(Vec<PathBuf>, PathBuf), AppError> {
    if !artifact.url.starts_with("https://") {
        return Err(AppError::Cloud("云图片下载地址不安全".into()));
    }
    let limit = if artifact.mime == "video/mp4" { 500 * 1024 * 1024 } else { 20 * 1024 * 1024 };
    if artifact.bytes == 0 || artifact.bytes > limit {
        return Err(AppError::Cloud("云图片大小无效".into()));
    }
    if artifact.sha256.len() != 64 || !artifact.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(AppError::Cloud("云图片校验信息无效".into()));
    }
    let mut response = cloud
        .http()
        .get(&artifact.url)
        .send()
        .await
        .map_err(|error| AppError::Cloud(format!("下载云图片失败: {error}")))?;
    if !response.status().is_success() {
        return Err(AppError::Cloud(format!(
            "下载云图片失败（HTTP {}）",
            response.status().as_u16()
        )));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| AppError::Cloud("读取云产物失败".into()))? {
        if bytes.len() as u64 + chunk.len() as u64 > artifact.bytes { return Err(AppError::Cloud("云产物超出声明大小".into())); }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.len() as u64 != artifact.bytes {
        return Err(AppError::Cloud("云图片大小校验失败".into()));
    }
    let actual_hash = format!("{:x}", Sha256::digest(&bytes));
    if !actual_hash.eq_ignore_ascii_case(&artifact.sha256) {
        return Err(AppError::Cloud("云图片完整性校验失败".into()));
    }
    let extension = match artifact.mime.as_str() {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/png" => "png",
        "video/mp4" => "mp4",
        _ => return Err(AppError::Cloud("云图片格式无效".into())),
    };
    let temp_dir = std::env::temp_dir().join(format!("bowerbird-cloud-{}", Ulid::new()));
    tokio::fs::create_dir_all(&temp_dir).await?;
    let path = temp_dir.join(format!("result-{remote_task_id}.{extension}"));
    tokio::fs::write(&path, bytes).await?;
    Ok((vec![path], temp_dir))
}

pub(crate) async fn acknowledge_artifact(
    auth: &AuthClient,
    cloud: &CloudClient,
    endpoint: &str,
    remote_task_id: &str,
) {
    let _ = auth
        .send_authorized(
            cloud.http().post(endpoint).json(&serde_json::json!({
                "action": "artifact_received",
                "job_id": remote_task_id,
            })),
            "确认云图片接收失败",
        )
        .await;
}

pub(crate) async fn recover_cloud_generation(
    cloud: &CloudClient,
    auth: &AuthClient,
    remote_task_id: &str,
) -> Result<(Vec<PathBuf>, PathBuf), AppError> {
    let endpoint = cloud
        .config()
        .endpoint("generate-proxy")
        .ok_or_else(|| AppError::Cloud("当前构建未配置 Bowerbird Cloud".into()))?;
    wait_for_cloud_job(cloud, auth, &endpoint, remote_task_id).await
}

pub(crate) async fn find_video_job(cloud: &CloudClient, auth: &AuthClient, job: &str, turn: &str) -> Result<Option<String>, AppError> {
    let endpoint = cloud.config().endpoint("generate-proxy").ok_or_else(|| AppError::Cloud("Cloud 未配置".into()))?;
    let response = auth.send_authorized(cloud.http().post(endpoint).json(&serde_json::json!({
        "action": "get_by_key", "idempotency_key": video_idempotency_key(job, turn),
    })), "查询原视频任务失败").await?;
    if response.status().as_u16() == 404 { return Ok(None); }
    if !response.status().is_success() { return Err(AppError::Cloud("原视频任务状态尚无法确认，不会重新生成".into())); }
    let result: GenerateResponse = response.json().await.map_err(|_| AppError::Cloud("原视频任务响应无效".into()))?;
    Ok(result.remote_task_id)
}
