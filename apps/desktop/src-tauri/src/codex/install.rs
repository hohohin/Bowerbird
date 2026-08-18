//! codex CLI 一键安装（免 Node 直装 + npm 回退）。
//!
//! `@openai/codex` 的 npm 主包只是 Node 启动器，CLI 本体是 Rust 二进制，随平台子包
//! `@openai/codex@{version}-{platform}` 发布——tarball 内 `package/vendor/<triple>/`
//! 即完整发行版（含 rg / sandbox 工具），解出即可独立运行，实测不依赖 Node。
//! 因此一键安装直接从 npm registry（npmmirror 优先、npmjs 兜底）下载平台包
//! tarball，sha512 校验后解压到 `{app_data}/codex-cli/`，`resolve_codex_binary`
//! 优先取该托管副本：用户全程无需安装 Node.js / npm，不改系统 PATH、不弹 UAC。
//! 直装失败（如内网只剩 npm 镜像可达）且本机有 npm 时，回退原 `npm install -g`。

use std::io::Read;
use std::path::Path;
use std::time::Duration;

use base64::Engine;
use futures_util::StreamExt;
use sha2::{Digest, Sha512};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio::sync::oneshot;

use super::codex_cli::{app_data_dir, codex_command, npm_command, resolve_codex_binary, resolve_npm_binary};
use crate::error::AppError;

/// npmmirror（国内快）在前，npmjs 官方源兜底。
const REGISTRIES: [&str; 2] = ["https://registry.npmmirror.com", "https://registry.npmjs.org"];

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

/// 一键安装入口：先免 Node 直装独立版；失败且本机有 npm 时回退 `npm install -g`。
/// `cancel` 由命令层（SETUP_CANCEL）传入，下载流 / npm 等待处响应取消。
pub(crate) async fn install_codex(
    app: &AppHandle,
    cancel: &mut oneshot::Receiver<()>,
) -> Result<(), AppError> {
    match install_codex_standalone(app, cancel).await {
        Ok(()) => Ok(()),
        // 用户取消不回退、不重试。
        Err(e) if matches!(&e, AppError::Codex(m) if m == "已取消") => Err(e),
        Err(standalone_err) => match resolve_npm_binary() {
            Some(npm) => {
                emit_progress(
                    app,
                    &format!("独立版下载失败，回退 npm 安装…（{standalone_err}）"),
                    None,
                );
                npm_install(app, &npm, cancel).await
            }
            None => Err(standalone_err),
        },
    }
}

/// 免 Node 直装：依次尝试 REGISTRIES，任一源成功即返回。
async fn install_codex_standalone(
    app: &AppHandle,
    cancel: &mut oneshot::Receiver<()>,
) -> Result<(), AppError> {
    let tag = platform_tag()
        .ok_or_else(|| AppError::Codex("当前系统/架构暂不支持一键直装，请手动安装 codex CLI".into()))?;
    let client = reqwest::Client::builder()
        // 单请求超时（含 tarball 下载；元数据请求共用长超时，慢点无妨）。
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| AppError::Codex(format!("初始化下载失败: {e}")))?;

    let mut last_err = String::new();
    for registry in REGISTRIES {
        match install_from_registry(app, &client, registry, tag, cancel).await {
            Ok(()) => return Ok(()),
            Err(e) if matches!(&e, AppError::Codex(m) if m == "已取消") => return Err(e),
            Err(e) => last_err = format!("{registry}: {e}"),
        }
    }
    Err(AppError::Codex(format!("独立版下载安装失败（{last_err}）")))
}

