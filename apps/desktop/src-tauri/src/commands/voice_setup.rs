//! App-owned Python and VoxCPM installation. Never changes PATH or a user's Python.
use std::{path::{Path, PathBuf}, process::{Command, ExitStatus}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant, SystemTime}};
use serde::{Serialize, Deserialize};
use tauri::{AppHandle, Manager, State};
use crate::{cloud::{AuthClient, EntitlementService}, core::paths::LibraryPaths, error::{AppError, AppResult}};
use super::{
    comfy_driver,
    install_download::{transfer, wait_cancel, TransferProgress},
    local_install::{command, free_bytes, hash, log_tail, remember_verified, spawn_managed, verification_stamp, verified, watch_install_account, ManagedChild},
};
use super::voice::{self, Config};

const VERSION: &str = "voxcpm2-2026-11-10";
const VERIFIED_FOR: Duration = Duration::from_secs(300);
const PYPI: &str = "https://pypi.org/simple";
const PYPI_MIRROR: &str = "https://mirrors.cloud.tencent.com/pypi/simple/";
// Includes space for the expanded environment and uv cache. Missing wheel
// archives are counted separately because they coexist with the installed files.
const INSTALL_RESERVE: u64 = 12_000_000_000;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum InstallStep { Resources, Python, Pytorch, Voxcpm, CudaCheck }
impl InstallStep {
    fn start_percent(self) -> u8 {
        match self {
            Self::Resources => 0,
            Self::Python => 57,
            Self::Pytorch => 62,
            Self::Voxcpm => 91,
            Self::CudaCheck => 97,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Environment {
    pub phase: String, pub message: String, pub directory: String, pub gpu: String,
    pub free_bytes: u64, pub required_bytes: u64, pub completed_bytes: u64, pub total_bytes: u64, pub can_install: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    install_step: Option<InstallStep>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    progress_percent: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active_seconds: Option<u64>,
}
#[derive(Deserialize)]
struct Download { file: String, url: String, mirror_url: Option<String>, size: u64, sha256: String }
impl Download {
    fn cuda_wheel(&self) -> bool { self.file.starts_with("cuda-wheels/") }
}
struct Install { state: Environment, cancel: Arc<AtomicBool>, owner: Option<String> }
static INSTALL: Mutex<Option<Install>> = Mutex::new(None);
type FileStamps = Vec<(PathBuf, u64, SystemTime)>;
struct Verification {
    files: FileStamps,
    at: Instant,
}
static VERIFICATION: tokio::sync::Mutex<Option<Verification>> = tokio::sync::Mutex::const_new(None);
fn err(text: impl Into<String>) -> AppError { AppError::Other(text.into()) }
fn files() -> Vec<Download> { serde_json::from_str(include_str!("voice-downloads.json").trim_start_matches('\u{feff}')).expect("bundled voice manifest") }
fn update_install(update: impl FnOnce(&mut Environment)) {
    if let Some(job) = INSTALL.lock().unwrap().as_mut()
        .filter(|job| job.state.phase == "installing" && !job.cancel.load(Ordering::Relaxed)) {
        update(&mut job.state);
    }
}
fn set_install_step(state: &mut Environment, step: InstallStep, message: &str) {
    state.install_step = Some(step);
    state.message = message.into();
    state.progress_percent = Some(step.start_percent());
    state.active_seconds = None;
}
fn install_step(step: InstallStep, message: &str) {
    update_install(|state| set_install_step(state, step, message));
}
fn transfer_percent(step: InstallStep, end: u8, bytes: u64, total: u64) -> u8 {
    let start = step.start_percent();
    start + ((end - start) as u64 * bytes.min(total) / total.max(1)) as u8
}
fn check_cancel(cancel: &AtomicBool) -> AppResult<()> { if cancel.load(Ordering::Relaxed) { Err(err("准备已暂停，已下载的文件保留，稍后可继续")) } else { Ok(()) } }
pub fn shutdown() {
    if let Some(job) = INSTALL.lock().unwrap().as_ref() {
        job.cancel.store(true, Ordering::Relaxed);
    }
}
fn active_state(job: &Install, owner: Option<&str>) -> Environment {
    let mut state = job.state.clone();
    if job.owner.as_deref() != owner {
        state.message = "另一个账号的配音环境准备正在停止，请稍后重新检测".into();
        state.install_step = None;
        state.progress_percent = None;
        state.active_seconds = None;
    }
    state
}
async fn verify(config: &Config, cancel: &AtomicBool) -> AppResult<()> {
    voice::validate_config(config)?;
    check_cancel(cancel)?;
    let mut probe = command(&config.python);
    probe.args(["-c", "import torch; from voxcpm import VoxCPM; import soundfile; assert torch.cuda.is_available(), 'CUDA unavailable'; assert torch.ones(1,device='cuda').sum().item()==1; assert hasattr(VoxCPM, 'generate')"])
        .env("HF_HUB_OFFLINE", "1").env("PYTHONUTF8", "1");
    let log = tempfile::NamedTempFile::new()?;
    let child = spawn_managed(&mut probe, Some(log.as_file()))?;
    let status = tokio::time::timeout(Duration::from_secs(45), wait_child(child, cancel, |_| {}))
        .await.map_err(|_| err("配音运行环境检查超时，请稍后继续准备"))??;
    if status.success() { return Ok(()); }
    let detail = log_tail(log.path(), 16 * 1024, 0).to_ascii_lowercase();
    if ["cuda unavailable", "nvidia driver", "cuda driver", "cuda initialization", "cuda error"].iter().any(|reason| detail.contains(reason)) {
        return Err(err("配音环境无法使用 NVIDIA CUDA，请更新显卡驱动后继续准备"));
    }
    Err(err("配音运行组件校验未通过，请继续准备以修复配音运行环境"))
}
fn verification_files(config: &Config) -> Option<FileStamps> {
    let model = Path::new(&config.model);
    [PathBuf::from(&config.python), model.join("config.json"), model.join("model.safetensors"), model.join("audiovae.pth")]
        .into_iter().map(|path| {
            let meta = std::fs::metadata(&path).ok().filter(|meta| meta.is_file())?;
            Some((path, meta.len(), meta.modified().ok()?))
        }).collect()
}
async fn verify_with_cache(
    cache: &mut Option<Verification>, config: &Config, refresh: bool,
    run: impl std::future::Future<Output = AppResult<()>> + Send,
) -> AppResult<()> {
    let files = verification_files(config);
    if !refresh && cache.as_ref().is_some_and(|cached| {
        cached.at.elapsed() < VERIFIED_FOR && files.as_ref() == Some(&cached.files)
    }) { return Ok(()); }
    *cache = None;
    run.await?;
    if verification_files(config) != files {
        return Err(err("配音环境文件已变更，请重新检测"));
    }
    *cache = files.map(|files| Verification { files, at: Instant::now() });
    Ok(())
}
async fn verify_cached(config: &Config, refresh: bool, cancel: &AtomicBool) -> AppResult<()> {
    let mut cache = tokio::select! {
        guard = VERIFICATION.lock() => guard,
        _ = wait_cancel(cancel) => return check_cancel(cancel),
    };
    check_cancel(cancel)?;
    verify_with_cache(&mut cache, config, refresh, verify(config, cancel)).await
}
async fn inspect(directory: PathBuf, paths: &LibraryPaths, refresh: bool) -> AppResult<Environment> {
    let downloads = files(); let total: u64 = downloads.iter().map(|d| d.size).sum();
    let completed = downloads.iter().map(|d| std::fs::metadata(directory.join(&d.file)).or_else(|_| std::fs::metadata(directory.join(&d.file).with_extension("part"))).map(|m| m.len().min(d.size)).unwrap_or(0)).sum::<u64>();
    let mut state = Environment { phase: "missing".into(), message: "应用会下载并配置本机配音组件".into(), directory: directory.to_string_lossy().into(), gpu: String::new(),
        free_bytes: if cfg!(windows) { free_bytes(&directory)? } else { 0 }, required_bytes: total.saturating_sub(completed) + INSTALL_RESERVE,
        completed_bytes: completed, total_bytes: total, can_install: false, install_step: None, progress_percent: None, active_seconds: None };
    if !cfg!(all(windows, target_arch = "x86_64")) { state.phase="unsupported".into(); state.message="本机配音安装目前支持 Windows x64 与 NVIDIA 显卡".into(); return Ok(state); }
    let hardware = if refresh { comfy_driver::detect_with_refresh(true).await } else { comfy_driver::detect().await };
    state.gpu = hardware.gpus.iter().map(|gpu| gpu.name.as_str()).collect::<Vec<_>>().join("\n");
    if state.gpu.is_empty() { state.phase="unsupported".into(); state.message="未检测到可用的 NVIDIA 显卡，请确认驱动安装后重新检测".into(); return Ok(state); }
    if let Ok(config) = voice::read::<Config>(&voice::root(paths).join("config.json")) {
        if verify_cached(&config, refresh, &AtomicBool::new(false)).await.is_ok() { state.phase="ready".into(); state.message="本机配音已就绪".into(); return Ok(state); }
    }
    // CUDA 12.x's published Windows floor for minor-version compatibility.
    if comfy_driver::drivers_below(&hardware, (528, 33)) {
        state.phase = "unsupported".into();
        state.message = "请将 NVIDIA 驱动更新至 528.33 或更新版本，再准备本机配音环境".into();
        return Ok(state);
    }
    state.can_install = state.free_bytes >= state.required_bytes;
    if !state.can_install { state.message="安装磁盘空间不足，请更换安装位置或清理空间".into(); }
    if let Ok(old) = voice::read::<Environment>(&directory.join("setup.json")) {
        if old.phase == "failed" && state.can_install {
            state.phase = old.phase;
            state.message = old.message;
        } else if matches!(old.phase.as_str(), "installing" | "paused") {
            state.phase = "paused".into();
            if state.can_install { state.message = "上次准备尚未完成，已下载文件保留，可继续准备".into(); }
        }
    }
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::sync::atomic::AtomicUsize;
    #[tokio::test]
    async fn successful_probe_reuses_only_current_files_until_forced_or_expired() {
        let root = tempfile::tempdir().unwrap();
        let python = root.path().join("python.exe");
        let model = root.path().join("model");
        std::fs::create_dir(&model).unwrap();
        std::fs::write(&python, b"first").unwrap();
        for file in ["config.json", "model.safetensors", "audiovae.pth"] {
            std::fs::write(model.join(file), b"model").unwrap();
        }
        let config = Config { python: python.to_string_lossy().into(), model: model.to_string_lossy().into() };
        let count = AtomicUsize::new(0);
        let probe = || async { count.fetch_add(1, Ordering::Relaxed); Ok(()) };
        let mut cache = None;
        verify_with_cache(&mut cache, &config, false, probe()).await.unwrap();
        verify_with_cache(&mut cache, &config, false, probe()).await.unwrap();
        assert_eq!(count.load(Ordering::Relaxed), 1);
        verify_with_cache(&mut cache, &config, true, probe()).await.unwrap();
        cache.as_mut().unwrap().at -= VERIFIED_FOR;
        verify_with_cache(&mut cache, &config, false, probe()).await.unwrap();
        assert_eq!(count.load(Ordering::Relaxed), 3);
        std::fs::write(&python, b"updated Python").unwrap();
        verify_with_cache(&mut cache, &config, false, probe()).await.unwrap();
        std::fs::remove_file(model.join("config.json")).unwrap();
        let reject = async { count.fetch_add(1, Ordering::Relaxed); Err(err("missing config")) };
        assert!(verify_with_cache(&mut cache, &config, false, reject).await.is_err());
        assert!(cache.is_none());
        assert_eq!(count.load(Ordering::Relaxed), 5);
        std::fs::write(model.join("config.json"), b"restored").unwrap();
        verify_with_cache(&mut cache, &config, false, probe()).await.unwrap();
        let other = root.path().join("other-python.exe");
        std::fs::copy(python, &other).unwrap();
        let config = Config { python: other.to_string_lossy().into(), ..config };
        verify_with_cache(&mut cache, &config, false, probe()).await.unwrap();
        assert_eq!(count.load(Ordering::Relaxed), 7);
    }
    #[test]
    fn pypi_mirror_requires_an_official_index_network_failure() {
        assert!(pypi_network_failure("failed to fetch: `https://pypi.org/simple/example/`\n  client error (connect)\n  dns error"));
        assert!(pypi_network_failure("failed to fetch: https://files.pythonhosted.org/packages/a.whl\n  503 service unavailable"));
        for detail in [
            "failed to fetch: https://download.pytorch.org/whl/cu128/\n timed out",
            "https://pypi.org/simple/example/\n no solution found",
            "https://pypi.org/simple/example/\n client error (connect)\n invalid certificate",
            "https://files.pythonhosted.org/packages/a.whl\n hash mismatch",
            "https://files.pythonhosted.org/packages/a.whl\n permission denied",
        ] { assert!(!pypi_network_failure(detail), "{detail}"); }
    }
    #[test]
    fn installation_progress_tracks_bytes_within_each_real_step() {
        assert_eq!(transfer_percent(InstallStep::Resources, 56, 0, 200), 0);
        assert_eq!(transfer_percent(InstallStep::Resources, 56, 100, 200), 28);
        assert_eq!(transfer_percent(InstallStep::Resources, 56, 200, 200), 56);
        assert_eq!(InstallStep::Python.start_percent(), 57);
        assert_eq!(transfer_percent(InstallStep::Pytorch, 87, 40, 100), 72);
        assert_eq!(transfer_percent(InstallStep::Pytorch, 87, 100, 100), 87);
        assert!(InstallStep::Voxcpm.start_percent() > 87);
        assert!(InstallStep::CudaCheck.start_percent() > InstallStep::Voxcpm.start_percent());
    }
    #[test]
    fn cuda_wheels_are_exact_local_install_inputs_on_both_pypi_indexes() {
        let root = Path::new("managed voice");
        let python = root.join("runtime/Scripts/python.exe");
        let cuda: Vec<_> = files().into_iter().filter(Download::cuda_wheel).collect();
        assert_eq!(cuda.len(), 2);
        let paths: Vec<_> = cuda.iter().map(|item| root.join(&item.file)).collect();
        for filename in ["torch-2.11.0+cu128-cp312-cp312-win_amd64.whl", "torchaudio-2.11.0+cu128-cp312-cp312-win_amd64.whl"] {
            assert!(paths.iter().any(|path| path.ends_with(filename)));
        }
        for index in [PYPI, PYPI_MIRROR] {
            let command = wheel_command(root, &python, index, &["voxcpm==2.0.3"], &paths);
            let args: Vec<_> = command.get_args().collect();
            assert!(args.contains(&std::ffi::OsStr::new(index)));
            assert!(args.ends_with(&[paths[0].as_os_str(), paths[1].as_os_str()]));
        }
    }
    #[tokio::test]
    async fn download_falls_back_and_reuses_only_the_verified_mirror_file() {
        use axum::{Router, routing::get, http::StatusCode};
        let server = Router::new().route("/missing", get(|| async { StatusCode::NOT_FOUND }))
            .route("/mirror", get(|| async { "abcdef" }))
            .route("/corrupt", get(|| async { "xxxxxx" }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap(); });
        let root = tempfile::tempdir().unwrap();
        let mut item = Download { file: "model.bin".into(), url: format!("http://{address}/missing"),
            mirror_url: Some(format!("http://{address}/mirror")), size: 6, sha256: format!("{:x}", Sha256::digest(b"abcdef")) };
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let cancel = AtomicBool::new(false);
        download(&http, root.path(), &item, &cancel, |_, _| {}).await.unwrap();
        let path = root.path().join(&item.file);
        assert_eq!(std::fs::read(&path).unwrap(), b"abcdef");
        assert!(verified(&path, item.size, &item.sha256));
        item.mirror_url = Some(format!("http://{address}/corrupt"));
        download(&http, root.path(), &item, &cancel, |_, _| {}).await.unwrap();
        std::fs::write(&path, b"tampered").unwrap();
        assert!(download(&http, root.path(), &item, &cancel, |_, _| {}).await.unwrap_err().to_string().contains("校验未通过"));
        assert!(!verified(&path, item.size, &item.sha256));
        assert!(!path.with_extension("part").exists());
        task.abort();
    }
    #[tokio::test]
    async fn cuda_wheel_rejects_a_tampered_archive_even_with_a_verification_stamp() {
        use axum::{Router, routing::get, http::StatusCode};
        let server = Router::new().route("/official", get(|| async { StatusCode::NOT_FOUND }))
            .route("/mirror", get(|| async { "xxxxxx" }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap(); });
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("cuda-wheels")).unwrap();
        let item = Download { file: "cuda-wheels/example-1.0.0-py3-none-any.whl".into(),
            url: format!("http://{address}/official"), mirror_url: Some(format!("http://{address}/mirror")),
            size: 6, sha256: format!("{:x}", Sha256::digest(b"abcdef")) };
        let path = root.path().join(&item.file);
        std::fs::write(&path, b"zzzzzz").unwrap();
        remember_verified(&path, verification_stamp(&path, &item.sha256));
        assert!(verified(&path, item.size, &item.sha256));
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let error = download(&http, root.path(), &item, &AtomicBool::new(false), |_, _| {}).await.unwrap_err();
        assert!(error.to_string().contains("校验未通过"));
        assert!(!path.exists());
        assert!(!path.with_extension("part").exists());
        task.abort();
    }
    #[tokio::test]
    async fn download_resumes_checks_hash_and_keeps_partial_on_pause() {
        use axum::{Router, routing::get, http::{HeaderMap, StatusCode}};
        let server=Router::new().route("/file", get(|headers: HeaderMap| async move {
            if headers.get("range").and_then(|v|v.to_str().ok())==Some("bytes=3-") {
                (StatusCode::PARTIAL_CONTENT, [("content-range","bytes 3-5/6")], "def")
            } else { (StatusCode::OK, [("content-range","")], "abcdef") }
        })).route("/bad",get(|| async { "xxxxxx" }));
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); let address=listener.local_addr().unwrap();
        let task=tokio::spawn(async move { axum::serve(listener,server).await.unwrap(); });
        let root=tempfile::tempdir().unwrap(); std::fs::write(root.path().join("model.part"),"abc").unwrap();
        let mut item=Download { file:"model.bin".into(), url:format!("http://{address}/file"),mirror_url:None,size:6,sha256:format!("{:x}",Sha256::digest(b"abcdef")) };
        let http=reqwest::Client::new(); let cancel=AtomicBool::new(false);
        download(&http,root.path(),&item,&cancel,|_, _| {}).await.unwrap(); assert_eq!(std::fs::read(root.path().join("model.bin")).unwrap(),b"abcdef");
        item.file="bad.bin".into(); item.url=format!("http://{address}/bad"); assert!(download(&http,root.path(),&item,&cancel,|_, _| {}).await.is_err()); assert!(!root.path().join("bad.bin").exists());
        std::fs::write(root.path().join("pause.part"),"abc").unwrap(); item.file="pause.bin".into(); cancel.store(true,Ordering::Relaxed);
        assert!(download(&http,root.path(),&item,&cancel,|_, _| {}).await.is_err()); assert_eq!(std::fs::read(root.path().join("pause.part")).unwrap(),b"abc");
        assert!(files().iter().all(|f| f.sha256.len()==64 && f.url.starts_with("https://") && !f.file.contains("..")));
        task.abort();
    }
    #[tokio::test]
    async fn download_retries_interruption_and_preserves_range() {
        use axum::{Router, routing::get, http::{HeaderMap, StatusCode}, response::IntoResponse};
        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let request_count = requests.clone();
        let server = Router::new().route("/file", get(move |headers: HeaderMap| {
            let requests = requests.clone();
            async move {
                match requests.fetch_add(1, Ordering::Relaxed) {
                    0 => StatusCode::SERVICE_UNAVAILABLE.into_response(),
                    1 => "abc".into_response(),
                    _ => {
                        assert_eq!(headers.get("range").unwrap(), "bytes=3-");
                        (StatusCode::PARTIAL_CONTENT, [("content-range", "bytes 3-5/6")], "def").into_response()
                    }
                }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap(); });
        let root = tempfile::tempdir().unwrap();
        let item = Download { file: "model.bin".into(), url: format!("http://{address}/file"), mirror_url: None, size: 6, sha256: format!("{:x}", Sha256::digest(b"abcdef")) };
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let result = download(&http, root.path(), &item, &AtomicBool::new(false), |_, _| {}).await;
        task.abort();
        result.unwrap();
        assert_eq!(request_count.load(Ordering::Relaxed), 3);
        assert_eq!(std::fs::read(root.path().join(item.file)).unwrap(), b"abcdef");
    }
    #[tokio::test]
    async fn account_change_pauses_in_flight_voice_download() {
        use axum::{routing::get, Router};
        use crate::cloud::{config::CloudConfig, CloudClient};
        let auth = AuthClient::with_test_session(CloudClient::new(CloudConfig::default()).unwrap());
        let arrived = Arc::new(tokio::sync::Notify::new());
        let requested = arrived.clone();
        let server = Router::new().route("/file", get(move || {
            let requested = requested.clone();
            async move {
                requested.notify_one();
                std::future::pending::<&'static str>().await
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, server).await.unwrap(); });
        let root = tempfile::tempdir().unwrap();
        let part = root.path().join("model.part");
        std::fs::write(&part, b"abc").unwrap();
        let item = Download { file: "model.bin".into(), url: format!("http://{address}/file"), mirror_url: None, size: 6, sha256: format!("{:x}", Sha256::digest(b"abcdef")) };
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let watcher = tokio::spawn(watch_install_account(auth.clone(), "test-user".into(), cancel.clone()));
        let switch = async {
            arrived.notified().await;
            auth.set_test_user("other-user");
        };
        let (result, ()) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(download(&http, root.path(), &item, &cancel, |_, _| {}), switch)
        }).await.unwrap();
        watcher.await.unwrap();
        server.abort();
        assert!(result.unwrap_err().to_string().contains("下载已暂停"));
        assert_eq!(std::fs::read(&part).unwrap(), b"abc");
        assert!(!root.path().join(&item.file).exists());
    }
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "read-only verification of an existing managed CUDA environment"]
    async fn existing_managed_environment_reuses_verified_cuda_probe() {
        let directory = PathBuf::from(std::env::var("VOICE_INSTALL_TEST_DIRECTORY").unwrap());
        let config = Config { python: directory.join("runtime/Scripts/python.exe").display().to_string(),
            model: directory.join("model").display().to_string() };
        let hardware = comfy_driver::detect_with_refresh(true).await;
        assert!(!hardware.gpus.is_empty(), "{hardware:?}");
        assert!(!comfy_driver::drivers_below(&hardware, (528, 33)), "{hardware:?}");
        let cancel = AtomicBool::new(false);
        let start = Instant::now();
        verify_cached(&config, true, &cancel).await.unwrap();
        let elapsed = start.elapsed();
        let start = Instant::now();
        verify_cached(&config, false, &cancel).await.unwrap();
        let cached = start.elapsed();
        assert!(cached < Duration::from_millis(500), "cache hit took {cached:?}");
        println!("{hardware:?}; verified in {elapsed:?}; cache hit in {cached:?}");
    }
    #[tokio::test]
    #[ignore = "explicit isolated local installation; downloads runtime and dependencies"]
    async fn real_managed_installation_verifies_python_and_cuda() {
        let directory=PathBuf::from(std::env::var("VOICE_INSTALL_TEST_DIRECTORY").unwrap());
        let temp=tempfile::tempdir().unwrap(); let paths=LibraryPaths::init(temp.path().into()).unwrap();
        let config = install(&directory, &AtomicBool::new(false)).await.unwrap();
        voice::write(&voice::root(&paths).join("config.json"), &config).unwrap();
        let config: Config=voice::read(&voice::root(&paths).join("config.json")).unwrap();
        verify(&config, &AtomicBool::new(false)).await.unwrap();
        println!("verified managed Python: {}",config.python);
    }
}
fn download_name(item: &Download) -> &'static str {
    match item.file.as_str() {
        "uv.whl" => "配音安装组件",
        "model/model.safetensors" => "配音主模型",
        "model/audiovae.pth" => "音频编码模型",
        file if file.starts_with("cuda-wheels/torch-") => "PyTorch CUDA",
        file if file.starts_with("cuda-wheels/torchaudio-") => "TorchAudio CUDA",
        _ => "配音模型文件",
    }
}
async fn checksum(path: &Path, item: &Download, cancel: &AtomicBool, report: impl Fn(u64) + Send + 'static) -> AppResult<bool> {
    let size = item.size;
    let before = verification_stamp(path, &item.sha256);
    report(0);
    Ok(hash(path, cancel, report).await? == item.sha256
        && before.is_some() && verification_stamp(path, &item.sha256) == before
        && tokio::fs::metadata(path).await.is_ok_and(|metadata| metadata.len() == size))
}
async fn download(
    http: &reqwest::Client, root: &Path, item: &Download, cancel: &AtomicBool,
    report: impl Fn(&str, u64) + Send + Copy + 'static,
) -> AppResult<()> {
    check_cancel(cancel)?;
    let path = root.join(&item.file); let part = path.with_extension("part");
    // Executable wheels are rehashed before every install attempt, including resume.
    if !item.cuda_wheel() && verified(&path, item.size, &item.sha256) { return Ok(()); }
    let name = download_name(item);
    let size = item.size;
    let report_checksum = move |read: u64| {
        let percent = read.min(size).saturating_mul(100) / size.max(1);
        report(&format!("正在校验{name}（{percent}%）"), size);
    };
    if tokio::fs::metadata(&path).await.is_ok_and(|metadata| metadata.is_file() && metadata.len() == item.size) {
        let stamp = verification_stamp(&path, &item.sha256);
        if checksum(&path, item, cancel, report_checksum).await? {
            if !item.cuda_wheel() { remember_verified(&path, stamp); }
            return Ok(());
        }
    }
    if item.cuda_wheel() && path.exists() { tokio::fs::remove_file(&path).await?; }
    tokio::fs::create_dir_all(path.parent().unwrap()).await?;
    if tokio::fs::metadata(&part).await.is_ok_and(|metadata| metadata.len() > item.size) {
        // This temporary file is inside the app-owned setup directory.
        tokio::fs::remove_file(&part).await?;
    }
    let sources = [Some(item.url.clone()), item.mirror_url.clone()];
    for (attempt, url) in sources.into_iter().enumerate() {
        let Some(url) = url else { break; };
        let label = if attempt == 0 { format!("正在下载{name}") } else { format!("正在通过备用源下载{name}") };
        let offset = tokio::fs::metadata(&part).await.map(|metadata| metadata.len()).unwrap_or(0);
        report(&label, offset);
        let transfer = transfer(http, &part, item.size, cancel, move || std::future::ready(Ok(url.clone())), move |state| match state {
            TransferProgress::Downloading(offset) => report(&label, offset),
            TransferProgress::Reconnecting(offset) => report(&format!("连接中断，正在继续下载{name}"), offset),
        }).await;
        if let Err(error) = transfer {
            if attempt != 0 || item.mirror_url.is_none() || cancel.load(Ordering::Relaxed) || matches!(error, AppError::Io(_)) {
                return Err(error);
            }
            tracing::warn!(file = %item.file, "switching voice download to mirror");
            continue;
        }
        let stamp = verification_stamp(&part, &item.sha256);
        if !checksum(&part, item, cancel, report_checksum).await? {
            tokio::fs::remove_file(&part).await?;
            continue;
        }
        check_cancel(cancel)?;
        if path.exists() { tokio::fs::remove_file(&path).await?; }
        tokio::fs::rename(part, &path).await?;
        if !item.cuda_wheel() { remember_verified(&path, stamp); }
        return Ok(());
    }
    Err(err("配音下载文件校验未通过，请继续准备以重新下载"))
}
async fn download_group(
    http: &reqwest::Client, root: &Path, items: &[Download], cancel: &AtomicBool,
    step: InstallStep, end_percent: u8, earlier_bytes: u64,
) -> AppResult<u64> {
    let total = items.iter().map(|item| item.size).sum();
    let mut done = 0;
    for item in items {
        let report = move |message: &str, offset| update_install(|state| {
            if state.install_step == Some(step) {
                state.message = message.into();
                state.completed_bytes = earlier_bytes + done + offset;
                state.progress_percent = Some(transfer_percent(step, end_percent, done + offset, total));
            }
        });
        download(http, root, item, cancel, report).await?;
        report(&format!("已校验{}", download_name(item)), item.size);
        done += item.size;
    }
    Ok(done)
}
fn setup_failure(error: &AppError) -> String {
    match error {
        AppError::Io(error) => match error.kind() {
            std::io::ErrorKind::StorageFull => "安装磁盘空间不足，请更换安装位置或清理空间后继续准备".into(),
            std::io::ErrorKind::PermissionDenied => "无法写入配音安装目录，请检查磁盘权限或更换安装位置".into(),
            _ => format!("无法读写配音安装文件，请检查安装目录和磁盘（{error}）"),
        },
        other => other.to_string(),
    }
}
struct CommandFailure { status: ExitStatus, tail: String }
fn pypi_network_failure(tail: &str) -> bool {
    const PYPI_HOSTS: &[&str] = &["https://pypi.org/", "https://files.pythonhosted.org/"];
    const NETWORK_ERRORS: &[&str] = &[
        "timed out", "timeout", "deadline exceeded", "client error (connect)", "dns error",
        "network is unreachable", "connection refused", "connection reset", "temporary failure",
        "429 too many requests", "500 internal server error", "502 bad gateway", "503 service unavailable", "504 gateway timeout",
    ];
    if ["hash mismatch", "hashes do not match", "certificate", "not enough space", "no space left", "disk full", "os error 112", "permission denied", "access is denied"]
        .iter().any(|reason| tail.contains(reason)) { return false; }
    let lines = tail.lines().collect::<Vec<_>>();
    lines.iter().enumerate().any(|(line, text)| PYPI_HOSTS.iter().any(|host| text.contains(host))
        && lines[line..(line + 5).min(lines.len())].iter().any(|next| NETWORK_ERRORS.iter().any(|error| next.contains(error))))
}
fn command_failure(stage: &str, failure: CommandFailure) -> AppError {
    let CommandFailure { status, tail } = failure;
    // Classify the tool's diagnostics without returning its raw URLs or output.
    if ["no space left", "disk full", "not enough space", "os error 112"].iter().any(|reason| tail.contains(reason)) {
        return err("安装磁盘空间不足，请清理空间后继续准备");
    }
    if ["timed out", "timeout", "deadline exceeded"].iter().any(|reason| tail.contains(reason)) {
        return err("下载配音运行组件超时，请检查网络后继续准备");
    }
    if ["download failed", "failed to download", "network is unreachable", "connection refused"].iter().any(|reason| tail.contains(reason)) {
        return err("无法下载配音运行组件，请检查网络后继续准备");
    }
    err(format!("{stage}失败（{status}），可继续准备，详情见安装目录的 setup.log"))
}
async fn wait_child(mut child: ManagedChild, cancel: &AtomicBool, mut on_alive: impl FnMut(u64)) -> AppResult<ExitStatus> {
    check_cancel(cancel)?;
    let started = Instant::now();
    let mut last_report = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            child.kill_and_wait()?;
            check_cancel(cancel)?;
        }
        if let Some(status) = child.try_wait()? { return Ok(status); }
        let elapsed = started.elapsed().as_secs();
        if elapsed > last_report {
            on_alive(elapsed);
            last_report = elapsed;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}
