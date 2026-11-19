// Only the official CLI process launched by this app receives the preload and parent pipe.
use super::*;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex as AsyncMutex};
#[path = "local_chat_dsh_install.rs"]
mod private_install;

pub(super) async fn ensure_installed() -> AppResult<()> {
    private_install::install().await
}

const PRELOAD: &str = include_str!("local_chat_dsh_compat.cjs");
const SYSTEM_PORT: &str = "automatic-host.json";
const PRIVATE_PORT: &str = "automatic-private-host.json";
static OWNED: LazyLock<AsyncMutex<HashMap<&'static str, (Child, LocalConnection)>>> =
    LazyLock::new(|| AsyncMutex::new(HashMap::new()));

pub(super) struct Launcher {
    executable: PathBuf,
    cli: PathBuf,
    electron: bool,
}

fn desktop(root: &Path) -> Option<Launcher> {
    #[cfg(target_os = "macos")]
    let (exe, resources) = ("Contents/MacOS/DeepSeek Harness", "Contents/Resources");
    #[cfg(not(target_os = "macos"))]
    let (exe, resources) = ("DeepSeek Harness.exe", "resources");
    let executable = root.join(exe);
    let resources = root.join(resources);
    // Files inside the Electron archive are resolved by the installed Electron executable.
    (executable.is_file() && resources.join("app.asar").is_file()).then(|| Launcher {
        executable,
        electron: true,
        cli: resources.join("app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"),
    })
}

#[cfg(windows)]
fn registered_desktop() -> Option<Launcher> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};
    use windows::{core::w, Win32::System::Registry::*};
    // Installer's uninstall registration, including custom destinations and per-machine installs.
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let mut buffer = [0u16; 1024];
        let mut size = std::mem::size_of_val(&buffer) as u32;
        let result = unsafe {
            RegGetValueW(hive,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\1bf39983-50d0-5fe0-9ef4-cece76f67c5e"),
            w!("InstallLocation"), RRF_RT_REG_SZ, None, Some(buffer.as_mut_ptr().cast()), Some(&mut size))
        };
        if result.is_ok() {
            let len = buffer
                .iter()
                .position(|ch| *ch == 0)
                .unwrap_or(buffer.len());
            if let Some(launcher) = desktop(&PathBuf::from(OsString::from_wide(&buffer[..len]))) {
                return Some(launcher);
            }
        }
    }
    None
}

pub(super) fn discover() -> Option<Launcher> {
    private_install::installed().or_else(system)
}

fn system() -> Option<Launcher> {
    // The opt-in native acceptance test must start as a machine without system DSH.
    #[cfg(test)]
    if std::env::var_os("BOWERBIRD_DSH_AUTO_FIXTURE").is_some()
        && std::env::var_os("BOWERBIRD_DSH_TEST_PRIVATE_INSTALL").as_deref()
            == Some(std::ffi::OsStr::new("1"))
    {
        return None;
    }
    #[cfg(windows)]
    if let Some(found) = registered_desktop() {
        return Some(found);
    }
    #[cfg(target_os = "macos")]
    for dir in std::iter::once(PathBuf::from("/Applications"))
        .chain(std::env::var_os("HOME").map(|p| PathBuf::from(p).join("Applications")))
    {
        if let Some(found) = desktop(&dir.join("DeepSeek Harness.app")) {
            return Some(found);
        }
    }
    let mut paths: Vec<_> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .filter(|path| path.is_absolute())
        .collect();
    if cfg!(unix) {
        paths.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
    }
    let node = paths
        .iter()
        .map(|dir| dir.join(if cfg!(windows) { "node.exe" } else { "node" }))
        .find(|p| p.is_file());
    for dir in &paths {
        let shim = dir.join(if cfg!(windows) { "dsh.cmd" } else { "dsh" });
        if !shim.is_file() {
            continue;
        }
        let Ok(resolved) = shim.canonicalize() else {
            continue;
        };
        for parent in resolved.ancestors().skip(1).take(8) {
            if let Some(found) = desktop(parent) {
                return Some(found);
            }
        }
        // npm/pnpm installs expose the official package bin directly or beside a Windows shim.
        for entry in [
            resolved,
            dir.join("node_modules/@deepseek-ai/dsh/lib/bin.js"),
        ] {
            if let Some(executable) = &node {
                if entry.ends_with("@deepseek-ai/dsh/lib/bin.js") && entry.is_file() {
                    return Some(Launcher {
                        executable: executable.clone(),
                        cli: entry,
                        electron: false,
                    });
                }
            }
        }
    }
    None
}

