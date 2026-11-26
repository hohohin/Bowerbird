//! Opt-in, isolated Windows portable setup. Detection never installs or starts a process.
use std::{path::{Path, PathBuf}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use crate::{cloud::{AuthClient, EntitlementService}, error::{AppError, AppResult}};
use super::comfy_video;
use super::comfy_video::Mode as VideoMode;
use crate::codex::h3_image;
use super::comfy_discovery::{self, Installation};
use super::install_download::{transfer, wait_cancel, TransferProgress};
use super::local_install::{command, free_bytes, hash, log_tail, metadata_stamp, remember_verified,
    spawn_managed, verification_stamp, verified, watch_install_account, ManagedChild};
use super::comfy_driver as driver;

const MANAGED_ENDPOINT: &str = "http://127.0.0.1:18188";
const VERSION: &str = "h3-v1-comfy-0.42.1";
const FALLBACK_PORTS: std::ops::RangeInclusive<u16> = 18192..=18199;
#[derive(Clone, Copy, Debug, serde::Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Mode { #[default] Frames, Reference, Text, R2v, Image, Edit }
impl Mode {
    fn video(self) -> Option<VideoMode> {
        match self { Self::Frames => Some(VideoMode::Frames), Self::Reference => Some(VideoMode::Reference), Self::Text => Some(VideoMode::Text), Self::R2v => Some(VideoMode::R2v), _ => None }
    }
    fn image(self) -> bool { self.video().is_none() }
    fn names(self) -> &'static [&'static str] {
        match self.video() { Some(video) => comfy_video::model_names_for_mode(video), None => h3_image::models(self == Self::Edit) }
    }
    fn existing_service(self) -> (&'static str, &'static str) {
        if self.image() { ("18191", "http://127.0.0.1:18191") } else { ("18189", "http://127.0.0.1:18189") }
    }
    fn version(self) -> &'static str { if self.image() { "h3-image-comfy-0.45.0" } else { VERSION } }
    fn endpoint(self) -> &'static str { if self.image() { "http://127.0.0.1:18190" } else { MANAGED_ENDPOINT } }
    fn default_port(self, existing: bool) -> u16 {
        match (self.image(), existing) {
            (false, false) => 18188,
            (false, true) => 18189,
            (true, false) => 18190,
            (true, true) => 18191,
        }
    }
    async fn check(self, http: &reqwest::Client, base: &str) -> AppResult<()> {
        match self.video() { Some(video) => comfy_video::check_for_mode(http, base, video).await, None => h3_image::check(http, base, self == Self::Edit).await }
    }
}
const RESERVE: u64 = 12 * 1024 * 1024 * 1024;
struct Download { file: &'static str, size: u64, sha: &'static str }
fn label(item: &Download) -> &'static str {
    if item.file == "portable.7z" { "ComfyUI 与 Python" }
    else if item.file.contains("image_pruned") { "图片主模型" }
    else if item.file.contains("image_vae") { "图片解码模型" }
    else if item.file.contains("diffusion_models/") { "视频主模型" }
    else if item.file.contains("text_encoders/") { "文本理解模型" }
    else if item.file.contains("audio_vae") { "音频解码模型" }
    else if item.file.contains("video_vae") { "画面解码模型" }
    else { "8 步加速模型" }
}
// Pinned upstream revisions and LFS hashes; never substitute a similarly named LoRA.
const DOWNLOADS: &[Download] = &[
    Download { file: "portable.7z", size: 2018444114, sha: "496afd18790ec685d99ebba2edf200d7371a29fbdd3a992bb0f4f52f244a6874" },
    Download { file: "models/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors", size: 20970379616, sha: "e889202c41dafb67b10d67b97f0d8541508036a6090af23425a5c2615d03c47a" },
    Download { file: "models/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", size: 15687142551, sha: "35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6" },
    Download { file: "models/vae/minimax_h3_audio_vae_fp32.safetensors", size: 605254808, sha: "8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48" },
    Download { file: "models/vae/minimax_h3_video_vae_int8_convrot.safetensors", size: 2811065184, sha: "52a2c8c73583c86e4f41cdcce3a6ad0ea562987bc0bf3d60a0cef5f5c8e60c0e" },
    Download { file: "models/loras/minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors", size: 1956193000, sha: "08cfe946033af7d27719b964b6e0a0e50c32138daabbd6ce4137e23df6bf9980" },
    Download { file: "models/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors", size: 20970379616, sha: "9255f52b6677845ad238f20dfaafa94727053694127ab7f255c048f0f9365779" },
];
const IMAGE_DOWNLOADS: &[Download] = &[
    Download { file: "portable.7z", size: 2071479423, sha: "60c12e8c7af778047ad0413722dd3dc0f6ca773a41cbf5cb229ee9bc92c44a6f" },
    Download { file: "models/diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors", size: 20979314802, sha: "83eb140f1ff95c068f8a6886e6d3f3d0d4ab2e07bb2fe6d2ef992a51146ee622" },
    Download { file: "models/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors", size: 27141342152, sha: "bc2ced0fbea64757fa9acddccfc0b3f4819d1dcf1da6c124d690d368be283923" },
    Download { file: "models/vae/minimax_h3_image_vae_fp16.safetensors", size: 1168505312, sha: "d80e9c2e5cfc9844869961ff5a58c9a9e52182df6bfb30b26018dd7f348721af" },
];
fn downloads(mode: Mode) -> Vec<&'static Download> {
    if !mode.image() { return DOWNLOADS.iter().collect(); }
    let names = mode.names();
    IMAGE_DOWNLOADS.iter().filter(|item| item.file == "portable.7z" || names.contains(&item.file.rsplit('/').next().unwrap())).collect()
}
fn tos_available(item: &Download) -> bool { DOWNLOADS.iter().any(|known| known.file == item.file) }
fn modelscope_url(item: &Download) -> Option<String> {
    let path = item.file.strip_prefix("models/")?;
    if IMAGE_DOWNLOADS.iter().any(|v| v.file == item.file) {
        return Some(format!("https://modelscope.cn/models/Comfy-Org/MiniMax-H3-Image/resolve/b8ebf14be96f02e5c58960620a101de71b0bd9f3/{path}"));
    }
    let (repo, revision, path) = match path {
        "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors" => ("Comfy-Org/MiniMax-H3", "02d0e736e1112426c30683e0ed8fd7182a4e5d6d", path),
        "diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors" => ("Comfy-Org/MiniMax-H3", "d51b9ec4bf7d7af1ce11bcbbd1a809aadb38011e", path),
        "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors" => ("Comfy-Org/MiniMax-H3", "160418ce87d04db418a33a0dbe904d5a2d774e3f", path),
        "vae/minimax_h3_audio_vae_fp32.safetensors" => ("Comfy-Org/MiniMax-H3", "dcdcca14e93e72d8cba0b6312771cf0779e85cc1", path),
        "vae/minimax_h3_video_vae_int8_convrot.safetensors" => ("Comfy-Org/MiniMax-H3", "28f23183b0ec49739a0c01184f04384e5470042e", path),
        "loras/minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors" => ("lightx2v/Minimax-h3-Turbo", "b9591d0cd28b7e64106551ac3843dcfee07d7785", path.strip_prefix("loras/").unwrap()),
        _ => return None,
    };
    Some(format!("https://modelscope.cn/models/{repo}/resolve/{revision}/{path}"))
}
fn modelscope_redirect_allowed(url: &reqwest::Url) -> bool {
    url.scheme() == "https" && url.port().is_none() && url.username().is_empty() && url.password().is_none()
        && url.host_str().is_some_and(|host| host == "modelscope.cn" || host.ends_with(".modelscope.cn"))
}
fn modelscope_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder().no_proxy().https_only(true)
        .user_agent(concat!("Bowerbird/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() < 5 && modelscope_redirect_allowed(attempt.url()) { attempt.follow() }
            else { attempt.stop() }
        }))
        .connect_timeout(Duration::from_secs(15)).read_timeout(Duration::from_secs(30))
        .build().map_err(|_| err("无法初始化模型下载连接"))
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    mode: Mode, models_required: usize,
    phase: String, message: String, endpoint: String, directory: String,
    can_install: bool, can_add_models: bool, installed: bool, download_bytes: u64, required_bytes: u64,
    completed_bytes: u64, total_bytes: u64,
    existing: Vec<Installation>,
    hardware: Option<driver::Hardware>,
    driver_download: Option<driver::DriverDownload>,
}
struct Job { owner: String, state: Environment, cancel: Arc<AtomicBool>, resumed_bytes: u64, recovery: Option<(String, PathBuf)> }
static JOB: Mutex<Option<Job>> = Mutex::new(None);
struct VideoProcess { child: ManagedChild, log: PathBuf, installation: PathBuf, default_port: u16 }
static VIDEO_PROCESSES: Mutex<Option<std::collections::HashMap<String, VideoProcess>>> = Mutex::new(None);
fn err(message: impl Into<String>) -> AppError { AppError::Other(message.into()) }
fn active(state: &Environment) -> bool { matches!(state.phase.as_str(), "installing" | "starting") }
fn retain_setup_outcome(state: &mut Environment, previous: Option<&Environment>) {
    let Some(previous) = previous.filter(|old| old.mode == state.mode && matches!(old.phase.as_str(), "failed" | "cancelled") && old.directory == state.directory
        && old.existing.first().map(|i| &i.path) == state.existing.first().map(|i| &i.path)) else { return; };
    // A successful prerequisite check does not mean a previous installation/start succeeded.
    // Prefer new readiness/blocker information; otherwise keep the failure available for retry.
    if (state.phase == "missing" && state.can_install) || (state.phase == "stopped" && state.existing.first().is_some_and(|i| i.can_start)) {
        state.phase = previous.phase.clone();
        state.message = previous.message.clone();
    }
}
fn progress(message: String, bytes: u64) {
    if let Some(job) = JOB.lock().unwrap().as_mut() { update_progress(job, message, bytes); }
}
fn update_progress(job: &mut Job, message: String, bytes: u64) {
    job.state.message = message;
    job.state.completed_bytes = job.state.completed_bytes.max(bytes.saturating_sub(job.resumed_bytes).min(job.state.download_bytes));
}
fn installation_stage(message: &str, starting: bool) {
    if let Some(job) = JOB.lock().unwrap().as_mut() {
        job.resumed_bytes = 0;
        if starting { job.state.phase = "starting".into(); }
        let bytes = job.state.download_bytes;
        update_progress(job, message.into(), bytes);
    }
}
fn cancelled(cancel: &AtomicBool) -> AppResult<()> {
    if cancel.load(Ordering::Relaxed) { Err(err("已取消，保留已下载文件，下次可继续")) } else { Ok(()) }
}
fn endpoint_port(endpoint: &str) -> Option<u16> {
    endpoint.strip_prefix("http://127.0.0.1:")?.parse().ok()
}
pub(super) fn owned_video_port(endpoint: &str) -> bool {
    endpoint_port(endpoint).is_some_and(|port| matches!(port, 18188 | 18189) || FALLBACK_PORTS.contains(&port))
}
fn same_installation(one: &Path, two: &Path) -> bool {
    one == two || one.canonicalize().ok().zip(two.canonicalize().ok()).is_some_and(|(one, two)| one == two)
}
pub(super) fn running_original_service(endpoint: &str, installation: &Path) -> bool {
    video_installation(endpoint).is_some_and(|path| same_installation(&path, installation))
}
fn running_endpoint(installation: &Path, default_port: u16) -> Option<String> {
    let matches: Vec<_> = {
        let mut registry = VIDEO_PROCESSES.lock().unwrap();
        registry.as_mut()?.iter_mut().filter(|(_, process)| process.default_port == default_port)
            .filter_map(|(endpoint, process)| matches!(process.child.try_wait(), Ok(None))
                .then(|| (endpoint.clone(), process.installation.clone()))).collect()
    };
    matches.into_iter().find(|(_, path)| same_installation(path, installation)).map(|(endpoint, _)| endpoint)
}

fn may_probe_endpoint(endpoint: &str) -> bool {
    let mut registry = VIDEO_PROCESSES.lock().unwrap();
    registry.as_mut().and_then(|entries| entries.get_mut(endpoint))
        .is_none_or(|process| matches!(process.child.try_wait(), Ok(None)))
}

#[derive(serde::Deserialize, Serialize)]
struct PortAssignment { installation: PathBuf, port: u16 }

fn remembered_port(file: &Path, installation: &Path) -> Option<u16> {
    if !std::fs::metadata(file).is_ok_and(|meta| meta.len() < 16 * 1024) { return None; }
    let assignment: PortAssignment = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    (FALLBACK_PORTS.contains(&assignment.port) && same_installation(&assignment.installation, installation))
        .then_some(assignment.port)
}

fn write_port_assignment(file: &Path, installation: &Path, port: u16) -> AppResult<()> {
    let temp = file.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, serde_json::to_vec(&PortAssignment { installation: installation.to_owned(), port })?)?;
    if let Err(error) = std::fs::rename(&temp, file) {
        let _ = std::fs::remove_file(&temp);
        return Err(error.into());
    }
    Ok(())
}

fn select_launch_port(default: u16, remembered: Option<u16>, exact: Option<u16>, mut occupied: impl FnMut(u16) -> bool) -> AppResult<u16> {
    if let Some(port) = exact {
        return if occupied(port) { Err(err("原 ComfyUI 启动端口已被占用，请恢复原实例后继续取回任务")) } else { Ok(port) };
    }
    let candidates = remembered.into_iter().chain([default]).chain(FALLBACK_PORTS);
    for port in candidates { if !occupied(port) { return Ok(port); } }
    Err(err("本机 ComfyUI 默认启动端口和备用端口均被占用，请释放其中一个端口后重试"))
}

