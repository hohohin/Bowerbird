//! Shared filesystem validation and process ownership for the H3 and voice installers.
use std::{
    ffi::OsStr,
    fs::{self, File, Metadata},
    io::{self, Read, Seek, SeekFrom},
    path::Path,
    process::Command,
    sync::{atomic::{AtomicBool, Ordering}, Arc},
    time::{Duration, Instant},
};

use sha2::{Digest, Sha256};

use crate::{cloud::AuthClient, error::{AppError, AppResult}};
use super::install_download::wait_cancel;

#[cfg(windows)]
#[path = "local_install/windows_process.rs"]
mod windows_process;
#[cfg(windows)]
pub(super) use windows_process::{spawn_managed, ManagedChild};

pub(super) fn command(program: impl AsRef<OsStr>) -> Command {
    let program = program.as_ref();
    #[cfg(windows)]
    let resolved = ["tar.exe", "cmd.exe", "powershell.exe"].into_iter()
        .find(|name| program.eq_ignore_ascii_case(OsStr::new(name)))
        .and_then(|_| windows_process::system_program(program).ok());
    #[cfg(windows)]
    let program = resolved.as_deref().map(Path::as_os_str).unwrap_or(program);
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;
        command.creation_flags(CREATE_NO_WINDOW.0);
    }
    command
}

#[cfg(not(windows))]
pub(super) struct ManagedChild(std::process::Child);

#[cfg(not(windows))]
pub(super) fn spawn_managed(command: &mut Command, log: Option<&File>) -> io::Result<ManagedChild> {
    use std::process::Stdio;
    command.stdin(Stdio::null());
    if let Some(log) = log {
        command.stdout(log.try_clone()?).stderr(log.try_clone()?);
    } else {
        command.stdout(Stdio::null()).stderr(Stdio::null());
    }
    command.spawn().map(ManagedChild)
}

#[cfg(not(windows))]
impl ManagedChild {
    pub(super) fn id(&self) -> u32 { self.0.id() }
    pub(super) fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> { self.0.try_wait() }
    pub(super) fn kill_and_wait(&mut self) -> io::Result<()> {
        if self.0.try_wait()?.is_none() {
            if let Err(error) = self.0.kill() {
                if self.0.try_wait()?.is_none() { return Err(error); }
            }
            self.0.wait()?;
        }
        Ok(())
    }
}

#[cfg(not(windows))]
impl Drop for ManagedChild {
    fn drop(&mut self) {
        let _ = self.kill_and_wait();
    }
}

pub(super) fn free_bytes(path: &Path) -> AppResult<u64> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{core::PCWSTR, Win32::Storage::FileSystem::GetDiskFreeSpaceExW};
        let mut ancestor = path;
        while !ancestor.exists() {
            ancestor = ancestor.parent().ok_or_else(|| AppError::Other("安装磁盘不可用".into()))?;
        }
        let wide: Vec<u16> = ancestor.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut available = 0;
        unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut available), None, None) }
            .map_err(io::Error::from)?;
        Ok(available)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err(AppError::Other("此平台暂不支持一键安装".into()))
    }
}