fn command(launcher: &Launcher) -> Command {
    let mut cmd = Command::new(&launcher.executable);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    if launcher.electron {
        cmd.env("ELECTRON_RUN_AS_NODE", "1");
    }
    cmd.arg("--expose-internals").kill_on_drop(true);
    cmd
}

pub(super) async fn account_capable() -> AppResult<bool> {
    if private_install::installed().is_some() {
        return Ok(true);
    }
    let Some(launcher) = system() else {
        return Ok(false);
    };
    // Account status is polled while a browser is open. Re-read the composition
    // only when the system runtime changes, and never cache a failed probe.
    static CAPABILITY: AsyncMutex<Option<(PathBuf, std::time::SystemTime, bool)>> =
        AsyncMutex::const_new(None);
    let source = launcher
        .cli
        .ancestors()
        .find(|p| p.file_name() == Some(std::ffi::OsStr::new("app.asar")))
        .unwrap_or(&launcher.cli);
    let modified = std::fs::metadata(source)?.modified()?;
    let mut cached = CAPABILITY.lock().await;
    if let Some((path, timestamp, result)) = cached.as_ref() {
        if path == source && *timestamp == modified {
            return Ok(*result);
        }
    }
    let result = supports_account(&launcher).await?;
    *cached = Some((source.to_owned(), modified, result));
    Ok(result)
}

/// Read the CLI's local default composition, without the user's profile or credentials.
async fn supports_account(launcher: &Launcher) -> AppResult<bool> {
    let probe = tempfile::tempdir()?;
    let output = tokio::time::timeout(
        Duration::from_secs(20),
        command(launcher)
            .arg(&launcher.cli)
            .args(["web", "--dump-default-config"])
            .env("DSH_HOME", probe.path())
            .current_dir(probe.path())
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| error("本机 DSH 组件检测超时，请重试"))??;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("unknown option") && stderr.contains("--dump-default-config") {
            return Ok(false);
        }
        return Err(error("无法检测本机 DSH 的账号组件，请检查安装后重试"));
    }
    account_plugins(&String::from_utf8_lossy(&output.stdout))
}

fn account_plugins(config: &str) -> AppResult<bool> {
    let names: Vec<_> = config
        .lines()
        .filter_map(|line| line.trim_start().strip_prefix("name:"))
        .map(|name| name.trim().trim_matches(['\'', '"']))
        .collect();
    if names.is_empty() {
        return Err(error("本机 DSH 没有返回可识别的组件列表"));
    }
    Ok(names.contains(&"@deepseek-ai/dsh-api-account-controller")
        && names.contains(&"@deepseek-ai/dsh-deepseek-account-platform"))
}

fn endpoint(line: &str, wanted: u16) -> Option<LocalConnection> {
    static LOGIN: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"http://127\.0\.0\.1:[0-9]{1,5}/\?token=[a-zA-Z0-9._~%+-]+").unwrap()
    });
    let auth = LOGIN.find(line)?.as_str();
    let parsed = reqwest::Url::parse(auth).ok()?;
    let port = parsed.port()?;
    if port == 0 || (wanted != 0 && wanted != port) {
        return None;
    }
    let base = validate_connection(&format!("http://127.0.0.1:{port}"), Some(auth)).ok()?;
    Some(LocalConnection {
        base,
        auth: Some(auth.into()),
    })
}

#[cfg(test)]
#[test]
fn dsh_local_account_capability_needs_a_recognizable_default_composition() {
    let legacy = "- id: gateway\n  name: '@deepseek-ai/dsh-api-gateway'\n";
    assert!(!account_plugins(legacy).unwrap());
    let current = "- id: account-controller\n  name: '@deepseek-ai/dsh-api-account-controller'\n\
                   - id: deepseek-account\n  name: \"@deepseek-ai/dsh-deepseek-account-platform\"\n";
    assert!(account_plugins(current).unwrap());
    assert!(account_plugins("DSH unavailable").is_err());
}

