use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{error, lock, read, write, Config, Job};
use crate::commands::local_install::{self, ManagedChild};
use crate::error::AppResult;

pub(super) const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
static WORKER: Mutex<Option<Worker>> = Mutex::new(None);
static STOPPING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub(super) struct Stage {
    pub stage: String,
    pub progress: Option<u8>,
    pub error_code: Option<String>,
    pub user_message: Option<String>,
    pub warning: Option<String>,
}

#[derive(Serialize)]
struct Request<'a> {
    #[serde(flatten)]
    job: &'a Job,
    preset: &'static str,
}

#[derive(Serialize)]
struct Mailbox<'a> {
    request_path: &'a Path,
}

struct Worker {
    child: ManagedChild,
    directory: tempfile::TempDir,
    base: PathBuf,
    config: Config,
    idle_since: Option<Instant>,
}

impl Worker {
    fn start(base: &Path, config: &Config) -> AppResult<Self> {
        let script = runner_path(base)?;
        Self::launch(base, config, &script)
    }

    fn launch(base: &Path, config: &Config, script: &Path) -> AppResult<Self> {
        let workers = base.join("workers");
        fs::create_dir_all(&workers)?;
        let directory = tempfile::Builder::new()
            .prefix("worker-")
            .tempdir_in(workers)?;
        let log = File::create(directory.path().join("worker.log"))?;
        let mut command = local_install::command(&config.python);
        command
            .arg("-u")
            .arg(script)
            .arg("--worker")
            .arg(directory.path())
            .env("PYTHONUTF8", "1")
            .env("HF_HUB_OFFLINE", "1")
            .env("NUMBA_CACHE_DIR", base.join("numba-cache"))
            .env("BOWERBIRD_VOICE_PARENT_PID", std::process::id().to_string());
        // ManagedChild supplies null stdin and owns the Windows process tree.
        let child = local_install::spawn_managed(&mut command, Some(&log))?;
        Ok(Self {
            child,
            directory,
            base: base.to_owned(),
            config: config.clone(),
            idle_since: None,
        })
    }

    fn is_reusable(&mut self, base: &Path, config: &Config) -> bool {
        self.base == base
            && &self.config == config
            && self
                .idle_since
                .is_some_and(|idle| idle.elapsed() < IDLE_TIMEOUT)
            && self.child.try_wait().is_ok_and(|exit| exit.is_none())
    }

    fn log_tail(&self) -> String {
        local_install::log_tail(&self.directory.path().join("worker.log"), 16 * 1024, 0)
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        if let Err(cause) = self.child.kill_and_wait() {
            tracing::warn!("voice worker {} termination: {cause}", self.child.id());
        }
    }
}

fn runner_path(base: &Path) -> AppResult<PathBuf> {
    let contents = include_bytes!("../voice_runner.py");
    let path = base.join(runner_filename(contents));
    if fs::read(&path).is_ok_and(|bytes| bytes == contents) {
        return Ok(path);
    }
    let mut temporary = tempfile::NamedTempFile::new_in(base)?;
    temporary.write_all(contents)?;
    temporary.as_file().sync_all()?;
    temporary.persist(&path).map_err(|err| err.error)?;
    Ok(path)
}

fn runner_filename(contents: &[u8]) -> String {
    let digest = format!("{:x}", Sha256::digest(contents));
    format!("runner-{}.py", &digest[..8])
}

pub(super) fn sweep_artifacts(base: &Path) {
    use super::store::{owned_dir, owned_file, remove_file};
    const AGE: Duration = Duration::from_secs(24 * 60 * 60);
    if !owned_dir(base) {
        return;
    }
    let current_script = runner_filename(include_bytes!("../voice_runner.py"));
    let stale = |path: &Path| {
        fs::symlink_metadata(path)
            .and_then(|meta| meta.modified())
            .is_ok_and(|modified| modified.elapsed().is_ok_and(|age| age >= AGE))
    };
    if let Ok(entries) = fs::read_dir(base) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            if name == current_script.as_str() || !owned_file(&path) || !stale(&path) {
                continue;
            }
            if name
                .to_str()
                .and_then(|name| name.strip_prefix("runner-")?.strip_suffix(".py"))
                .is_some_and(|hash| {
                    hash.len() == 8 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
            {
                remove_file(&path);
            }
        }
    }
    let workers = base.join("workers");
    if !owned_dir(&workers) {
        return;
    }
    let active = lock(&WORKER)
        .as_ref()
        .map(|worker| worker.directory.path().to_owned());
    if let Ok(entries) = fs::read_dir(workers) {
        for entry in entries.flatten() {
            let path = entry.path();
            if active.as_ref() == Some(&path) || !owned_dir(&path) || !stale(&path) {
                continue;
            }
            if !entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("worker-"))
            {
                continue;
            }
            for file in ["worker.log", "request.json", "request.claimed.json"] {
                remove_file(&path.join(file));
            }
            let _ = fs::remove_dir(path);
        }
    }
}

