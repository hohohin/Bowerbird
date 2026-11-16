// Private installation of the same official npm CLI the standalone DSH Web guide uses.
// Node archives are pinned to the SHA-256 published in nodejs.org/dist/v24.21.0/SHASUMS256.txt;
// npm ci verifies every registry tarball against the shipped lockfile.
use super::*;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;

const NODE: &str = "24.21.0";
const DSH: &str = "0.2.2-rc.1";
const PACKAGE: &str = include_str!("dsh-install/package.json");
const LOCKFILE: &str = include_str!("dsh-install/package-lock.json");
static INSTALL: AsyncMutex<()> = AsyncMutex::const_new(());

struct Distribution {
    directory: String,
    archive: String,
    digest: &'static str,
}

fn distribution() -> Option<Distribution> {
    let (tag, digest) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => (
            "win-x64",
            "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
        ),
        ("windows", "aarch64") => (
            "win-arm64",
            "8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921",
        ),
        ("macos", "x86_64") => (
            "darwin-x64",
            "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
        ),
        ("macos", "aarch64") => (
            "darwin-arm64",
            "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
        ),
        _ => return None,
    };
    let directory = format!("node-v{NODE}-{tag}");
    let extension = if cfg!(windows) { "zip" } else { "tar.gz" };
    Some(Distribution {
        archive: format!("{directory}.{extension}"),
        directory,
        digest,
    })
}

fn installation() -> AppResult<PathBuf> {
    Ok(root()?.join("runtime").join(DSH))
}

fn launcher(dir: &Path, dist: &Distribution) -> Launcher {
    Launcher {
        executable: dir.join(&dist.directory).join(if cfg!(windows) {
            "node.exe"
        } else {
            "bin/node"
        }),
        cli: dir.join("node_modules/@deepseek-ai/dsh/lib/bin.js"),
        electron: false,
    }
}

pub(super) fn installed() -> Option<Launcher> {
    let base = installation().ok()?;
    let generation = std::fs::read_to_string(base.join("current")).ok()?;
    let generation = uuid::Uuid::parse_str(&generation).ok()?;
    let result = launcher(&base.join(generation.to_string()), &distribution()?);
    (result.executable.is_file() && result.cli.is_file()).then_some(result)
}

fn verified(path: &Path, expected: &str) -> AppResult<bool> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.into()),
    };
    let mut sha = Sha256::new();
    let mut block = vec![0; 128 * 1024];
    loop {
        let count = file.read(&mut block)?;
        if count == 0 {
            break;
        }
        sha.update(&block[..count]);
    }
    Ok(format!("{:x}", sha.finalize()) == expected)
}

fn extract(path: &Path, target: &Path) -> AppResult<()> {
    let file = File::open(path)?;
    if cfg!(windows) {
        zip::ZipArchive::new(file)
            .and_then(|mut archive| archive.extract(target))
            .map_err(|_| error("本机 DSH 运行环境无法解压，请检查磁盘空间后重试"))?;
    } else {
        tar::Archive::new(flate2::read::GzDecoder::new(file)).unpack(target)?;
    }
    Ok(())
}

fn node_command(path: &Path) -> Command {
    let mut cmd = Command::new(path);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    cmd.kill_on_drop(true)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    cmd
}

