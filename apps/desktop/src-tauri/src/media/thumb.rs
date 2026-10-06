//! 缩略图生成。Phase 1 用 image crate 缩放（Lanczos3）+ JPEG 输出。
//! 性能不足时切换到 fast_image_resize（已列入 Cargo.toml 备用）。

use std::path::Path;
use super::tools;
#[cfg(not(target_os = "macos"))]
use super::tools::Tool;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use image::imageops::FilterType;
use image::{ImageFormat, ImageReader};

use crate::error::{AppError, AppResult};

/// 生成缩略图：最长边不超过 `max_size`，JPEG 输出到 `dst`。
pub fn generate(src: &Path, dst: &Path, max_size: u32) -> AppResult<()> {
    let img = ImageReader::open(src)?
        .with_guessed_format()?
        .decode()
        .map_err(|e| AppError::Media(format!("decode: {e}")))?;
    generate_from_image(&img, dst, max_size)
}

/// 同 `generate`，但从已解码的 `DynamicImage` 生成（省一次 decode）。
pub fn generate_from_image(img: &image::DynamicImage, dst: &Path, max_size: u32) -> AppResult<()> {
    let (w, h) = (img.width(), img.height());
    let (dst_w, dst_h) = if w.max(h) <= max_size {
        (w, h)
    } else {
        let scale = max_size as f32 / w.max(h) as f32;
        (
            ((w as f32) * scale).round().max(1.0) as u32,
            ((h as f32) * scale).round().max(1.0) as u32,
        )
    };

    let resized = img.resize(dst_w, dst_h, FilterType::Lanczos3);
    let rgb = resized.to_rgb8();

    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    rgb.save_with_format(dst, ImageFormat::Jpeg)
        .map_err(|e| AppError::Media(format!("save thumb: {e}")))?;
    Ok(())
}

/// Decode in a disposable process. A stuck media decoder must not block the UI or run forever.
pub fn generate_video(src: &Path, dst: &Path, max_size: u32) -> AppResult<()> {
    if let Some(parent) = dst.parent() { std::fs::create_dir_all(parent)?; }
    let temporary = dst.with_extension(format!("{}.jpg", ulid::Ulid::new()));
    let result = (|| {
        #[cfg(target_os = "macos")]
        {
            let mut command = tools::command(&std::env::current_exe()?);
            command.arg("--video-thumbnail-worker").arg(src).arg(&temporary).arg(max_size.to_string());
            run_bounded(&mut command, Duration::from_secs(15))?;
        }
        #[cfg(not(target_os = "macos"))]
        {
            let binary = tools::resolve(Tool::Ffmpeg)?;
            let mut command = tools::command(&binary);
            command.args(["-nostdin", "-y", "-i"]).arg(src)
                .args(["-frames:v", "1", "-vf"])
                .arg(format!("scale={max_size}:{max_size}:force_original_aspect_ratio=decrease"))
                .arg(&temporary);
            run_bounded(&mut command, Duration::from_secs(15))?;
        }
        let image = image::open(&temporary)?;
        if image.width() == 0 || image.height() == 0 || image.width().max(image.height()) > max_size {
            return Err(AppError::Media("视频封面尺寸无效".into()));
        }
        std::fs::rename(&temporary, dst)?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&temporary);
    result
}

fn run_bounded(command: &mut Command, timeout: Duration) -> AppResult<()> {
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return if status.success() { Ok(()) } else { Err(AppError::Media("视频封面提取失败".into())) },
            Ok(None) if started.elapsed() < timeout => std::thread::sleep(Duration::from_millis(25)),
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::Media(match result {
                    Err(error) => error.to_string(),
                    _ => "视频封面提取超时".into(),
                }));
            }
        }
    }
}

/// Early CLI dispatch: no windows, accounts, database, or production initialization.
pub fn video_thumbnail_worker() -> Option<i32> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).and_then(|arg| arg.to_str()) != Some("--video-thumbnail-worker") { return None; }
    #[cfg(target_os = "macos")]
    {
        #[link(name = "bowerbird_video_thumbnail", kind = "static")]
        extern "C" { fn bowerbird_video_thumbnail(source: *const std::ffi::c_char, destination: *const std::ffi::c_char, size: u32) -> i32; }
        if args.len() != 5 { return Some(2); }
        let size = args[4].to_str().and_then(|size| size.parse::<u32>().ok()).filter(|size| (1..=1024).contains(size));
        let strings = args[2..4].iter().map(|arg| arg.to_str().and_then(|value| std::ffi::CString::new(value).ok())).collect::<Option<Vec<_>>>();
        return Some(match (strings, size) {
            (Some(paths), Some(size)) => unsafe { bowerbird_video_thumbnail(paths[0].as_ptr(), paths[1].as_ptr(), size) },
            _ => 2,
        });
    }
    #[cfg(not(target_os = "macos"))]
    Some(2)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn video_decoder_timeout_is_bounded_and_reaped() {
        let started = Instant::now();
        let error = run_bounded(Command::new("/bin/sleep").arg("20"), Duration::from_millis(80)).unwrap_err();
        assert!(error.to_string().contains("超时"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
    #[test]
    fn video_decoder_failure_is_reported() {
        assert!(run_bounded(&mut Command::new("/usr/bin/false"), Duration::from_secs(1)).is_err());
        assert!(run_bounded(&mut Command::new("/usr/bin/true"), Duration::from_secs(1)).is_ok());
    }
}