pub(super) fn reap_idle() {
    let mut worker = lock(&WORKER);
    if worker.as_ref().is_some_and(|worker| {
        worker.idle_since.is_some_and(|idle| {
            idle.elapsed() >= IDLE_TIMEOUT
                || read::<Config>(&worker.base.join("config.json"))
                    .is_ok_and(|config| config != worker.config)
        })
    }) {
        worker.take();
    }
}

pub(super) fn shutdown() {
    STOPPING.store(true, Ordering::SeqCst);
    lock(&WORKER).take();
}

pub(super) fn append_diagnostic(dir: &Path, message: &str) {
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("diagnostic.log"))
    {
        let _ = writeln!(file, "{message}");
    }
}

fn failure(code: &str, message: &str) -> Stage {
    Stage {
        stage: "failed".into(),
        error_code: Some(code.into()),
        user_message: Some(message.into()),
        ..Stage::default()
    }
}

pub(super) fn runner_failure(dir: &Path) -> Stage {
    let tail = local_install::log_tail(&dir.join("diagnostic.log"), 16 * 1024, 0).to_lowercase();
    if tail.contains("out of memory") && tail.contains("cuda") {
        failure("cuda_oom", "显存不足，请关闭其他占用显存的应用后重试")
    } else if tail.contains("1455") || tail.contains("paging file is too small") {
        failure(
            "paging_file",
            "Windows 页面文件空间不足，请释放内存或增大虚拟内存后重试",
        )
    } else if tail.contains("filenotfounderror") {
        failure(
            "file_missing",
            "声音环境或参考录音缺少文件，请重新检测环境并检查录音",
        )
    } else if tail.contains("modulenotfounderror") || tail.contains("importerror") {
        failure("environment", "本机声音依赖无法加载，请重新检测或修复环境")
    } else {
        failure("worker_exited", "声音进程意外退出，请查看诊断日志后重试")
    }
}

fn timeout_for(text: &str) -> Duration {
    Duration::from_secs(180 + (text.chars().count().min(3240) as u64 / 2))
}

#[cfg(test)]
pub(super) fn worker_pid() -> Option<u32> {
    lock(&WORKER).as_ref().map(|worker| worker.child.id())
}