fn launch_endpoint(app: &AppHandle, installation: &Path, default: u16, exact: Option<&str>) -> AppResult<String> {
    let file = assignment_file(app, default)?;
    let exact = exact.map(|endpoint| endpoint_port(endpoint).ok_or_else(|| err("原任务端口无效"))).transpose()?;
    let port = select_launch_port(default, remembered_port(&file, installation), exact, |port| {
        // Binding tests the listener directly and does not depend on Windows loopback connect timeouts.
        std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).is_err()
    })?;
    Ok(format!("http://127.0.0.1:{port}"))
}

fn assignment_file(app: &AppHandle, default: u16) -> AppResult<PathBuf> {
    Ok(app.path().app_local_data_dir().map_err(|error| err(error.to_string()))?.join(format!("comfy-port-{default}.json")))
}

struct LaunchPorts { managed: String, existing: String }
impl LaunchPorts {
    fn new(root: &Path, existing: &[Installation], mode: Mode) -> Self {
        Self {
            managed: running_endpoint(root, mode.default_port(false)).unwrap_or_else(|| mode.endpoint().into()),
            existing: existing.first().and_then(|instance| running_endpoint(&instance.path, mode.default_port(true)))
                .unwrap_or_else(|| mode.existing_service().1.into()),
        }
    }
}

fn config(app: &AppHandle, mode: Mode) -> AppResult<PathBuf> { Ok(app.path().app_local_data_dir().map_err(|e| err(e.to_string()))?.join(if mode.image() { "comfy-image-install-location.json" } else { "comfy-install-location.json" })) }
fn location(app: &AppHandle, directory: Option<String>, mode: Mode) -> AppResult<PathBuf> {
    if let Some(directory) = directory {
        let parent = PathBuf::from(directory).canonicalize().map_err(|error| err(format!("无法访问所选安装位置：{error}。请确认磁盘已连接，并通过“安装位置”选择可访问的文件夹。")))?;
        if !parent.is_dir() { return Err(err("请选择安装文件夹")); }
        return Ok(parent.join(if mode.image() { "Bowerbird-ComfyUI-Image" } else { "Bowerbird-ComfyUI" }));
    }
    if let Ok(data) = std::fs::read(config(app, mode)?) {
        let path: PathBuf = serde_json::from_slice(&data)?;
        if path.is_absolute() { return Ok(path); }
    }
    Ok(app.path().app_local_data_dir().map_err(|e| err(e.to_string()))?.join(if mode.image() { "Bowerbird-ComfyUI-Image" } else { "Bowerbird-ComfyUI" }))
}
fn portable(root: &Path) -> PathBuf { root.join("ComfyUI_windows_portable") }
fn runtime_installed(root: &Path, mode: Mode) -> bool {
    std::fs::read_to_string(root.join("ready.txt")).ok().as_deref() == Some(mode.version())
        && portable(root).join("python_embeded/python.exe").is_file() && portable(root).join("ComfyUI/main.py").is_file()
        && root.join("models.yaml").is_file()
}
fn installed(root: &Path, mode: Mode) -> bool {
    runtime_installed(root, mode) && downloads(mode).iter().filter(|item| item.file != "portable.7z").all(|item| std::fs::metadata(root.join(item.file)).is_ok_and(|m| m.len() == item.size))
}
fn installed_for_original_mode(root: &Path, mode: Mode) -> bool {
    runtime_installed(root, mode) && mode.names().iter().all(|name| {
        downloads(mode).into_iter().find(|item| item.file.rsplit('/').next() == Some(*name)).is_some_and(|item| {
            std::fs::metadata(root.join(item.file)).is_ok_and(|meta| meta.is_file() && meta.len() == item.size)
        })
    })
}
fn stop_process_tree(child: &mut ManagedChild) {
    if let Err(error) = child.kill_and_wait() {
        tracing::warn!(pid = child.id(), %error, "ComfyUI owned process cleanup failed");
    }
}
fn prerequisites(hardware: &driver::Hardware) -> Result<(), String> {
    if let Some(issue) = &hardware.issue { return Err(issue.clone()); }
    if !command("tar.exe").arg("--version").output().is_ok_and(|out| out.status.success()) { return Err("未找到 Windows tar 解压工具，请更新 Windows 或连接已有 ComfyUI".into()); }
    Ok(())
}
// Read-only preflight: report directory conflicts before enabling installation.
fn check_destination(root: &Path) -> AppResult<()> {
    match std::fs::metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(err(format!("无法访问安装目录 {}：{error}。请连接磁盘或通过“安装位置”选择有权限的文件夹。", root.display()))),
        Ok(meta) if !meta.is_dir() => return Err(err(format!("安装路径 {} 已被文件占用，请通过“安装位置”选择其他文件夹。", root.display()))),
        Ok(_) => {},
    }
    let mut entries = std::fs::read_dir(root).map_err(|error| err(format!("无法读取安装目录 {}：{error}。请通过“安装位置”选择有权限的文件夹。", root.display())))?;
    if !root.join("bowerbird-setup.txt").is_file() && entries.next().transpose()?.is_some() {
        return Err(err(format!("安装目录 {} 已有其他文件，无法安全安装。请通过“安装位置”选择其他文件夹；不会覆盖原文件。", root.display())));
    }
    Ok(())
}
fn check_disk_space(available: u64, required: u64) -> AppResult<()> {
    if available >= required { return Ok(()); }
    Err(err(format!("安装磁盘空间不足：需空闲 {:.1} GB，当前可用 {:.1} GB，还差 {:.1} GB。请清理磁盘或通过“安装位置”更换磁盘后重试。",
        required as f64 / 1e9, available as f64 / 1e9, (required - available) as f64 / 1e9)))
}
fn supplement_message(state: &Environment) -> String {
    format!("补充缺失模型（约 {:.1} GB），已有环境与模型直接复用", state.download_bytes as f64 / 1e9)
}
fn downloaded_bytes(root: &Path, item: &Download) -> u64 {
    let path = root.join(item.file);
    std::fs::metadata(&path).or_else(|_| std::fs::metadata(path.with_extension("part")))
        .ok().filter(|metadata| metadata.is_file() && metadata.len() <= item.size)
        .map_or(0, |metadata| metadata.len())
}
fn plan(root: &Path, mode: Mode) -> Environment {
    let download_bytes = downloads(mode).iter().map(|item| {
        if item.file == "portable.7z" && runtime_installed(root, mode) { return 0; }
        item.size - downloaded_bytes(root, item)
    }).sum();
    Environment { mode, models_required: mode.names().len(), phase: "missing".into(), message: "未发现运行中的 ComfyUI，也未找到已登记的安装".into(), endpoint: mode.endpoint().into(), directory: root.to_string_lossy().into(), can_install: false, can_add_models: false, installed: installed(root, mode), download_bytes, required_bytes: download_bytes + RESERVE, completed_bytes: 0, total_bytes: downloads(mode).iter().map(|d| d.size).sum(), existing: Vec::new(), hardware: None, driver_download: None }
}
struct Probe { result: AppResult<()>, identified: bool }
async fn probe(http: &reqwest::Client, base: &str, mode: Mode) -> Option<Probe> {
    let response = match http.get(format!("{base}/system_stats")).timeout(Duration::from_secs(8)).send().await {
        Ok(response) => response,
        // Windows may report an unopened loopback port as a connect timeout instead of refused.
        // No HTTP connection was established; filesystem discovery still identifies stopped installs.
        Err(error) if error.is_connect() => return None,
        Err(_) => return Some(Probe { result: Err(err("本机服务检查超时或连接异常，请稍后重新检测；不能据此判断未安装")), identified: false }),
    };
    let Ok(stats) = response.json::<serde_json::Value>().await else { return None; };
    let version = stats["system"]["comfyui_version"].as_str()?;
    let mut parts = version.trim_start_matches('v').split('.');
    let numbers = parts.next()?.parse::<u32>().ok().zip(parts.next()?.parse::<u32>().ok());
    let Some(version_number) = numbers else {
        // Common ports can belong to unrelated apps. A generic HTTP response is not a ComfyUI installation.
        return None;
    };
    if mode.image() && version_number < (0, 45) {
        return Some(Probe { result: Err(err(format!("ComfyUI {version} 需要更新到 0.45.0 或更高版本"))), identified: true });
    }
    Some(Probe { result: mode.check(http, base).await, identified: true })
}
#[cfg(test)]
async fn detect(root: &Path, preferred: &str, existing: Vec<Installation>, mode: Mode) -> AppResult<Environment> {
    let ports = LaunchPorts::new(root, &existing, mode);
    detect_scoped(root, preferred, existing, mode, false, false, &ports).await
}
async fn detect_scoped(root: &Path, preferred: &str, existing: Vec<Installation>, mode: Mode, exact: bool, pinned: bool, ports: &LaunchPorts) -> AppResult<Environment> {
    let preferred = comfy_video::endpoint(preferred)?;
    let mut state = plan(root, mode);
    state.existing = existing;
    let http = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(2)).timeout(Duration::from_secs(45)).build().map_err(|e| err(e.to_string()))?;
    let preferred = if !exact && endpoint_port(&preferred).is_some_and(|port| FALLBACK_PORTS.contains(&port)) &&
        preferred != ports.managed && preferred != ports.existing { ports.managed.clone() } else { preferred };
    let mut endpoints = vec![preferred, ports.managed.clone(), ports.existing.clone(), "http://127.0.0.1:8000".into(), "http://127.0.0.1:8188".into()];
    if mode.image() { endpoints.extend([MANAGED_ENDPOINT.into(), "http://127.0.0.1:18189".into()]); }
    endpoints.extend(state.existing.iter().map(|i| i.endpoint.clone()));
    if exact { endpoints.truncate(1); }
    else if pinned {
        endpoints = vec![ports.existing.clone()];
        endpoints.extend(state.existing.iter().map(|i| i.endpoint.clone()));
    }
    let mut seen = std::collections::HashSet::new();
    endpoints.retain(|value| seen.insert(value.clone()) && (exact || may_probe_endpoint(value)));
    use futures_util::StreamExt;
    let mut pending: futures_util::stream::FuturesOrdered<_> = endpoints.iter().map(|base| probe(&http, base, mode)).collect();
    let mut results = Vec::with_capacity(endpoints.len());
    for base in &endpoints {
        let result = pending.next().await.expect("one probe per endpoint");
        if result.as_ref().is_some_and(|probe| probe.result.is_ok()) && (exact || may_probe_endpoint(base)) {
            state.phase = "ready".into(); state.endpoint = base.clone(); state.message = "本机环境已就绪 · 模型与节点可用".into();
            return Ok(state);
        }
        results.push(result);
    }
    if let Some((base, Some(Probe { result: Err(error), .. }))) = endpoints.iter().zip(&results).find(|(base, result)| {
        let Some(probe) = result else { return false; };
        // An unidentified listener on an automatic launch port can be bypassed.
        // A previously confirmed Bowerbird instance or an exact recovery cannot.
        if !exact && !probe.identified && [ports.managed.as_str(), ports.existing.as_str()].contains(&base.as_str())
            && video_installation(base).is_none() { return false; }
        if mode.image() { base.as_str() == ports.managed.as_str() } else {
            // The dedicated image service may be up while the independently startable video service is stopped.
            ![Mode::Image.endpoint(), Mode::Image.existing_service().1].contains(&base.as_str())
        }
    }) {
        state.phase = "unavailable".into(); state.endpoint = base.clone();
        state.message = format!("服务尚未通过检查（{base}）：{error}");
        // An owned running installation can add this mode's missing model without replacing its runtime.
        if base == &ports.managed && runtime_installed(root, mode) && !state.installed {
            match free_bytes(root).and_then(|bytes| check_disk_space(bytes, state.required_bytes)) {
                Ok(()) => { state.can_install = true; state.can_add_models = true; state.message = supplement_message(&state); }
                Err(error) => state.message = error.to_string(),
            }
            state.existing.clear();
        }
        if !mode.image() && !state.can_add_models && [ports.managed.as_str(), ports.existing.as_str()].contains(&base.as_str()) {
            state.message.push_str("。若视频服务一直无响应，请在 ComfyUI Desktop 或任务管理器中结束该实例，再重新检测。");
        }
        return Ok(state);
    }
    if exact && video_port_occupied(&endpoints[0]).await {
        state.phase = "unavailable".into();
        state.endpoint = endpoints[0].clone();
        state.message = "原视频端口已被占用，请恢复原 ComfyUI 实例后继续取回。".into();
        return Ok(state);
    }
    if mode.image() {
        // Prefer the isolated runtime when an older or incomplete Desktop is already responding.
        state.existing.retain(|instance| !endpoints.iter().zip(&results).any(|(base, result)| base == &instance.endpoint && result.is_some()));
        if let Some((base, Some(Probe { result: Err(issue), .. }))) = endpoints.iter().zip(&results)
            .find(|(_,v)|matches!(v, Some(Probe { result: Err(_), .. }))) {
            state.message = format!("已检测到 {base}：{issue}。可准备独立的 H3 图片环境。");
        } else if !state.existing.is_empty() {
            state.message = "已找到 ComfyUI 安装。若已配置图片模型可先启动并重新检测，或安装独立图片环境。".into();
        }
        state.existing.retain(|i| i.models_found == mode.names().len() && i.can_start);
    }
    if let Some(instance) = state.existing.first() {
        state.phase = "stopped".into(); state.endpoint = instance.endpoint.clone();
        state.message = if !instance.can_start {
            format!("已找到 {}，但缺少可用的 Python 程序，暂时无法自动启动。请在 ComfyUI Desktop 中修复环境并启动，或修复该安装的 Python 后返回应用重新检测。安装目录：{}", instance.name, instance.path.display())
        } else if instance.models_found < mode.names().len() {
            format!("已找到 {}，磁盘检查仅定位到 {}/{} 个所需模型。可点击启动进一步检查；若仍提示缺失，请在已有 ComfyUI 中补齐模型后返回应用。", instance.name, instance.models_found, mode.names().len())
        } else { format!("已找到 {}，但服务未启动。可直接启动已有环境，无需重新下载。", instance.name) };
        return Ok(state);
    }
    if !mode.image() && state.installed {
        state.can_install = true;
        state.message = "已找到视频环境。运行时会自动启动。".into();
        return Ok(state);
    }
    let hardware = driver::detect().await;
    let checked = hardware.clone();
    let support = tokio::task::spawn_blocking(move || prerequisites(&checked)).await.map_err(|e| err(e.to_string()))?;
    state.hardware = Some(hardware);
    match support {
        Ok(()) => {
            if !state.installed {
                if let Err(error) = check_destination(root) { state.message = error.to_string(); return Ok(state); }
            }
            match free_bytes(root) {
                Ok(bytes) => match if state.installed { Ok(()) } else { check_disk_space(bytes, state.required_bytes) } {
                    Ok(()) => { state.can_install = true; state.can_add_models = runtime_installed(root, mode) && !state.installed; if state.can_add_models { state.message = supplement_message(&state); } }
                    Err(error) => state.message = error.to_string(),
                },
                Err(error) => state.message = format!("无法检查安装磁盘 {}：{error}。请确认磁盘已连接，并通过“安装位置”选择可访问的磁盘。", root.display()),
            }
        }
        Err(reason) => state.message = reason,
    }
    Ok(state)
}
#[derive(serde::Deserialize)]
struct DownloadGrant { url: String, file: String, size: u64, sha256: String }
fn validate_grant(grant: DownloadGrant, item: &Download) -> AppResult<String> {
    let url = reqwest::Url::parse(&grant.url).map_err(|_| err("下载授权地址无效"))?;
    if url.scheme() != "https" || url.host_str() != Some("bowerbird.tos-cn-guangzhou.volces.com")
        || url.port().is_some() || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some()
        || url.path() != format!("/comfyui/{VERSION}/{}", item.file)
        || grant.file != item.file || grant.size != item.size || grant.sha256 != item.sha {
        return Err(err("下载授权与固定安装资源不匹配，请更新客户端"));
    }
    Ok(grant.url)
}
async fn download_grant(app: &AppHandle, http: &reqwest::Client, item: &Download, owner: &str) -> AppResult<String> {
    let auth = app.state::<AuthClient>();
    let entitlement = app.state::<EntitlementService>();
    if comfy_video::account(&auth, &entitlement).await? != owner { return Err(err("账号已切换，安装已停止")); }
    let endpoint = crate::cloud::config::CloudConfig::official().account_endpoint("comfy-download").ok_or_else(|| err("下载授权服务未配置"))?;
    let response = auth.send_authorized(http.post(endpoint).timeout(Duration::from_secs(30))
        .json(&serde_json::json!({"version": VERSION, "file": item.file})), "获取安装下载授权失败").await?;
    if !response.status().is_success() {
        return Err(err(if response.status() == reqwest::StatusCode::FORBIDDEN { "下载需要有效的 Pro／Studio 权益或测试账号资格" }
            else { "获取下载授权失败，请稍后重试" }));
    }
    let grant = response.json::<DownloadGrant>().await.map_err(|_| err("下载授权响应无效"))?;
    if auth.snapshot().user_id.as_deref() != Some(owner) { return Err(err("账号已切换，安装已停止")); }
    validate_grant(grant, item)
}
// Old frame installs wrote ready.txt only after verifying every frame resource.
fn legacy_frames_verified_at(root: &Path, mode: Mode) -> Option<std::time::SystemTime> {
    if mode.image() || !runtime_installed(root, mode) || root.join(DOWNLOADS.last()?.file).exists() { return None; }
    if !DOWNLOADS[1..6].iter().all(|item| std::fs::metadata(root.join(item.file)).is_ok_and(|m| m.is_file() && m.len() == item.size)) { return None; }
    std::fs::metadata(root.join("ready.txt")).ok()?.modified().ok()
}

