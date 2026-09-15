//! 缩略图生成。Phase 1 用 image crate 缩放（Lanczos3）+ JPEG 输出。
//! 性能不足时切换到 fast_image_resize（已列入 Cargo.toml 备用）。

use std::path::Path;
use super::tools::{self, Tool};

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

/// 视频缩略图：用解析出的 ffmpeg 在第 1 秒抽一帧（max_size 最长边）。
pub fn generate_video(src: &Path, dst: &Path, max_size: u32) -> AppResult<()> {
    use std::process::Stdio;
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let binary = tools::resolve(Tool::Ffmpeg)?;
    for seek in ["1", "0"] {
        let mut command = tools::command(binary);
        let status = command
            .args(["-y", "-ss", seek, "-i"])
            .arg(src)
            .args(["-frames:v", "1", "-vf"])
            .arg(format!(
                "scale={max_size}:{max_size}:force_original_aspect_ratio=decrease"
            ))
            .arg(dst)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| tools::spawn_error(Tool::Ffmpeg, binary, e))?;
        if status.success() && image::open(dst).is_ok() {
            return Ok(());
        }
    }
    let _ = std::fs::remove_file(dst);
    Err(AppError::Media("ffmpeg 未能生成视频缩略图".into()))
}
