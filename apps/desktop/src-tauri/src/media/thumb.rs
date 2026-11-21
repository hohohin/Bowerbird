//! 缩略图生成。Phase 1 用 image crate 缩放（Lanczos3）+ JPEG 输出。
//! 性能不足时切换到 fast_image_resize（已列入 Cargo.toml 备用）。

use std::path::Path;
use super::tools::{self, Tool};
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
    generate_video_with_meta(src, dst, max_size, false).map(|_| ())
}

pub(crate) fn generate_video_with_meta(src: &Path, dst: &Path, max_size: u32, read_meta: bool) -> AppResult<Option<super::probe::ProbeMeta>> {
    if let Some(parent) = dst.parent() { std::fs::create_dir_all(parent)?; }
    let temporary = dst.with_extension(format!("{}.jpg", ulid::Ulid::new()));
    let result = (|| {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let native = (|| -> AppResult<Option<super::probe::ProbeMeta>> {
            let mut command = tools::command(&std::env::current_exe()?);
            command.arg("--video-thumbnail-worker").arg(src).arg(&temporary).arg(max_size.to_string());
            if read_meta {
                command.arg("--metadata");
                let output = super::probe::native::run_probe(&mut command, Duration::from_secs(15))?;
                Ok(serde_json::from_slice(&output).ok())
            } else {
                run_bounded(&mut command, Duration::from_secs(15))?;
                Ok(None)
            }
        })();
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let native: AppResult<Option<super::probe::ProbeMeta>> = Err(AppError::Media("当前系统没有原生视频读取接口".into()));
        let metadata = match native {
            Ok(metadata) => metadata,
            Err(native_error) => {
                let binary = tools::resolve(Tool::Ffmpeg)?;
                let mut command = tools::command(&binary);
                command.args(["-nostdin", "-y", "-i"]).arg(src)
                    .args(["-frames:v", "1", "-vf"])
                    .arg(format!("scale={max_size}:{max_size}:force_original_aspect_ratio=decrease"))
                    .arg(&temporary);
                run_bounded(&mut command, Duration::from_secs(15)).map_err(|error| {
                    tracing::debug!(%native_error, "native thumbnail fallback");
                    error
                })?;
                if read_meta {
                    let ext = src.extension().unwrap_or_default().to_string_lossy().to_lowercase();
                    super::probe::probe_video_ffprobe(src, ext, std::fs::metadata(src)?.len()).ok()
                } else { None }
            }
        };
        let image = image::open(&temporary)?;
        if image.width() == 0 || image.height() == 0 || image.width().max(image.height()) > max_size {
            return Err(AppError::Media("视频封面尺寸无效".into()));
        }
        std::fs::rename(&temporary, dst)?;
        Ok(metadata)
    })();
    let _ = std::fs::remove_file(&temporary);
    #[cfg(target_os = "windows")]
    let _ = std::fs::remove_file(temporary.with_extension("bmp"));
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
    let read_meta = match args.len() {
        5 => false,
        6 if args[5] == "--metadata" => true,
        _ => return Some(2),
    };
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "bowerbird_video_thumbnail", kind = "static")]
        #[link(name = "mfplat")]
        #[link(name = "mfreadwrite")]
        #[link(name = "mfuuid")]
        #[link(name = "ole32")]
        #[link(name = "delayimp")]
        extern "C" { fn bowerbird_windows_video_frame(source: *const u16, destination: *const u16, rotation: *mut u32, width: *mut u32, height: *mut u32, duration: *mut f64) -> i32; }
        let Some(size) = args[4].to_str().and_then(|size| size.parse::<u32>().ok()).filter(|size| (1..=1024).contains(size)) else { return Some(2); };
        let bitmap = Path::new(&args[3]).with_extension("bmp");
        let source: Vec<u16> = args[2].encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = bitmap.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut rotation = 0;
        let (mut width, mut height, mut duration) = (0, 0, 0.0);
        // SAFETY: NUL-terminated OS paths and a writable u32; the worker owns the decoder.
        let status = unsafe { bowerbird_windows_video_frame(source.as_ptr(), destination.as_ptr(), &mut rotation, &mut width, &mut height, if read_meta { &mut duration } else { std::ptr::null_mut() }) };
        let result = (|| -> AppResult<()> {
            if status < 0 { return Err(AppError::Media(format!("Windows 视频封面提取失败：{status:#x}"))); }
            let frame = image::open(&bitmap)?;
            let frame = match rotation { 90 => frame.rotate90(), 180 => frame.rotate180(), 270 => frame.rotate270(), _ => frame };
            generate_from_image(&frame, Path::new(&args[3]), size)
        })();
        let _ = std::fs::remove_file(bitmap);
        if read_meta && result.is_ok() { print_thumbnail_metadata(Path::new(&args[2]), width, height, duration); }
        return Some(if result.is_ok() { 0 } else { 1 });
    }
    #[cfg(target_os = "macos")]
    {
        #[link(name = "bowerbird_video_thumbnail", kind = "static")]
        extern "C" { fn bowerbird_video_thumbnail(source: *const std::ffi::c_char, destination: *const std::ffi::c_char, size: u32, width: *mut u32, height: *mut u32, duration: *mut f64) -> i32; }
        let size = args[4].to_str().and_then(|size| size.parse::<u32>().ok()).filter(|size| (1..=1024).contains(size));
        let strings = args[2..4].iter().map(|arg| arg.to_str().and_then(|value| std::ffi::CString::new(value).ok())).collect::<Option<Vec<_>>>();
        return Some(match (strings, size) {
            (Some(paths), Some(size)) => {
                let (mut width, mut height, mut duration) = (0, 0, 0.0);
                let status = unsafe { bowerbird_video_thumbnail(paths[0].as_ptr(), paths[1].as_ptr(), size, &mut width, &mut height, if read_meta { &mut duration } else { std::ptr::null_mut() }) };
                if read_meta && status == 0 { print_thumbnail_metadata(Path::new(&args[2]), width, height, duration); }
                status
            },
            _ => 2,
        });
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Some(2)
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn print_thumbnail_metadata(source: &Path, width: u32, height: u32, duration: f64) {
    let ext = source.extension().unwrap_or_default().to_string_lossy().to_lowercase();
    let size = std::fs::metadata(source).map_or(0, |meta| meta.len());
    // Some native backends report only the first fragment's presentation offset.
    let iso = matches!(ext.as_str(), "mp4" | "mov" | "m4v")
        .then(|| super::probe::probe_iso_native(source, &ext, size).ok()).flatten();
    if let Some(meta) = iso.or_else(|| super::probe::checked_meta(&ext, size, width, height, duration).ok()) {
        if let Ok(json) = serde_json::to_string(&meta) { println!("{json}"); }
    }
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