pub(super) async fn watch_install_account(auth: AuthClient, owner: String, cancel: Arc<AtomicBool>) {
    while !cancel.load(Ordering::Relaxed) {
        let login = auth.snapshot();
        if !login.logged_in || login.user_id.as_deref() != Some(owner.as_str()) {
            cancel.store(true, Ordering::Relaxed);
            return;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

pub(super) fn log_tail(path: &Path, max_bytes: u64, start: u64) -> String {
    let read = || -> io::Result<String> {
        let mut file = File::open(path)?;
        let len = file.metadata()?.len();
        file.seek(SeekFrom::Start(start.max(len.saturating_sub(max_bytes))))?;
        let mut bytes = Vec::new();
        file.take(max_bytes).read_to_end(&mut bytes)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    };
    read().unwrap_or_default()
}

fn cancelled() -> AppError {
    AppError::Other("校验已暂停，已下载内容保留".into())
}

struct StopHash(Arc<AtomicBool>);
impl Drop for StopHash {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

pub(super) async fn hash(path: &Path, cancel: &AtomicBool, mut progress: impl FnMut(u64) + Send + 'static) -> AppResult<String> {
    if cancel.load(Ordering::Relaxed) { return Err(cancelled()); }
    let path = path.to_owned();
    let stop = StopHash(Arc::new(AtomicBool::new(false)));
    let worker_stop = stop.0.clone();
    let (send, mut updates) = tokio::sync::watch::channel(0);
    let mut worker = tokio::task::spawn_blocking(move || {
        let mut file = File::open(path)?;
        let mut digest = Sha256::new();
        let mut buffer = vec![0; 1024 * 1024];
        let mut read_bytes = 0;
        let mut published: Option<Instant> = None;
        while !worker_stop.load(Ordering::Relaxed) {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                send.send_replace(read_bytes);
                return Ok(format!("{:x}", digest.finalize()));
            }
            digest.update(&buffer[..count]);
            read_bytes += count as u64;
            if published.is_none_or(|previous| previous.elapsed() >= Duration::from_millis(200)) {
                send.send_replace(read_bytes);
                published = Some(Instant::now());
            }
        }
        Err(cancelled())
    });
    let waiting = wait_cancel(cancel);
    tokio::pin!(waiting);
    let mut reported = None;
    loop {
        if cancel.load(Ordering::Relaxed) { return Err(cancelled()); }
        tokio::select! {
            biased;
            _ = &mut waiting => return Err(cancelled()),
            result = &mut worker => {
                if cancel.load(Ordering::Relaxed) { return Err(cancelled()); }
                let digest = result.map_err(|_| AppError::Other("文件校验任务未完成".into()))??;
                let total = *updates.borrow();
                if reported != Some(total) { progress(total); }
                return Ok(digest);
            }
            Ok(()) = updates.changed() => {
                let latest = *updates.borrow_and_update();
                progress(latest);
                reported = Some(latest);
            }
        }
    }
}

pub(super) fn metadata_stamp(metadata: &Metadata, sha: &str) -> Option<String> {
    if !metadata.is_file() { return None; }
    let modified = metadata.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(format!("{}:{}:{sha}", metadata.len(), modified.as_nanos()))
}

pub(super) fn verification_stamp(path: &Path, sha: &str) -> Option<String> {
    metadata_stamp(&fs::metadata(path).ok()?, sha)
}

pub(super) fn verified(path: &Path, size: u64, sha: &str) -> bool {
    fs::metadata(path).ok().filter(|metadata| metadata.len() == size)
        .and_then(|metadata| metadata_stamp(&metadata, sha))
        .is_some_and(|stamp| fs::read_to_string(path.with_extension("verified")).is_ok_and(|cached| cached == stamp))
}

pub(super) fn remember_verified(path: &Path, stamp: Option<String>) {
    if let Some(stamp) = stamp {
        let _ = fs::write(path.with_extension("verified"), stamp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn hash_verification_records_progress_and_invalidates_an_old_stamp() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("model.bin");
        fs::write(&file, b"abc").unwrap();
        let cancel = AtomicBool::new(false);
        let bytes = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let reported = bytes.clone();
        let digest = hash(&file, &cancel, move |position| reported.store(position, Ordering::Relaxed)).await.unwrap();
        assert_eq!(digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(bytes.load(Ordering::Relaxed), 3);
        assert!(!verified(&file, 3, &digest));
        remember_verified(&file, verification_stamp(&file, &digest));
        assert!(verified(&file, 3, &digest));
        assert!(!verified(&file, 3, "different-digest"));
        fs::write(&file, b"ab").unwrap();
        assert!(!verified(&file, 3, &digest));
        cancel.store(true, Ordering::Relaxed);
        assert!(hash(&file, &cancel, |_| panic!("cancelled hash reported progress")).await.is_err());
    }

    #[tokio::test]
    async fn cancelling_during_hash_returns_promptly_without_a_final_digest() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("large-model.bin");
        let size = 64 * 1024 * 1024;
        File::create(&path).unwrap().set_len(size).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let requested_at = Arc::new(std::sync::Mutex::new(None));
        let stop = cancel.clone();
        let time = requested_at.clone();
        let digest = hash(&path, &cancel, move |bytes| {
            assert!(bytes > 0 && bytes < size, "cancel must occur during an active read");
            assert!(!stop.swap(true, Ordering::Relaxed), "unexpected progress after cancellation");
            *time.lock().unwrap() = Some(Instant::now());
        }).await;
        assert!(digest.unwrap_err().to_string().contains("校验已暂停"));
        assert!(requested_at.lock().unwrap().unwrap().elapsed() < Duration::from_millis(500));
        assert_eq!(fs::metadata(path).unwrap().len(), size);
    }
}
