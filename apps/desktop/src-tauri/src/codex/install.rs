//! Codex CLI 的独立安装与静默更新。所有入口共用锁；新版本先在独立目录校验，
//! 再原子切换 current.json。已运行任务持有的旧路径和私有登录资料始终保留。

use std::future::Future;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use base64::Engine;
use futures_util::StreamExt;
use sha2::{Digest, Sha512};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio::sync::{oneshot, Mutex};

use super::codex_cli::{
    app_data_dir, codex_binary_in, codex_command, npm_command, resolve_codex_binary,
    resolve_npm_binary, stable_version,
};
use crate::error::AppError;

static INSTALL_LOCK: Mutex<()> = Mutex::const_new(());

/// 优先官方源，仅在不可用时尝试镜像；同一次安装始终请求相同版本。
const REGISTRIES: [&str; 2] = [
    "https://registry.npmjs.org",
    "https://registry.npmmirror.com",
];

const METADATA_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const VERSION_TIMEOUT: Duration = Duration::from_secs(20);

/// npm dist 平台后缀（平台子包版本形如 `0.147.0-win32-x64`）。`env::consts` 是编译期
/// 常量，match 会被整体折叠，不支持的架构返回 None。
fn platform_tag() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("win32-x64"),
        ("windows", "aarch64") => Some("win32-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        _ => None,
    }
}

fn cancelled() -> AppError {
    AppError::Codex("已取消".into())
}

/// 进度行经 `codex://setup-progress` 推前端；`percent`（0-100）非空时前端显示进度条。
fn emit_progress(app: &AppHandle, line: &str, percent: Option<u32>) {
    let _ = app.emit(
        "codex://setup-progress",
        serde_json::json!({ "stage": "install", "line": line, "percent": percent }),
    );
}

fn progress(app: Option<&AppHandle>, line: &str, percent: Option<u32>) {
    if let Some(app) = app {
        emit_progress(app, line, percent);
    }
}

fn is_cancelled(error: &AppError) -> bool {
    matches!(error, AppError::Codex(message) if message == "已取消")
}

fn check_cancel(cancel: &mut oneshot::Receiver<()>) -> Result<(), AppError> {
    match cancel.try_recv() {
        Err(oneshot::error::TryRecvError::Empty) => Ok(()),
        _ => Err(cancelled()),
    }
}

async fn cancellable<T>(
    cancel: &mut oneshot::Receiver<()>,
    operation: impl Future<Output = Result<T, AppError>>,
) -> Result<T, AppError> {
    tokio::select! {
        biased;
        _ = &mut *cancel => Err(cancelled()),
        result = operation => result,
    }
}

fn managed_root() -> Result<PathBuf, AppError> {
    app_data_dir()
        .map(|data| data.join("codex-cli"))
        .ok_or_else(|| AppError::Codex("无法定位应用数据目录".into()))
}

fn client() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|error| AppError::Codex(format!("初始化下载失败: {error}")))
}

/// 一键安装与后台更新共用版本安装流程。只有首次未托管安装保留旧 npm 回退。
pub(crate) async fn install_codex(
    app: &AppHandle,
    cancel: &mut oneshot::Receiver<()>,
) -> Result<(), AppError> {
    let _guard = match INSTALL_LOCK.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            emit_progress(app, "正在等待当前更新完成…", None);
            cancellable(cancel, async { Ok(INSTALL_LOCK.lock().await) }).await?
        }
    };
    let root = managed_root()?;
    let was_managed = root.join("current.json").exists() || root.join("vendor").exists();
    let result = async {
        let client = client()?;
        progress(Some(app), "正在获取最新版本…", None);
        let version = latest_version(&client, cancel).await?;
        if let Some(binary) = resolve_codex_binary() {
            if let Ok(installed) = cancellable(cancel, binary_version(&binary)).await {
                if !newer_version(&version, &installed)? {
                    progress(Some(app), "已是最新版本", Some(100));
                    return Ok(());
                }
            }
            check_cancel(cancel)?;
        }
        install_version(&root, &version, &client, Some(app), cancel).await
    }
    .await;
    match result {
        Ok(()) => Ok(()),
        Err(error) if is_cancelled(&error) || was_managed => Err(error),
        Err(standalone_err) => match resolve_npm_binary() {
            Some(npm) => {
                tracing::warn!("Codex 独立安装失败，将尝试 npm: {standalone_err}");
                emit_progress(app, "正在尝试另一种安装方式…", None);
                npm_install(app, &npm, cancel).await
            }
            None => Err(standalone_err),
        },
    }
}