async fn install_from_registry(
    app: &AppHandle,
    client: &reqwest::Client,
    registry: &str,
    tag: &str,
    cancel: &mut oneshot::Receiver<()>,
) -> Result<(), AppError> {
    emit_progress(app, "正在获取最新版本…", None);
    let latest: serde_json::Value = client
        .get(format!("{registry}/@openai/codex/latest"))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| AppError::Codex(format!("获取版本信息失败: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Codex(format!("解析版本信息失败: {e}")))?;
    let version = latest["version"]
        .as_str()
        .ok_or_else(|| AppError::Codex("版本信息缺少 version 字段".into()))?
        .to_string();

    // 平台子包元数据：tarball 地址 + sha512 integrity（个别源缺 integrity 则跳过校验）。
    let meta: serde_json::Value = client
        .get(format!("{registry}/@openai/codex/{version}-{tag}"))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| AppError::Codex(format!("获取平台包信息失败: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Codex(format!("解析平台包信息失败: {e}")))?;
    let tarball = meta["dist"]["tarball"]
        .as_str()
        .ok_or_else(|| AppError::Codex("平台包信息缺少 tarball 地址".into()))?
        .to_string();
    let integrity = meta["dist"]["integrity"].as_str().map(str::to_string);

    let data =
        app_data_dir().ok_or_else(|| AppError::Codex("无法定位应用数据目录".into()))?;
    std::fs::create_dir_all(data.join("codex-cli.download"))?;
    let tgz_path = data.join("codex-cli.download").join("codex.tgz");

    download_tarball(app, client, &tarball, &tgz_path, cancel).await?;

    emit_progress(app, "下载完成，校验中…", Some(99));
    // 校验 + 解压换入是纯阻塞 IO（354MB 解压），放 blocking 线程池避免卡 async 运行时。
    tokio::task::spawn_blocking(move || {
        if let Some(integrity) = integrity.as_deref() {
            verify_sha512(&tgz_path, integrity)?;
        }
        extract_and_swap(&data)
    })
    .await
    .map_err(|e| AppError::Codex(format!("安装任务异常退出: {e}")))??;

    // 复查托管二进制可执行（resolve 优先托管目录，--version 走完整路径不依赖 PATH）。
    let binary = resolve_codex_binary()
        .ok_or_else(|| AppError::Codex("安装完成但未找到 codex 二进制".into()))?;
    let version_ok = codex_command(&binary)
        .arg("--version")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !version_ok {
        return Err(AppError::Codex("安装的 codex 无法执行（--version 失败）".into()));
    }
    emit_progress(app, &format!("codex {version} 安装完成"), Some(100));
    Ok(())
}

/// 流式下载 tarball 到 `dest`，按 content-length 节流推进度；随时可取消。
async fn download_tarball(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    cancel: &mut oneshot::Receiver<()>,
) -> Result<(), AppError> {
    let resp = client
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| AppError::Codex(format!("下载失败: {e}")))?;
    let total = resp.content_length();
    if let Some(t) = total {
        emit_progress(
            app,
            &format!("开始下载，约 {:.0} MB", t as f64 / 1048576.0),
            Some(0),
        );
    } else {
        emit_progress(app, "开始下载…", None);
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
                emit_progress(
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
fn verify_sha512(path: &Path, integrity: &str) -> Result<(), AppError> {
    let expected = integrity
        .strip_prefix("sha512-")
        .ok_or_else(|| AppError::Codex("integrity 算法不是 sha512".into()))?;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha512::new();
    let mut buf = vec![0u8; 8 * 1024 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let got = base64::engine::general_purpose::STANDARD.encode(hasher.finalize());
    if got != expected {
        return Err(AppError::Codex("sha512 校验失败，下载可能不完整，请重试".into()));
    }
    Ok(())
}

/// 解压 tarball 并把 `package/vendor/` 换入 `{app_data}/codex-cli/`（解析方
/// `managed_codex_binary` 扫描的布局）。旧版先挪到 `codex-cli.old` 让位，失败回滚；
/// 结尾清理 tmp / old（Windows 上删除失败不致命，残留由下次安装清理）。
fn extract_and_swap(data: &Path) -> Result<(), AppError> {
    let tgz = data.join("codex-cli.download").join("codex.tgz");
    let tmp = data.join("codex-cli.tmp");
    let old = data.join("codex-cli.old");
    let final_dir = data.join("codex-cli");
    let _ = std::fs::remove_dir_all(&tmp);
    let _ = std::fs::remove_dir_all(&old);
    std::fs::create_dir_all(&tmp)?;

    let file = std::fs::File::open(&tgz)?;
    let gz = flate2::read::GzDecoder::new(file);
    // tar crate 的 unpack 自带 `..` 路径穿越防护。
    tar::Archive::new(gz).unpack(&tmp)?;
    let vendor = tmp.join("package").join("vendor");
    if !vendor.is_dir() {
        return Err(AppError::Codex("tarball 结构异常（缺 package/vendor）".into()));
    }

    if final_dir.exists() {
        std::fs::rename(&final_dir, &old)?;
    }
    if let Err(e) = std::fs::create_dir(&final_dir)
        .and_then(|()| std::fs::rename(&vendor, final_dir.join("vendor")))
    {
        let _ = std::fs::rename(&old, &final_dir);
        return Err(AppError::Io(e));
    }
    #[cfg(unix)]
    make_vendor_executable(&final_dir.join("vendor"))?;

    let _ = std::fs::remove_dir_all(&tmp);
    let _ = std::fs::remove_dir_all(&old);
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
/// 逐行 stdout/stderr 推进度，180s 超时 + 可取消（`kill_on_drop`）。
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

    // 逐行读 stdout + stderr → emit 进度（两个 task 并发读，互不阻塞）。
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app_out = app.clone();
    let stdout_task = tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut lines: Vec<String> = Vec::new();
        if let Some(out) = stdout {
            let mut r = BufReader::new(out).lines();
            while let Ok(Some(line)) = r.next_line().await {
                emit_progress(&app_out, &line, None);
                lines.push(line);
            }
        }
        lines
    });
    let app_err = app.clone();
    let stderr_task = tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut lines: Vec<String> = Vec::new();
        if let Some(e) = stderr {
            let mut r = BufReader::new(e).lines();
            while let Ok(Some(line)) = r.next_line().await {
                emit_progress(&app_err, &line, None);
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
        return Err(AppError::Codex(format!("npm 安装失败（退出 {status}）| {tail}")));
    }
    // 复查 codex 二进制是否就位（npm 装完应出现在 %APPDATA%\npm 或 PATH）。
    if resolve_codex_binary().is_none() {
        return Err(AppError::Codex(
            "npm 安装已完成但未找到 codex，请重启应用使其进入 PATH".into(),
        ));
    }
    Ok(())
}

/// extract_and_swap 依赖的临时目录布局（测试与实现共用）。
#[cfg(test)]
pub(crate) fn install_dirs_for_test(data: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
    (
        data.join("codex-cli.download").join("codex.tgz"),
        data.join("codex-cli"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use ulid::Ulid;

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

    /// 构造与官方 tarball 同构的最小 tgz（package/vendor/<triple>/bin/codex.exe），
    /// 验证 extract_and_swap 换入后落在 `codex-cli/vendor/` 布局（managed_codex_binary
    /// 扫描的位置），且重复安装（旧版让位）也能成功。
    #[test]
    fn extract_and_swap_installs_vendor_layout() {
        let data = std::env::temp_dir().join(format!("bowerbird-codex-install-test-{}", Ulid::new()));
        let (tgz, final_dir) = install_dirs_for_test(&data);
        fs::create_dir_all(tgz.parent().unwrap()).unwrap();

        let src = data.join("fake-codex.exe");
        fs::write(&src, b"fake").unwrap();
        {
            let file = fs::File::create(&tgz).unwrap();
            let enc = flate2::write::GzEncoder::new(file, flate2::Compression::default());
            let mut archive = tar::Builder::new(enc);
            archive
                .append_path_with_name(&src, "package/vendor/x86_64-pc-windows-msvc/bin/codex.exe")
                .unwrap();
            archive
                .append_path_with_name(&src, "package/package.json")
                .unwrap();
            archive.into_inner().unwrap().finish().unwrap();
        }

        extract_and_swap(&data).unwrap();
        assert!(final_dir.join("vendor/x86_64-pc-windows-msvc/bin/codex.exe").is_file());
        // 不相关的 package/package.json 不应进入最终目录。
        assert!(!final_dir.join("package.json").is_file());

        // 二次安装：旧版挪 .old 让位后仍成功。
        extract_and_swap(&data).unwrap();
        assert!(final_dir.join("vendor/x86_64-pc-windows-msvc/bin/codex.exe").is_file());
        assert!(!data.join("codex-cli.old").exists());

        fs::remove_dir_all(&data).ok();
    }
}
