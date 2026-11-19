//! App-owned Python and VoxCPM installation. Never changes PATH or a user's Python.
use std::{path::{Path, PathBuf}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use serde::{Serialize, Deserialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tokio::io::AsyncWriteExt;
use crate::{cloud::{AuthClient, EntitlementService}, core::paths::LibraryPaths, error::{AppError, AppResult}};
use super::voice::{self, Config};

const VERSION: &str = "voxcpm2-2026-11-10";
#[derive(Clone, Serialize, Deserialize)]
pub struct Environment {
    pub phase: String, pub message: String, pub directory: String, pub gpu: String,
    pub free_bytes: u64, pub required_bytes: u64, pub completed_bytes: u64, pub total_bytes: u64, pub can_install: bool,
}
#[derive(Deserialize)]
struct Download { file: String, url: String, size: u64, sha256: String }
struct Install { state: Environment, cancel: Arc<AtomicBool> }
static INSTALL: Mutex<Option<Install>> = Mutex::new(None);
fn err(text: impl Into<String>) -> AppError { AppError::Other(text.into()) }
fn files() -> Vec<Download> { serde_json::from_str(include_str!("voice-downloads.json").trim_start_matches('\u{feff}')).expect("bundled voice manifest") }
fn progress(message: &str, bytes: u64) { if let Some(job) = INSTALL.lock().unwrap().as_mut() { job.state.message = message.into(); job.state.completed_bytes = bytes; } }
fn check_cancel(cancel: &AtomicBool) -> AppResult<()> { if cancel.load(Ordering::Relaxed) { Err(err("准备已暂停，已下载的文件保留，稍后可继续")) } else { Ok(()) } }
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
async fn verify(config: &Config) -> bool {
    if voice::validate_config(config).is_err() { return false; }
    tokio::time::timeout(Duration::from_secs(45), command(&config.python).args(["-c", "import torch; from voxcpm import VoxCPM; import soundfile; assert torch.cuda.is_available(); assert torch.ones(1,device='cuda').sum().item()==1; assert hasattr(VoxCPM, 'generate')"])
        .env("HF_HUB_OFFLINE", "1").env("PYTHONUTF8", "1").output()).await.is_ok_and(|r| r.is_ok_and(|o| o.status.success()))
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
        if verify(&config).await { state.phase="ready".into(); state.message="本机配音已就绪".into(); return Ok(state); }
    }
    state.can_install = state.free_bytes >= state.required_bytes;
    if !state.can_install { state.message="安装磁盘空间不足，请更换安装位置或清理空间".into(); }
    if let Ok(old) = voice::read::<Environment>(&directory.join("setup.json")) {
        if matches!(old.phase.as_str(), "installing" | "paused" | "failed") { state.phase="paused".into(); state.message="上次准备尚未完成，已下载文件保留，可继续准备".into(); }
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
    #[ignore = "explicit isolated local installation; downloads runtime and dependencies"]
    async fn real_managed_installation_verifies_python_and_cuda() {
        let directory=PathBuf::from(std::env::var("VOICE_INSTALL_TEST_DIRECTORY").unwrap());
        let temp=tempfile::tempdir().unwrap(); let paths=LibraryPaths::init(temp.path().into()).unwrap();
        install(&directory,&paths,&AtomicBool::new(false)).await.unwrap();
        let config: Config=voice::read(&voice::root(&paths).join("config.json")).unwrap();
        assert!(verify(&config).await); println!("verified managed Python: {}",config.python);
    }
}
async fn checksum(path: PathBuf, expected: String) -> AppResult<bool> {
    tokio::task::spawn_blocking(move || { let mut file = std::fs::File::open(path)?; let mut hash = Sha256::new(); std::io::copy(&mut file, &mut hash)?; Ok(format!("{:x}", hash.finalize()) == expected) }).await.map_err(|e| err(e.to_string()))?
}
async fn download(http: &reqwest::Client, root: &Path, item: &Download, cancel: &AtomicBool, done: u64) -> AppResult<()> {
    let path = root.join(&item.file); let part = path.with_extension("part");
    if path.is_file() { progress("正在校验已下载文件", done); if checksum(path.clone(), item.sha256.clone()).await? { return Ok(()); } }
    tokio::fs::create_dir_all(path.parent().unwrap()).await?;
    let mut offset = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
    if offset >= item.size { offset=0; }
    check_cancel(cancel)?;
    let mut response = http.get(&item.url).header(reqwest::header::RANGE, format!("bytes={offset}-")).send().await.map_err(|e| err(e.to_string()))?.error_for_status().map_err(|e| err(e.to_string()))?;
    if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        let expected = format!("bytes {offset}-{}\u{2f}{}", item.size-1, item.size);
        if response.headers().get(reqwest::header::CONTENT_RANGE).and_then(|v| v.to_str().ok()) != Some(expected.as_str()) { return Err(err("下载返回的文件范围不正确，请重试")); }
    } else { offset=0; }
    let mut file = tokio::fs::OpenOptions::new().create(true).write(true).truncate(offset==0).append(offset>0).open(&part).await?;
    while let Some(bytes) = tokio::time::timeout(Duration::from_secs(45), response.chunk()).await.map_err(|_| err("下载连接超时，已下载内容保留"))?.map_err(|e| err(e.to_string()))? {
        check_cancel(cancel)?; offset += bytes.len() as u64;
        if offset > item.size { return Err(err("下载文件大小不正确，请重试")); }
        file.write_all(&bytes).await?; progress(if item.file == "uv.whl" { "正在下载配音组件" } else { "正在下载声音模型" }, done + offset);
    }
    file.sync_all().await?; drop(file);
    progress("正在校验下载文件", done + offset);
    if offset != item.size || !checksum(part.clone(), item.sha256.clone()).await? {
        let _ = tokio::fs::remove_file(&part).await; return Err(err("下载文件校验未通过，请继续准备以重新下载"));
    }
    check_cancel(cancel)?;
    if path.exists() { tokio::fs::remove_file(&path).await?; } tokio::fs::rename(part, path).await?; Ok(())
}
async fn run_command(mut cmd: tokio::process::Command, root: &Path, cancel: &AtomicBool) -> AppResult<()> {
    check_cancel(cancel)?;
    let log = std::fs::OpenOptions::new().create(true).append(true).open(root.join("setup.log"))?;
    cmd.stdin(std::process::Stdio::null()).stdout(log.try_clone()?).stderr(log);
    let mut child = cmd.spawn()?;
    loop {
        if cancel.load(Ordering::Relaxed) {
            #[cfg(windows)] if let Some(id) = child.id() { let _ = command("taskkill.exe").args(["/PID", &id.to_string(), "/T", "/F"]).output().await; }
            let _=child.kill().await; let _=child.wait().await; return check_cancel(cancel);
        }
        if let Some(status)=child.try_wait()? { return if status.success() { Ok(()) } else { Err(err("配音组件准备未完成，请检查网络后继续准备；诊断已保留")) }; }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}
fn uv(root: &Path) -> tokio::process::Command {
    let mut cmd = command(root.join("uv.exe")); cmd.arg("--no-config")
        .env("UV_CACHE_DIR", root.join("cache")).env("UV_PYTHON_INSTALL_DIR", root.join("python"))
        .env("UV_NO_PROGRESS", "1").env("PYTHONUTF8", "1").env_remove("UV_TORCH_BACKEND"); cmd
}
async fn install(root: &Path, paths: &LibraryPaths, cancel: &AtomicBool) -> AppResult<()> {
    if root.exists() && std::fs::read_dir(root)?.next().is_some() && std::fs::read_to_string(root.join("owner.txt")).ok().as_deref() != Some(VERSION) { return Err(err("该目录已有其他文件，请更换安装位置")); }
    std::fs::create_dir_all(root)?; std::fs::write(root.join("owner.txt"), VERSION)?;
    let http = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).build().map_err(|e| err(e.to_string()))?;
    let items=files(); let mut done=0;
    for item in &items { download(&http, root, item, cancel, done).await?; done+=item.size; }
    let mut archive=zip::ZipArchive::new(std::fs::File::open(root.join("uv.whl"))?).map_err(|e| err(e.to_string()))?;
    let name=archive.file_names().find(|name| name.ends_with("/uv.exe")).ok_or_else(|| err("安装组件缺少执行程序"))?.to_owned();
    let mut entry=archive.by_name(&name).map_err(|e| err(e.to_string()))?;
    std::io::copy(&mut entry, &mut std::fs::File::create(root.join("uv.exe"))?)?; drop(entry); drop(archive);
    let python=root.join("runtime/Scripts/python.exe");
    progress("正在准备独立运行环境，可关闭窗口", done);
    if !python.is_file() { let mut cmd=uv(root); cmd.args(["venv", "--python", "3.12.13", "--managed-python"]).arg(root.join("runtime")); run_command(cmd, root, cancel).await?; }
    progress("正在安装配音组件，首次准备可能需要较长时间", done);
    // Only torch/torchaudio use the CUDA index. TorchCodec's Windows wheel lives on PyPI.
    let mut cmd=uv(root); cmd.args(["pip", "install", "--python"]).arg(&python).args(["--default-index", "https://pypi.org/simple", "--torch-backend", "cu128", "torch==2.11.0", "torchaudio==2.11.0"]);
    run_command(cmd, root, cancel).await?;
    let mut cmd=uv(root); cmd.args(["pip", "install", "--python"]).arg(&python).args(["--default-index", "https://pypi.org/simple", "voxcpm==2.0.3", "torch==2.11.0", "torchaudio==2.11.0", "torchcodec==0.14.0", "transformers==5.13.0"]);
    run_command(cmd, root, cancel).await?; check_cancel(cancel)?;
    progress("正在检查配音环境", done);
    let config=Config { python: python.to_string_lossy().into(), model: root.join("model").to_string_lossy().into() };
    if !verify(&config).await { return Err(err("配音环境检查未通过，请确认 NVIDIA 驱动可用后继续准备")); }
    check_cancel(cancel)?; voice::write(&voice::root(paths).join("config.json"), &config)?; Ok(())
}
#[tauri::command]
pub async fn voice_environment(app: AppHandle, paths: State<'_, Arc<LibraryPaths>>, auth: State<'_, AuthClient>, entitlement: State<'_, EntitlementService>, action: String, directory: Option<String>) -> AppResult<Environment> {
    { let mut current=INSTALL.lock().unwrap(); if let Some(job)=current.as_mut() {
        if action=="pause" { job.cancel.store(true, Ordering::Relaxed); job.state.message="正在暂停，已下载的内容会保留".into(); return Ok(job.state.clone()); }
        if job.state.phase=="installing" || action=="status" { return Ok(job.state.clone()); }
    } }
    let location=voice::root(&paths).join("setup-location.json");
    let root=if let Some(directory)=directory { let parent=PathBuf::from(directory).canonicalize()?; if !parent.is_dir() { return Err(err("请选择安装文件夹")); } parent.join("Bowerbird-Voice") }
        else { voice::read::<PathBuf>(&location).unwrap_or(app.path().app_local_data_dir().map_err(|e| err(e.to_string()))?.join("Bowerbird-Voice")) };
    let mut state=inspect(root.clone(), &paths).await?;
    if action=="install" && state.phase!="ready" {
        voice::access(&auth, &entitlement).await?;
        if !state.can_install { return Err(err(state.message)); }
        if root.exists() && std::fs::read_dir(&root)?.next().is_some() && std::fs::read_to_string(root.join("owner.txt")).ok().as_deref()!=Some(VERSION) { return Err(err("该目录已有其他文件，请更换安装位置")); }
        let cancel=Arc::new(AtomicBool::new(false)); state.phase="installing".into(); state.message="正在准备下载".into();
        { let mut current=INSTALL.lock().unwrap(); if current.as_ref().is_some_and(|j| j.state.phase=="installing") { return Ok(current.as_ref().unwrap().state.clone()); }
            std::fs::create_dir_all(&root)?; std::fs::write(root.join("owner.txt"), VERSION)?;
            voice::write(&location,&root)?; voice::write(&root.join("setup.json"),&state)?;
            *current=Some(Install {state:state.clone(),cancel:cancel.clone()});
        }
        let paths=paths.inner().clone();
        tokio::spawn(async move {
            let result=install(&root,&paths,&cancel).await;
            if let Err(error)=&result { tracing::warn!("voice setup: {error}"); }
            if let Some(job)=INSTALL.lock().unwrap().as_mut() {
                job.state.phase=if cancel.load(Ordering::Relaxed) { "paused" } else if result.is_ok() { "ready" } else { "failed" }.into();
                job.state.message=if result.is_ok() { "本机配音已就绪".into() } else if cancel.load(Ordering::Relaxed) { "准备已暂停，已下载文件保留".into() } else { "准备未完成，请检查网络、磁盘或驱动后继续；诊断已保留".into() };
                let _=voice::write(&root.join("setup.json"),&job.state);
            }
        });
    } else {
        let mut current=INSTALL.lock().unwrap();
        if let Some(job)=current.as_ref().filter(|job| job.state.phase=="installing") { return Ok(job.state.clone()); }
        voice::write(&location,&root)?; *current=Some(Install{state:state.clone(),cancel:Arc::new(AtomicBool::new(false))});
    }
    Ok(state)
}