/// 静默更新只接管现有 CLI 的后续版本，不触碰系统安装或用户指定入口。
pub(crate) async fn update_codex(_app: &AppHandle) -> Result<bool, AppError> {
    if std::env::var("BOWERBIRD_CODEX_BINARY").is_ok_and(|value| !value.trim().is_empty()) {
        return Ok(false);
    }
    let _guard = INSTALL_LOCK
        .try_lock()
        .map_err(|_| AppError::Codex("安装正在进行，稍后再检查更新".into()))?;
    let Some(binary) = resolve_codex_binary() else {
        return Ok(false);
    };
    let installed = binary_version(&binary).await?;
    let client = client()?;
    // 发送端存活到本次检查结束，后台任务不会被误判为用户取消。
    let (_cancel_tx, mut cancel) = oneshot::channel();
    let latest = latest_version(&client, &mut cancel).await?;
    if !newer_version(&latest, &installed)? {
        return Ok(false);
    }
    install_version(&managed_root()?, &latest, &client, None, &mut cancel).await?;
    Ok(true)
}

fn newer_version(latest: &str, installed: &str) -> Result<bool, AppError> {
    let latest =
        stable_version(latest).ok_or_else(|| AppError::Codex("更新版本不是稳定发行版".into()))?;
    let installed = stable_version(installed)
        .ok_or_else(|| AppError::Codex("无法确认当前版本，已保留原安装".into()))?;
    Ok(latest > installed)
}

async fn metadata(
    client: &reqwest::Client,
    url: String,
    cancel: &mut oneshot::Receiver<()>,
) -> Result<serde_json::Value, AppError> {
    cancellable(cancel, async {
        client
            .get(url)
            .timeout(METADATA_TIMEOUT)
            .send()
            .await
            .and_then(|response| response.error_for_status())
            .map_err(|error| AppError::Codex(format!("获取版本信息失败: {error}")))?
            .json()
            .await
            .map_err(|error| AppError::Codex(format!("解析版本信息失败: {error}")))
    })
    .await
}