pub(super) async fn install() -> AppResult<()> {
    let _guard = INSTALL.lock().await;
    if account_capable().await? {
        return Ok(());
    }
    let dist = distribution().ok_or_else(|| error("当前系统暂不支持自动安装本机 DSH"))?;
    let base = installation()?;
    std::fs::create_dir_all(&base)?;
    let lockfile = base.join("install.lock");
    // OS releases this lock on process exit. Another desktop instance can then resume.
    let _file_lock = tokio::task::spawn_blocking(move || -> std::io::Result<File> {
        let handle = File::options()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lockfile)?;
        handle.lock()?;
        Ok(handle)
    })
    .await
    .map_err(|_| error("本机 DSH 安装等待已中断"))??;
    if installed().is_some() {
        return Ok(());
    }
    let stage = tempfile::Builder::new()
        .prefix(".install-")
        .tempdir_in(&base)?;
    let runtime = stage.path().join("runtime");
    std::fs::create_dir(&runtime)?;
    let archive = base.join(&dist.archive);
    let cached = archive.clone();
    let expected = dist.digest;
    let reusable = tokio::task::spawn_blocking(move || verified(&cached, expected))
        .await
        .map_err(|_| error("本机 DSH 安装包检查中断"))??;
    if !reusable {
        let download = stage.path().join("node.download");
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(600))
            .build()
            .map_err(|_| error("本机 DSH 安装连接建立失败"))?;
        let (_keep, mut cancel) = tokio::sync::oneshot::channel();
        let official = format!("https://nodejs.org/dist/v{NODE}/{}", dist.archive);
        if crate::codex::install::download_tarball(None, &client, &official, &download, &mut cancel)
            .await
            .is_err()
        {
            let mirror = format!(
                "https://npmmirror.com/mirrors/node/v{NODE}/{}",
                dist.archive
            );
            crate::codex::install::download_tarball(None, &client, &mirror, &download, &mut cancel)
                .await
                .map_err(|_| error("本机 DSH 运行环境下载失败，请检查网络后重试"))?;
        }
        let cache = archive.clone();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            if !verified(&download, expected)? {
                return Err(error("本机 DSH 安装包校验失败，请重试"));
            }
            std::fs::rename(download, cache)?;
            Ok(())
        })
        .await
        .map_err(|_| error("本机 DSH 安装包检查中断"))??;
    }
    let dest = runtime.clone();
    tokio::task::spawn_blocking(move || extract(&archive, &dest))
        .await
        .map_err(|_| error("本机 DSH 安装包解压中断"))??;
    std::fs::write(runtime.join("package.json"), PACKAGE)?;
    std::fs::write(runtime.join("package-lock.json"), LOCKFILE)?;
    let npm_config = stage.path().join("npmrc");
    std::fs::write(&npm_config, "")?;
    let npm = runtime.join(&dist.directory).join(if cfg!(windows) {
        "node_modules/npm/bin/npm-cli.js"
    } else {
        "lib/node_modules/npm/bin/npm-cli.js"
    });
    let candidate = launcher(&runtime, &dist);
    // Both sources must satisfy the exact same lockfile. Retry at the mirror only
    // for an unavailable registry; local permission or integrity errors stay failures.
    for (index, registry) in crate::codex::install::REGISTRIES.iter().enumerate() {
        let result = tokio::time::timeout(
            Duration::from_secs(900),
            node_command(&candidate.executable)
                .current_dir(&runtime)
                .arg(&npm)
                .args([
                    "ci",
                    "--ignore-scripts",
                    "--prefer-offline",
                    "--no-audit",
                    "--no-fund",
                    "--loglevel=error",
                    "--fetch-retries=1",
                    "--fetch-retry-mintimeout=1000",
                    "--fetch-timeout=30000",
                    "--registry",
                    registry,
                    "--cache",
                ])
                .arg(base.join("npm-cache"))
                .arg("--userconfig")
                .arg(&npm_config)
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .output(),
        )
        .await
        .map_err(|_| error("本机 DSH 下载超时，重试将复用已下载的文件"))??;
        if result.status.success() {
            break;
        }
        let reason = String::from_utf8_lossy(&result.stderr);
        if index != 0
            || ![
                "EAI_AGAIN",
                "ENOTFOUND",
                "ETIMEDOUT",
                "ECONNRESET",
                "ECONNREFUSED",
                "EHOSTUNREACH",
                "E502",
                "E503",
                "E504",
                "FETCH_ERROR",
            ]
            .iter()
            .any(|code| reason.contains(code))
        {
            return Err(error("本机 DSH 安装失败，请检查网络及磁盘空间后重试"));
        }
    }
    let version = tokio::time::timeout(
        Duration::from_secs(30),
        node_command(&candidate.executable)
            .arg(&candidate.cli)
            .arg("--version")
            .current_dir(&runtime)
            .output(),
    )
    .await
    .map_err(|_| error("本机 DSH 安装验证超时"))??;
    if !version.status.success()
        || String::from_utf8_lossy(&version.stdout).trim() != DSH
        || !supports_account(&candidate).await?
    {
        return Err(error("本机 DSH 安装验证失败，请重新安装"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    std::fs::rename(runtime, base.join(&id))?;
    dsh_local::write_private(&base.join("current"), &id)
}

#[cfg(test)]
#[tokio::test]
#[ignore = "downloads the pinned DSH and Node distributions to an isolated app-data directory"]
async fn dsh_managed_installer_accepts_concurrent_requests() {
    let fixture = PathBuf::from(std::env::var_os("BOWERBIRD_DSH_AUTO_FIXTURE").unwrap());
    let dir = installation().unwrap();
    assert!(fixture.starts_with(std::env::temp_dir()) && dir.starts_with(fixture));
    assert_eq!(
        std::env::var("BOWERBIRD_DSH_TEST_PRIVATE_INSTALL").unwrap(),
        "1"
    );
    let (first, second) = tokio::join!(install(), install());
    first.unwrap();
    second.unwrap();
    let published = std::fs::read_to_string(dir.join("current")).unwrap();
    assert!(installed().is_some());
    install().await.unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.join("current")).unwrap(),
        published
    );
}
