//! Opt-in, isolated Windows portable setup. Detection never installs or starts a process.
use std::{path::{Path, PathBuf}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use crate::{cloud::{AuthClient, EntitlementService}, error::{AppError, AppResult}};
use super::comfy_video;
use super::comfy_discovery::{self, Installation};

const MANAGED_ENDPOINT: &str = "http://127.0.0.1:18188";
const VERSION: &str = "h3-v1-comfy-0.42.1";
const RESERVE: u64 = 12 * 1024 * 1024 * 1024;
struct Download { file: &'static str, url: &'static str, size: u64, sha: &'static str }
fn label(item: &Download) -> &'static str {
    if item.file == "portable.7z" { "ComfyUI 与 Python" }
    else if item.file.contains("diffusion_models/") { "视频主模型" }
    else if item.file.contains("text_encoders/") { "文本理解模型" }
    else if item.file.contains("audio_vae") { "音频解码模型" }
    else if item.file.contains("video_vae") { "画面解码模型" }
    else { "8 步加速模型" }
}
// Pinned upstream revisions and LFS hashes; never substitute a similarly named LoRA.
const DOWNLOADS: &[Download] = &[
    Download { file: "portable.7z", url: "https://github.com/Comfy-Org/ComfyUI/releases/download/v0.42.1/ComfyUI_windows_portable_nvidia.7z", size: 2018444114, sha: "496afd18790ec685d99ebba2edf200d7371a29fbdd3a992bb0f4f52f244a6874" },
    Download { file: "models/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors", url: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/e5eb578a89295337b8ff433a035929ce0279e0b6/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors", size: 20970379616, sha: "e889202c41dafb67b10d67b97f0d8541508036a6090af23425a5c2615d03c47a" },
    Download { file: "models/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", url: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/e5eb578a89295337b8ff433a035929ce0279e0b6/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", size: 15687142551, sha: "35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6" },
    Download { file: "models/vae/minimax_h3_audio_vae_fp32.safetensors", url: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/e5eb578a89295337b8ff433a035929ce0279e0b6/vae/minimax_h3_audio_vae_fp32.safetensors", size: 605254808, sha: "8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48" },
    Download { file: "models/vae/minimax_h3_video_vae_int8_convrot.safetensors", url: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/e5eb578a89295337b8ff433a035929ce0279e0b6/vae/minimax_h3_video_vae_int8_convrot.safetensors", size: 2811065184, sha: "52a2c8c73583c86e4f41cdcce3a6ad0ea562987bc0bf3d60a0cef5f5c8e60c0e" },
    Download { file: "models/loras/minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors", url: "https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/a29e57d195f80ead07c89f89e55ecf2911e893c5/minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors", size: 1956193000, sha: "08cfe946033af7d27719b964b6e0a0e50c32138daabbd6ce4137e23df6bf9980" },
];
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    phase: String, message: String, endpoint: String, directory: String,
    can_install: bool, installed: bool, download_bytes: u64, required_bytes: u64,
    completed_bytes: u64, total_bytes: u64,
    existing: Vec<Installation>,
}
struct Job { owner: String, state: Environment, cancel: Arc<AtomicBool> }
static JOB: Mutex<Option<Job>> = Mutex::new(None);
fn err(message: impl Into<String>) -> AppError { AppError::Other(message.into()) }
fn active(state: &Environment) -> bool { matches!(state.phase.as_str(), "installing" | "starting") }
fn progress(message: String, bytes: u64) {
    if let Some(job) = JOB.lock().unwrap().as_mut() { job.state.message = message; job.state.completed_bytes = bytes; }
}
fn cancelled(cancel: &AtomicBool) -> AppResult<()> {
    if cancel.load(Ordering::Relaxed) { Err(err("已取消，保留已下载文件，下次可继续")) } else { Ok(()) }
}
fn config(app: &AppHandle) -> AppResult<PathBuf> { Ok(app.path().app_local_data_dir().map_err(|e| err(e.to_string()))?.join("comfy-install-location.json")) }
fn location(app: &AppHandle, directory: Option<String>) -> AppResult<PathBuf> {
    if let Some(directory) = directory {
        let parent = PathBuf::from(directory).canonicalize()?;
        if !parent.is_dir() { return Err(err("请选择安装文件夹")); }
        return Ok(parent.join("Bowerbird-ComfyUI"));
    }
    if let Ok(data) = std::fs::read(config(app)?) {
        let path: PathBuf = serde_json::from_slice(&data)?;
        if path.is_absolute() { return Ok(path); }
    }
    Ok(app.path().app_local_data_dir().map_err(|e| err(e.to_string()))?.join("Bowerbird-ComfyUI"))
}
fn portable(root: &Path) -> PathBuf { root.join("ComfyUI_windows_portable") }
fn installed(root: &Path) -> bool {
    std::fs::read_to_string(root.join("ready.txt")).ok().as_deref() == Some(VERSION)
        && portable(root).join("python_embeded/python.exe").is_file() && portable(root).join("ComfyUI/main.py").is_file()
        && root.join("models.yaml").is_file()
        && DOWNLOADS.iter().skip(1).all(|item| std::fs::metadata(root.join(item.file)).is_ok_and(|m| m.len() == item.size))
}
fn command(name: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut cmd = std::process::Command::new(name);
    #[cfg(windows)] { use std::os::windows::process::CommandExt; cmd.creation_flags(0x08000000); }
    cmd
}
fn prerequisites() -> Result<(), String> {
    if !cfg!(all(windows, target_arch = "x86_64")) { return Err("一键安装目前支持 Windows x64 + NVIDIA；其他系统请连接已有 ComfyUI".into()); }
    let gpu = command("nvidia-smi").args(["--query-gpu=driver_version", "--format=csv,noheader"]).output().map_err(|_| "未检测到 NVIDIA 驱动，请安装显卡驱动后重新检测")?;
    if !gpu.status.success() { return Err("NVIDIA 驱动不可用，请先安装或更新驱动".into()); }
    // CUDA 13 Windows minimum driver branch (official portable uses cu130).
    if !String::from_utf8_lossy(&gpu.stdout).lines().any(|line| line.trim().split('.').next().and_then(|v| v.parse::<u32>().ok()).is_some_and(|v| v >= 580)) {
        return Err("此安装包需要 NVIDIA 580 或更新驱动，请更新驱动后重新检测".into());
    }
    if !command("tar.exe").arg("--version").output().is_ok_and(|out| out.status.success()) { return Err("未找到 Windows tar 解压工具，请更新 Windows 或连接已有 ComfyUI".into()); }
    Ok(())
}
fn free_bytes(path: &Path) -> AppResult<u64> {
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        let mut ancestor = path;
        while !ancestor.exists() { ancestor = ancestor.parent().ok_or_else(|| err("安装磁盘不可用"))?; }
        let wide: Vec<u16> = ancestor.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut available = 0;
        unsafe { windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(windows::core::PCWSTR(wide.as_ptr()), Some(&mut available), None, None) }.map_err(|e| err(e.to_string()))?;
        Ok(available)
    }
    #[cfg(not(windows))] { let _ = path; Err(err("此平台暂不支持一键安装")) }
}
fn plan(root: &Path) -> Environment {
    let download_bytes = DOWNLOADS.iter().map(|item| {
        let path = root.join(item.file);
        let bytes = std::fs::metadata(&path).or_else(|_| std::fs::metadata(path.with_extension("part"))).map(|m| m.len()).unwrap_or(0);
        item.size.saturating_sub(bytes.min(item.size))
    }).sum();
    Environment { phase: "missing".into(), message: "未发现运行中的 ComfyUI，也未找到已登记的安装".into(), endpoint: MANAGED_ENDPOINT.into(), directory: root.to_string_lossy().into(), can_install: false, installed: installed(root), download_bytes, required_bytes: download_bytes + RESERVE, completed_bytes: 0, total_bytes: DOWNLOADS.iter().map(|d| d.size).sum(), existing: Vec::new() }
}
async fn probe(http: &reqwest::Client, base: &str) -> Option<AppResult<()>> {
    let response = match http.get(format!("{base}/system_stats")).timeout(Duration::from_secs(8)).send().await {
        Ok(response) => response,
        // Windows may report an unopened loopback port as a connect timeout instead of refused.
        // No HTTP connection was established; filesystem discovery still identifies stopped installs.
        Err(error) if error.is_connect() => return None,
        Err(_) => return Some(Err(err("本机服务检查超时或连接异常，请稍后重新检测；不能据此判断未安装"))),
    };
    let system = response.json::<serde_json::Value>().await;
    if !system.as_ref().is_ok_and(|v| v["system"].is_object()) {
        // Common ports can belong to unrelated apps. A generic HTTP response is not a ComfyUI installation.
        return None;
    }
    Some(comfy_video::check(http, base).await)
}
async fn detect(root: &Path, preferred: &str, existing: Vec<Installation>) -> AppResult<Environment> {
    let preferred = comfy_video::endpoint(preferred)?;
    let mut state = plan(root);
    state.existing = existing;
    let http = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(2)).timeout(Duration::from_secs(45)).build().map_err(|e| err(e.to_string()))?;
    let mut endpoints = vec![preferred, MANAGED_ENDPOINT.into(), "http://127.0.0.1:18189".into(), "http://127.0.0.1:8000".into(), "http://127.0.0.1:8188".into()];
    endpoints.extend(state.existing.iter().map(|i| i.endpoint.clone()));
    let mut seen = std::collections::HashSet::new(); endpoints.retain(|value| seen.insert(value.clone()));
    let results = futures_util::future::join_all(endpoints.iter().map(|base| probe(&http, base))).await;
    for (base, result) in endpoints.iter().zip(&results) {
        if matches!(result, Some(Ok(()))) { state.phase = "ready".into(); state.endpoint = base.clone(); state.message = "本机环境已就绪 · 模型与节点可用".into(); return Ok(state); }
    }
    if let Some((base, Some(Err(error)))) = endpoints.iter().zip(&results).find(|(_, r)| r.is_some()) {
        state.phase = "unavailable".into(); state.endpoint = base.clone();
        state.message = format!("服务尚未通过检查（{base}）：{error}"); return Ok(state);
    }
    if let Some(instance) = state.existing.first() {
        state.phase = "stopped".into(); state.endpoint = instance.endpoint.clone();
        state.message = format!("已找到 {}，但服务未启动。{}", instance.name,
            if instance.can_start { "可直接启动已有环境，无需重新下载。" } else { "请在 ComfyUI Desktop 中启动后重新检测。" });
        return Ok(state);
    }
    let support = tokio::task::spawn_blocking(prerequisites).await.map_err(|e| err(e.to_string()))?;
    match support {
        Ok(()) => {
            match free_bytes(root) {
                Ok(bytes) if bytes >= state.required_bytes || state.installed => { state.can_install = true; }
                Ok(_) => state.message.push_str("。安装磁盘空间不足，请更换位置"),
                Err(error) => state.message.push_str(&format!("。无法检查安装磁盘：{error}")),
            }
        }
        Err(reason) => state.message.push_str(&format!("。{reason}")),
    }
    Ok(state)
}
async fn hash(path: &Path, cancel: &AtomicBool) -> AppResult<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut sha = Sha256::new(); let mut buf = vec![0; 1024 * 1024];
    loop { cancelled(cancel)?; let read = file.read(&mut buf).await?; if read == 0 { break; } sha.update(&buf[..read]); }
    Ok(format!("{:x}", sha.finalize()))
}
async fn download(http: &reqwest::Client, item: &Download, root: &Path, cancel: &AtomicBool, done: u64) -> AppResult<()> {
    cancelled(cancel)?;
    let target = root.join(item.file); let part = target.with_extension("part");
    tokio::fs::create_dir_all(target.parent().unwrap()).await?;
    if target.is_file() {
        progress(format!("正在校验{}…", label(item)), done);
        if tokio::fs::metadata(&target).await?.len() == item.size && hash(&target, cancel).await? == item.sha { return Ok(()); }
        return Err(err(format!("已存在的文件校验失败：{}。请移走该文件后重试", target.display())));
    }
    let mut offset = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
    if offset > item.size { return Err(err("断点文件大小异常，请更换安装位置")); }
    if offset < item.size {
        let mut request = http.get(item.url);
        if offset > 0 { request = request.header(reqwest::header::RANGE, format!("bytes={offset}-")); }
        let mut response = tokio::select! {
            result = request.send() => result.map_err(|e| err(format!("下载连接失败，可重试：{e}")))?,
            _ = wait_cancel(cancel) => return cancelled(cancel),
        };
        if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
            let expected = format!("bytes {offset}-{}/{}", item.size - 1, item.size);
            if response.headers().get(reqwest::header::CONTENT_RANGE).and_then(|h| h.to_str().ok()) != Some(expected.as_str()) { return Err(err("下载服务器返回了错误的断点范围")); }
        } else if response.status() == reqwest::StatusCode::OK { offset = 0; }
        else { return Err(err(format!("下载服务返回 {}，可稍后重试", response.status()))); }
        let mut file = tokio::fs::OpenOptions::new().create(true).write(true).truncate(offset == 0).append(offset > 0).open(&part).await?;
        loop {
            let chunk = tokio::select! {
                result = response.chunk() => result.map_err(|e| err(format!("下载中断，可继续：{e}")))?,
                _ = wait_cancel(cancel) => { file.sync_all().await?; return cancelled(cancel); },
            };
            let Some(chunk) = chunk else { break; };
            if offset + chunk.len() as u64 > item.size { return Err(err("下载文件超过已知大小")); }
            file.write_all(&chunk).await?; offset += chunk.len() as u64;
            progress(format!("正在下载{}…", label(item)), done + offset);
        }
        file.sync_all().await?;
    }
    progress(format!("正在校验{}…", label(item)), done + offset);
    if offset != item.size { return Err(err("下载不完整，点击重试可继续下载")); }
    if hash(&part, cancel).await? != item.sha { tokio::fs::remove_file(&part).await?; return Err(err("下载校验失败，损坏的临时文件已清除，请重试")); }
    tokio::fs::rename(part, target).await?;
    Ok(())
}
async fn wait_cancel(cancel: &AtomicBool) { while !cancel.load(Ordering::Relaxed) { tokio::time::sleep(Duration::from_millis(200)).await; } }
async fn install(app: &AppHandle, root: &Path, cancel: &AtomicBool, owner: &str) -> AppResult<()> {
    prerequisites().map_err(err)?;
    let state = plan(root);
    if !state.installed && free_bytes(root)? < state.required_bytes { return Err(err("安装磁盘空间不足，请更换位置后重试")); }
    let marker = root.join("bowerbird-setup.txt");
    if root.exists() && !marker.is_file() && std::fs::read_dir(root)?.next().is_some() { return Err(err("此安装位置已有其他文件，请选择空文件夹")); }
    tokio::fs::create_dir_all(root).await?;
    tokio::fs::write(&marker, VERSION).await?;
    let location = config(app)?;
    tokio::fs::create_dir_all(location.parent().unwrap()).await?;
    tokio::fs::write(location, serde_json::to_vec(root)?).await?;
    let check_owner = || -> AppResult<()> {
        cancelled(cancel)?;
        if app.state::<AuthClient>().snapshot().user_id.as_deref() != Some(owner) { return Err(err("账号已切换，安装已停止")); }
        Ok(())
    };
    if !state.installed {
        let http = reqwest::Client::builder().https_only(true).connect_timeout(Duration::from_secs(30)).read_timeout(Duration::from_secs(60)).build().map_err(|e| err(e.to_string()))?;
        let mut done = 0;
        for item in DOWNLOADS { check_owner()?; download(&http, item, root, cancel, done).await?; done += item.size; }
        check_owner()?; progress("正在解压 ComfyUI 与 Python 环境…".into(), done);
        let mut child = command("tar.exe").arg("-xf").arg(root.join("portable.7z")).arg("-C").arg(root).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn()?;
        loop {
            if let Err(error) = check_owner() { let _ = child.kill(); let _ = child.wait(); return Err(error); }
            if let Some(status) = child.try_wait()? { if !status.success() { return Err(err("解压失败，请检查磁盘空间与 Windows tar 版本后重试")); } break; }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        // JSON is valid YAML; a separate configuration never overwrites an existing user's config.
        let model_config = serde_json::json!({"bowerbird": {"base_path":root.join("models"),"diffusion_models":"diffusion_models","text_encoders":"text_encoders","vae":"vae","loras":"loras"}});
        tokio::fs::write(root.join("models.yaml"), serde_json::to_vec_pretty(&model_config)?).await?;
        tokio::fs::write(root.join("ready.txt"), VERSION).await?;
    }
    check_owner()?;
    // Never start over an occupied port, even if it belongs to another ComfyUI.
    if tokio::net::TcpStream::connect("127.0.0.1:18188").await.is_ok() { return Err(err("端口 18188 已被占用，请重新检测或关闭占用该端口的程序")); }
    progress("正在启动本机环境并检查模型…".into(), state.total_bytes);
    let mut cmd = command(portable(root).join("python_embeded/python.exe"));
    cmd.current_dir(portable(root)).args(["-s", "ComfyUI/main.py", "--windows-standalone-build", "--listen", "127.0.0.1", "--port", "18188", "--disable-auto-launch", "--extra-model-paths-config"])
        .arg(root.join("models.yaml"));
    launch(app, cmd, MANAGED_ENDPOINT, &root.join("startup.log"), cancel, owner).await
}
fn startup_log_tail(path: &Path) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let read = || -> std::io::Result<String> {
        let mut file = std::fs::File::open(path)?;
        file.seek(SeekFrom::End(-(file.metadata()?.len().min(65536) as i64)))?;
        let mut bytes = Vec::new();
        file.take(65536).read_to_end(&mut bytes)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    };
    read().unwrap_or_default()
}
fn startup_failure(log: &str, path: &Path) -> AppError {
    let detail = log.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("进程已退出，未提供错误详情");
    let detail: String = detail.chars().take(600).collect();
    err(format!("ComfyUI 启动失败：{detail}。日志：{}", path.display()))
}
async fn launch(app: &AppHandle, mut cmd: std::process::Command, endpoint: &str, log_path: &Path, cancel: &AtomicBool, owner: &str) -> AppResult<()> {
    cancelled(cancel)?;
    let http = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(30)).build().map_err(|e| err(e.to_string()))?;
    let log = std::fs::File::create(log_path)?;
    let mut child = cmd.stdin(std::process::Stdio::null()).stdout(log.try_clone()?).stderr(log).spawn()?;
    let mut reason = String::new();
    for _ in 0..120 {
        if cancel.load(Ordering::Relaxed) || app.state::<AuthClient>().snapshot().user_id.as_deref() != Some(owner) {
            let _ = child.kill(); let _ = child.wait(); return Err(err("已取消本次启动"));
        }
        if child.try_wait()?.is_some() {
            let log = startup_log_tail(log_path);
            return Err(startup_failure(&log, log_path));
        }
        match comfy_video::check(&http, endpoint).await { Ok(()) => return Ok(()), Err(error) => reason = error.to_string() }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let _ = child.kill(); let _ = child.wait();
    Err(err(format!("启动检查未通过：{reason}。日志：{}", log_path.display())))
}
async fn start_existing(app: &AppHandle, instance: &Installation, cancel: &AtomicBool, owner: &str) -> AppResult<()> {
    let python = instance.python.as_ref().ok_or_else(|| err("未找到此安装的 Python，请在 ComfyUI Desktop 中启动"))?;
    if tokio::net::TcpStream::connect("127.0.0.1:18189").await.is_ok() { return Err(err("已有环境启动端口 18189 被占用，请重新检测")); }
    let logs = app.path().app_local_data_dir().map_err(|e| err(e.to_string()))?.join("comfy-existing");
    tokio::fs::create_dir_all(&logs).await?;
    let mut cmd = command(python);
    cmd.current_dir(instance.main.parent().unwrap()).arg("-s").arg(&instance.main)
        .args(["--listen", "127.0.0.1", "--port", "18189", "--disable-auto-launch"]).args(&instance.launch_args);
    if !instance.model_configs.is_empty() { cmd.arg("--extra-model-paths-config").args(&instance.model_configs); }
    launch(app, cmd, "http://127.0.0.1:18189", &logs.join("startup.log"), cancel, owner).await
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

#[tauri::command]
pub async fn comfy_video_environment(app: AppHandle, auth: State<'_, AuthClient>, entitlement: State<'_, EntitlementService>, action: String, endpoint: String, directory: Option<String>, existing_directory: Option<String>) -> AppResult<Environment> {
    let owner = comfy_video::account(&auth, &entitlement).await?;
    if !matches!(action.as_str(), "detect" | "status" | "prepare" | "install" | "cancel" | "select_existing" | "start_existing") { return Err(err("不支持的环境操作")); }
    {
        let job = JOB.lock().unwrap();
        if let Some(job) = job.as_ref() {
            if active(&job.state) {
                if job.owner != owner { return Err(err("另一个账号的环境安装正在进行")); }
                if action == "cancel" { job.cancel.store(true, Ordering::Relaxed); }
                return Ok(job.state.clone());
            }
            if action == "status" && job.owner == owner { return Ok(job.state.clone()); }
        }
    }
    let selection_file = config(&app)?.with_file_name("comfy-existing-location.json");
    let saved: Option<PathBuf> = std::fs::read(&selection_file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let selected = existing_directory.map(PathBuf::from).or(saved);
    let config_dirs = comfy_discovery::desktop_config_dirs();
    let names = comfy_video::model_names();
    let mut existing = comfy_discovery::discover(&config_dirs, selected.as_deref(), &names);
    if matches!(action.as_str(), "select_existing" | "start_existing") {
        let first = existing.first().ok_or_else(|| err("所选文件夹未找到 ComfyUI。请选择 Desktop 安装总目录、具体实例目录或便携版目录"))?;
        std::fs::create_dir_all(selection_file.parent().unwrap())?;
        std::fs::write(&selection_file, serde_json::to_vec(&first.path)?)?;
    }
    // Older UI called this "更换位置". Never interpret an existing installation as a download destination.
    if let Some(directory) = directory.as_deref() {
        let located = comfy_discovery::discover(&config_dirs, Some(Path::new(directory)), &names);
        if !located.is_empty() {
            if action == "install" { return Err(err("所选位置是已有 ComfyUI，请使用“选择已有 ComfyUI”连接，避免重复安装")); }
            existing = located;
        }
    }
    let root = location(&app, directory)?;
    let mut state = detect(&root, &endpoint, existing).await?;
    if !matches!(action.as_str(), "prepare" | "install" | "start_existing") { return Ok(state); }
    if state.phase == "ready" { return Ok(state); }
    let start = preparation_target(&state, &action)?;
    let cancel = Arc::new(AtomicBool::new(false));
    state.phase = if start.is_some() || state.installed { "starting" } else { "installing" }.into();
    state.message = if state.phase == "starting" { "正在启动已有 ComfyUI 并检查模型…" } else { "正在准备本机环境…" }.into();
    {
        let mut job = JOB.lock().unwrap();
        if let Some(job) = job.as_ref().filter(|job| active(&job.state)) {
            if job.owner == owner { return Ok(job.state.clone()); }
            return Err(err("另一个账号的环境准备正在进行"));
        }
        *job = Some(Job { owner: owner.clone(), state: state.clone(), cancel: cancel.clone() });
    }
    tauri::async_runtime::spawn(async move {
        // Downloads may take hours. Stop promptly on logout/account switch, including mid-file.
        let watcher_app = app.clone(); let watcher_owner = owner.clone(); let watcher_cancel = cancel.clone();
        let watcher = tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let login = watcher_app.state::<AuthClient>().snapshot();
                if !login.logged_in || login.user_id.as_deref() != Some(watcher_owner.as_str()) { watcher_cancel.store(true, Ordering::Relaxed); break; }
            }
        });
        let result = if let Some(instance) = &start { start_existing(&app, instance, &cancel, &owner).await } else { install(&app, &root, &cancel, &owner).await };
        watcher.abort();
        if let Some(job) = JOB.lock().unwrap().as_mut() {
            let remaining = plan(&root);
            job.state.download_bytes = remaining.download_bytes;
            job.state.required_bytes = remaining.required_bytes;
            job.state.installed = remaining.installed;
            match result {
                Ok(()) => { job.state.phase = "ready".into(); job.state.endpoint = if start.is_some() { "http://127.0.0.1:18189" } else { MANAGED_ENDPOINT }.into(); job.state.message = "本机环境已就绪 · 可以生成视频".into(); job.state.installed = start.is_none(); }
                Err(error) => { job.state.phase = if cancel.load(Ordering::Relaxed) { "cancelled" } else { "failed" }.into(); job.state.message = error.to_string(); }
            }
        }
    });
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, routing::get, http::{HeaderMap, StatusCode}, response::IntoResponse};
    fn scratch() -> PathBuf {
        let root = std::env::temp_dir().join(format!("bowerbird-h3-setup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap(); root
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
        let mut state = plan(&scratch()); state.can_install = true;
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
        state.phase = "unavailable".into();
        assert!(preparation_target(&state, "prepare").is_err(), "never duplicate a responding but incompatible service");
        state.phase = "stopped".into(); state.existing[0].can_start = false;
        assert!(preparation_target(&state, "prepare").is_err(), "missing Python requires a usable installation");
    }
    #[test]
    fn h3_setup_manifest_and_empty_plan() {
        let root = scratch(); let state = plan(&root);
        assert!(!state.installed); assert!(!root.join("ready.txt").exists());
        assert_eq!(state.download_bytes, 44_048_479_273);
        for item in DOWNLOADS {
            assert_eq!(item.sha.len(), 64);
            assert!(item.sha.chars().all(|c| c.is_ascii_hexdigit()));
            assert!(item.url.starts_with("https://"));
            assert!(!Path::new(item.file).is_absolute());
        }
        assert!(DOWNLOADS[5].url.contains("768p"));
        assert_eq!(DOWNLOADS[5].sha, "08cfe946033af7d27719b964b6e0a0e50c32138daabbd6ce4137e23df6bf9980");
    }
    #[tokio::test]
    async fn h3_setup_slow_server_is_detected_and_model_failure_is_not_missing_install() {
        let server = Router::new()
            .route("/system_stats", get(|| async {
                tokio::time::sleep(Duration::from_millis(4200)).await;
                axum::Json(serde_json::json!({"system":{"comfyui_version":"fixture"}}))
            }))
            .route("/object_info", get(|| async { axum::Json(serde_json::json!({})) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
        let http = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(10)).build().unwrap();
        let result = probe(&http, &format!("http://{address}")).await;
        assert!(matches!(result, Some(Err(_))), "slow live server is recognized even if H3 nodes are unavailable");
        assert!(result.unwrap().unwrap_err().to_string().contains("H3"));
        task.abort();
    }
    #[tokio::test]
    #[ignore = "Read-only local installation and HTTP checks; no startup, installation or generation"]
    async fn h3_setup_local_environment_read_only() {
        let existing = comfy_discovery::discover(&comfy_discovery::desktop_config_dirs(), None, &comfy_video::model_names());
        assert!(!existing.is_empty());
        let state = detect(&scratch(), "http://127.0.0.1:8000", existing).await.unwrap();
        println!("local environment: {} | {} | {} installation(s)", state.phase, state.message, state.existing.len());
        assert_ne!(state.phase, "missing"); assert!(!state.can_install);
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
        let item = |route: &str| Download { file:"model.bin", url:Box::leak(format!("http://{address}/{route}").into_boxed_str()), size:6, sha:Box::leak(sha.clone().into_boxed_str()) };
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let cancel = AtomicBool::new(false);
        for route in ["resume", "whole"] {
            let root = scratch(); std::fs::write(root.join("model.part"), b"abc").unwrap();
            download(&http, &item(route), &root, &cancel, 0).await.unwrap();
            assert_eq!(std::fs::read(root.join("model.bin")).unwrap(), b"abcdef");
            // A complete verified file must be reused, without another HTTP request.
            download(&http, &item("not-found"), &root, &cancel, 0).await.unwrap();
        }
        let root = scratch(); std::fs::write(root.join("model.part"), b"abc").unwrap();
        assert!(download(&http, &item("wrong-range"), &root, &cancel, 0).await.is_err());
        assert_eq!(std::fs::read(root.join("model.part")).unwrap(), b"abc");
        let root = scratch();
        assert!(download(&http, &item("corrupt"), &root, &cancel, 0).await.is_err());
        assert!(!root.join("model.bin").exists()); assert!(!root.join("model.part").exists());
        cancel.store(true, Ordering::Relaxed);
        assert!(download(&http, &item("whole"), &root, &cancel, 0).await.is_err());
        assert!(!root.join("model.part").exists());
        task.abort();
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