fn migrate_frame_receipt(path: &Path, item: &Download, verified_at: std::time::SystemTime) {
    let cache = path.with_extension("verified");
    if cache.exists() { return; }
    let Ok(meta) = std::fs::metadata(path) else { return; };
    if meta.len() != item.size || ![meta.modified(), meta.created()].into_iter().all(|t| t.is_ok_and(|time| time <= verified_at)) { return; }
    remember_verified(path, metadata_stamp(&meta, item.sha));
}

async fn verify_download(path: &Path, item: &Download, cancel: &AtomicBool, done: u64) -> AppResult<bool> {
    let name = label(item);
    let total = item.size;
    progress(format!("正在校验{name}…"), done);
    let digest = hash(path, cancel, move |bytes| {
        let percent = (bytes.saturating_mul(100) / total.max(1)).min(100);
        progress(format!("正在校验{name}（{percent}%）…"), done);
    }).await?;
    Ok(digest == item.sha)
}
async fn download<F, Fut>(http: &reqwest::Client, item: &Download, root: &Path, cancel: &AtomicBool, done: u64, grant: F) -> AppResult<()>
where F: FnMut() -> Fut, Fut: std::future::Future<Output = AppResult<String>> {
    cancelled(cancel)?;
    let target = root.join(item.file); let part = target.with_extension("part");
    tokio::fs::create_dir_all(target.parent().unwrap()).await?;
    if target.is_file() {
        if verified(&target, item.size, item.sha) { return Ok(()); }
        if tokio::fs::metadata(&target).await?.len() == item.size {
            let stamp = verification_stamp(&target, item.sha);
            if verify_download(&target, item, cancel, done).await? {
                remember_verified(&target, stamp);
                return Ok(());
            }
        }
        return Err(err(format!("已存在的文件校验失败：{}。请移走该文件后重试", target.display())));
    }
    if tokio::fs::metadata(&part).await.is_ok_and(|m| m.is_file() && m.len() > item.size) {
        tokio::fs::remove_file(&part).await?;
    }
    // TOS re-signs on each attempt. Public mirrors resolve the same pinned revision.
    transfer(http, &part, item.size, cancel, grant, |state| match state {
        TransferProgress::Downloading(offset) => progress(format!("正在下载{}…", label(item)), done + offset),
        TransferProgress::Reconnecting(offset) => progress(format!("正在恢复{}下载…", label(item)), done + offset),
    }).await?;
    if !verify_download(&part, item, cancel, done + item.size).await? { tokio::fs::remove_file(&part).await?; return Err(err("下载校验失败，损坏的临时文件已清除，请重试")); }
    tokio::fs::rename(part, &target).await?;
    remember_verified(&target, verification_stamp(&target, item.sha));
    Ok(())
}
async fn download_resource<F, Fut>(http: &reqwest::Client, mirror: Option<(&reqwest::Client, &str)>, item: &Download, root: &Path, cancel: &AtomicBool, done: u64, grant: F) -> AppResult<()>
where F: FnMut() -> Fut, Fut: std::future::Future<Output = AppResult<String>> {
    // Reuse verified files without contacting either source. Both sources share the same hash and .part.
    if !root.join(item.file).is_file() {
        if let Some((mirror_http, url)) = mirror {
            let error = match download(mirror_http, item, root, cancel, done, || std::future::ready(Ok(url.to_owned()))).await {
                Ok(()) => return Ok(()),
                Err(error) => error,
            };
            cancelled(cancel)?;
            tracing::warn!(file = item.file, source = "modelscope", %error, "switching ComfyUI download source");
            progress(format!("正在切换备用下载源：{}…", label(item)), done);
        }
    }
    download(http, item, root, cancel, done, grant).await
}
async fn write_licenses(root: &Path) -> AppResult<()> {
    let directory = root.join("licenses");
    tokio::fs::create_dir_all(&directory).await?;
    for (name, content) in [
        ("MiniMax-H3-LICENSE.txt", include_str!("../../../src/assets/comfy-licenses/MiniMax-H3-LICENSE.txt")),
        ("NOTICE.txt", include_str!("../../../src/assets/comfy-licenses/NOTICE.txt")),
        ("Qwen3-VL-LICENSE.txt", include_str!("../../../src/assets/comfy-licenses/Qwen3-VL-LICENSE.txt")),
        ("ComfyUI-v0.42.1-LICENSE.txt", include_str!("../../../src/assets/comfy-licenses/ComfyUI-v0.42.1-LICENSE.txt")),
        ("Comfy-Org-MiniMax-H3-README.md", include_str!("../../../src/assets/comfy-licenses/Comfy-Org-MiniMax-H3-README.md")),
        ("LightX2V-README.md", include_str!("../../../src/assets/comfy-licenses/LightX2V-README.md")),
        ("sources.json", include_str!("../../../src/assets/comfy-licenses/sources.json")),
    ] { tokio::fs::write(directory.join(name), content).await?; }
    Ok(())
}
async fn install(app: &AppHandle, root: &Path, cancel: &AtomicBool, owner: &str, mode: Mode, allow_download: bool, exact: Option<&str>) -> AppResult<String> {
    let check_owner = || -> AppResult<()> {
        cancelled(cancel)?;
        let login = app.state::<AuthClient>().snapshot();
        if !login.logged_in || login.user_id.as_deref() != Some(owner) { return Err(err("账号已切换，安装已停止")); }
        Ok(())
    };
    check_owner()?;
    let state = plan(root, mode);
    let ready = state.installed || exact.is_some() && installed_for_original_mode(root, mode);
    if !allow_download && !ready { return Err(err("已安装环境的文件有变动，请重新检测并补齐缺失的文件。")); }
    if !ready {
        prerequisites(&driver::detect().await).map_err(err)?;
        check_disk_space(free_bytes(root)?, state.required_bytes)?;
    }
    check_owner()?;
    let marker = root.join("bowerbird-setup.txt");
    check_destination(root)?;
    tokio::fs::create_dir_all(root).await?;
    tokio::fs::write(&marker, mode.version()).await?;
    if exact.is_none() {
        let location = config(app, mode)?;
        tokio::fs::create_dir_all(location.parent().unwrap()).await?;
        tokio::fs::write(location, serde_json::to_vec(root)?).await?;
    }
    if !ready {
        let http = reqwest::Client::builder().no_proxy().https_only(true).redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(30)).read_timeout(Duration::from_secs(60)).build().map_err(|e| err(e.to_string()))?;
        // Separate unauthenticated client: only ModelScope downloads may follow its CDN redirects.
        let mirror_http = modelscope_client()?;
        let public = if mode.image() {
            Some(reqwest::Client::builder().https_only(true).connect_timeout(Duration::from_secs(30))
                .read_timeout(Duration::from_secs(60)).build().map_err(|_| err("无法初始化图片安装下载"))?)
        } else { None };
        let mut done = 0;
        if mode.image() {
            let licenses = root.join("licenses");
            tokio::fs::create_dir_all(&licenses).await?;
            tokio::fs::write(licenses.join("sources.txt"), "Runtime: https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.45.0\nModels: https://huggingface.co/Comfy-Org/MiniMax-H3-Image/tree/0bb149f51e3156ed4b90dd45d5620346bfe1df8f\nWorkflows: https://github.com/Comfy-Org/workflow_templates/tree/main/templates\n").await?;
            tokio::fs::write(licenses.join("MiniMax-H3-Image-LICENSE.txt"), include_str!("../../../src/assets/comfy-licenses/MiniMax-H3-Image-LICENSE.txt")).await?;
        } else { write_licenses(root).await?; }
        let legacy_receipt = legacy_frames_verified_at(root, mode);
        for item in downloads(mode) {
            check_owner()?;
            if item.file == "portable.7z" && runtime_installed(root, mode) { continue; }
            if comfy_video::account(&app.state::<AuthClient>(), &app.state::<EntitlementService>()).await? != owner { return Err(err("账号已切换，安装已停止")); }
            let target = root.join(item.file);
            if let Some(at) = legacy_receipt.filter(|_| DOWNLOADS[1..6].iter().any(|old| old.file == item.file)) {
                migrate_frame_receipt(&target, item, at);
            }
            let already = downloaded_bytes(root, item);
            let resumed = if target.is_file() { 0 } else { already };
            if let Some(job) = JOB.lock().unwrap().as_mut() { job.resumed_bytes = resumed; }
            let mirror_url = modelscope_url(item);
            if let Some(public) = &public {
                let url = match item.file.strip_prefix("models/") {
                    Some(path) => format!("https://huggingface.co/Comfy-Org/MiniMax-H3-Image/resolve/0bb149f51e3156ed4b90dd45d5620346bfe1df8f/{path}"),
                    None => "https://github.com/Comfy-Org/ComfyUI/releases/download/v0.45.0/ComfyUI_windows_portable_nvidia.7z".into(),
                };
                download_resource(public, mirror_url.as_deref().map(|url| (&mirror_http,url)), item, root, cancel, done, || std::future::ready(Ok(url.clone()))).await?;
            } else if item.file.contains("ref2va") {
                if let Err(primary) = download(&http, item, root, cancel, done, || download_grant(app, &http, item, owner)).await {
                    if target.exists() { return Err(primary); }
                    cancelled(cancel)?;
                    let url = mirror_url.ok_or_else(|| err("缺少备用下载源"))?;
                    tracing::warn!(file = item.file, source = "tos", error = %primary, "switching ComfyUI download source");
                    download(&mirror_http, item, root, cancel, done, || std::future::ready(Ok(url.clone()))).await?;
                }
            } else {
                debug_assert!(tos_available(item));
                download_resource(&http, mirror_url.as_deref().map(|url| (&mirror_http, url)), item, root, cancel, done, || download_grant(app, &http, item, owner)).await?;
            }
            done += item.size - already;
        }
        if !runtime_installed(root, mode) {
            installation_stage("正在解压 ComfyUI 与 Python 环境…", false);
            extract_portable(root, mode, cancel, &check_owner).await?;
        }
    }
    cleanup_archive(root).await;
    check_owner()?;
    let default = mode.default_port(false);
    if let Some(endpoint) = running_endpoint(root, default).filter(|endpoint| exact.is_none_or(|expected| endpoint.as_str() == expected)) {
        let http = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(45)).build().map_err(|e| err(e.to_string()))?;
        mode.check(&http, &endpoint).await?;
        check_owner()?;
        return Ok(endpoint);
    }
    installation_stage("正在启动本机环境并检查模型…", true);
    let endpoint = launch_endpoint(app, root, default, exact)?;
    let port = endpoint_port(&endpoint).expect("selected loopback port").to_string();
    let mut cmd = command(portable(root).join("python_embeded/python.exe"));
    cmd.current_dir(portable(root)).args(["-s", "ComfyUI/main.py", "--windows-standalone-build", "--listen", "127.0.0.1", "--port", &port, "--disable-auto-launch", "--extra-model-paths-config"])
        .arg(root.join("models.yaml"))
        .args(comfy_memory_args(&portable(root).join("ComfyUI/main.py"), &[]));
    launch(app, cmd, &endpoint, root, &root.join("startup.log"), cancel, owner, mode, default).await?;
    Ok(endpoint)
}