#[cfg(test)]
pub(super) fn expire_worker() {
    if let Some(worker) = lock(&WORKER).as_mut() {
        worker.idle_since = Instant::now().checked_sub(IDLE_TIMEOUT);
    }
    reap_idle();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_raw_logs_and_limits_timeouts() {
        let temp = tempfile::tempdir().unwrap();
        for (message, code) in [
            ("RuntimeError: CUDA out of memory", "cuda_oom"),
            ("OSError: [WinError 1455]", "paging_file"),
            ("FileNotFoundError: model", "file_missing"),
            ("ModuleNotFoundError: torch", "environment"),
        ] {
            fs::write(temp.path().join("diagnostic.log"), message).unwrap();
            assert_eq!(
                runner_failure(temp.path()).error_code.as_deref(),
                Some(code)
            );
        }
        assert_eq!(timeout_for("短台词"), Duration::from_secs(181));
        assert_eq!(timeout_for(&"字".repeat(10_000)), Duration::from_secs(1800));
    }

    #[test]
    #[ignore = "requires VOICE_TEST_PYTHON; no GPU is used. Run native voice integration tests serially"]
    fn stalled_worker_is_terminated_and_recreated() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();
        let mut job = super::super::tests::job();
        job.config.python = std::env::var("VOICE_TEST_PYTHON").unwrap();
        let reference = base.join("reference.wav");
        fs::write(&reference, b"fixture").unwrap();
        job.reference = Some(reference.to_string_lossy().into());
        let script = base.join("fixture.py");
        fs::write(&script, "import time\ntime.sleep(30)\n").unwrap();
        for cancel_instead in [false, true] {
            let mut worker = Worker::launch(base, &job.config, &script).unwrap();
            worker.idle_since = Some(Instant::now());
            *lock(&WORKER) = Some(worker);
            let cancel = AtomicBool::new(false);
            if cancel_instead {
                let result = std::thread::scope(|scope| {
                    scope.spawn(|| {
                        std::thread::sleep(Duration::from_millis(150));
                        cancel.store(true, Ordering::SeqCst);
                    });
                    run_with_timeout(base, &job, &cancel, Duration::from_secs(3), |_| {})
                });
                assert!(result.unwrap_err().to_string().contains("取消"));
            } else {
                let status =
                    run_with_timeout(base, &job, &cancel, Duration::from_millis(250), |_| {})
                        .unwrap();
                assert_eq!(status.error_code.as_deref(), Some("timeout"));
            }
            assert!(worker_pid().is_none());
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires VOICE_TEST_PYTHON; Windows process-tree fixture, no GPU"]
    fn worker_tree_exits_when_desktop_is_force_killed() {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use std::process::{Child, Stdio};
        use windows::Win32::{
            Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
        };

        const READY: &str = "BOWERBIRD_VOICE_TEST_TREE_READY";
        if let Some(ready) = std::env::var_os(READY) {
            let ready = PathBuf::from(ready);
            let base = ready.parent().unwrap();
            let script = base.join("tree.py");
            fs::write(
                &script,
                r#"
import os
from pathlib import Path
import subprocess
import sys
import time

child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
ready = Path(os.environ["BOWERBIRD_VOICE_TEST_TREE_READY"])
temporary = ready.with_suffix(".tmp")
temporary.write_text(f"{os.getpid()} {child.pid}", encoding="utf-8")
temporary.replace(ready)
time.sleep(30)
"#,
            )
            .unwrap();
            let config = Config {
                python: std::env::var("VOICE_TEST_PYTHON").unwrap(),
                model: String::new(),
            };
            let _worker = Worker::launch(base, &config, &script).unwrap();
            std::thread::sleep(Duration::from_secs(35));
            return;
        }

        struct FixtureParent(Child);
        impl Drop for FixtureParent {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let scratch = tempfile::tempdir().unwrap();
        let ready = scratch.path().join("ready.txt");
        let (_, module) = module_path!().split_once("::").unwrap();
        let name = format!("{module}::worker_tree_exits_when_desktop_is_force_killed");
        let mut parent = FixtureParent(
            local_install::command(std::env::current_exe().unwrap())
                .args(["--ignored", "--exact", &name])
                .env(READY, &ready)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(8);
        let pids = loop {
            if let Ok(value) = fs::read_to_string(&ready) {
                break value
                    .split_whitespace()
                    .map(|pid| pid.parse::<u32>().unwrap())
                    .collect::<Vec<_>>();
            }
            assert!(
                parent.0.try_wait().unwrap().is_none(),
                "desktop fixture stopped before creating its worker"
            );
            assert!(
                Instant::now() < deadline,
                "desktop fixture did not report its worker tree"
            );
            std::thread::sleep(Duration::from_millis(30));
        };
        assert_eq!(pids.len(), 2);
        let handles: Vec<_> = pids
            .into_iter()
            .map(|pid| unsafe {
                OwnedHandle::from_raw_handle(
                    OpenProcess(PROCESS_SYNCHRONIZE, false, pid).unwrap().0,
                )
            })
            .collect();
        for handle in &handles {
            assert_eq!(
                unsafe { WaitForSingleObject(HANDLE(handle.as_raw_handle()), 0) },
                WAIT_TIMEOUT
            );
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        parent.0.kill().unwrap();
        parent.0.wait().unwrap();
        for handle in &handles {
            let left = deadline
                .saturating_duration_since(Instant::now())
                .as_millis() as u32;
            assert_eq!(
                unsafe { WaitForSingleObject(HANDLE(handle.as_raw_handle()), left) },
                WAIT_OBJECT_0
            );
        }
    }
}

pub(super) fn run(
    base: &Path,
    job: &Job,
    cancel: &AtomicBool,
    report: impl FnMut(&Stage),
) -> AppResult<Stage> {
    run_with_timeout(base, job, cancel, timeout_for(&job.text), report)
}

pub(super) fn run_with_timeout(
    base: &Path,
    job: &Job,
    cancel: &AtomicBool,
    timeout: Duration,
    mut report: impl FnMut(&Stage),
) -> AppResult<Stage> {
    if cancel.load(Ordering::SeqCst) {
        return Err(error("生成已取消，可以重新生成"));
    }
    if !job
        .reference
        .as_deref()
        .is_some_and(|path| Path::new(path).is_file())
    {
        return Err(error("请先选择有效的参考录音，再生成克隆配音"));
    }
    let dir = base.join("runs").join(&job.id);
    let request_path = dir.join("request.json");
    write(
        &request_path,
        &Request {
            job,
            preset: if job.purpose == "preview" {
                "quick"
            } else {
                "quality"
            },
        },
    )?;
    let status_path = dir.join("status.json");

    {
        let mut worker = lock(&WORKER);
        if STOPPING.load(Ordering::SeqCst) || cancel.load(Ordering::SeqCst) {
            return Err(error("生成已取消，可以重新生成"));
        }
        if !worker
            .as_mut()
            .is_some_and(|worker| worker.is_reusable(base, &job.config))
        {
            worker.take();
            match Worker::start(base, &job.config) {
                Ok(process) => *worker = Some(process),
                Err(cause) => {
                    append_diagnostic(
                        &dir,
                        &format!("Could not start the managed voice worker: {cause}"),
                    );
                    return Ok(failure(
                        "worker_spawn",
                        "无法启动本机声音环境，请检查 Python 程序与依赖安装",
                    ));
                }
            }
        }
        let process = worker.as_mut().expect("voice worker installed under lock");
        process.idle_since = None;
        if let Err(cause) = write(
            &process.directory.path().join("request.json"),
            &Mailbox {
                request_path: &request_path,
            },
        ) {
            worker.take();
            append_diagnostic(&dir, &format!("Could not send the voice request: {cause}"));
            return Ok(failure(
                "worker_request",
                "无法将请求发送给本机声音进程，请检查磁盘空间后重试",
            ));
        }
    }

    let started = Instant::now();
    let mut previous = None;
    loop {
        let status = read::<Stage>(&status_path).ok();
        let mut worker = lock(&WORKER);
        if cancel.load(Ordering::SeqCst) || STOPPING.load(Ordering::SeqCst) {
            worker.take();
            return Err(error("生成已取消，可以重新生成"));
        }
        if let Some(status) = status
            .as_ref()
            .filter(|s| matches!(s.stage.as_str(), "succeeded" | "failed"))
        {
            if status.error_code.as_deref() == Some("cuda_oom") {
                worker.take();
            } else if let Some(process) = worker.as_mut() {
                process.idle_since = Some(Instant::now());
            }
            drop(worker);
            if status.stage == "succeeded" {
                // Rust still has to publish the WAV. Notify even when the runner's
                // own brief saving stage fell between two polls.
                report(status);
            }
            return Ok(status.clone());
        }
        let Some(process) = worker.as_mut() else {
            return Ok(runner_failure(&dir));
        };
        if started.elapsed() >= timeout {
            worker.take();
            append_diagnostic(
                &dir,
                &format!(
                    "Voice inference exceeded its {} s deadline",
                    timeout.as_secs()
                ),
            );
            return Ok(failure(
                "timeout",
                "本机声音生成超时，请分段生成或关闭占用显存的应用后重试",
            ));
        }
        match process.child.try_wait() {
            Ok(None) => (),
            result => {
                append_diagnostic(
                    &dir,
                    &format!("Voice worker stopped: {result:?}\n{}", process.log_tail()),
                );
                worker.take();
                // The worker may have committed its result between the first read and exit.
                if let Ok(status) = read::<Stage>(&status_path) {
                    if matches!(status.stage.as_str(), "succeeded" | "failed") {
                        return Ok(status);
                    }
                }
                return Ok(runner_failure(&dir));
            }
        }
        drop(worker);
        if let Some(status) = status.filter(|status| Some(status) != previous.as_ref()) {
            report(&status);
            previous = Some(status);
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}
