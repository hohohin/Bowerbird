//! Native metadata runs before Tauri initialization, in a disposable child process.
use super::*;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub(super) fn probe_system(path: &Path, ext: &str, size: u64) -> AppResult<ProbeMeta> {
    let mut command = tools::command(&std::env::current_exe()?);
    command.arg("--video-probe-worker").arg(path);
    let output = run_probe(&mut command, Duration::from_secs(15))?;
    let meta: ProbeMeta = serde_json::from_slice(&output)
        .map_err(|e| AppError::Media(format!("系统视频信息无效：{e}")))?;
    checked_meta(ext, size, meta.width, meta.height, meta.duration)
}

// Redirect to a unique file rather than a pipe: a full pipe must not deadlock the
// timeout loop. Only read a bounded metadata response, and clean up on every path.
pub(super) fn run_probe(command: &mut Command, timeout: Duration) -> AppResult<Vec<u8>> {
    let path = std::env::temp_dir().join(format!("bowerbird-probe-{}.json", ulid::Ulid::new()));
    let output = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
    let result = (|| {
        let mut child = command.stdin(Stdio::null()).stdout(output).stderr(Stdio::null()).spawn()?;
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => break,
                Ok(Some(status)) => return Err(AppError::Media(format!("视频信息读取失败（{status}）"))),
                Ok(None) if started.elapsed() < timeout => std::thread::sleep(Duration::from_millis(25)),
                result => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(AppError::Media(match result {
                        Err(error) => error.to_string(),
                        _ => "视频信息读取超时".into(),
                    }));
                }
            }
        }
        let mut bytes = Vec::new();
        std::fs::File::open(&path)?.take(65537).read_to_end(&mut bytes)?;
        if bytes.len() > 65536 { return Err(AppError::Media("视频信息响应过大".into())); }
        Ok(bytes)
    })();
    // Command retains the stdout handle, including when spawn fails (Windows).
    command.stdout(Stdio::null());
    let _ = std::fs::remove_file(path);
    result
}

pub fn video_probe_worker() -> Option<i32> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).and_then(|arg| arg.to_str()) != Some("--video-probe-worker") { return None; }
    if args.len() != 3 { return Some(2); }
    let result = read_system(Path::new(&args[2])).and_then(|(width, height, duration)| {
        checked_meta("", 0, width, height, duration)
    });
    Some(match result {
        Ok(meta) => match serde_json::to_string(&meta) {
            Ok(json) => { println!("{json}"); 0 }
            Err(_) => 1,
        },
        Err(_) => 1,
    })
}

#[cfg(target_os = "windows")]
fn read_system(path: &Path) -> AppResult<(u32, u32, f64)> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "bowerbird_video_thumbnail", kind = "static")]
    #[link(name = "mfplat")]
    #[link(name = "mfreadwrite")]
    #[link(name = "mfuuid")]
    #[link(name = "ole32")]
    #[link(name = "delayimp")]
    extern "C" {
        fn bowerbird_windows_video_probe(source: *const u16, width: *mut u32, height: *mut u32, duration: *mut f64) -> i32;
    }
    let source: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let (mut width, mut height, mut duration) = (0, 0, 0.0);
    // SAFETY: terminated OS path and valid writable outputs; called only in the worker.
    let status = unsafe { bowerbird_windows_video_probe(source.as_ptr(), &mut width, &mut height, &mut duration) };
    if status < 0 { return Err(AppError::Media(format!("系统视频信息读取失败：{status:#x}"))); }
    Ok((width, height, duration))
}

#[cfg(target_os = "macos")]
fn read_system(path: &Path) -> AppResult<(u32, u32, f64)> {
    use std::os::unix::ffi::OsStrExt;
    #[link(name = "bowerbird_video_thumbnail", kind = "static")]
    extern "C" {
        fn bowerbird_video_probe(source: *const std::ffi::c_char, width: *mut u32, height: *mut u32, duration: *mut f64) -> i32;
    }
    let source = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| AppError::Media("视频路径无效".into()))?;
    let (mut width, mut height, mut duration) = (0, 0, 0.0);
    // SAFETY: terminated path and valid writable outputs; called only in the worker.
    let status = unsafe { bowerbird_video_probe(source.as_ptr(), &mut width, &mut height, &mut duration) };
    if status != 0 { return Err(AppError::Media("系统视频信息读取失败".into())); }
    Ok((width, height, duration))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn read_system(_: &Path) -> AppResult<(u32, u32, f64)> {
    Err(AppError::Media("当前系统没有原生视频读取接口".into()))
}
