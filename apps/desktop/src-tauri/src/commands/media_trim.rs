use std::{
    fs,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use crate::error::{AppError, AppResult};

// An edit must not encode against a source another trim is replacing.
pub(super) static TRIM_QUEUE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

pub(super) fn validate_range(start: f64, end: f64, duration: Option<f64>, media: &str) -> AppResult<()> {
    if !start.is_finite() || !end.is_finite() || start < 0.0 || end <= start
        || duration.is_some_and(|duration| !duration.is_finite() || end > duration + 0.001 || start >= duration) {
        return Err(AppError::Media(format!("入点和出点无效：需要 0 ≤ 入点 < 出点 ≤ {media}时长")));
    }
    Ok(())
}

pub(super) fn run_encoder(command: &mut Command, log: &Path, media: &str) -> AppResult<()> {
    let mut child = command.stdout(Stdio::null()).stderr(fs::File::create(log)?).spawn()?;
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => {
                let message = fs::read_to_string(log).unwrap_or_default();
                return Err(AppError::Media(format!("{media}裁剪失败：{}", message.chars().take(4000).collect::<String>())));
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(40)),
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::Media(format!("{media}裁剪超时或进程异常：{result:?}")));
            }
        }
    }
}