async fn output(stream: impl AsyncRead + Unpin, port: u16, ready: mpsc::Sender<LocalConnection>) {
    let mut stream = BufReader::new(stream);
    let mut line = Vec::new();
    let mut discarding = false;
    loop {
        line.clear();
        let read = (&mut stream).take(8192).read_until(b'\n', &mut line).await;
        if !matches!(read, Ok(n) if n > 0) {
            break;
        }
        if discarding || (line.len() == 8192 && !line.ends_with(b"\n")) {
            discarding = !line.ends_with(b"\n");
            continue;
        }
        let Ok(text) = std::str::from_utf8(&line) else {
            continue;
        };
        if !ready.is_closed() {
            if let Some(connection) = endpoint(text, port) {
                let _ = ready.try_send(connection);
            }
        }
        if let Some((_, raw)) = text.split_once("[bowerbird-dsh-card-json] ") {
            if let Ok(event) = serde_json::from_str::<Value>(raw) {
                if event["reason"] == "surplus-trailing-brace" {
                    let field = |name: &str| {
                        event[name].as_str().filter(|s| {
                            s.len() <= 128
                                && s.bytes()
                                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
                        })
                    };
                    if let (Some(session), Some(call), Some(sha256)) =
                        (field("sessionId"), field("callId"), field("sha256"))
                    {
                        tracing::info!(
                            session,
                            call,
                            sha256,
                            "normalized surplus trailing brace in local DSH card call"
                        );
                    }
                }
            }
        }
    }
}

fn saved_port(slot: &str) -> AppResult<Option<u16>> {
    match std::fs::read(root()?.join(slot)) {
        Ok(bytes) => serde_json::from_slice::<u16>(&bytes)
            .ok()
            .filter(|p| *p > 0)
            .map(Some)
            .ok_or_else(|| error("本机 DSH 的自动连接记录无效")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(error("无法读取本机 DSH 自动连接记录")),
    }
}

pub(super) async fn ensure() -> AppResult<LocalConnection> {
    let slot = if private_install::installed().is_some() {
        PRIVATE_PORT
    } else {
        SYSTEM_PORT
    };
    ensure_slot(slot).await
}

pub(super) async fn recover_at(base: &str) -> AppResult<Option<LocalConnection>> {
    for slot in [SYSTEM_PORT, PRIVATE_PORT] {
        if saved_port(slot)?.is_some_and(|port| base == format!("http://127.0.0.1:{port}")) {
            return Ok(Some(ensure_slot(slot).await?));
        }
    }
    Ok(None)
}

async fn ensure_slot(slot: &'static str) -> AppResult<LocalConnection> {
    let mut state = OWNED.lock().await;
    if let Some((child, connection)) = state.get_mut(slot) {
        if child.try_wait()?.is_none() {
            return Ok(connection.clone());
        }
    }
    state.remove(slot);
    // A newly installed account-capable host can run alongside unfinished API-key
    // sessions. Both ports are durable, so recovery after restart keeps its origin.
    let launcher = if slot == PRIVATE_PORT {
        private_install::installed()
    } else {
        system().or_else(private_install::installed)
    }
    .ok_or_else(|| error("请前往模型设置，点击本机 DSH 的「登录授权」完成安装与配置"))?;
    let root = root()?;
    let preload = root.join("local-chat-compat.cjs");
    if std::fs::read(&preload).ok().as_deref() != Some(PRELOAD.as_bytes()) {
        dsh_local::write_private(&preload, PRELOAD)?;
    }
    let mut port = saved_port(slot)?.unwrap_or(0);
    // A stopped host still owns its recorded origin. Keep the OS from assigning
    // that port to the other slot on its first launch.
    let other_slot = if slot == SYSTEM_PORT {
        PRIVATE_PORT
    } else {
        SYSTEM_PORT
    };
    let _reserve_prior_origin = if port == 0 {
        saved_port(other_slot)?
            .and_then(|port| std::net::TcpListener::bind(("127.0.0.1", port)).ok())
    } else {
        None
    };
    dsh_local::prepare_auto_profile()?;
    for attempt in 0..2 {
        let (mut child, connection) = launch(&launcher, &root, Some(&preload), port).await?;
        port = reqwest::Url::parse(&connection.base)
            .ok()
            .and_then(|u| u.port())
            .unwrap();
        let health = dsh_local::inspect(&connection.base, connection.auth.as_deref()).await?;
        if !health.live {
            return Err(error(
                "自动连接需要 DSH 0.2 或更高版本，请更新 DeepSeek Harness",
            ));
        }
        let installed = dsh_local::install(&connection.base, connection.auth.as_deref()).await?;
        if matches!(installed, dsh_local::Install::Active) {
            dsh_local::write_private(&root.join(slot), &port.to_string())?;
            state.insert(slot, (child, connection.clone()));
            return Ok(connection);
        }
        // No caller has received this child. Restart it once to load the new
        // managed block on profiles without HMR. Never stop a user's other host.
        close(&mut child).await;
        if attempt == 1 {
            break;
        }
    }
    Err(error("本机 DSH 未能加载建卡组件，请检查 DSH 配置后重试"))
}

async fn launch(
    launcher: &Launcher,
    root: &Path,
    preload: Option<&Path>,
    port: u16,
) -> AppResult<(Child, LocalConnection)> {
    let mut command = command(launcher);
    if let Some(preload) = preload {
        command.arg("--require").arg(preload).env("BOWERBIRD_DSH_PARENT_PIPE", "1");
    }
    let mut child = command
        .arg(&launcher.cli)
        .args(["web", "--no-open", "--host", "127.0.0.1", "--port"])
        .arg(port.to_string())
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| error("无法启动本机 DSH，请检查 DeepSeek Harness 安装"))?;
    let (tx, mut rx) = mpsc::channel(2);
    tokio::spawn(output(child.stdout.take().unwrap(), port, tx.clone()));
    tokio::spawn(output(child.stderr.take().unwrap(), port, tx));
    let connection = tokio::time::timeout(Duration::from_secs(40), rx.recv())
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error("本机 DSH 未能在专用端口启动，请检查安装和端口占用后重试"))?;
    Ok((child, connection))
}

