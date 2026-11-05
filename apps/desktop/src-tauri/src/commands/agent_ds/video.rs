//! Local HyperFrames capability of the existing Codex card. No second agent loop.
use super::*;
use crate::codex::codex_cli::{app_data_dir, npm_command, resolve_npm_binary};
use crate::media::tools::{self, Tool};
use tokio::process::Command;
use tokio::sync::{watch, Mutex};

const VERSION: &str = "0.9.10";
static INSTALL: Mutex<()> = Mutex::const_new(());
static ACCEPT: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn runtime_root() -> Result<PathBuf, AppError> {
    Ok(app_data_dir().ok_or_else(|| AppError::Other("无法找到应用资料目录".into()))?.join("video-runtime").join(VERSION))
}

fn node_binary() -> Result<PathBuf, AppError> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let mut dirs = resolve_npm_binary().and_then(|npm| Path::new(&npm).parent().map(Path::to_path_buf)).into_iter().collect::<Vec<_>>();
    if let Some(path) = std::env::var_os("PATH") { dirs.extend(std::env::split_paths(&path)); }
    dirs.into_iter().map(|dir| dir.join(name)).find(|path| path.is_file())
        .ok_or_else(|| AppError::Other("视频制作需要 Node.js 22 或更新版本，请安装后重试".into()))
}

fn command(node: &Path) -> Command {
    let mut cmd = Command::new(node);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    cmd.kill_on_drop(true).env("HYPERFRAMES_NO_TELEMETRY", "1");
    cmd
}

async fn run(mut cmd: Command, cancel: &mut watch::Receiver<bool>) -> Result<String, AppError> {
    let (stdout, stderr, status) = run_output(&mut cmd, cancel).await?;
    if !status.success() {
        tracing::warn!("HyperFrames preparation: {stderr}");
        return Err(AppError::Other("视频环境准备失败，请检查网络及 Node.js 安装后重试".into()));
    }
    Ok(stdout)
}

async fn run_output(cmd: &mut Command, cancel: &mut watch::Receiver<bool>) -> Result<(String, String, std::process::ExitStatus), AppError> {
    if *cancel.borrow() { return Err(AppError::Other("视频任务已停止".into())); }
    cmd.kill_on_drop(true).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let output = {
        let execution = async { tokio::try_join!(codex::read_tail(stdout), codex::read_tail(stderr), child.wait()) };
        tokio::select! {
            _ = cancel.changed() => Err(AppError::Other("视频任务已停止".into())),
            output = tokio::time::timeout(Duration::from_secs(600), execution) => output
                .map_err(|_| AppError::Other("视频工具执行超时，请检查原任务".into())).and_then(|result| result.map_err(AppError::from)),
        }
    };
    if output.is_err() { stop_child(&mut child).await; }
    output
}

