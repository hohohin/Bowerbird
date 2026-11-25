//! App-owned Python and VoxCPM installation. Never changes PATH or a user's Python.
use std::{path::{Path, PathBuf}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use serde::{Serialize, Deserialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tokio::io::AsyncReadExt;
use crate::{cloud::{AuthClient, EntitlementService}, core::paths::LibraryPaths, error::{AppError, AppResult}};
use super::install_download::{transfer, TransferProgress};
use super::voice::{self, Config};

const VERSION: &str = "voxcpm2-2026-11-10";
#[derive(Clone, Serialize, Deserialize)]
pub struct Environment {
    pub phase: String, pub message: String, pub directory: String, pub gpu: String,
    pub free_bytes: u64, pub required_bytes: u64, pub completed_bytes: u64, pub total_bytes: u64, pub can_install: bool,
}
#[derive(Deserialize)]
struct Download { file: String, url: String, size: u64, sha256: String }
struct Install { state: Environment, cancel: Arc<AtomicBool>, owner: Option<String> }
static INSTALL: Mutex<Option<Install>> = Mutex::new(None);
fn err(text: impl Into<String>) -> AppError { AppError::Other(text.into()) }
fn files() -> Vec<Download> { serde_json::from_str(include_str!("voice-downloads.json").trim_start_matches('\u{feff}')).expect("bundled voice manifest") }
fn progress(message: &str, bytes: u64) { if let Some(job) = INSTALL.lock().unwrap().as_mut() { job.state.message = message.into(); job.state.completed_bytes = bytes; } }
fn check_cancel(cancel: &AtomicBool) -> AppResult<()> { if cancel.load(Ordering::Relaxed) { Err(err("准备已暂停，已下载的文件保留，稍后可继续")) } else { Ok(()) } }
fn active_state(job: &Install, owner: Option<&str>) -> Environment {
    let mut state = job.state.clone();
    if job.owner.as_deref() != owner { state.message = "另一个账号的配音环境准备正在停止，请稍后重新检测".into(); }
    state
}
async fn watch_install_account(auth: AuthClient, owner: String, cancel: Arc<AtomicBool>) {
    while !cancel.load(Ordering::Relaxed) {
        let login = auth.snapshot();
        if !login.logged_in || login.user_id.as_deref() != Some(owner.as_str()) {
            cancel.store(true, Ordering::Relaxed);
            return;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}
fn command(path: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(path); cmd.kill_on_drop(true);
    #[cfg(windows)] cmd.creation_flags(0x08000000);
    cmd
}
fn free_bytes(path: &Path) -> AppResult<u64> {
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        let mut ancestor = path; while !ancestor.exists() { ancestor = ancestor.parent().ok_or_else(|| err("安装磁盘不可用"))?; }
        let wide: Vec<u16> = ancestor.as_os_str().encode_wide().chain(Some(0)).collect(); let mut available = 0;
        unsafe { windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(windows::core::PCWSTR(wide.as_ptr()), Some(&mut available), None, None) }.map_err(|e| err(e.to_string()))?;
        Ok(available)
    }
    #[cfg(not(windows))] { let _ = path; Ok(0) }
}
async fn verify(config: &Config) -> AppResult<()> {
    voice::validate_config(config)?;
    let output = tokio::time::timeout(Duration::from_secs(45), command(&config.python).args(["-c", "import torch; from voxcpm import VoxCPM; import soundfile; assert torch.cuda.is_available(), 'CUDA unavailable'; assert torch.ones(1,device='cuda').sum().item()==1; assert hasattr(VoxCPM, 'generate')"])
        .env("HF_HUB_OFFLINE", "1").env("PYTHONUTF8", "1").output())
        .await.map_err(|_| err("配音运行环境检查超时，请稍后继续准备"))??;
    if output.status.success() { return Ok(()); }
    let detail = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    if ["cuda unavailable", "nvidia driver", "cuda driver", "cuda initialization", "cuda error"].iter().any(|reason| detail.contains(reason)) {
        return Err(err("配音环境无法使用 NVIDIA CUDA，请更新显卡驱动后继续准备"));
    }
    Err(err("配音运行组件校验未通过，请继续准备以修复配音运行环境"))
}
async fn inspect(directory: PathBuf, paths: &LibraryPaths) -> AppResult<Environment> {
    let downloads = files(); let total: u64 = downloads.iter().map(|d| d.size).sum();
    let completed = downloads.iter().map(|d| std::fs::metadata(directory.join(&d.file)).or_else(|_| std::fs::metadata(directory.join(&d.file).with_extension("part"))).map(|m| m.len().min(d.size)).unwrap_or(0)).sum::<u64>();
    let mut state = Environment { phase: "missing".into(), message: "应用会下载并配置本机配音组件".into(), directory: directory.to_string_lossy().into(), gpu: String::new(),
        free_bytes: free_bytes(&directory)?, required_bytes: total.saturating_sub(completed) + 12_000_000_000, completed_bytes: completed, total_bytes: total, can_install: false };
    if !cfg!(all(windows, target_arch = "x86_64")) { state.phase="unsupported".into(); state.message="本机配音安装目前支持 Windows x64 与 NVIDIA 显卡".into(); return Ok(state); }
    if let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(10), command("nvidia-smi").args(["--query-gpu=name", "--format=csv,noheader"]).output()).await {
        if output.status.success() { state.gpu=String::from_utf8_lossy(&output.stdout).trim().into(); }
    }
    if state.gpu.is_empty() { state.phase="unsupported".into(); state.message="未检测到可用的 NVIDIA 显卡，请确认驱动安装后重新检测".into(); return Ok(state); }
    if let Ok(config) = voice::read::<Config>(&voice::root(paths).join("config.json")) {
        if verify(&config).await.is_ok() { state.phase="ready".into(); state.message="本机配音已就绪".into(); return Ok(state); }
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
        let mut item=Download { file:"model.bin".into(), url:format!("http://{address}/file"),size:6,sha256:format!("{:x}",Sha256::digest(b"abcdef")) };
        let http=reqwest::Client::new(); let cancel=AtomicBool::new(false);
        download(&http,root.path(),&item,&cancel,0).await.unwrap(); assert_eq!(std::fs::read(root.path().join("model.bin")).unwrap(),b"abcdef");
        item.file="bad.bin".into(); item.url=format!("http://{address}/bad"); assert!(download(&http,root.path(),&item,&cancel,0).await.is_err()); assert!(!root.path().join("bad.bin").exists());
        std::fs::write(root.path().join("pause.part"),"abc").unwrap(); item.file="pause.bin".into(); cancel.store(true,Ordering::Relaxed);
        assert!(download(&http,root.path(),&item,&cancel,0).await.is_err()); assert_eq!(std::fs::read(root.path().join("pause.part")).unwrap(),b"abc");
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
        let item = Download { file: "model.bin".into(), url: format!("http://{address}/file"), size: 6, sha256: format!("{:x}", Sha256::digest(b"abcdef")) };
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let result = download(&http, root.path(), &item, &AtomicBool::new(false), 0).await;
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
        let item = Download { file: "model.bin".into(), url: format!("http://{address}/file"), size: 6, sha256: format!("{:x}", Sha256::digest(b"abcdef")) };
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let watcher = tokio::spawn(watch_install_account(auth.clone(), "test-user".into(), cancel.clone()));
        let switch = async {
            arrived.notified().await;
            auth.set_test_user("other-user");
        };
        let (result, ()) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(download(&http, root.path(), &item, &cancel, 0), switch)
        }).await.unwrap();
        watcher.await.unwrap();
        server.abort();
        assert!(result.unwrap_err().to_string().contains("下载已暂停"));
        assert_eq!(std::fs::read(&part).unwrap(), b"abc");
        assert!(!root.path().join(&item.file).exists());
    }
    #[tokio::test]
    #[ignore = "explicit isolated local installation; downloads runtime and dependencies"]
    async fn real_managed_installation_verifies_python_and_cuda() {
        let directory=PathBuf::from(std::env::var("VOICE_INSTALL_TEST_DIRECTORY").unwrap());
        let temp=tempfile::tempdir().unwrap(); let paths=LibraryPaths::init(temp.path().into()).unwrap();
        let config = install(&directory, &AtomicBool::new(false)).await.unwrap();
        voice::write(&voice::root(&paths).join("config.json"), &config).unwrap();
        let config: Config=voice::read(&voice::root(&paths).join("config.json")).unwrap();
        verify(&config).await.unwrap();
        println!("verified managed Python: {}",config.python);
    }
}
async fn checksum(path: &Path, expected: &str, cancel: &AtomicBool) -> AppResult<bool> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        check_cancel(cancel)?;
        let read = file.read(&mut buffer).await?;
        if read == 0 { break; }
        hash.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hash.finalize()) == expected)
}
async fn download(http: &reqwest::Client, root: &Path, item: &Download, cancel: &AtomicBool, done: u64) -> AppResult<()> {
    check_cancel(cancel)?;
    let path = root.join(&item.file); let part = path.with_extension("part");
    if path.is_file() { progress("正在校验已下载文件", done); if checksum(&path, &item.sha256, cancel).await? { return Ok(()); } }
    tokio::fs::create_dir_all(path.parent().unwrap()).await?;
    if tokio::fs::metadata(&part).await.is_ok_and(|metadata| metadata.len() > item.size) {
        // This temporary file is inside the app-owned setup directory.
        tokio::fs::remove_file(&part).await?;
    }
    let label = if item.file == "uv.whl" { "正在下载配音组件" } else { "正在下载声音模型" };
    transfer(http, &part, item.size, cancel, || std::future::ready(Ok(item.url.clone())), |state| match state {
        TransferProgress::Downloading(offset) => progress(label, done + offset),
        TransferProgress::Reconnecting(offset) => progress("连接中断，正在继续下载配音资源", done + offset),
    }).await?;
    progress("正在校验下载文件", done + item.size);
    if !checksum(&part, &item.sha256, cancel).await? {
        tokio::fs::remove_file(&part).await?;
        return Err(err("配音下载文件校验未通过，请继续准备以重新下载"));
    }
    check_cancel(cancel)?;
    if path.exists() { tokio::fs::remove_file(&path).await?; } tokio::fs::rename(part, path).await?; Ok(())
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
fn command_failure(stage: &str, status: std::process::ExitStatus, path: &Path, start: u64) -> AppError {
    use std::io::{Read, Seek, SeekFrom};
    let read_tail = || -> std::io::Result<String> {
        let mut file = std::fs::File::open(path)?;
        file.seek(SeekFrom::Start(start.max(file.metadata()?.len().saturating_sub(16 * 1024))))?;
        let mut bytes = Vec::new();
        file.take(16 * 1024).read_to_end(&mut bytes)?;
        Ok(String::from_utf8_lossy(&bytes).to_ascii_lowercase())
    };
    let tail = read_tail().unwrap_or_default();
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
async fn run_command(mut cmd: tokio::process::Command, root: &Path, cancel: &AtomicBool, stage: &str) -> AppResult<()> {
    check_cancel(cancel)?;
    let path = root.join("setup.log");
    let log = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
    let start = log.metadata()?.len();
    cmd.stdin(std::process::Stdio::null()).stdout(log.try_clone()?).stderr(log);
    let mut child = cmd.spawn()?;
    loop {
        if cancel.load(Ordering::Relaxed) {
            #[cfg(windows)] if let Some(id) = child.id() { let _ = command("taskkill.exe").args(["/PID", &id.to_string(), "/T", "/F"]).output().await; }
            let _=child.kill().await; let _=child.wait().await; return check_cancel(cancel);
        }
        if let Some(status)=child.try_wait()? { return if status.success() { Ok(()) } else { Err(command_failure(stage, status, &path, start)) }; }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}
fn uv(root: &Path) -> tokio::process::Command {
    let mut cmd = command(root.join("uv.exe")); cmd.arg("--no-config")
        .env("UV_CACHE_DIR", root.join("cache")).env("UV_PYTHON_INSTALL_DIR", root.join("python"))
        .env("UV_NO_PROGRESS", "1").env("PYTHONUTF8", "1").env_remove("UV_TORCH_BACKEND"); cmd
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
    let items=files(); let mut done=0;
    for item in &items { download(&http, root, item, cancel, done).await?; done+=item.size; }
    check_cancel(cancel)?;
    let unpack_root = root.to_path_buf();
    tokio::task::spawn_blocking(move || unpack_uv(&unpack_root)).await.map_err(|_| err("解压配音组件的任务未完成"))??;
    check_cancel(cancel)?;
    let python=root.join("runtime/Scripts/python.exe");
    progress("正在准备独立运行环境，可关闭窗口", done);
    if !python.is_file() { let mut cmd=uv(root); cmd.args(["venv", "--python", "3.12.13", "--managed-python"]).arg(root.join("runtime")); run_command(cmd, root, cancel, "准备 Python 环境").await?; }
    progress("正在安装配音组件，首次准备可能需要较长时间", done);
    // Only torch/torchaudio use the CUDA index. TorchCodec's Windows wheel lives on PyPI.
    let mut cmd=uv(root); cmd.args(["pip", "install", "--python"]).arg(&python).args(["--default-index", "https://pypi.org/simple", "--torch-backend", "cu128", "torch==2.11.0", "torchaudio==2.11.0"]);
    run_command(cmd, root, cancel, "安装 PyTorch CUDA 组件").await?;
    let mut cmd=uv(root); cmd.args(["pip", "install", "--python"]).arg(&python).args(["--default-index", "https://pypi.org/simple", "voxcpm==2.0.3", "torch==2.11.0", "torchaudio==2.11.0", "torchcodec==0.14.0", "transformers==5.13.0"]);
    run_command(cmd, root, cancel, "安装 VoxCPM 配音组件").await?; check_cancel(cancel)?;
    progress("正在检查配音环境", done);
    let config=Config { python: python.to_string_lossy().into(), model: root.join("model").to_string_lossy().into() };
    verify(&config).await?;
    check_cancel(cancel)?;
    Ok(config)
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
        if matches!(action.as_str(), "pause" | "status") && (job.owner.is_none() || job.owner == owner) { return Ok(job.state.clone()); }
    } }
    let location=voice::root(&paths).join("setup-location.json");
    let root=if let Some(directory)=directory { let parent=PathBuf::from(directory).canonicalize()?; if !parent.is_dir() { return Err(err("请选择安装文件夹")); } parent.join("Bowerbird-Voice") }
        else { voice::read::<PathBuf>(&location).unwrap_or(app.path().app_local_data_dir().map_err(|e| err(e.to_string()))?.join("Bowerbird-Voice")) };
    let mut state=inspect(root.clone(), &paths).await?;
    if action=="install" && state.phase!="ready" {
        voice::access(&auth, &entitlement).await?;
        let owner = owner.ok_or_else(|| err("账号已切换，请重新准备配音环境"))?;
        if !state.can_install { return Err(err(state.message)); }
        if root.exists() && std::fs::read_dir(&root)?.next().is_some() && std::fs::read_to_string(root.join("owner.txt")).ok().as_deref()!=Some(VERSION) { return Err(err("该目录已有其他文件，请更换安装位置")); }
        let cancel=Arc::new(AtomicBool::new(false)); state.phase="installing".into(); state.message="正在准备下载".into();
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
                let _=voice::write(&root.join("setup.json"),&job.state);
            }
        });
    } else {
        let mut current=INSTALL.lock().unwrap();
        if let Some(job)=current.as_ref().filter(|job| job.state.phase=="installing") {
            return Ok(active_state(job, owner.as_deref()));
        }
        voice::write(&location,&root)?; *current=Some(Install{state:state.clone(),cancel:Arc::new(AtomicBool::new(false)),owner:None});
    }
    Ok(state)
}