fn owned_portable(root: &Path, mode: Mode) -> AppResult<Option<PathBuf>> {
    let runtime = portable(root);
    let meta = match std::fs::symlink_metadata(&runtime) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let canonical_root = root.canonicalize()?;
    if std::fs::read_to_string(root.join("bowerbird-setup.txt")).ok().as_deref() != Some(mode.version())
        || !meta.is_dir() || meta.file_type().is_symlink()
        || runtime.canonicalize()? != portable(&canonical_root) {
        return Err(err("无法安全清理残缺的托管 ComfyUI，请检查安装路径或选择空文件夹"));
    }
    Ok(Some(runtime))
}

async fn cleanup_archive(root: &Path) {
    let archive = root.join("portable.7z");
    for path in [&archive, &archive.with_extension("verified")] {
        if let Err(error) = tokio::fs::remove_file(path).await {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(%error, path = %path.display(), "verified ComfyUI runtime archive cleanup failed");
            }
        }
    }
}

async fn extract_portable(
    root: &Path, mode: Mode, cancel: &AtomicBool, check_owner: impl Fn() -> AppResult<()>,
) -> AppResult<()> {
    check_owner()?;
    let stale = owned_portable(root, mode)?;
    if let Err(error) = tokio::fs::remove_file(root.join("ready.txt")).await {
        if error.kind() != std::io::ErrorKind::NotFound { return Err(error.into()); }
    }
    if let Some(runtime) = stale { tokio::fs::remove_dir_all(runtime).await?; }
    check_owner()?;
    let log_path = root.join("extract.log");
    let log = std::fs::File::create(&log_path)?;
    let mut cmd = command("tar.exe");
    cmd.arg("-xf").arg(root.join("portable.7z")).arg("-C").arg(root);
    let mut child = spawn_managed(&mut cmd, Some(&log))?;
    drop(log);
    let status = loop {
        if let Err(error) = check_owner() { stop_process_tree(&mut child); return Err(error); }
        if let Some(status) = child.try_wait()? { break status; }
        tokio::select! {
            _ = wait_cancel(cancel) => {
                stop_process_tree(&mut child);
                return cancelled(cancel);
            }
            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
        }
    };
    let output = portable(root);
    if !status.success() || !output.join("python_embeded/python.exe").is_file() || !output.join("ComfyUI/main.py").is_file() {
        let tail = startup_log_tail(&log_path);
        let last_line = tail.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("解压包未提供完整的 ComfyUI 与 Python");
        let detail: String = last_line.chars().take(512).collect();
        return Err(err(format!("解压失败：{detail}。请检查磁盘空间与 Windows tar 版本。日志：{}", log_path.display())));
    }
    check_owner()?;
    // JSON is valid YAML; a separate configuration never overwrites an existing user's config.
    let model_config = serde_json::json!({"bowerbird": {"base_path":root.join("models"),"diffusion_models":"diffusion_models","text_encoders":"text_encoders","vae":"vae","loras":"loras"}});
    tokio::fs::write(root.join("models.yaml"), serde_json::to_vec_pretty(&model_config)?).await?;
    tokio::fs::write(root.join("ready.txt"), mode.version()).await?;
    cleanup_archive(root).await;
    Ok(())
}

fn startup_log_tail(path: &Path) -> String {
    log_tail(path, 65536, 0)
}
#[tauri::command]
pub fn comfy_video_log_tail(app: AppHandle) -> AppResult<String> {
    let local = app.path().app_local_data_dir().map_err(|e| err(e.to_string()))?;
    let mut paths = vec![
        ("视频 · 已有安装", local.join("comfy-existing/startup.log")),
        ("图片 · 已有安装", local.join("comfy-existing/image-startup.log")),
    ];
    for (mode, title) in [(Mode::Frames, "视频 · 托管安装"), (Mode::Image, "图片 · 托管安装")] {
        if let Ok(root) = location(&app, None, mode) {
            paths.push((title, root.join("startup.log")));
            paths.push((if mode.image() { "图片 · 托管解压" } else { "视频 · 托管解压" }, root.join("extract.log")));
        }
    }
    Ok(setup_log_report(&paths))
}
fn setup_log_report(paths: &[(&str, PathBuf)]) -> String {
    let mut report = String::new();
    for (title, path) in paths {
        let logs = [path.with_extension("prev.log"), path.clone()].into_iter().chain(latest_startup_fallback(path));
        for log in logs {
            let tail = startup_log_tail(&log);
            if tail.is_empty() { continue; }
            let lines: Vec<_> = tail.lines().rev().take(12).collect();
            report.push_str(&format!("\n{title} · {}\n", log.file_name().unwrap().to_string_lossy()));
            for line in lines.into_iter().rev() { report.extend(line.chars().take(512)); report.push('\n'); }
        }
    }
    report
}
fn latest_startup_fallback(path: &Path) -> Option<PathBuf> {
    let prefix = format!("{}.fallback.", path.file_stem()?.to_string_lossy());
    std::fs::read_dir(path.parent()?).ok()?.filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|entry| entry.path())
        .filter(|entry| entry.file_name().is_some_and(|name| {
            let name = name.to_string_lossy();
            name.starts_with(&prefix) && name.ends_with(".log")
        }))
        .max()
}
fn open_startup_log(path: &Path) -> AppResult<(PathBuf, std::fs::File)> {
    let mut primary_available = true;
    for (source, destination) in [
        (path.with_extension("prev.2.log"), path.with_extension("prev.3.log")),
        (path.with_extension("prev.log"), path.with_extension("prev.2.log")),
        (path.to_owned(), path.with_extension("prev.log")),
    ] {
        if let Err(error) = std::fs::rename(&source, destination) {
            if error.kind() != std::io::ErrorKind::NotFound {
                if source == path { primary_available = false; }
                tracing::warn!(%error, path = %source.display(), "ComfyUI startup log rotation failed");
            }
        }
    }
    if primary_available {
        match std::fs::File::create(path) {
            Ok(file) => return Ok((path.to_owned(), file)),
            Err(error) => tracing::warn!(%error, path = %path.display(), "ComfyUI startup log is not writable"),
        }
    }
    let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
    let fallback = path.with_extension(format!("fallback.{timestamp}.{}.log", uuid::Uuid::new_v4()));
    let file = std::fs::File::create(&fallback)?;
    Ok((fallback, file))
}
fn startup_failure(log: &str, path: &Path) -> AppError {
    let detail = log.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("进程已退出，未提供错误详情");
    let detail: String = detail.chars().take(600).collect();
    err(format!("ComfyUI 启动失败：{detail}。日志：{}", path.display()))
}
fn video_exit_message(log: &str) -> &'static str {
    if log.lines().rev().take(80).any(|line| {
        let line = line.to_ascii_lowercase();
        line.contains("out of memory") || line.contains("outofmemoryerror") || line.contains("cuda_error_out_of_memory")
    }) {
        "本机视频进程在显存不足后中止。运行时会尝试恢复服务。重新生成前请关闭占用显存的应用，或降低视频分辨率。"
    } else {
        "本机视频进程已异常中止，运行时会尝试恢复。"
    }
}
async fn video_port_occupied(endpoint: &str) -> bool {
    let Some(address) = endpoint.strip_prefix("http://") else { return false; };
    matches!(tokio::time::timeout(Duration::from_secs(2), tokio::net::TcpStream::connect(address)).await, Ok(Ok(_)))
}

fn fatal_video_log(log: &str) -> bool {
    log.lines().any(|line| line.contains("Fatal Python error:") || line.contains("Windows fatal exception") || line.contains("CUDA error: an illegal memory access") || line.contains("CUDA error: the launch timed out"))
}

pub(super) fn video_abort_detected(endpoint: &str) -> bool {
    let Some((aborted, log)) = ({
        VIDEO_PROCESSES.lock().unwrap().as_mut().and_then(|processes| processes.get_mut(endpoint))
            .map(|process| (process.child.try_wait().ok().flatten().is_some_and(|status| !status.success()), process.log.clone()))
    }) else { return false; };
    aborted || fatal_video_log(&startup_log_tail(&log))
}

pub(super) fn video_installation(endpoint: &str) -> Option<PathBuf> {
    let mut registry = VIDEO_PROCESSES.lock().unwrap();
    let process = registry.as_mut()?.get_mut(endpoint)?;
    if !matches!(process.child.try_wait(), Ok(None)) { return None; }
    Some(process.installation.clone())
}
pub(super) fn registered_installation(endpoint: &str) -> Option<PathBuf> {
    let registry = VIDEO_PROCESSES.lock().unwrap();
    Some(registry.as_ref()?.get(endpoint)?.installation.clone())
}

fn watch_video_exit(endpoint: String, pid: u32) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let (exit, log) = {
                let mut registry = VIDEO_PROCESSES.lock().unwrap();
                let Some(process) = registry.as_mut().and_then(|entries| entries.get_mut(&endpoint)).filter(|p| p.child.id() == pid) else { return; };
                match process.child.try_wait() {
                    Ok(None) => continue,
                    Ok(Some(exit)) => (exit, process.log.clone()),
                    Err(_) => return,
                }
            };
            use std::io::Write;
            if let Ok(mut file) = std::fs::OpenOptions::new().append(true).open(log) {
                let _ = writeln!(file, "\n[Bowerbird] ComfyUI process exited: {exit}");
            }
            return; // Keep the exit status and log until recovery or shutdown.
        }
    });
}