#[cfg(test)]
pub(in crate::commands::local_chat) async fn unmodified_peer() -> AppResult<(Child, LocalConnection)> {
    launch(&discover().unwrap(), &root()?, None, 0).await
}

async fn close(child: &mut Child) {
    drop(child.stdin.take());
    if tokio::time::timeout(Duration::from_secs(2), child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
    }
}

pub(super) async fn stop() {
    for (_, (mut child, _)) in OWNED.lock().await.drain() {
        close(&mut child).await;
    }
}

#[cfg(test)]
#[tokio::test]
#[ignore = "requires an installed system CLI and an isolated, prepared private DSH runtime"]
async fn dsh_managed_install_keeps_the_original_host_recoverable() {
    let fixture = PathBuf::from(std::env::var_os("BOWERBIRD_DSH_AUTO_FIXTURE").unwrap());
    assert!(fixture.starts_with(std::env::temp_dir()) && root().unwrap().starts_with(&fixture));
    assert!(PathBuf::from(std::env::var_os("DSH_HOME").unwrap()).starts_with(&fixture));
    assert!(system().is_some() && private_install::installed().is_some());
    let system = ensure_slot(SYSTEM_PORT).await.unwrap();
    let private = ensure().await.unwrap();
    assert_ne!(system.base, private.base);
    // An unfinished original request can keep using the original host during setup.
    assert_eq!(
        recover_at(&system.base).await.unwrap().unwrap().auth,
        system.auth
    );
    assert_eq!(
        recover_at(&private.base).await.unwrap().unwrap().auth,
        private.auth
    );
    stop().await;
    assert_eq!(
        recover_at(&system.base).await.unwrap().unwrap().base,
        system.base
    );
    assert_eq!(
        recover_at(&private.base).await.unwrap().unwrap().base,
        private.base
    );
    stop().await;
}