async fn run_command(mut cmd: Command, root: &Path, cancel: &AtomicBool) -> AppResult<Option<CommandFailure>> {
    check_cancel(cancel)?;
    let path = root.join("setup.log");
    let log = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
    let start = log.metadata()?.len();
    update_install(|state| state.active_seconds = None);
    let status = wait_child(spawn_managed(&mut cmd, Some(&log))?, cancel, |elapsed| {
        update_install(|state| state.active_seconds = Some(elapsed));
    }).await?;
    update_install(|state| state.active_seconds = None);
    Ok((!status.success()).then(|| CommandFailure { status, tail: log_tail(&path, 16 * 1024, start).to_ascii_lowercase() }))
}
fn uv(root: &Path) -> Command {
    let mut cmd = command(root.join("uv.exe")); cmd.arg("--no-config")
        .env("UV_CACHE_DIR", root.join("cache")).env("UV_PYTHON_INSTALL_DIR", root.join("python"))
        .env("UV_NO_PROGRESS", "1").env("PYTHONUTF8", "1").env_remove("UV_TORCH_BACKEND"); cmd
}
fn wheel_command(root: &Path, python: &Path, index: &str, packages: &[&str], cuda_wheels: &[PathBuf]) -> Command {
    let mut cmd = uv(root);
    // CUDA wheels are explicit verified file paths, so either PyPI index can
    // resolve their usual dependencies without resolving torch on that index.
    cmd.args(["pip", "install", "--python"]).arg(python).args(["--default-index", index])
        .args(packages).args(cuda_wheels);
    cmd
}
async fn install_wheels(root: &Path, python: &Path, cancel: &AtomicBool, stage: &str, packages: &[&str], cuda_wheels: &[PathBuf]) -> AppResult<()> {
    update_install(|state| state.message = format!("正在{stage}"));
    let Some(error) = run_command(wheel_command(root, python, PYPI, packages, cuda_wheels), root, cancel).await? else { return Ok(()); };
    if !pypi_network_failure(&error.tail) { return Err(command_failure(stage, error)); }
    update_install(|state| state.message = format!("正在通过国内 PyPI 镜像{stage}所需的依赖"));
    tracing::warn!(%stage, "official PyPI unreachable; retrying voice setup with mirror");
    if let Some(error) = run_command(wheel_command(root, python, PYPI_MIRROR, packages, cuda_wheels), root, cancel).await? {
        return Err(command_failure(stage, error));
    }
    Ok(())
}
fn unpack_uv(root: &Path) -> AppResult<()> {
    let mut archive = zip::ZipArchive::new(std::fs::File::open(root.join("uv.whl"))?)
        .map_err(|_| err("无法读取配音安装组件，请重新准备"))?;
    let name = archive.file_names().find(|name| name.ends_with("/uv.exe"))
        .ok_or_else(|| err("安装组件缺少执行程序"))?.to_owned();
    let mut entry = archive.by_name(&name).map_err(|_| err("无法解压配音安装组件，请重新准备"))?;
    std::io::copy(&mut entry, &mut std::fs::File::create(root.join("uv.exe"))?)?;
    Ok(())
}
async fn install(root: &Path, cancel: &AtomicBool) -> AppResult<Config> {
    if root.exists() && std::fs::read_dir(root)?.next().is_some() && std::fs::read_to_string(root.join("owner.txt")).ok().as_deref() != Some(VERSION) { return Err(err("该目录已有其他文件，请更换安装位置")); }
    std::fs::create_dir_all(root)?; std::fs::write(root.join("owner.txt"), VERSION)?;
    let http = reqwest::Client::builder().https_only(true).connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(45)).build().map_err(|_| err("无法初始化配音安装下载"))?;
    let (cuda, resources): (Vec<_>, Vec<_>) = files().into_iter().partition(Download::cuda_wheel);
    let resource_bytes = download_group(&http, root, &resources, cancel, InstallStep::Resources, 56, 0).await?;
    check_cancel(cancel)?;
    install_step(InstallStep::Python, "正在解压配音安装组件");
    let unpack_root = root.to_path_buf();
    tokio::task::spawn_blocking(move || unpack_uv(&unpack_root)).await.map_err(|_| err("解压配音组件的任务未完成"))??;
    check_cancel(cancel)?;
    let python=root.join("runtime/Scripts/python.exe");
    install_step(InstallStep::Python, "正在准备独立 Python 环境");
    if !python.is_file() {
        let mut cmd=uv(root);
        cmd.args(["venv", "--python", "3.12.13", "--managed-python"]).arg(root.join("runtime"));
        if let Some(error) = run_command(cmd, root, cancel).await? { return Err(command_failure("准备 Python 环境", error)); }
    }
    install_step(InstallStep::Pytorch, "正在准备 PyTorch CUDA 安装包");
    download_group(&http, root, &cuda, cancel, InstallStep::Pytorch, 87, resource_bytes).await?;
    let cuda_paths: Vec<_> = cuda.iter().map(|item| root.join(&item.file)).collect();
    install_wheels(root, &python, cancel, "安装 PyTorch CUDA 组件", &[], &cuda_paths).await?;
    install_step(InstallStep::Voxcpm, "正在安装 VoxCPM 组件");
    install_wheels(root, &python, cancel, "安装 VoxCPM 组件",
        &["voxcpm==2.0.3", "torchcodec==0.14.0", "transformers==5.13.0"], &cuda_paths).await?;
    check_cancel(cancel)?;
    install_step(InstallStep::CudaCheck, "正在校验 NVIDIA CUDA");
    let config=Config { python: python.to_string_lossy().into(), model: root.join("model").to_string_lossy().into() };
    verify_cached(&config, true, cancel).await?;
    check_cancel(cancel)?;
    Ok(config)
}
async fn remove_cuda_wheels(root: &Path) {
    for item in files().into_iter().filter(Download::cuda_wheel) {
        let path = root.join(&item.file);
        for staged in [path.with_extension("part"), path] {
            if let Err(error) = tokio::fs::remove_file(staged).await {
                if error.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(file = %item.file, %error, "could not remove installed CUDA wheel archive");
                }
            }
        }
    }
}
#[tauri::command]
pub async fn voice_environment(app: AppHandle, paths: State<'_, Arc<LibraryPaths>>, auth: State<'_, AuthClient>, entitlement: State<'_, EntitlementService>, action: String, directory: Option<String>) -> AppResult<Environment> {
    let owner = auth.snapshot().user_id;
    { let mut current=INSTALL.lock().unwrap(); if let Some(job)=current.as_mut() {
        if job.state.phase == "installing" {
            if action=="pause" && job.owner == owner {
                job.cancel.store(true, Ordering::Relaxed);
                job.state.message="正在暂停，已下载的内容会保留".into();
            }
            return Ok(active_state(job, owner.as_deref()));
        }
        if action == "pause" && (job.owner.is_none() || job.owner == owner) { return Ok(job.state.clone()); }
    } }
    let location=voice::root(&paths).join("setup-location.json");
    let selected = directory.is_some();
    let root=if let Some(directory)=directory { let parent=PathBuf::from(directory).canonicalize()?; if !parent.is_dir() { return Err(err("请选择安装文件夹")); } parent.join("Bowerbird-Voice") }
        else { voice::read::<PathBuf>(&location).unwrap_or(app.path().app_local_data_dir().map_err(|e| err(e.to_string()))?.join("Bowerbird-Voice")) };
    let mut state=inspect(root.clone(), &paths, action == "recheck").await?;
    if action=="install" && state.phase!="ready" {
        voice::access(&auth, &entitlement).await?;
        let owner = owner.ok_or_else(|| err("账号已切换，请重新准备配音环境"))?;
        if !state.can_install { return Err(err(state.message)); }
        if root.exists() && std::fs::read_dir(&root)?.next().is_some() && std::fs::read_to_string(root.join("owner.txt")).ok().as_deref()!=Some(VERSION) { return Err(err("该目录已有其他文件，请更换安装位置")); }
        let cancel=Arc::new(AtomicBool::new(false));
        state.phase="installing".into();
        set_install_step(&mut state, InstallStep::Resources, "正在准备下载配音资源");
        let started = auth.with_current_user(&owner, || {
            let mut current=INSTALL.lock().unwrap();
            if let Some(job) = current.as_ref().filter(|job| job.state.phase == "installing") {
                return Ok(Some(active_state(job, Some(&owner))));
            }
            std::fs::create_dir_all(&root)?; std::fs::write(root.join("owner.txt"), VERSION)?;
            voice::write(&location,&root)?; voice::write(&root.join("setup.json"),&state)?;
            *current=Some(Install {state:state.clone(), cancel:cancel.clone(), owner:Some(owner.clone())});
            Ok(None)
        })?;
        if let Some(active) = started { return Ok(active); }
        let auth = auth.inner().clone();
        let config = voice::root(&paths).join("config.json");
        tokio::spawn(async move {
            let watcher = tokio::spawn(watch_install_account(auth.clone(), owner.clone(), cancel.clone()));
            let result = install(&root, &cancel).await.and_then(|ready| auth.with_current_user(&owner, || {
                check_cancel(&cancel)?;
                voice::write(&config, &ready)
            }));
            watcher.abort();
            if result.is_ok() { remove_cuda_wheels(&root).await; }
            let account_changed = auth.snapshot().user_id.as_deref() != Some(owner.as_str());
            if let Some(job)=INSTALL.lock().unwrap().as_mut().filter(|job| Arc::ptr_eq(&job.cancel, &cancel)) {
                (job.state.phase, job.state.message) = match result {
                    Ok(()) => ("ready".into(), "本机配音已就绪".into()),
                    Err(_) if account_changed || cancel.load(Ordering::Relaxed) =>
                        ("paused".into(), "准备已暂停，已下载文件保留".into()),
                    Err(error) => {
                        let message = setup_failure(&error);
                        tracing::warn!(%message, "voice setup failed");
                        ("failed".into(), message)
                    }
                };
                job.state.active_seconds = None;
                if job.state.phase == "ready" {
                    job.state.progress_percent = Some(100);
                    job.state.install_step = None;
                }
                let _=voice::write(&root.join("setup.json"),&job.state);
            }
        });
    } else {
        let mut current=INSTALL.lock().unwrap();
        if let Some(job)=current.as_ref().filter(|job| job.state.phase=="installing") {
            return Ok(active_state(job, owner.as_deref()));
        }
        if selected {
            voice::write(&location,&root)?;
            *current = None;
        }
    }
    Ok(state)
}