// Reap only a process launched by this application and conclusively aborted by Python.
fn reap_aborted_video(endpoint: &str) -> AppResult<bool> {
    let (pid, log, exited) = {
        let mut registry = VIDEO_PROCESSES.lock().unwrap();
        let Some(process) = registry.as_mut().and_then(|entries| entries.get_mut(endpoint)) else { return Ok(false); };
        (process.child.id(), process.log.clone(), process.child.try_wait()?.is_some())
    };
    if !exited && !fatal_video_log(&startup_log_tail(&log)) { return Ok(false); }
    let child = {
        let mut registry = VIDEO_PROCESSES.lock().unwrap();
        let Some(processes) = registry.as_mut() else { return Ok(false); };
        if !processes.get(endpoint).is_some_and(|process| process.child.id() == pid) { return Ok(false); }
        processes.remove(endpoint)
    };
    if let Some(mut process) = child {
        process.child.kill_and_wait()?;
    }
    Ok(true)
}
pub fn shutdown() {
    if let Some(job) = JOB.lock().unwrap().as_ref() { job.cancel.store(true, Ordering::Relaxed); }
    let processes = VIDEO_PROCESSES.lock().unwrap().take().unwrap_or_default();
    for (_, mut process) in processes {
        stop_process_tree(&mut process.child);
    }
}
async fn launch(app: &AppHandle, mut cmd: std::process::Command, endpoint: &str, installation: &Path, log_path: &Path, cancel: &AtomicBool, owner: &str, mode: Mode, default_port: u16) -> AppResult<()> {
    cancelled(cancel)?;
    let http = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(30)).build().map_err(|e| err(e.to_string()))?;
    let (log_path, log) = open_startup_log(log_path)?;
    let mut child = spawn_managed(&mut cmd, Some(&log))?;
    drop(log);
    let mut reason = String::new();
    let check_owner = || {
        if cancel.load(Ordering::Relaxed) || app.state::<AuthClient>().snapshot().user_id.as_deref() != Some(owner) {
            return Err(err("已取消本次启动"));
        }
        Ok(())
    };
    let readiness = async {
        let acknowledgement = format!("To see the GUI go to: {endpoint}");
        let mut bound = false;
        loop {
            check_owner()?;
            if child.try_wait()?.is_some() { return Err(startup_failure(&startup_log_tail(&log_path), &log_path)); }
            // ComfyUI logs the address only after it binds successfully. Until then a
            // successful HTTP response could belong to another process that won the port.
            bound |= startup_log_tail(&log_path).contains(&acknowledgement);
            if bound {
                match mode.check(&http, endpoint).await {
                    Ok(()) if child.try_wait()?.is_none() => return check_owner(),
                    Ok(()) => return Err(startup_failure(&startup_log_tail(&log_path), &log_path)),
                    Err(error) => reason = error.to_string(),
                }
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    };
    let result = tokio::select! {
        biased;
        _ = wait_cancel(cancel) => Some(Err(err("已取消本次启动"))),
        result = tokio::time::timeout(Duration::from_secs(120), readiness) => result.ok(),
    };
    let result = result.unwrap_or_else(|| Err(err(format!("启动检查超过 120 秒：{reason}。日志：{}", log_path.display()))));
    if let Err(error) = result {
        stop_process_tree(&mut child);
        return Err(error);
    }
    let pid = child.id();
    let previous = {
        let mut registry = VIDEO_PROCESSES.lock().unwrap();
        check_owner()?;
        registry.get_or_insert_with(Default::default)
            .insert(endpoint.into(), VideoProcess { child, log: log_path, installation: installation.to_path_buf(), default_port })
    };
    drop(previous);
    if let Some(port) = endpoint_port(endpoint) {
        if let Err(error) = assignment_file(app, default_port).and_then(|file| write_port_assignment(&file, installation, port)) {
            tracing::warn!(%error, "could not save the current ComfyUI port");
        }
    }
    watch_video_exit(endpoint.into(), pid);
    Ok(())
}
async fn start_existing(app: &AppHandle, instance: &Installation, cancel: &AtomicBool, owner: &str, mode: Mode, exact: Option<&str>) -> AppResult<String> {
    let python = instance.python.as_ref().ok_or_else(|| err("未找到此安装的 Python，请在 ComfyUI Desktop 中启动"))?;
    let default = mode.default_port(true);
    let endpoint = launch_endpoint(app, &instance.path, default, exact)?;
    let port = endpoint_port(&endpoint).expect("selected loopback port").to_string();
    let logs = app.path().app_local_data_dir().map_err(|e| err(e.to_string()))?.join("comfy-existing");
    tokio::fs::create_dir_all(&logs).await?;
    let mut cmd = command(python);
    cmd.current_dir(instance.main.parent().unwrap()).arg("-s").arg(&instance.main)
        .args(["--listen", "127.0.0.1", "--port", &port, "--disable-auto-launch"])
        .args(existing_launch_args(&instance.launch_args, mode))
        .args(comfy_memory_args(&instance.main, &instance.launch_args));
    if !instance.model_configs.is_empty() { cmd.arg("--extra-model-paths-config").args(&instance.model_configs); }
    launch(app, cmd, &endpoint, &instance.path, &logs.join(if mode.image() { "image-startup.log" } else { "startup.log" }), cancel, owner, mode, default).await?;
    Ok(endpoint)
}

fn comfy_memory_args(main: &Path, args: &[String]) -> Option<&'static str> {
    const DISABLE_PINNED_MEMORY: &str = "--disable-pinned-memory";
    if !cfg!(windows) || args.iter().any(|arg| arg == DISABLE_PINNED_MEMORY) { return None; }
    // An older installation can still be started without a flag it doesn't recognize.
    let cli = std::fs::read_to_string(main.parent()?.join("comfy/cli_args.py")).ok()?;
    cli.contains(DISABLE_PINNED_MEMORY).then_some(DISABLE_PINNED_MEMORY)
}

#[cfg(all(test, windows))]
#[test]
fn only_append_supported_comfy_memory_flag_once() {
    let root = tempfile::tempdir().unwrap();
    let main = root.path().join("main.py");
    assert_eq!(comfy_memory_args(&main, &[]), None);
    std::fs::create_dir(root.path().join("comfy")).unwrap();
    std::fs::write(root.path().join("comfy/cli_args.py"), "parser.add_argument('--disable-pinned-memory')").unwrap();
    assert_eq!(comfy_memory_args(&main, &[]), Some("--disable-pinned-memory"));
    assert_eq!(comfy_memory_args(&main, &["--disable-pinned-memory".into()]), None);
}

fn existing_launch_args(args: &[String], mode: Mode) -> Vec<&str> {
    args.iter().map(|arg| {
        // Sage Attention can abort the entire service during H3 video sampling.
        if !mode.image() && arg == "--use-sage-attention" { "--use-pytorch-cross-attention" } else { arg.as_str() }
    }).collect()
}

// Run may start an installed environment, but must never implicitly download a new one.
fn preparation_target(state: &Environment, action: &str) -> AppResult<Option<Installation>> {
    if action == "start_existing" || (action == "prepare" && state.phase == "stopped") {
        if state.phase != "stopped" { return Err(err("已有服务正在响应或检查未通过，请先核对服务状态，避免重复启动")); }
        let instance = state.existing.first().filter(|i| i.can_start).ok_or_else(|| err("未找到可直接启动的 Python 环境，请在环境设置中选择完整安装目录，或在 ComfyUI Desktop 中启动"))?;
        Ok(Some(instance.clone()))
    } else {
        if !state.can_install { return Err(err(&state.message)); }
        if action == "prepare" && !state.installed { return Err(err("尚未安装本机环境，请先点击卡片中的“一键下载并安装”，完成后再运行")); }
        Ok(None)
    }
}

fn recovering_managed(mode: Mode, endpoint: &str, installation: &Path) -> bool {
    endpoint == mode.endpoint() || endpoint != mode.existing_service().1 && runtime_installed(installation, mode)
}

fn same_recovery(job: &Job, endpoint: &str, installation: &Path) -> AppResult<()> {
    if job.recovery.as_ref().is_some_and(|(running, root)| running == endpoint && root == installation) {
        Ok(())
    } else {
        Err(err("另一套 ComfyUI 环境正在准备，请完成后再取回原任务"))
    }
}

