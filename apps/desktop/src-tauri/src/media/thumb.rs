//! 缩略图生成。Phase 1 用 image crate 缩放（Lanczos3）+ JPEG 输出。
//! 性能不足时切换到 fast_image_resize（已列入 Cargo.toml 备用）。

use std::path::Path;

use image::imageops::FilterType;
use image::{ImageFormat, ImageReader};

use crate::error::{AppError, AppResult};

/// 生成缩略图：最长边不超过 `max_size`，JPEG 输出到 `dst`。
pub fn generate(src: &Path, dst: &Path, max_size: u32) -> AppResult<()> {
    let img = ImageReader::open(src)?
        .with_guessed_format()?
        .decode()
        .map_err(|e| AppError::Media(format!("decode: {e}")))?;

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

/// 视频缩略图：用系统 ffmpeg 在第 1 秒抽一帧（max_size 最长边）。
pub fn generate_video(src: &Path, dst: &Path, max_size: u32) -> AppResult<()> {
    use std::process::Stdio;
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let status = std::process::Command::new("ffmpeg")
        .args(["-y", "-ss", "1", "-i"])
        .arg(src)
        .args(["-frames:v", "1", "-vf"])
        .arg(format!("scale={max_size}:-2"))
        .arg(dst)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| AppError::Media(format!("spawn ffmpeg: {e}")))?;
    if !status.success() {
        return Err(AppError::Media(format!("ffmpeg exited {status}")));
    }
    Ok(())
}