async fn latest_version(
    client: &reqwest::Client,
    cancel: &mut oneshot::Receiver<()>,
) -> Result<String, AppError> {
    let mut last_error = None;
    for registry in REGISTRIES {
        let result = async {
            let meta = metadata(client, format!("{registry}/@openai/codex/latest"), cancel).await?;
            let version = meta["version"]
                .as_str()
                .filter(|value| stable_version(value).is_some())
                .ok_or_else(|| AppError::Codex("未找到有效的稳定版本".into()))?;
            Ok(version.to_owned())
        }
        .await;
        match result {
            Ok(version) => return Ok(version),
            Err(error) if is_cancelled(&error) => return Err(error),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap())
}

async fn binary_version(binary: &str) -> Result<String, AppError> {
    let output = tokio::time::timeout(
        VERSION_TIMEOUT,
        codex_command(binary)
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| AppError::Codex("检查版本超时，已保留原安装".into()))?
    .map_err(|error| AppError::Codex(format!("检查版本失败: {error}")))?;
    if !output.status.success() {
        return Err(AppError::Codex("无法运行此版本，已保留原安装".into()));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let version = text
        .trim()
        .strip_prefix("codex-cli ")
        .filter(|value| stable_version(value).is_some())
        .ok_or_else(|| AppError::Codex("无法确认版本，已保留原安装".into()))?;
    Ok(version.to_owned())
}

fn require_version(actual: &str, expected: &str) -> Result<(), AppError> {
    if actual != expected {
        return Err(AppError::Codex(format!(
            "下载版本与预期不符（{actual} / {expected}），已保留原安装"
        )));
    }
    Ok(())
}

async fn install_version(
    root: &Path,
    version: &str,
    client: &reqwest::Client,
    app: Option<&AppHandle>,
    cancel: &mut oneshot::Receiver<()>,
) -> Result<(), AppError> {
    if stable_version(version).is_none() {
        return Err(AppError::Codex("安装版本无效".into()));
    }
    let tag = platform_tag().ok_or_else(|| AppError::Codex("当前系统暂不支持自动安装".into()))?;
    let versions = root.join("versions");
    std::fs::create_dir_all(&versions)?;
    let destination = versions.join(version);
    // 中断于发布指针之前的完整版本可以复用；绝不覆盖可能仍被任务使用的目录。
    if destination.exists() {
        let binary = codex_binary_in(&destination)
            .ok_or_else(|| AppError::Codex("已有版本文件不完整，已保留原安装".into()))?;
        let actual = cancellable(cancel, binary_version(&binary.to_string_lossy())).await?;
        check_cancel(cancel)?;
        activate_version(root, version, &actual, None)?;
        progress(app, "安装完成", Some(100));
        return Ok(());
    }
    let mut last_error = None;
    for registry in REGISTRIES {
        let result = async {
            let meta = metadata(client, format!("{registry}/@openai/codex/{version}-{tag}"), cancel).await?;
            let tarball = meta["dist"]["tarball"].as_str()
                .ok_or_else(|| AppError::Codex("版本信息缺少下载地址".into()))?;
            let integrity = meta["dist"]["integrity"].as_str()
                .ok_or_else(|| AppError::Codex("缺少安装包校验信息，已停止安装".into()))?.to_owned();
            expected_sha512(&integrity)?;
            let staging = tempfile::Builder::new().prefix(".install-").tempdir_in(root)?;
            let tgz = staging.path().join("codex.tgz");
            download_tarball(app, client, tarball, &tgz, cancel).await?;
            progress(app, "下载完成，正在检查…", Some(99));
            let stop = Arc::new(AtomicBool::new(false));
            let worker_stop = stop.clone();
            let mut worker = tokio::task::spawn_blocking(move || {
                verify_sha512(&tgz, &integrity, &worker_stop)?;
                extract_package(&tgz, staging.path(), &worker_stop)?;
                Ok::<_, AppError>(staging)
            });
            let staging = tokio::select! {
                result = &mut worker => result.map_err(|error| AppError::Codex(format!("安装任务异常退出: {error}")))??,
                _ = &mut *cancel => {
                    stop.store(true, Ordering::Relaxed);
                    // 等待 blocking 清理完成再释放安装锁，取消后绝不继续发布。
                    let _ = worker.await;
                    return Err(cancelled());
                }
            };
            let package = staging.path().join("package");
            let binary = codex_binary_in(&package)
                .ok_or_else(|| AppError::Codex("安装包缺少可执行文件".into()))?;
            let actual = cancellable(cancel, binary_version(&binary.to_string_lossy())).await?;
            check_cancel(cancel)?;
            activate_version(root, version, &actual, Some(&package))?;
            Ok(())
        }.await;
        match result {
            Ok(()) => {
                progress(app, "安装完成", Some(100));
                return Ok(());
            }
            Err(error) if is_cancelled(&error) => return Err(error),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap())
}

/// 流式下载 tarball 到 `dest`，按 content-length 节流推进度；随时可取消。
async fn download_tarball(
    app: Option<&AppHandle>,
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    cancel: &mut oneshot::Receiver<()>,
) -> Result<(), AppError> {
    let resp = cancellable(cancel, async {
        client
            .get(url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| AppError::Codex(format!("下载失败: {e}")))
    })
    .await?;
    let total = resp.content_length();
    if let Some(t) = total {
        progress(
            app,
            &format!("开始下载，约 {:.0} MB", t as f64 / 1048576.0),
            Some(0),
        );
    } else {
        progress(app, "开始下载…", None);
    }

    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| AppError::Codex(format!("创建临时文件失败: {e}")))?;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_pct: Option<u32> = None;
    while let Some(chunk) = tokio::select! {
        c = stream.next() => c,
        _ = &mut *cancel => return Err(cancelled()),
    } {
        let bytes = chunk.map_err(|e| AppError::Codex(format!("下载中断: {e}")))?;
        file.write_all(&bytes).await?;
        downloaded += bytes.len() as u64;
        if let Some(t) = total.filter(|t| *t > 0) {
            let pct = ((downloaded * 100) / t) as u32;
            // 每变 1% 推一行，避免事件刷屏；封顶 99（100 留给校验/解压完成）。
            if last_pct != Some(pct) && pct < 100 {
                last_pct = Some(pct);
                progress(
                    app,
                    &format!(
                        "下载中 {pct}%（{:.0}/{:.0} MB）",
                        downloaded as f64 / 1048576.0,
                        t as f64 / 1048576.0
                    ),
                    Some(pct.min(99)),
                );
            }
        }
    }
    file.flush().await?;
    Ok(())
}

/// sha512 校验（integrity 形如 `sha512-<base64>`；分块读避免整包进内存）。
fn expected_sha512(integrity: &str) -> Result<Vec<u8>, AppError> {
    let expected = integrity
        .strip_prefix("sha512-")
        .ok_or_else(|| AppError::Codex("integrity 算法不是 sha512".into()))?;
    let digest = base64::engine::general_purpose::STANDARD
        .decode(expected)
        .map_err(|_| AppError::Codex("安装包校验信息无效".into()))?;
    if digest.len() != 64 {
        return Err(AppError::Codex("安装包校验信息无效".into()));
    }
    Ok(digest)
}

fn verify_sha512(path: &Path, integrity: &str, stop: &AtomicBool) -> Result<(), AppError> {
    let expected = expected_sha512(integrity)?;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha512::new();
    let mut buf = vec![0u8; 8 * 1024 * 1024];
    loop {
        if stop.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    if hasher.finalize().as_slice() != expected {
        return Err(AppError::Codex(
            "sha512 校验失败，下载可能不完整，请重试".into(),
        ));
    }
    Ok(())
}

/// 只解包普通文件/目录；拒绝链接和路径逃逸，避免归档写出独立 staging。
fn extract_package(tgz: &Path, destination: &Path, stop: &AtomicBool) -> Result<(), AppError> {
    let file = std::fs::File::open(tgz)?;
    let gz = flate2::read::GzDecoder::new(file);
    for entry in tar::Archive::new(gz).entries()? {
        if stop.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        let mut entry = entry?;
        let entry_type = entry.header().entry_type();
        let path = entry.path()?;
        let safe_path = path.starts_with("package")
            && path.components().all(|component| {
                matches!(
                    component,
                    std::path::Component::Normal(_) | std::path::Component::CurDir
                )
            });
        if !safe_path
            || !(entry_type.is_file() || entry_type.is_dir())
            || !entry.unpack_in(destination)?
        {
            return Err(AppError::Codex("安装包包含不支持的文件路径或链接".into()));
        }
    }
    let vendor = destination.join("package/vendor");
    if !vendor.is_dir() {
        return Err(AppError::Codex(
            "tarball 结构异常（缺 package/vendor）".into(),
        ));
    }

    #[cfg(unix)]
    make_vendor_executable(&vendor)?;
    Ok(())
}

fn activate_version(
    root: &Path,
    version: &str,
    actual: &str,
    package: Option<&Path>,
) -> Result<(), AppError> {
    require_version(actual, version)?;
    if stable_version(version).is_none() {
        return Err(AppError::Codex("安装版本无效".into()));
    }
    if let Some(package) = package {
        std::fs::rename(package, root.join("versions").join(version))?;
    }
    publish_current(root, version)
}

/// 同文件系统临时文件 + persist 原子替换；失败时原指针和旧版本保持可用。
fn publish_current(root: &Path, version: &str) -> Result<(), AppError> {
    if stable_version(version).is_none()
        || codex_binary_in(&root.join("versions").join(version)).is_none()
    {
        return Err(AppError::Codex("版本文件不完整，已保留原安装".into()));
    }
    let mut pointer = tempfile::NamedTempFile::new_in(root)?;
    serde_json::to_writer(pointer.as_file_mut(), version)?;
    pointer.flush()?;
    pointer.as_file().sync_all()?;
    pointer
        .persist(root.join("current.json"))
        .map_err(|error| AppError::Io(error.error))?;
    Ok(())
}

/// Unix 下 tar 条目权限可能未被保留，vendor 内文件统一 0755，确保 codex / rg 可执行。
#[cfg(unix)]
fn make_vendor_executable(vendor: &Path) -> Result<(), AppError> {
    use std::os::unix::fs::PermissionsExt;
    fn walk(dir: &Path) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            if path.is_dir() {
                walk(&path)?;
            } else {
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
            }
        }
        Ok(())
    }
    walk(vendor).map_err(AppError::Io)
}

/// npm 回退安装（原 codex_install 主体）：spawn `npm install -g @openai/codex`，
/// 收集 stdout/stderr 供诊断，180s 超时 + 可取消（`kill_on_drop`）。
async fn npm_install(
    app: &AppHandle,
    npm: &str,
    cancel: &mut oneshot::Receiver<()>,
) -> Result<(), AppError> {
    let mut cmd = npm_command(npm, &["install", "-g", "@openai/codex"]);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Codex(format!("启动 npm 失败: {e}")))?;

    // 并发收集 stdout/stderr，工程信息不直接送入安装进度。
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    emit_progress(app, "正在安装，请稍候…", None);
    let stdout_task = tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut lines: Vec<String> = Vec::new();
        if let Some(out) = stdout {
            let mut r = BufReader::new(out).lines();
            while let Ok(Some(line)) = r.next_line().await {
                lines.push(line);
            }
        }
        lines
    });
    let stderr_task = tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut lines: Vec<String> = Vec::new();
        if let Some(e) = stderr {
            let mut r = BufReader::new(e).lines();
            while let Ok(Some(line)) = r.next_line().await {
                lines.push(line);
            }
        }
        lines
    });

    // 等退出（180s 超时 + 可取消；任一分支 return 后 child drop → kill_on_drop 终止 npm）。
    let status = tokio::select! {
        r = tokio::time::timeout(Duration::from_secs(180), child.wait()) => match r {
            Ok(s) => s.map_err(|e| AppError::Codex(format!("等待 npm 失败: {e}")))?,
            Err(_) => return Err(AppError::Codex("npm 安装超时（180s），请重试或检查网络".into())),
        },
        _ = &mut *cancel => return Err(cancelled()),
    };
    let stdout_lines = stdout_task.await.unwrap_or_default();
    let stderr_lines = stderr_task.await.unwrap_or_default();

    if !status.success() {
        // npm 的错误常打在 stdout（进度/错误混合），stderr 可能空；两者拼起来才看得到真因。
        let combined = format!("{}\n{}", stdout_lines.join("\n"), stderr_lines.join("\n"));
        let tail: String = combined.trim().chars().take(500).collect();
        return Err(AppError::Codex(format!(
            "npm 安装失败（退出 {status}）| {tail}"
        )));
    }
    // 复查 codex 二进制是否就位（npm 装完应出现在 %APPDATA%\npm 或 PATH）。
    if resolve_codex_binary().is_none() {
        return Err(AppError::Codex(
            "npm 安装已完成但未找到 codex，请重启应用使其进入 PATH".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fake_binary(root: &Path, contents: &[u8]) -> PathBuf {
        let name = if cfg!(windows) { "codex.exe" } else { "codex" };
        let binary = root.join("vendor/test-triple/bin").join(name);
        fs::create_dir_all(binary.parent().unwrap()).unwrap();
        fs::write(&binary, contents).unwrap();
        binary
    }

    fn tarball(root: &Path, link: bool) -> PathBuf {
        let archive_path = root.join("fixture.tgz");
        let file = fs::File::create(&archive_path).unwrap();
        let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
        let mut archive = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o755);
        if link {
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            header.set_link_name("../../outside").unwrap();
            header.set_cksum();
            archive
                .append_data(&mut header, "package/vendor/unsafe-link", std::io::empty())
                .unwrap();
        } else {
            let name = if cfg!(windows) { "codex.exe" } else { "codex" };
            header.set_size(4);
            header.set_cksum();
            archive
                .append_data(
                    &mut header,
                    format!("package/vendor/test-triple/bin/{name}"),
                    &b"fake"[..],
                )
                .unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap();
        archive_path
    }

    #[test]
    fn platform_tag_matches_build_target() {
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        assert_eq!(platform_tag(), Some("win32-x64"));
        #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
        assert_eq!(platform_tag(), Some("win32-arm64"));
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        assert_eq!(platform_tag(), Some("darwin-arm64"));
        #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
        assert_eq!(platform_tag(), Some("darwin-x64"));
    }

    #[test]
    fn stable_updates_never_downgrade_or_install_prereleases() {
        assert!(newer_version("0.147.0", "0.99.0").unwrap());
        assert!(newer_version("1.0.0", "0.999.999").unwrap());
        assert!(!newer_version("0.147.0", "0.147.0").unwrap());
        assert!(!newer_version("0.146.9", "0.147.0").unwrap());
        assert!(newer_version("0.148.0-alpha.1", "0.147.0").is_err());
        assert!(newer_version("0.148.0", "unknown").is_err());
    }

    #[test]
    fn sha512_is_required_and_rejects_tampering() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("package.tgz");
        fs::write(&path, b"original").unwrap();
        let integrity = format!(
            "sha512-{}",
            base64::engine::general_purpose::STANDARD.encode(Sha512::digest(b"original"))
        );
        let stop = AtomicBool::new(false);
        verify_sha512(&path, &integrity, &stop).unwrap();
        fs::write(&path, b"changed").unwrap();
        assert!(verify_sha512(&path, &integrity, &stop).is_err());
        for invalid in ["", "sha1-abc", "sha512-abc", "sha512-!!!!"] {
            assert!(verify_sha512(&path, invalid, &stop).is_err());
        }
        assert!(!fixture.path().join("current.json").exists());
    }

    #[test]
    fn extraction_is_isolated_and_rejects_links() {
        let fixture = tempfile::tempdir().unwrap();
        let archive = tarball(fixture.path(), false);
        let destination = fixture.path().join("unpacked");
        fs::create_dir(&destination).unwrap();
        extract_package(&archive, &destination, &AtomicBool::new(false)).unwrap();
        assert!(codex_binary_in(&destination.join("package")).is_some());
        assert!(!fixture.path().join("current.json").exists());
        let unsafe_archive = tarball(fixture.path(), true);
        assert!(extract_package(&unsafe_archive, &destination, &AtomicBool::new(false)).is_err());
        assert!(!fixture.path().join("outside").exists());
    }

    #[test]
    fn activation_requires_matching_version_and_preserves_old_files() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let old = fake_binary(&root.join("versions/0.146.0"), b"old");
        let legacy = fake_binary(root, b"legacy");
        publish_current(root, "0.146.0").unwrap();
        let package = root.join("staging/package");
        fake_binary(&package, b"new");
        assert!(activate_version(root, "0.147.0", "0.146.0", Some(&package)).is_err());
        assert_eq!(
            fs::read_to_string(root.join("current.json")).unwrap(),
            "\"0.146.0\""
        );
        assert!(!root.join("versions/0.147.0").exists());
        activate_version(root, "0.147.0", "0.147.0", Some(&package)).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("current.json")).unwrap(),
            "\"0.147.0\""
        );
        assert_eq!(fs::read(&old).unwrap(), b"old");
        assert_eq!(fs::read(&legacy).unwrap(), b"legacy");
        assert!(publish_current(root, "0.148.0").is_err());
        assert!(publish_current(root, "../outside").is_err());
        assert_eq!(
            fs::read_to_string(root.join("current.json")).unwrap(),
            "\"0.147.0\""
        );
    }

    #[test]
    fn failed_pointer_replace_keeps_old_version_and_valid_download() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let old = fake_binary(&root.join("versions/0.146.0"), b"old");
        let package = root.join("staging/package");
        fake_binary(&package, b"new");
        // 目录占位模拟 Windows 指针替换失败；旧目录始终不移动或删除。
        fs::create_dir(root.join("current.json")).unwrap();
        assert!(activate_version(root, "0.147.0", "0.147.0", Some(&package)).is_err());
        assert_eq!(fs::read(old).unwrap(), b"old");
        assert!(codex_binary_in(&root.join("versions/0.147.0")).is_some());
        assert!(root.join("current.json").is_dir());
    }

    #[tokio::test]
    async fn install_lock_and_cancellation_prevent_concurrent_work() {
        let guard = INSTALL_LOCK.lock().await;
        assert!(INSTALL_LOCK.try_lock().is_err());
        let (sender, mut cancel) = oneshot::channel();
        sender.send(()).unwrap();
        let result = cancellable(&mut cancel, async { Ok(INSTALL_LOCK.lock().await) }).await;
        assert!(matches!(result, Err(error) if is_cancelled(&error)));
        drop(guard);
        assert!(INSTALL_LOCK.try_lock().is_ok());
    }

    #[test]
    fn cancelled_verification_does_not_unpack() {
        let fixture = tempfile::tempdir().unwrap();
        let archive = tarball(fixture.path(), false);
        let stop = AtomicBool::new(true);
        assert!(extract_package(&archive, fixture.path(), &stop).is_err());
        assert!(!fixture.path().join("package").exists());
    }
}