#[tauri::command]
pub async fn comfy_video_environment(app: AppHandle, auth: State<'_, AuthClient>, entitlement: State<'_, EntitlementService>, action: String, endpoint: String, directory: Option<String>, existing_directory: Option<String>, mode: Option<Mode>) -> AppResult<Environment> {
    let owner = comfy_video::account(&auth, &entitlement).await?;
    let mode = mode.unwrap_or_default();
    if !matches!(action.as_str(), "detect" | "status" | "prepare" | "recover" | "install" | "cancel" | "select_existing" | "start_existing" | "driver") { return Err(err("不支持的环境操作")); }
    let recovering = action == "recover";
    let endpoint = comfy_video::endpoint(&endpoint)?;
    let requested = existing_directory.map(PathBuf::from);
    let original = if recovering {
        if mode.image() || !owned_video_port(&endpoint) { return Err(err("请在原 ComfyUI 中恢复此任务使用的服务，再继续取回。")); }
        Some(requested.as_ref().filter(|path| path.is_absolute()).cloned()
            .ok_or_else(|| err("未找到原任务的本机安装记录，请启动原 ComfyUI 后继续取回。"))?)
    } else { None };
    let previous = {
        let job = JOB.lock().unwrap();
        if let Some(job) = job.as_ref() {
            if active(&job.state) && (job.state.mode == mode || !matches!(action.as_str(), "detect" | "status")) {
                if job.owner != owner { return Err(err("另一个账号的环境安装正在进行")); }
                if job.state.mode != mode { return Err(err("另一个工作流的环境准备正在进行，请完成后重新检测")); }
                if let Some(original) = &original { same_recovery(job, &endpoint, original)?; }
                if action == "cancel" { job.cancel.store(true, Ordering::Relaxed); }
                return Ok(job.state.clone());
            }
            if action == "status" && job.owner == owner && job.state.mode == mode { return Ok(job.state.clone()); }
        }
        job.as_ref().filter(|job| job.owner == owner && job.state.mode == mode).map(|job| job.state.clone())
    };
    if let Some(original) = &original {
        let expected = registered_installation(&endpoint).is_some_and(|path| same_installation(&path, original));
        if expected && video_abort_detected(&endpoint) {
            let target = endpoint.clone();
            tokio::task::spawn_blocking(move || reap_aborted_video(&target)).await.map_err(|e| err(e.to_string()))??;
        }
        if !running_original_service(&endpoint, original) && video_port_occupied(&endpoint).await {
            return Err(err("原 ComfyUI 端口已有其他程序监听，请关闭占用程序并恢复原实例后取回任务"));
        }
    }
    let selection_file = config(&app, mode)?.with_file_name(if mode.image() { "comfy-image-existing-location.json" } else { "comfy-existing-location.json" });
    let saved: Option<PathBuf> = std::fs::read(&selection_file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let selected = requested.clone().or(saved);
    let config_dirs = comfy_discovery::desktop_config_dirs();
    let names = mode.names();
    let original_managed = original.as_ref().is_some_and(|path| recovering_managed(mode, &endpoint, path));
    let mut existing = if original_managed { Vec::new() } else { comfy_discovery::discover(&config_dirs, selected.as_deref(), names) };
    existing.sort_by_key(|item| item.models_found < names.len());
    if let Some(original) = original.as_ref().filter(|_| !original_managed) {
        existing.retain(|instance| same_installation(&instance.path, original));
    }
    if matches!(action.as_str(), "select_existing" | "start_existing") {
        let first = existing.first().ok_or_else(|| err("所选文件夹未找到 ComfyUI。请选择 Desktop 安装总目录、具体实例目录或便携版目录"))?;
        std::fs::create_dir_all(selection_file.parent().unwrap())?;
        let temp = selection_file.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&temp, serde_json::to_vec(&first.path)?)?;
        std::fs::rename(&temp, &selection_file)?;
    }
    // Older UI called this "更换位置". Never interpret an existing installation as a download destination.
    if let Some(directory) = directory.as_deref() {
        let located = comfy_discovery::discover(&config_dirs, Some(Path::new(directory)), &names);
        if !located.is_empty() {
            if action == "install" { return Err(err("所选位置是已有 ComfyUI，请使用“选择已有 ComfyUI”连接，避免重复安装")); }
            existing = located;
        }
    }
    let pinned = !mode.image() && selected.is_some() && (directory.is_none() || action == "prepare") && !original_managed;
    let root = if original_managed { original.clone().unwrap() } else { location(&app, directory, mode)? };
    if pinned && existing.is_empty() {
        let path = selected.as_deref().unwrap();
        let mut state = plan(&root, mode);
        state.phase = "unavailable".into();
        state.directory = path.to_string_lossy().into_owned();
        state.message = format!("无法访问已选择的 ComfyUI：{}。请连接原磁盘，或点击「选择已有 ComfyUI」重新定位。", path.display());
        return Ok(state);
    }
    let ports = LaunchPorts::new(&root, &existing, mode);
    let mut state = detect_scoped(&root, &endpoint, existing.clone(), mode, recovering, pinned, &ports).await?;
    if pinned && !recovering && state.phase == "ready" {
        let expected = if state.endpoint == ports.existing { existing.first().map(|instance| instance.path.as_path()) } else { None };
        if let (Some(process_path), Some(expected)) = (video_installation(&state.endpoint), expected) {
            if !same_installation(&process_path, expected) {
                state.phase = "unavailable".into();
                state.message = format!("视频端口正由另一套 ComfyUI 使用（{}）。请关闭该实例后重新检测，或重新选择这套环境。", process_path.display());
            }
        }
    }
    if recovering && state.phase == "ready" && !running_original_service(&endpoint, original.as_deref().unwrap()) {
        return Err(err("原 ComfyUI 端口已有其他程序监听，请恢复原实例后取回任务"));
    }
    if original_managed && state.phase == "missing" && installed_for_original_mode(&root, mode) {
        state.can_install = true;
        state.installed = true;
    }
    if !mode.image() && action == "prepare" && state.phase == "unavailable" {
        if auth.snapshot().user_id.as_deref() != Some(owner.as_str()) { return Err(err("账号已切换，请重新检测环境")); }
        let target = if existing.is_empty() { ports.managed.clone() } else { ports.existing.clone() };
        if state.endpoint == target
            && tokio::task::spawn_blocking(move || reap_aborted_video(&target)).await.map_err(|e| err(e.to_string()))?? {
            let ports = LaunchPorts::new(&root, &existing, mode);
            state = detect_scoped(&root, &endpoint, existing, mode, false, pinned, &ports).await?;
        }
    }
    if action == "driver" {
        if let Some(hardware) = state.hardware.as_ref().filter(|v| v.driver_required) {
            let download = driver::lookup(hardware).await;
            let login = auth.snapshot();
            if !login.logged_in || login.user_id.as_deref() != Some(owner.as_str()) { return Err(err("账号已切换，请重新检测环境")); }
            state.message = download.message.clone();
            state.driver_download = Some(download);
        }
        return Ok(state);
    }
    if !matches!(action.as_str(), "prepare" | "recover" | "install" | "start_existing") {
        retain_setup_outcome(&mut state, previous.as_ref());
        if !mode.image() && state.phase == "unavailable" && video_abort_detected(&state.endpoint) {
            state.phase = "recoverable".into();
            let log = VIDEO_PROCESSES.lock().unwrap().as_ref().and_then(|entries| entries.get(&state.endpoint)).map(|p| p.log.clone());
            if let Some(log) = log {
                state.message = video_exit_message(&startup_log_tail(&log)).into();
            }
        }
        return Ok(state);
    }
    if state.phase == "ready" { return Ok(state); }
    // Prerequisites may have changed since the UI check. Return the actual blocker to the UI
    // instead of converting it into an IPC error that invites another detection-only click.
    if action == "install" && !state.can_install && state.existing.is_empty() { return Ok(state); }
    let start = preparation_target(&state, if recovering { "prepare" } else { &action })?;
    if recovering && start.is_some() == original_managed {
        return Err(err("原任务使用的视频环境暂时不可启动，请核对已登记的 ComfyUI。"));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    if recovering { state.endpoint = endpoint.clone(); }
    state.phase = if start.is_some() || state.installed { "starting" } else { "installing" }.into();
    state.message = if state.phase == "starting" { "正在启动已有 ComfyUI 并检查模型…" } else { "正在准备本机环境…" }.into();
    {
        let mut job = JOB.lock().unwrap();
        if let Some(job) = job.as_ref().filter(|job| active(&job.state)) {
            if job.owner == owner && job.state.mode == mode {
                if let Some(original) = &original { same_recovery(job, &endpoint, original)?; }
                return Ok(job.state.clone());
            }
            if job.owner == owner { return Err(err("另一个工作流的环境准备正在进行，请完成后重新检测")); }
            return Err(err("另一个账号的环境准备正在进行"));
        }
        *job = Some(Job { owner: owner.clone(), state: state.clone(), cancel: cancel.clone(), resumed_bytes: 0,
            recovery: original.map(|path| (endpoint.clone(), path)) });
    }
    let allow_download = action == "install";
    tauri::async_runtime::spawn(async move {
        // Downloads may take hours. Stop promptly on logout/account switch, including mid-file.
        let watcher = tauri::async_runtime::spawn(watch_install_account(
            app.state::<AuthClient>().inner().clone(), owner.clone(), cancel.clone()));
        let exact = recovering.then_some(endpoint.as_str());
        let result = if let Some(instance) = &start { start_existing(&app, instance, &cancel, &owner, mode, exact).await }
            else { install(&app, &root, &cancel, &owner, mode, allow_download, exact).await };
        watcher.abort();
        let remaining = plan(&root, mode);
        if let Some(job) = JOB.lock().unwrap().as_mut() {
            job.state.download_bytes = remaining.download_bytes;
            job.state.required_bytes = remaining.required_bytes;
            job.state.installed = remaining.installed;
            match result {
                Ok(endpoint) => { job.state.phase = "ready".into(); job.state.endpoint = endpoint; job.state.message = "本机环境已就绪".into(); job.state.installed = start.is_none(); }
                Err(error) => {
                    job.state.phase = if cancel.load(Ordering::Relaxed) { "cancelled" } else { "failed" }.into();
                    job.state.message = match error {
                        AppError::Io(error) => format!("{}时无法读写所需文件：{error}。请检查安装目录权限、剩余磁盘空间及安全软件拦截后重试。", if start.is_some() { "启动已有环境" } else { "安装环境" }),
                        other => other.to_string(),
                    };
                }
            }
        }
    });
    Ok(state)
}

pub(crate) async fn prepare_image(app: &AppHandle, edit: bool) -> AppResult<String> {
    let mode = if edit { Mode::Edit } else { Mode::Image };
    let auth = app.state::<AuthClient>();
    let owner = auth.snapshot().user_id.ok_or_else(|| err("请登录后使用 H3 图片"))?;
    let check_owner = || {
        let login = auth.snapshot();
        if !login.logged_in || login.user_id.as_deref() != Some(owner.as_str()) {
            return Err(err("账号已切换，请重新检测环境"));
        }
        Ok(())
    };
    tokio::time::timeout(Duration::from_secs(150), async {
        let mut action = "prepare";
        loop {
            check_owner()?;
            let state = comfy_video_environment(app.clone(), app.state(), app.state(), action.into(), mode.endpoint().into(), None, None, Some(mode)).await?;
            check_owner()?;
            match state.phase.as_str() {
                "ready" => return Ok(state.endpoint),
                "installing" | "starting" => {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    action = "status";
                }
                _ => return Err(err(format!("{}。请在 MiniMax-H3-Image 旁打开环境设置", state.message))),
            }
        }
    }).await.map_err(|_| err("等待本机 H3 图片环境超时，请在环境设置中查看准备状态"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, routing::get, http::{HeaderMap, StatusCode}, response::IntoResponse};
    use sha2::{Digest, Sha256};
    #[tokio::test]
    async fn h3_setup_oversized_partial_restarts_without_a_range() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("tiny.part"), b"more than six").unwrap();
        let item = Download { file: "tiny.bin", size: 6, sha: "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721" };
        assert_eq!(downloaded_bytes(root.path(), &item), 0);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/", get(|headers: HeaderMap| async move {
                assert!(!headers.contains_key("range"));
                "abcdef"
            }))).await.unwrap();
        });
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        download(&http, &item, root.path(), &AtomicBool::new(false), 0,
            || std::future::ready(Ok(url.clone()))).await.unwrap();
        assert_eq!(std::fs::read(root.path().join(item.file)).unwrap(), b"abcdef");
        server.abort();
    }

    #[test]
    fn h3_setup_archive_progress_stays_at_download_completion_after_resume() {
        let root = tempfile::tempdir().unwrap();
        let mut job = Job { owner: String::new(), state: plan(root.path(), Mode::Frames),
            cancel: Arc::new(AtomicBool::new(false)), resumed_bytes: 7, recovery: None };
        job.state.download_bytes = 15;
        update_progress(&mut job, "正在下载最后一项".into(), 22);
        assert_eq!(job.state.completed_bytes, 15);
        job.resumed_bytes = 0;
        update_progress(&mut job, "正在解压".into(), 15);
        assert_eq!(job.state.completed_bytes, 15);
    }

    #[tokio::test]
    #[cfg(windows)]
    async fn h3_setup_extraction_failure_keeps_archive_and_includes_log() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        std::fs::write(root.join("bowerbird-setup.txt"), VERSION).unwrap();
        std::fs::create_dir(portable(root)).unwrap();
        std::fs::write(portable(root).join("stale.txt"), "incomplete").unwrap();
        std::fs::write(root.join("portable.7z"), "invalid archive").unwrap();
        let error = extract_portable(root, Mode::Frames, &AtomicBool::new(false), || Ok(())).await.unwrap_err().to_string();
        assert!(error.contains("extract.log") && error.contains("解压失败"), "{error}");
        assert!(!portable(root).join("stale.txt").exists());
        assert!(root.join("portable.7z").exists());
        assert!(!runtime_installed(root, Mode::Frames));
        assert!(!setup_log_report(&[("托管解压", root.join("extract.log"))]).is_empty());
    }

    #[tokio::test]
    #[cfg(windows)]
    async fn h3_setup_valid_archive_leaves_only_usable_runtime() {
        let root = tempfile::tempdir().unwrap();
        let fixtures = tempfile::tempdir().unwrap();
        let root = root.path();
        std::fs::write(root.join("bowerbird-setup.txt"), VERSION).unwrap();
        let fixture = portable(fixtures.path());
        std::fs::create_dir_all(fixture.join("python_embeded")).unwrap();
        std::fs::create_dir_all(fixture.join("ComfyUI")).unwrap();
        std::fs::write(fixture.join("python_embeded/python.exe"), "fixture").unwrap();
        std::fs::write(fixture.join("ComfyUI/main.py"), "fixture").unwrap();
        let archive = root.join("portable.7z");
        assert!(command("tar.exe").args(["--format=7zip", "-cf"]).arg(&archive)
            .arg("-C").arg(fixtures.path()).arg("ComfyUI_windows_portable").status().unwrap().success());
        std::fs::write(archive.with_extension("verified"), "fixture").unwrap();
        extract_portable(root, Mode::Frames, &AtomicBool::new(false), || Ok(())).await.unwrap();
        assert!(runtime_installed(root, Mode::Frames));
        assert!(!archive.exists());
        assert!(!archive.with_extension("verified").exists());
    }

    #[tokio::test]
    #[cfg(windows)]
    async fn h3_setup_cancels_spawned_tar_and_keeps_its_archive() {
        use std::sync::atomic::AtomicUsize;
        let root = tempfile::tempdir().unwrap();
        let fixtures = tempfile::tempdir().unwrap();
        let root = root.path();
        std::fs::write(root.join("bowerbird-setup.txt"), VERSION).unwrap();
        std::fs::write(fixtures.path().join("fixture.bin"), vec![17_u8; 4 * 1024 * 1024]).unwrap();
        let archive = root.join("portable.7z");
        assert!(command("tar.exe").args(["--format=7zip", "-cf"]).arg(&archive)
            .arg("-C").arg(fixtures.path()).arg("fixture.bin").status().unwrap().success());
        let checks = AtomicUsize::new(0);
        let cancel = AtomicBool::new(false);
        let result = extract_portable(root, Mode::Frames, &cancel, || {
            // First owner check after the actual managed tar child has been launched.
            if checks.fetch_add(1, Ordering::Relaxed) == 2 { cancel.store(true, Ordering::Relaxed); }
            cancelled(&cancel)
        }).await.unwrap_err();
        assert!(result.to_string().contains("已取消"));
        assert!(archive.exists());
        assert!(root.join("extract.log").is_file());
        assert!(!root.join("ready.txt").exists());
    }

    #[test]
    fn h3_setup_blocked_rotation_falls_back_to_diagnostic_log() {
        use std::io::Write;
        let root = tempfile::tempdir().unwrap();
        let startup = root.path().join("startup.log");
        std::fs::write(&startup, "old log").unwrap();
        for extension in ["prev.log", "prev.2.log", "prev.3.log"] {
            let blocker = startup.with_extension(extension);
            std::fs::create_dir(&blocker).unwrap();
            std::fs::write(blocker.join("marker"), "keep").unwrap();
        }
        let (path, mut file) = open_startup_log(&startup).unwrap();
        assert_ne!(path, startup);
        file.write_all(b"diagnostic fallback").unwrap();
        drop(file);
        let report = setup_log_report(&[("测试", startup)]);
        assert!(report.contains("old log") && report.contains("diagnostic fallback"), "{report}");
    }
    #[test]
    fn h3_setup_launch_ports_fall_back_but_recovery_keeps_the_original_port() {
        let mut visited = Vec::new();
        let port = select_launch_port(18188, None, None, |port| {
            visited.push(port);
            port != 18194
        }).unwrap();
        assert_eq!(port, 18194);
        assert_eq!(visited, [18188, 18192, 18193, 18194]);
        assert_eq!(select_launch_port(18188, Some(18194), None, |_| false).unwrap(), 18194);
        assert!(select_launch_port(18188, None, Some(18194), |port| port == 18194).is_err());
        assert_eq!(select_launch_port(18188, None, Some(18194), |_| false).unwrap(), 18194);
        assert!(select_launch_port(18188, None, None, |_| true).is_err());
    }

    #[test]
    fn h3_setup_remembered_port_is_scoped_to_the_installation_path() {
        let root = tempfile::tempdir().unwrap();
        let assignment = root.path().join("port.json");
        let initial = root.path().join("initial");
        let another = root.path().join("another");
        write_port_assignment(&assignment, &initial, 18194).unwrap();
        assert_eq!(remembered_port(&assignment, &initial), Some(18194));
        assert_eq!(remembered_port(&assignment, &another), None);
        write_port_assignment(&assignment, &initial, 8188).unwrap();
        assert_eq!(remembered_port(&assignment, &initial), None);
    }
    fn scratch() -> PathBuf {
        let root = std::env::temp_dir().join(format!("bowerbird-h3-setup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap(); root
    }
    #[test]
    fn h3_setup_detection_preserves_failure_until_retry_or_conditions_change() {
        let root = scratch();
        let mut previous = plan(&root, Mode::Frames);
        previous.phase = "failed".into(); previous.message = "下载授权失败，请重试".into();
        let mut detected = plan(&root, Mode::Frames); detected.can_install = true;
        retain_setup_outcome(&mut detected, Some(&previous));
        assert_eq!(detected.phase, "failed"); assert_eq!(detected.message, previous.message);
        assert!(preparation_target(&detected, "install").unwrap().is_none());
        detected = plan(&root, Mode::Frames); detected.message = "磁盘空间不足".into();
        retain_setup_outcome(&mut detected, Some(&previous));
        assert_eq!(detected.message, "磁盘空间不足"); assert_eq!(detected.phase, "missing");
        detected.phase = "ready".into(); retain_setup_outcome(&mut detected, Some(&previous));
        assert_eq!(detected.phase, "ready");
        detected = plan(&root.join("different"), Mode::Frames); detected.can_install = true;
        retain_setup_outcome(&mut detected, Some(&previous)); assert_eq!(detected.phase, "missing");
        detected = plan(&root, Mode::Frames); detected.can_install = true; previous.phase = "cancelled".into();
        retain_setup_outcome(&mut detected, Some(&previous)); assert_eq!(detected.phase, "cancelled");
    }
    #[test]
    fn h3_setup_preflight_reports_directory_conflicts_and_disk_shortfall() {
        let root = scratch();
        assert!(check_destination(&root.join("not-created")).is_ok());
        assert!(!root.join("not-created").exists(), "detection must not create files");
        assert!(check_destination(&root).is_ok());
        let user_file = root.join("keep.txt");
        std::fs::write(&user_file, "keep").unwrap();
        let reason = check_destination(&root).unwrap_err().to_string();
        assert!(reason.contains("已有其他文件") && reason.contains("安装位置"));
        assert!(check_destination(&user_file).unwrap_err().to_string().contains("被文件占用"));
        assert_eq!(std::fs::read_to_string(&user_file).unwrap(), "keep");
        std::fs::write(root.join("bowerbird-setup.txt"), VERSION).unwrap();
        assert!(check_destination(&root).is_ok(), "managed partial install can resume");
        let reason = check_disk_space(10_000_000_000, 56_900_000_000).unwrap_err().to_string();
        assert!(reason.contains("56.9 GB") && reason.contains("10.0 GB") && reason.contains("46.9 GB"));
        assert!(check_disk_space(56_900_000_000, 56_900_000_000).is_ok());
    }
    #[test]
    fn h3_setup_requires_fatal_evidence_before_reaping() {
        assert!(!fatal_video_log("Starting server\nCUDA out of memory. Trying again.\n"));
        assert!(fatal_video_log("Fatal Python error: Aborted\n"));
        assert!(fatal_video_log("Windows fatal exception: access violation\n"));
        assert!(video_exit_message("CUDA out of memory\nFatal Python error: Aborted").contains("显存不足"));
    }
    #[cfg(windows)]
    #[test]
    fn h3_setup_reaps_only_its_own_aborted_process() {
        let root = tempfile::tempdir().unwrap();
        let log = root.path().join("startup.log");
        let endpoint = "http://127.0.0.1:0";
        let child = spawn_managed(command("cmd.exe").args(["/D", "/C", "ping -n 30 127.0.0.1 >NUL"]), None).unwrap();
        VIDEO_PROCESSES.lock().unwrap().get_or_insert_with(Default::default)
            .insert(endpoint.into(), VideoProcess { child, log: log.clone(), installation: root.path().into(), default_port: 18188 });
        std::fs::write(&log, "CUDA out of memory; retrying").unwrap();
        assert!(!reap_aborted_video(endpoint).unwrap());
        assert!(video_installation(endpoint).is_some());
        std::fs::write(&log, "Fatal Python error: Aborted\n").unwrap();
        assert!(reap_aborted_video(endpoint).unwrap());
        assert!(video_installation(endpoint).is_none());
    }
    #[tokio::test]
    async fn h3_setup_distinguishes_foreign_listener_from_absent_service() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let base = format!("http://{address}");
        let server = tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/system_stats", get(|| async {
                axum::Json(serde_json::json!({"system":{"version":"1.0"}}))
            }))).await.unwrap();
        });
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        assert!(probe(&http, &base, Mode::Frames).await.is_none());
        assert!(video_port_occupied(&base).await);
        assert!(!reap_aborted_video(&base).unwrap());
        server.abort();
        let _ = server.await;
        assert!(!video_port_occupied(&base).await);
    }
    #[tokio::test]
    #[cfg(windows)]
    async fn h3_setup_does_not_probe_listener_that_replaced_an_exited_owned_process() {
        use std::sync::atomic::AtomicUsize;
        let root = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let probes = Arc::new(AtomicUsize::new(0));
        let counted = probes.clone();
        let server = tokio::spawn(async move {
            let app = Router::new().route("/system_stats", get(move || {
                counted.fetch_add(1, Ordering::Relaxed);
                async { axum::Json(serde_json::json!({"system":{"comfyui_version":"0.42.1"}})) }
            }));
            axum::serve(listener, app).await.unwrap();
        });
        let mut child = spawn_managed(command("cmd.exe").args(["/D", "/C", "exit", "0"]), None).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while child.try_wait().unwrap().is_none() { tokio::time::sleep(Duration::from_millis(20)).await; }
        }).await.unwrap();
        {
            VIDEO_PROCESSES.lock().unwrap().get_or_insert_with(Default::default).insert(base.clone(), VideoProcess {
                child, log: root.path().join("startup.log"), installation: root.path().into(), default_port: 18189,
            });
        }
        let instance = Installation { path: root.path().into(), endpoint: base.clone(), name: "原实例".into(),
            can_start: true, models_found: 5, python: None, main: root.path().join("main.py"), model_configs: vec![], launch_args: vec![] };
        let ports = LaunchPorts { managed: Mode::Frames.endpoint().into(), existing: base.clone() };
        let result = detect_scoped(root.path(), &base, vec![instance], Mode::Frames, false, true, &ports).await;
        let removed = VIDEO_PROCESSES.lock().unwrap().as_mut().unwrap().remove(&base);
        drop(removed);
        server.abort();
        assert_eq!(result.unwrap().phase, "stopped");
        assert_eq!(probes.load(Ordering::Relaxed), 0);
    }
    #[test]
    fn h3_setup_startup_failure_reports_actual_error_from_bounded_log_tail() {
        let log = "Traceback (most recent call last):\n  comfy_aimdo.control.init(simple_vram_headroom=simple_vram_headroom, nvml_pressure=True)\nTypeError: init() got an unexpected keyword argument 'nvml_pressure'\n";
        let root = scratch(); let path = root.join("startup.log");
        std::fs::write(&path, format!("{}{}", "x".repeat(70000), log)).unwrap();
        let tail = startup_log_tail(&path);
        assert_eq!(tail.len(), 65536);
        assert!(tail.ends_with(log));
        let message = startup_failure(&tail, &path).to_string();
        assert!(message.contains("TypeError: init() got an unexpected keyword argument 'nvml_pressure'"));
        assert!(message.contains("startup.log"));
    }
    #[test]
    fn h3_setup_run_prepares_installed_environment_without_implicit_download() {
        let mut state = plan(&scratch(), Mode::Frames); state.can_install = true;
        assert!(preparation_target(&state, "prepare").is_err(), "run must not download a missing environment");
        assert!(preparation_target(&state, "install").unwrap().is_none(), "explicit install remains available");
        state.installed = true;
        assert!(preparation_target(&state, "prepare").unwrap().is_none(), "reuse managed installation");
        state.installed = false; state.can_install = false; state.phase = "stopped".into();
        state.existing.push(Installation { path: "existing".into(), name: "Desktop".into(), endpoint: "http://127.0.0.1:8199".into(), can_start: true, models_found: 5,
            python: Some("existing/python.exe".into()), main: "existing/main.py".into(), model_configs: vec!["shared-models.yaml".into()], launch_args: vec!["--use-sage-attention".into()] });
        let instance = preparation_target(&state, "prepare").unwrap().unwrap();
        assert_eq!(instance.path, PathBuf::from("existing"));
        assert_eq!(instance.model_configs, vec![PathBuf::from("shared-models.yaml")]);
        assert_eq!(instance.launch_args, vec!["--use-sage-attention"]);
        assert_eq!(existing_launch_args(&instance.launch_args, Mode::Frames), ["--use-pytorch-cross-attention"]);
        assert_eq!(existing_launch_args(&instance.launch_args, Mode::Image), ["--use-sage-attention"]);
        state.phase = "unavailable".into();
        assert!(preparation_target(&state, "prepare").is_err(), "never duplicate a responding but incompatible service");
        state.phase = "stopped".into(); state.existing[0].can_start = false;
        assert!(preparation_target(&state, "prepare").is_err(), "missing Python requires a usable installation");
    }
    #[test]
    fn h3_setup_manifest_and_empty_plan() {
        let root = scratch(); let state = plan(&root, Mode::Frames);
        assert!(!state.installed); assert!(!root.join("ready.txt").exists());
        assert_eq!(state.download_bytes, 65_018_858_889);
        for item in downloads(Mode::Frames) {
            assert_eq!(item.sha.len(), 64);
            assert!(item.sha.chars().all(|c| c.is_ascii_hexdigit()));
            let cloud: serde_json::Value = serde_json::from_str(include_str!("../../../../cloud/supabase/functions/_shared/comfy-download-manifest.json")).unwrap();
            assert_eq!(cloud["version"], VERSION);
            assert_eq!(cloud["files"].as_array().unwrap().len(), downloads(Mode::Frames).len());
            let remote = cloud["files"].as_array().unwrap().iter().find(|f| f["file"] == item.file).unwrap();
            assert_eq!(remote["size"], item.size); assert_eq!(remote["sha256"], item.sha);
            assert!(!Path::new(item.file).is_absolute());
        }
        assert!(DOWNLOADS[5].file.contains("768p"));
        assert_eq!(DOWNLOADS[5].sha, "08cfe946033af7d27719b964b6e0a0e50c32138daabbd6ce4137e23df6bf9980");
    }
    #[test]
    fn h3_setup_reference_model_has_verified_download() {
        let item = DOWNLOADS.iter().find(|item| item.file.contains("ref2va")).expect("reference mode must prepare its own model");
        assert_eq!(item.size, 20_970_379_616);
        assert_eq!(item.sha, "9255f52b6677845ad238f20dfaafa94727053694127ab7f255c048f0f9365779");
        assert!(tos_available(item));
        assert!(modelscope_url(item).unwrap().contains("/d51b9ec4bf7d7af1ce11bcbbd1a809aadb38011e/"));
    }
    #[test]
    fn h3_setup_video_modes_share_the_full_install_plan_and_isolate_failures() {
        let root = scratch();
        let frames = plan(&root, Mode::Frames);
        let text = plan(&root, Mode::Text);
        let mut reference = plan(&root, Mode::Reference);
        assert_eq!(frames.download_bytes, 65_018_858_889);
        assert_eq!(frames.download_bytes, text.download_bytes);
        assert_eq!(reference.download_bytes, 65_018_858_889);
        assert_eq!(reference.models_required, 4);
        assert_eq!(text.models_required, 5);
        for mode in [Mode::Frames, Mode::Text, Mode::Reference, Mode::R2v] {
            let items = downloads(mode);
            assert_eq!(items.len(), DOWNLOADS.len());
            assert!(items.iter().any(|item| item.file.contains("ref2va")));
        }
        let mut previous = frames;
        previous.phase = "failed".into(); previous.message = "首尾帧环境准备失败".into();
        reference.can_install = true;
        retain_setup_outcome(&mut reference, Some(&previous));
        assert_eq!(reference.phase, "missing", "another mode's failure must not replace this mode's status");
        let output = serde_json::to_value(reference).unwrap();
        assert_eq!(output["mode"], "reference"); assert_eq!(output["modelsRequired"], 4);
    }
    #[test]
    fn h3_image_install_plans_use_the_validated_direct_prompt_models() {
        let root = scratch();
        let text = plan(&root, Mode::Image);
        let edit = plan(&root, Mode::Edit);
        assert_eq!(text.models_required, 3);
        assert_eq!(text.download_bytes, 51_360_641_689);
        assert_eq!(edit.models_required, 3);
        assert_eq!(edit.download_bytes, text.download_bytes);
        assert_ne!(Mode::Image.endpoint(), Mode::Frames.endpoint());
        assert_ne!(Mode::Image.version(), Mode::Frames.version());
        assert!(downloads(Mode::Edit).iter().skip(1).all(|d|modelscope_url(d).unwrap().contains("MiniMax-H3-Image/resolve/")));
    }
    #[test]
    fn h3_setup_existing_runtime_does_not_need_portable_redownload_for_new_mode() {
        let root = scratch();
        for file in ["ready.txt", "models.yaml", "ComfyUI_windows_portable/python_embeded/python.exe", "ComfyUI_windows_portable/ComfyUI/main.py"] {
            let path = root.join(file); std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, if file == "ready.txt" { VERSION } else { "fixture" }).unwrap();
        }
        assert!(runtime_installed(&root, Mode::Frames));
        assert!(!root.join("portable.7z").exists());
        assert_eq!(plan(&root, Mode::Reference).download_bytes, 65_018_858_889 - DOWNLOADS[0].size);
        assert_eq!(DOWNLOADS.iter().map(|d| d.size).sum::<u64>() - DOWNLOADS[..6].iter().map(|d| d.size).sum::<u64>(), 20_970_379_616);
    }
    #[tokio::test]
    async fn h3_setup_slow_server_is_detected_and_model_failure_is_not_missing_install() {
        let server = Router::new()
            .route("/system_stats", get(|| async {
                tokio::time::sleep(Duration::from_millis(4200)).await;
                axum::Json(serde_json::json!({"system":{"comfyui_version":"0.42.1"}}))
            }))
            .route("/object_info", get(|| async { axum::Json(serde_json::json!({})) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
        let http = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(10)).build().unwrap();
        let result = probe(&http, &format!("http://{address}"), Mode::Frames).await;
        let result = result.expect("slow live server is recognized even if H3 nodes are unavailable");
        assert!(result.identified);
        assert!(result.result.unwrap_err().to_string().contains("H3"));
        task.abort();
    }
    #[tokio::test]
    #[ignore = "Read-only local installation and HTTP checks; no startup, installation or generation"]
    async fn h3_setup_local_environment_read_only() {
        let existing = comfy_discovery::discover(&comfy_discovery::desktop_config_dirs(), None, &comfy_video::model_names());
        assert!(!existing.is_empty());
        let state = detect(&scratch(), "http://127.0.0.1:8000", existing, Mode::Frames).await.unwrap();
        println!("local environment: {} | {} | {} installation(s)", state.phase, state.message, state.existing.len());
        assert_ne!(state.phase, "missing"); assert!(!state.can_install);
    }
    #[test]
    fn h3_legacy_receipt_only_migrates_unchanged_models() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("test.bin");
        std::fs::write(&path, b"abc").unwrap();
        let item = Download { file: "test.bin", size: 3, sha: "fixture" };
        migrate_frame_receipt(&path, &item, std::time::UNIX_EPOCH);
        let cache = path.with_extension("verified");
        assert!(!cache.exists());
        migrate_frame_receipt(&path, &item, std::time::SystemTime::now());
        assert_eq!(std::fs::read_to_string(&cache).unwrap(), verification_stamp(&path, item.sha).unwrap());
        std::fs::write(&cache, "outdated").unwrap();
        migrate_frame_receipt(&path, &item, std::time::SystemTime::now());
        assert_eq!(std::fs::read_to_string(cache).unwrap(), "outdated");
    }

    #[tokio::test]
    async fn h3_setup_keeps_retrying_while_ranged_download_advances() {
        let server = Router::new().route("/file", get(|headers: HeaderMap| async move {
            let offset = headers.get("range").and_then(|value| value.to_str().ok())
                .map(|value| value.trim_start_matches("bytes=").trim_end_matches('-').parse::<usize>().unwrap()).unwrap_or(0);
            let byte = &"abcdef"[offset..offset + 1];
            if offset == 0 { return byte.into_response(); }
            (StatusCode::PARTIAL_CONTENT, [("content-range", format!("bytes {offset}-5/6"))], byte).into_response()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap(); });
        let root = tempfile::tempdir().unwrap();
        let item = Download { file: "model.bin", size: 6, sha: "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721" };
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let result = download(&http, &item, root.path(), &AtomicBool::new(false), 0, || {
            std::future::ready(Ok(format!("http://{address}/file")))
        }).await;
        task.abort();
        result.unwrap();
        assert_eq!(std::fs::read(root.path().join(item.file)).unwrap(), b"abcdef");
    }
    #[tokio::test]
    async fn h3_setup_download_resume_hash_and_cancel() {
        let server = Router::new()
            .route("/resume", get(|headers: HeaderMap| async move {
                assert_eq!(headers.get("range").unwrap(), "bytes=3-");
                (StatusCode::PARTIAL_CONTENT, [("content-range", "bytes 3-5/6")], "def").into_response()
            }))
            .route("/whole", get(|| async { "abcdef" }))
            .route("/corrupt", get(|| async { "broken" }))
            .route("/wrong-range", get(|| async { (StatusCode::PARTIAL_CONTENT, [("content-range", "bytes 0-5/6")], "abcdef") }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
        let sha = format!("{:x}", Sha256::digest(b"abcdef"));
        let item = Download { file:"model.bin", size:6, sha:Box::leak(sha.clone().into_boxed_str()) };
        let url = |route: &str| { let url = format!("http://{address}/{route}"); move || std::future::ready(Ok(url.clone())) };
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let cancel = AtomicBool::new(false);
        for route in ["resume", "whole"] {
            let root = scratch(); std::fs::write(root.join("model.part"), b"abc").unwrap();
            download(&http, &item, &root, &cancel, 0, url(route)).await.unwrap();
            assert_eq!(std::fs::read(root.join("model.bin")).unwrap(), b"abcdef");
            // A complete verified file must be reused, without another HTTP request.
            download(&http, &item, &root, &cancel, 0, url("not-found")).await.unwrap();
        }
        let root = scratch(); std::fs::write(root.join("model.part"), b"abc").unwrap();
        assert!(download(&http, &item, &root, &cancel, 0, url("wrong-range")).await.is_err());
        assert_eq!(std::fs::read(root.join("model.part")).unwrap(), b"abc");
        let root = scratch();
        assert!(download(&http, &item, &root, &cancel, 0, url("corrupt")).await.is_err());
        assert!(!root.join("model.bin").exists()); assert!(!root.join("model.part").exists());
        cancel.store(true, Ordering::Relaxed);
        assert!(download(&http, &item, &root, &cancel, 0, url("whole")).await.is_err());
        assert!(!root.join("model.part").exists());
        task.abort();
    }
    #[test]
    fn h3_setup_grant_is_bound_to_exact_tos_object_and_pinned_hash() {
        let item = &DOWNLOADS[0];
        let make = |url: String| DownloadGrant { url, file:item.file.into(), size:item.size, sha256:item.sha.into() };
        let good = format!("https://bowerbird.tos-cn-guangzhou.volces.com/comfyui/{VERSION}/portable.7z?X-Tos-Signature=test");
        assert!(validate_grant(make(good.clone()), item).is_ok());
        for bad in [good.replace("https:", "http:"), good.replace("bowerbird.tos-cn-guangzhou.volces.com", "evil.example"), good.replace("portable.7z", "other.7z"), format!("{good}#fragment")] {
            assert!(validate_grant(make(bad), item).is_err());
        }
        let mut wrong = make(good); wrong.sha256 = "0".repeat(64);
        assert!(validate_grant(wrong, item).is_err());
    }
    #[test]
    fn h3_setup_modelscope_sources_and_redirects_are_pinned() {
        assert!(modelscope_url(&DOWNLOADS[0]).is_none());
        for item in &DOWNLOADS[1..] {
            let url = reqwest::Url::parse(&modelscope_url(item).unwrap()).unwrap();
            assert_eq!(url.host_str(), Some("modelscope.cn"));
            assert!(url.path().ends_with(item.file.rsplit('/').next().unwrap()));
            let revision = url.path().split("/resolve/").nth(1).unwrap().split('/').next().unwrap();
            assert_eq!(revision.len(), 40); assert!(revision.chars().all(|c| c.is_ascii_hexdigit()));
            assert!(modelscope_redirect_allowed(&url));
        }
        assert!(modelscope_redirect_allowed(&reqwest::Url::parse("https://cdn-lfs-cn-1.modelscope.cn/file?signature=test").unwrap()));
        for bad in ["http://modelscope.cn/file", "https://modelscope.cn.evil.example/file", "https://evilmodelscope.cn/file", "https://127.0.0.1/file", "https://modelscope.cn:8443/file", "https://user:pass@modelscope.cn/file"] {
            assert!(!modelscope_redirect_allowed(&reqwest::Url::parse(bad).unwrap()));
        }
    }
    #[tokio::test]
    #[ignore = "Read-only ModelScope check: downloads 1 KiB per model, no installation or generation"]
    async fn h3_setup_modelscope_pinned_downloads_read_only() {
        let http = modelscope_client().unwrap();
        for item in &DOWNLOADS[1..] {
            let url = modelscope_url(item).unwrap();
            let mut response = http.get(url).header(reqwest::header::RANGE, "bytes=0-1023").send().await.unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::PARTIAL_CONTENT, "{}", item.file);
            assert_eq!(response.headers().get(reqwest::header::CONTENT_RANGE).unwrap().to_str().unwrap(), format!("bytes 0-1023/{}", item.size));
            assert!(modelscope_redirect_allowed(response.url()));
            let mut bytes = 0;
            while let Some(chunk) = response.chunk().await.unwrap() { bytes += chunk.len(); assert!(bytes <= 1024); }
            assert_eq!(bytes, 1024);
        }
    }
    #[tokio::test]
    async fn h3_setup_modelscope_preferred_fallback_resume_hash_and_cancel() {
        let server = Router::new()
            .route("/mirror", get(|headers: HeaderMap| async move {
                assert!(headers.get("authorization").is_none()); "abcdef"
            }))
            .route("/corrupt", get(|| async { "broken" }))
            .route("/partial", get(|headers: HeaderMap| async move {
                if headers.get("range").is_some() { StatusCode::NOT_FOUND.into_response() }
                else { "abc".into_response() }
            }))
            .route("/tos", get(|headers: HeaderMap| async move {
                assert!(headers.get("authorization").is_none());
                if let Some(range) = headers.get("range") {
                    assert_eq!(range, "bytes=3-");
                    (StatusCode::PARTIAL_CONTENT, [("content-range", "bytes 3-5/6")], "def").into_response()
                } else { "abcdef".into_response() }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let item = Download { file:"model.bin", size:6, sha:"bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721" };
        for route in ["mirror", "missing", "partial", "corrupt"] {
            let root = scratch(); let cancel = AtomicBool::new(false); let mut grants = 0;
            let mirror = format!("http://{address}/{route}");
            download_resource(&http, Some((&http, &mirror)), &item, &root, &cancel, 0, || {
                grants += 1; std::future::ready(Ok(format!("http://{address}/tos")))
            }).await.unwrap();
            assert_eq!(grants, if route == "mirror" { 0 } else { 1 });
            assert_eq!(std::fs::read(root.join(item.file)).unwrap(), b"abcdef");
            download_resource(&http, Some((&http, &mirror)), &item, &root, &cancel, 0, || {
                panic!("verified file must not request TOS authorization");
                #[allow(unreachable_code)] std::future::ready(Err(err("unexpected grant")))
            }).await.unwrap();
        }
        let root = scratch(); let cancel = AtomicBool::new(true); let mut grants = 0;
        let mirror = format!("http://{address}/missing");
        assert!(download_resource(&http, Some((&http, &mirror)), &item, &root, &cancel, 0, || {
            grants += 1; std::future::ready(Ok(format!("http://{address}/tos")))
        }).await.is_err());
        assert_eq!(grants, 0); assert!(!root.join("model.part").exists());
        // Portable has no mirror, and TOS authorization errors must not be bypassed.
        let cancel = AtomicBool::new(false);
        let error = download_resource(&http, None, &item, &root, &cancel, 0, || {
            std::future::ready(Err(err("download denied")))
        }).await.unwrap_err();
        assert!(error.to_string().contains("download denied"));
        task.abort();
    }
    #[tokio::test]
    async fn h3_setup_refreshes_expired_grants_and_resumes_partial_streams() {
        let server = Router::new()
            .route("/expired", get(|| async { StatusCode::FORBIDDEN }))
            .route("/partial", get(|| async { "abc" }))
            .route("/resume", get(|headers: HeaderMap| async move {
                assert!(headers.get("authorization").is_none());
                assert_eq!(headers.get("range").unwrap(), "bytes=3-");
                (StatusCode::PARTIAL_CONTENT, [("content-range", "bytes 3-5/6")], "def")
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let item = Download { file:"model.bin", size:6, sha:"bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721" };
        for first in ["expired", "partial"] {
            let root = scratch(); let cancel = AtomicBool::new(false); let mut grants = 0;
            if first == "expired" { std::fs::write(root.join("model.part"), b"abc").unwrap(); }
            download(&http, &item, &root, &cancel, 0, || {
                grants += 1;
                std::future::ready(Ok(format!("http://{address}/{}", if grants == 1 { first } else { "resume" })))
            }).await.unwrap();
            assert_eq!(grants, 2); assert_eq!(std::fs::read(root.join("model.bin")).unwrap(), b"abcdef");
            write_licenses(&root).await.unwrap();
            assert!(std::fs::read_to_string(root.join("licenses/NOTICE.txt")).unwrap().contains("MiniMax H3 Community License"));
        }
        task.abort();
    }
    #[test]
    #[cfg(windows)]
    fn h3_setup_kills_the_owned_windows_process_tree() {
        use windows::Win32::{Foundation::CloseHandle, System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        }};
        let root = tempfile::tempdir().unwrap();
        let pid_path = root.path().join("descendant.pid");
        let parent = spawn_managed(command("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command",
            "$leaf = Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 12' -WindowStyle Hidden -PassThru; Set-Content -LiteralPath $env:BOWERBIRD_SETUP_TEST_PID $leaf.Id; Wait-Process -Id $leaf.Id",
        ]).env("BOWERBIRD_SETUP_TEST_PID", &pid_path), None).unwrap();
        let mut parent = parent;
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        let leaf_pid = loop {
            if let Some(pid) = std::fs::read_to_string(&pid_path).ok().and_then(|pid| pid.trim().parse::<u32>().ok()) { break Some(pid); }
            if std::time::Instant::now() >= deadline || parent.try_wait().unwrap().is_some() { break None; }
            std::thread::sleep(Duration::from_millis(50));
        };
        let leaf = leaf_pid.and_then(|pid| unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid).ok() });
        let leaf = leaf.expect("test child must be alive before tree cleanup");
        drop(parent);
        let exit = unsafe {
            let result = WaitForSingleObject(leaf, 2000);
            let _ = CloseHandle(leaf);
            result
        };
        assert_eq!(exit.0, 0, "descendant remained alive");
    }
    #[test]
    fn h3_setup_diagnostics_include_managed_and_existing_image_logs() {
        let root = tempfile::tempdir().unwrap();
        let managed = root.path().join("startup.log");
        let existing = root.path().join("image-startup.log");
        std::fs::write(&managed, "managed image failure").unwrap();
        std::fs::write(&existing, "existing image failure").unwrap();
        std::fs::write(existing.with_extension("prev.log"), "previous image failure").unwrap();
        let report = setup_log_report(&[("图片 · 托管安装", managed), ("图片 · 已有安装", existing)]);
        assert!(report.contains("图片 · 托管安装 · startup.log\nmanaged image failure"));
        assert!(report.contains("图片 · 已有安装 · image-startup.log\nexisting image failure"));
        assert!(report.contains("image-startup.prev.log\nprevious image failure"));
    }
    #[test]
    #[cfg(windows)]
    fn h3_setup_windows_7zip_extraction() {
        let root = scratch(); let input = root.join("input"); let output = root.join("output");
        std::fs::create_dir_all(&input).unwrap(); std::fs::create_dir_all(&output).unwrap();
        std::fs::write(input.join("main.py"), "# synthetic fixture only").unwrap();
        assert!(command("tar.exe").current_dir(&input).args(["--format=7zip", "-cf"]).arg(root.join("fixture.7z")).arg("main.py").status().unwrap().success());
        assert!(command("tar.exe").arg("-xf").arg(root.join("fixture.7z")).arg("-C").arg(&output).status().unwrap().success());
        assert_eq!(std::fs::read(output.join("main.py")).unwrap(), b"# synthetic fixture only");
    }
}