pub(super) async fn stop_child(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        #[cfg(windows)]
        {
            let mut stop = Command::new("taskkill.exe");
            stop.args(["/PID", &pid.to_string(), "/T", "/F"]).creation_flags(0x08000000);
            let _ = stop.output().await;
        }
        #[cfg(unix)]
        { let _ = Command::new("kill").args(["-TERM", "--", &format!("-{pid}")]).output().await; }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

pub(super) fn project_root(root: &Path, scope: &str) -> Result<PathBuf, AppError> {
    let hash = scope.strip_prefix("session-bowerbird-").filter(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| AppError::Other("视频工程身份无效".into()))?;
    let base = root.parent().ok_or_else(|| AppError::Other("视频工程目录无效".into()))?.join("video-projects");
    std::fs::create_dir_all(&base)?;
    let base = std::fs::canonicalize(base)?;
    let path = base.join(hash);
    std::fs::create_dir_all(&path)?;
    if std::fs::canonicalize(&path)? != path { return Err(AppError::Other("视频工程目录越界".into())); }
    Ok(path)
}

pub(super) fn revision_root(root: &Path, _scope: &str) -> Result<PathBuf, AppError> {
    let project = std::fs::canonicalize(root)?.join("project");
    std::fs::create_dir_all(&project)?;
    if std::fs::canonicalize(&project)? != project { return Err(AppError::Other("视频工程轮次目录越界".into())); }
    Ok(project)
}

fn copy_project(source: &Path, target: &Path, depth: usize, count: &mut usize, bytes: &mut u64) -> Result<(), AppError> {
    if depth > 16 { return Err(AppError::Other("视频工程目录层级过深".into())); }
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        if [".hyperframes", "node_modules", ".git", "renders"].iter().any(|name| entry.file_name() == *name) { continue; }
        *count += 1;
        let meta = entry.metadata()?;
        if entry.file_type()?.is_symlink() || *count > 5000 { return Err(AppError::Other("视频工程包含链接或文件过多".into())); }
        let destination = target.join(entry.file_name());
        if meta.is_dir() { copy_project(&entry.path(), &destination, depth + 1, count, bytes)?; }
        else if meta.is_file() {
            *bytes += meta.len();
            if *bytes > 2 * 1024 * 1024 * 1024 { return Err(AppError::Other("视频工程超过 2 GiB，请精简素材后重试".into())); }
            std::fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

pub(super) fn accept_revision(root: &Path) -> Result<(), AppError> {
    let _lock = ACCEPT.lock().map_err(|_| AppError::Other("视频工程保存中断，请重启后取回原请求".into()))?;
    let request: Value = serde_json::from_slice(&std::fs::read(root.join("video-request.json"))?)?;
    let scope = request["scope"].as_str().ok_or_else(|| AppError::Other("视频工程身份缺失".into()))?;
    let base = project_root(root, scope)?;
    let revision = revision_root(root, scope)?;
    if !revision.join("index.html").is_file() { return Err(AppError::Other("视频工程未保存，请检查原任务".into())); }
    // Old recovered deliveries cannot replace a newer accepted revision.
    let latest = base.join("latest.json");
    let previous: Option<Value> = std::fs::read(&latest).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let id = root.file_name().unwrap().to_string_lossy();
    let current = previous.as_ref().and_then(|value| value["requestId"].as_str());
    if current == Some(id.as_ref()) || current != request["baseRequestId"].as_str() { return Ok(()); }
    write_json_atomic(&latest, &json!({"requestId":id}))
}

pub(super) fn request(root: &Path, id: &str, scope: &str, media: &[String]) -> Result<String, AppError> {
    workflow_file(root, id, "results")?;
    if media.len() > 32 { return Err(AppError::Other("视频制作最多引用 32 个素材".into())); }
    let base = project_root(root, scope)?;
    let project = revision_root(root, scope)?;
    let mut base_request_id = None;
    if base.join("latest.json").is_file() {
        let latest: Value = serde_json::from_slice(&std::fs::read(base.join("latest.json"))?)?;
        let previous = latest["requestId"].as_str().ok_or_else(|| AppError::Other("上次视频工程记录无效".into()))?;
        workflow_file(root, previous, "results")?;
        let source = std::fs::canonicalize(root.parent().unwrap())?.join(previous).join("project");
        if std::fs::canonicalize(&source)? != source || source == project { return Err(AppError::Other("上次视频工程路径无效".into())); }
        copy_project(&source, &project, 0, &mut 0, &mut 0)?;
        base_request_id = Some(previous.to_owned());
    }
    let assets = project.join("assets").join(id);
    std::fs::create_dir_all(&assets)?;
    if std::fs::canonicalize(&assets)? != assets { return Err(AppError::Other("视频素材目录越界".into())); }
    let mut references = Vec::new();
    let mut total = 0u64;
    for (index, source) in media.iter().enumerate() {
        let source = Path::new(source);
        let ext = source.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
        if !source.is_absolute() || !(crate::media::is_image_ext(&ext) || crate::media::probe::is_video(&ext) || crate::media::audio::is_audio(&ext)) {
            return Err(AppError::Other("视频制作仅支持本机图片、视频或音频素材".into()));
        }
        let meta = std::fs::metadata(source)?;
        total += meta.len();
        if !meta.is_file() || total > 1024 * 1024 * 1024 { return Err(AppError::Other("本次视频引用素材合计不能超过 1 GiB".into())); }
        let name = format!("input-{}.{}", index + 1, ext);
        let target = assets.join(&name);
        if target.exists() { return Err(AppError::Other("视频素材已准备，请取回原请求".into())); }
        std::fs::copy(source, &target)?;
        references.push(format!("素材 {}（引用中的【图片 {}】）：assets/{id}/{name}", index + 1, index + 1));
    }
    write_json_atomic(&root.join("video-request.json"), &json!({"scope":scope,"baseRequestId":base_request_id}))?;
    Ok(format!("使用本次请求目录的 .agents/skills/hyperframes/SKILL.md 制作视频。固定工程目录：{}。续轮先读取已有工程并按本次要求修改，不从头覆盖。\n{}\n引用编号以以上素材清单为准，先用本机工具查看图片或视频抽帧，音频按本机探测结果使用。直接编写 index.html；assets/gsap.js 已提供。通过 node bowerbird-hyperframes.mjs <命令> 调用桌面工具桥（从本次请求目录调用），只支持 lint/check/timeline --json、snapshot --at 秒数列表 或 --frames 数量、render --output 本次产物绝对路径 --fps 30 --quality delivery --workers 1。无需 init 或 npm；不直接启动 HyperFrames CLI。先 check、snapshot 检查，再 render。工具错误时修正工程；超时或已停止时结束任务，不重复投递。用户在应用点击运行即要求交付 MP4，无需转去其他应用或等待终端交互。只使用本次引用和本工程已有素材；不得安装插件、发布、登录外部服务或调用额外付费服务；缺少声音素材时保留无声并说明，不擅自生成。禁止使用网络资源，字体、脚本及素材均须本地化。保留工程用于后续修改。", project.display(), references.join("\n")))
}

pub(super) struct Prepared { node: PathBuf, cli: PathBuf, project: PathBuf, ffmpeg: PathBuf, ffprobe: PathBuf, browser: String, cache: PathBuf }

impl Prepared {
    pub(super) fn local_command(&self) -> Command {
        let mut cmd = command(&self.node);
        cmd.arg(&self.cli).current_dir(&self.project)
            .env("HYPERFRAMES_FFMPEG_PATH", &self.ffmpeg).env("HYPERFRAMES_FFPROBE_PATH", &self.ffprobe)
            .env("HYPERFRAMES_BROWSER_PATH", &self.browser).env("HYPERFRAMES_CACHE_DIR", &self.cache);
        cmd
    }
}

pub(super) async fn prepare(root: &Path, scope: &str, cancel: &mut watch::Receiver<bool>) -> Result<Prepared, AppError> {
    prepare_at(root, scope, runtime_root()?, cancel).await
}

async fn prepare_at(root: &Path, scope: &str, runtime: PathBuf, cancel: &mut watch::Receiver<bool>) -> Result<Prepared, AppError> {
    let project = revision_root(root, scope)?;
    let node = node_binary()?;
    let mut version = command(&node); version.arg("--version");
    let version = run(version, cancel).await?;
    if version.trim().trim_start_matches('v').split('.').next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0) < 22 {
        return Err(AppError::Other("视频制作需要 Node.js 22 或更新版本，请升级后重试".into()));
    }
    let _lock = tokio::select! {
        _ = cancel.changed() => return Err(AppError::Other("视频环境准备已停止".into())),
        guard = INSTALL.lock() => guard,
    };
    let package = runtime.join("node_modules/hyperframes");
    let cli = package.join("bin/hyperframes.mjs");
    let ready = std::fs::read(package.join("package.json")).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|value| value["version"] == VERSION) && cli.is_file();
    if !ready {
        let npm = resolve_npm_binary().ok_or_else(|| AppError::Other("视频制作需要 npm，请安装 Node.js 后重试".into()))?;
        std::fs::create_dir_all(&runtime)?;
        let mut install = npm_command(&npm, &["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "hyperframes@0.9.10"]);
        install.current_dir(&runtime);
        run(install, cancel).await?;
    }
    let mut check = command(&node); check.arg(&cli).arg("--version");
    if run(check, cancel).await?.trim() != VERSION { return Err(AppError::Other("视频工具版本校验失败，请重新准备环境".into())); }
    let ffmpeg = tools::resolve(Tool::Ffmpeg)?.to_path_buf();
    let ffprobe = tools::resolve(Tool::Ffprobe)?.to_path_buf();
    let cache = runtime.join("cache");
    let mut browser = command(&node);
    browser.arg(&cli).args(["browser", "ensure"]).env("HYPERFRAMES_CACHE_DIR", &cache);
    run(browser, cancel).await?;
    let mut browser_path = command(&node);
    browser_path.arg(&cli).args(["browser", "path"]).env("HYPERFRAMES_CACHE_DIR", &cache);
    let browser_path = run(browser_path, cancel).await?;
    let browser_path = browser_path.lines().rev().find(|line| Path::new(line.trim()).is_file())
        .ok_or_else(|| AppError::Other("视频渲染浏览器尚未就绪，请重试环境准备".into()))?;
    copy_skills(&package.join("dist/skills"), &root.join(".agents/skills"))?;
    let assets = project.join("assets");
    std::fs::create_dir_all(&assets)?;
    if !assets.join("gsap.js").exists() { std::fs::copy(package.join("dist/vendor/npm/gsap@3.15.0/dist/gsap.min.js"), assets.join("gsap.js"))?; }
    for name in ["video-tool-requests", "video-tool-results"] { std::fs::create_dir_all(root.join(name))?; }
    let config = json!({"root":root});
    std::fs::write(root.join("bowerbird-hyperframes.mjs"), format!("const config = {};\n{}", serde_json::to_string(&config)?, include_str!("video-runner.mjs")))?;
    Ok(Prepared { node, cli, project, ffmpeg, ffprobe, browser: browser_path.trim().to_owned(), cache: root.join(".hyperframes-cache") })
}

fn copy_skills(source: &Path, destination: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() { return Err(AppError::Other("视频技能包包含无效文件链接".into())); }
        let target = destination.join(entry.file_name());
        if kind.is_dir() { copy_skills(&entry.path(), &target)?; }
        else if kind.is_file() { std::fs::copy(entry.path(), target)?; }
    }
    Ok(())
}

fn tool_args(root: &Path, args: &[String]) -> Result<Vec<String>, AppError> {
    let invalid = || AppError::Other("视频工具参数不受支持；只允许本工程的检查、截图与 MP4 渲染".into());
    let Some(verb) = args.first() else { return Err(invalid()); };
    if !matches!(verb.as_str(), "lint" | "check" | "timeline" | "snapshot" | "render") || args.len() > 24 { return Err(invalid()); }
    let mut output = vec![verb.clone()];
    let mut fields = std::collections::HashSet::new();
    let mut index = 1;
    while index < args.len() {
        let (key, inline) = args[index].split_once('=').map(|(k, v)| (k, Some(v))).unwrap_or((&args[index], None));
        if !fields.insert(key.to_owned()) { return Err(invalid()); }
        if matches!(key, "--json" | "--help") || key == "--no-end" && verb == "snapshot" {
            if inline.is_some() { return Err(invalid()); }
            output.push(key.into()); index += 1; continue;
        }
        let value = if let Some(value) = inline { value } else { index += 1; args.get(index).map(String::as_str).ok_or_else(invalid)? };
        let number_in = |min: u32, max: u32| value.parse::<u32>().is_ok_and(|n| n >= min && n <= max);
        let allowed = match (verb.as_str(), key) {
            ("snapshot", "--frames") => number_in(1, 20),
            ("snapshot", "--at") => value.split(',').count() <= 20 && value.split(',').all(|n| n.parse::<f64>().is_ok_and(|n| n.is_finite() && (0.0..=3600.0).contains(&n))),
            ("render", "--fps") => number_in(1, 60),
            ("render", "--workers") => number_in(1, 2),
            ("render", "--quality") => matches!(value, "draft" | "looks" | "delivery" | "standard" | "high"),
            ("render", "--output" | "-o") => {
                let path = Path::new(value);
                let artifacts = root.join("artifacts").join(root.file_name().unwrap());
                let allowed_dir = std::fs::canonicalize(root)?.join("artifacts").join(root.file_name().unwrap());
                if std::fs::canonicalize(&artifacts)? != allowed_dir { return Err(invalid()); }
                path.is_absolute() && path.file_name().is_some_and(|name| name == "result.mp4")
                    && path.parent().and_then(|parent| std::fs::canonicalize(parent).ok()) == Some(allowed_dir.clone())
                    && (!path.exists() || std::fs::canonicalize(path).ok() == Some(allowed_dir.join("result.mp4")))
            }
            _ => false,
        };
        if !allowed { return Err(invalid()); }
        output.extend([key.to_owned(), value.to_owned()]); index += 1;
    }
    if verb == "render" && !fields.contains("--help") {
        if !fields.contains("--output") && !fields.contains("-o") { return Err(invalid()); }
        if fields.contains("--output") && fields.contains("-o") { return Err(invalid()); }
        if !fields.contains("--workers") { output.extend(["--workers".into(), "1".into()]); }
        if !fields.contains("--fps") { output.extend(["--fps".into(), "30".into()]); }
    }
    Ok(output)
}

/// Native local tool executor for the existing Codex agent, not a second agent loop.
pub(super) async fn serve(root: PathBuf, prepared: Prepared, mut cancel: watch::Receiver<bool>) {
    let result = serve_inner(&root, &prepared, &mut cancel).await;
    let message = result.err().map(|error| error.to_string()).unwrap_or_else(|| "视频工具已停止".into());
    let _ = write_json_atomic(&root.join("video-tool-stopped.json"), &json!({"error":message}));
}

async fn serve_inner(root: &Path, prepared: &Prepared, cancel: &mut watch::Receiver<bool>) -> Result<(), AppError> {
    let directory = root.join("video-tool-requests");
    let canonical = std::fs::canonicalize(&directory)?;
    loop {
        if *cancel.borrow() { return Ok(()); }
        for name in ["video-tool-requests", "video-tool-results", "project"] {
            if std::fs::canonicalize(root.join(name))? != std::fs::canonicalize(root)?.join(name) {
                return Err(AppError::Other("视频工具目录越界".into()));
            }
        }
        let entries = std::fs::read_dir(&directory)?.collect::<Result<Vec<_>, _>>()?;
        if entries.len() > 200 { return Err(AppError::Other("本次视频工具调用过多，请检查原任务".into())); }
        for entry in entries {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") { continue; }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()).filter(|s| uuid::Uuid::parse_str(s).is_ok()) else { continue; };
            let response = root.join("video-tool-results").join(format!("{id}.json"));
            if response.exists() { continue; }
            let result = async {
                if entry.file_type()?.is_symlink() || std::fs::canonicalize(&path)?.parent() != Some(&canonical) || entry.metadata()?.len() > 16384 {
                    return Err(AppError::Other("视频工具请求文件无效".into()));
                }
                let request: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
                let args: Vec<String> = serde_json::from_value(request["args"].clone())?;
                let args = tool_args(root, &args)?;
                // Claim before executing; an unknown interrupted render is never silently replayed.
                std::fs::OpenOptions::new().write(true).create_new(true).open(path.with_extension("claimed"))
                    .map_err(|_| AppError::Other("此视频工具请求已执行或中断，请检查原任务".into()))?;
                execute(root, prepared, &args, cancel).await
            }.await;
            write_json_atomic(&response, &result.unwrap_or_else(|error| json!({"error":error.to_string()})))?;
            if *cancel.borrow() { return Ok(()); }
        }
        tokio::select! { _ = cancel.changed() => return Ok(()), _ = tokio::time::sleep(Duration::from_millis(200)) => {} }
    }
}

/// Shared executor for the file bridge and the chat's scoped dynamic tool.
pub(super) async fn execute(root: &Path, prepared: &Prepared, args: &[String], cancel: &mut watch::Receiver<bool>) -> Result<Value, AppError> {
    let mut cmd = prepared.local_command();
    cmd.args(tool_args(root, args)?);
    let (stdout, stderr, status) = run_output(&mut cmd, cancel).await?;
    Ok(json!({"code":status.code().unwrap_or(1),"stdout":stdout,"stderr":stderr}))
}

pub(super) fn result_paths(root: &Path, id: &str, result: &Value) -> Result<Vec<PathBuf>, AppError> {
    if !root.join("video-request.json").is_file() { return Err(AppError::Other("此请求不是视频制作任务".into())); }
    let names = result["videos"].as_array().ok_or_else(|| AppError::Other("视频制作未返回成片".into()))?;
    let base = root.join("artifacts").join(id);
    let canonical = std::fs::canonicalize(&base)?;
    if canonical != std::fs::canonicalize(root)?.join("artifacts").join(id) { return Err(AppError::Other("视频输出目录越界".into())); }
    if names.len() != 1 { return Err(AppError::Other("每次视频制作须交付一个 MP4 成片".into())); }
    names.iter().map(|name| {
        let name = name.as_str().filter(|s| valid_result_image_name(s) && s.to_ascii_lowercase().ends_with(".mp4"))
            .ok_or_else(|| AppError::Other("视频文件名无效".into()))?;
        let path = std::fs::canonicalize(base.join(name))?;
        if path.parent() != Some(canonical.as_path()) || !path.is_file() || std::fs::metadata(&path)?.len() > 512 * 1024 * 1024 {
            return Err(AppError::Other("视频输出路径或大小无效，成片上限 512 MiB".into()));
        }
        let meta = crate::media::probe::probe(&path)?;
        if meta.width == 0 || meta.height == 0 || !meta.duration.is_finite() || meta.duration <= 0.0 {
            return Err(AppError::Other("视频输出不完整，请检查工程后重新渲染".into()));
        }
        Ok(path)
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, String, String) {
        let base = std::env::temp_dir().join(format!("bb-video-{}", uuid::Uuid::new_v4()));
        let id = format!("1793780000000-{}", uuid::Uuid::new_v4());
        let root = base.join(&id);
        std::fs::create_dir_all(root.join("results")).unwrap();
        let scope = format!("session-bowerbird-{}", "a".repeat(64));
        (root, id, scope)
    }
    #[test]
    fn video_engineering_identity_is_stable_and_scoped() {
        let (root, id, scope) = fixture();
        let base = project_root(&root, &scope).unwrap();
        let next_id = format!("1793780000001-{}", uuid::Uuid::new_v4());
        let next = root.parent().unwrap().join(&next_id);
        std::fs::create_dir_all(&next).unwrap();
        assert_eq!(project_root(&next, &scope).unwrap(), base);
        let guide = request(&root, &id, &scope, &[]).unwrap();
        let project = revision_root(&root, &scope).unwrap();
        std::fs::write(project.join("index.html"), b"existing project").unwrap();
        accept_revision(&root).unwrap();
        request(&next, &next_id, &scope, &[]).unwrap();
        let next_project = revision_root(&next, &scope).unwrap();
        assert_eq!(std::fs::read(next_project.join("index.html")).unwrap(), b"existing project");
        std::fs::write(next_project.join("index.html"), b"revised project").unwrap();
        accept_revision(&next).unwrap();
        accept_revision(&root).unwrap();
        let latest: Value = serde_json::from_slice(&std::fs::read(base.join("latest.json")).unwrap()).unwrap();
        assert_eq!(latest["requestId"], next_id);
        assert!(guide.contains("保留可编辑工程") || guide.contains("保留工程"));
        assert_eq!(std::fs::read(project.join("index.html")).unwrap(), b"existing project");
        assert_ne!(project_root(&next, &format!("session-bowerbird-{}", "b".repeat(64))).unwrap(), base);
        assert!(project_root(&root, "../../outside").is_err());
    }
    #[test]
    fn video_protocol_cannot_be_claimed_by_text_requests_or_fake_files() {
        let (root, id, scope) = fixture();
        let reply = root.join("results").join(format!("{id}.json"));
        let video = json!({"schemaVersion":1,"requestId":id,"videos":["result.mp4"]});
        write_json_atomic(&reply, &video).unwrap();
        assert!(read_workflow_result(&root, &id).is_err());
        request(&root, &id, &scope, &[]).unwrap();
        assert!(read_workflow_result(&root, &id).unwrap().is_some());
        let artifacts = root.join("artifacts").join(&id);
        std::fs::create_dir_all(&artifacts).unwrap();
        std::fs::write(artifacts.join("result.mp4"), b"not a video").unwrap();
        assert!(result_paths(&root, &id, &video).is_err());
        for videos in [json!([]), json!(["../outside.mp4"]), json!(["result.mp4", "second.mp4"]), json!(["result.png"])] {
            write_json_atomic(&reply, &json!({"schemaVersion":1,"requestId":id,"videos":videos})).unwrap();
            assert!(read_workflow_result(&root, &id).is_err());
        }
        write_json_atomic(&reply, &json!({"schemaVersion":1,"requestId":id,"text":"claimed success"})).unwrap();
        assert!(read_workflow_result(&root, &id).is_err());
        write_json_atomic(&reply, &json!({"schemaVersion":1,"requestId":id,"error":"环境未就绪"})).unwrap();
        assert!(read_workflow_result(&root, &id).is_ok());
    }
    #[test]
    fn video_inputs_are_snapshots_and_reject_non_media() {
        let (root, id, scope) = fixture();
        let source = root.join("source.png");
        std::fs::write(&source, b"fixture").unwrap();
        request(&root, &id, &scope, &[source.to_string_lossy().into_owned()]).unwrap();
        std::fs::write(&source, b"changed").unwrap();
        let project = revision_root(&root, &scope).unwrap();
        assert_eq!(std::fs::read(project.join("assets").join(&id).join("input-1.png")).unwrap(), b"fixture");
        assert!(request(&root, "new", &scope, &["https://example.com/a.mp4".into()]).is_err());
        assert!(request(&root, "new", &scope, &[root.join("script.exe").to_string_lossy().into_owned()]).is_err());
    }
    #[tokio::test]
    #[ignore = "requires an isolated installed BOWERBIRD_HYPERFRAMES_TEST_RUNTIME; no model calls"]
    async fn hyperframes_prepares_versioned_skills_and_wrapper() {
        let (root, id, scope) = fixture();
        request(&root, &id, &scope, &[]).unwrap();
        let (_sender, mut cancel) = watch::channel(false);
        let runtime = PathBuf::from(std::env::var("BOWERBIRD_HYPERFRAMES_TEST_RUNTIME").unwrap());
        let prepared = prepare_at(&root, &scope, runtime, &mut cancel).await.unwrap();
        assert!(prepared.project.is_dir());
        assert!(root.join(".agents/skills/hyperframes/SKILL.md").is_file());
        assert!(root.join(".agents/skills/hyperframes-cli/SKILL.md").is_file());
        let wrapper = std::fs::read_to_string(root.join("bowerbird-hyperframes.mjs")).unwrap();
        assert!(wrapper.contains("video-tool-requests"));
        assert!(prepared.project.join("assets/gsap.js").is_file());
    }
    #[test]
    fn video_tools_are_scoped_to_fixed_commands_and_artifacts() {
        let (root, id, _) = fixture();
        let artifacts = root.join("artifacts").join(id);
        std::fs::create_dir_all(&artifacts).unwrap();
        let check = |args: &[&str]| tool_args(&root, &args.iter().map(|arg| (*arg).into()).collect::<Vec<_>>());
        assert!(check(&["check", "--json"]).is_ok());
        assert!(check(&["snapshot", "--at", "0,1.5"]).is_ok());
        assert!(check(&["render", "--output", &artifacts.join("result.mp4").to_string_lossy(), "--quality", "delivery"]).is_ok());
        for args in [vec!["cloud", "render"], vec!["render", "--docker"], vec!["check", "../../outside"], vec!["snapshot", "--output", "outside"],
            vec!["snapshot", "--describe"], vec!["render", "--output", "C:/outside/result.mp4"], vec!["snapshot", "--frames", "1000"]] {
            assert!(check(&args).is_err(), "{args:?}");
        }
    }
    #[tokio::test]
    #[ignore = "isolated fixed runtime and synthetic project; no model calls"]
    async fn hyperframes_chat_engine_checks_previews_renders_and_cancels() {
        let (root, id, scope) = fixture();
        request(&root, &id, &scope, &[]).unwrap();
        let (stop, mut cancel) = watch::channel(false);
        let runtime = PathBuf::from(std::env::var("BOWERBIRD_HYPERFRAMES_TEST_RUNTIME").unwrap());
        let prepared = prepare_at(&root, &scope, runtime, &mut cancel).await.unwrap();
        copy_project(Path::new(&std::env::var("BOWERBIRD_HYPERFRAMES_TEST_PROJECT").unwrap()), &prepared.project, 0, &mut 0, &mut 0).unwrap();
        let artifacts = root.join("artifacts").join(&id); std::fs::create_dir_all(&artifacts).unwrap();
        for command in [vec!["check".into(), "--json".into()], vec!["snapshot".into(), "--frames".into(), "3".into(), "--json".into()],
            vec!["render".into(), "--output".into(), artifacts.join("result.mp4").to_string_lossy().into_owned(), "--quality".into(), "draft".into()]] {
            let result = execute(&root, &prepared, &command, &mut cancel).await.unwrap();
            assert_eq!(result["code"], 0, "{result}");
            if command[0] == "snapshot" {
                let result: Value = serde_json::from_str(result["stdout"].as_str().unwrap()).unwrap();
                assert_eq!(result["frames"].as_array().unwrap().len(), 3);
                for frame in result["frames"].as_array().unwrap() { assert!(Path::new(frame["path"].as_str().unwrap()).is_file()); }
            }
        }
        let paths = result_paths(&root, &id, &json!({"videos":["result.mp4"]})).unwrap();
        assert_eq!(crate::media::probe::probe(&paths[0]).unwrap().width, 640);
        stop.send(true).unwrap();
        assert!(execute(&root, &prepared, &["check".into()], &mut cancel).await.is_err());
    }
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "requires isolated runtime/project and BOWERBIRD_CODEX_BINARY; real sandbox, no model"]
    async fn hyperframes_tool_bridge_renders_inside_codex_sandbox() {
        let (root, id, scope) = fixture();
        request(&root, &id, &scope, &[]).unwrap();
        let (_sender, mut cancel) = watch::channel(false);
        let runtime = PathBuf::from(std::env::var("BOWERBIRD_HYPERFRAMES_TEST_RUNTIME").unwrap());
        let prepared = prepare_at(&root, &scope, runtime, &mut cancel).await.unwrap();
        copy_project(Path::new(&std::env::var("BOWERBIRD_HYPERFRAMES_TEST_PROJECT").unwrap()), &prepared.project, 0, &mut 0, &mut 0).unwrap();
        let node = prepared.node.clone();
        let output_dir = root.join("artifacts").join(&id);
        std::fs::create_dir_all(&output_dir).unwrap();
        let output = output_dir.join("result.mp4");
        std::fs::create_dir_all(root.join("isolated-codex-home")).unwrap();
        let (stop, receiver) = watch::channel(false);
        let bridge = tokio::spawn(serve(root.clone(), prepared, receiver));
        for args in [vec!["check".to_owned(), "--json".into()], vec!["snapshot".into(), "--frames".into(), "2".into()],
            vec!["render".into(), "--output".into(), output.to_string_lossy().into_owned(), "--fps".into(), "15".into(), "--quality".into(), "draft".into()]] {
            let mut cmd = command(Path::new(&std::env::var("BOWERBIRD_CODEX_BINARY").unwrap()));
            cmd.args(["-a", "never", "-c", "sandbox_mode=\"workspace-write\"", "-c", "windows.sandbox=\"unelevated\"", "-C"])
                .arg(&root).args(["sandbox", "--"]).arg(&node).arg(root.join("bowerbird-hyperframes.mjs")).args(args)
                .current_dir(&root).env("CODEX_HOME", root.join("isolated-codex-home"))
                .env_remove("CODEX_WINDOWS_REGISTERED_CORE").env_remove("CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY");
            let (stdout, stderr, status) = run_output(&mut cmd, &mut cancel).await.unwrap();
            if !status.success() { let _ = stop.send(true); bridge.await.unwrap(); panic!("{stdout}\n{stderr}"); }
        }
        let _ = stop.send(true); bridge.await.unwrap();
        let meta = crate::media::probe::probe(&output).unwrap();
        assert_eq!((meta.width, meta.height), (640, 360));
        assert!((meta.duration - 2.0).abs() < 0.2);
        let runtime = PathBuf::from(std::env::var("BOWERBIRD_HYPERFRAMES_TEST_RUNTIME").unwrap());
        let prepared = prepare_at(&root, &scope, runtime, &mut cancel).await.unwrap();
        let mut studio = super::super::video_studio::launch(&root, prepared, &cancel).await.unwrap();
        assert!(studio.url.starts_with("http://127.0.0.1:"));
        stop_child(&mut studio.child).await;
        assert!(studio.child.try_wait().unwrap().is_some());
    }
    #[test]
    #[ignore = "requires BOWERBIRD_HYPERFRAMES_TEST_VIDEO pointing to a rendered synthetic MP4"]
    fn hyperframes_rendered_video_is_ingested_once() {
        let (root, id, scope) = fixture();
        request(&root, &id, &scope, &[]).unwrap();
        let artifacts = root.join("artifacts").join(&id);
        std::fs::create_dir_all(&artifacts).unwrap();
        std::fs::write(revision_root(&root, &scope).unwrap().join("index.html"), b"synthetic fixture project").unwrap();
        std::fs::copy(std::env::var("BOWERBIRD_HYPERFRAMES_TEST_VIDEO").unwrap(), artifacts.join("result.mp4")).unwrap();
        write_json_atomic(&root.join("results").join(format!("{id}.json")), &json!({"schemaVersion":1,"requestId":id,"videos":["result.mp4"]})).unwrap();
        let paths = crate::core::paths::LibraryPaths::init(root.join("library")).unwrap();
        let db = crate::db::Database::open(&paths.db).unwrap();
        db.migrate().unwrap();
        let first = ingest_workflow_images(&root, &id, &paths, &db).unwrap();
        let second = ingest_workflow_images(&root, &id, &paths, &db).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].id, second[0].id);
        assert!(first[0].duration.unwrap_or(0.0) > 0.0);
    }
}
