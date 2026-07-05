//! 探测媒体元数据（尺寸 / 大小 / 扩展名 / 时长）。
//! Phase 2：图片走 image crate；视频走 ffprobe；SVG/PSD 暂不取尺寸（前端/占位渲染）。

use std::path::Path;
use std::process::Command;

use image::ImageReader;

use crate::error::AppResult;

#[derive(Debug, Clone)]
pub struct ProbeMeta {
    pub ext: String,
    pub width: u32,
    pub height: u32,
    pub size: u64,
    /// 视频/动图时长（秒）。图片固定 0.0。
    pub duration: f64,
}

const VIDEO_EXTS: &[&str] = &["mp4", "mov", "webm", "mkv", "avi", "m4v"];

pub fn is_video(ext: &str) -> bool {
    VIDEO_EXTS.contains(&ext.to_lowercase().as_str())
}

pub fn probe(path: &Path) -> AppResult<ProbeMeta> {
    let size = std::fs::metadata(path)?.len();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if is_video(&ext) {
        return probe_video(path, ext, size);
    }

    // 图片 / SVG / PSD：用 image crate（SVG/PSD 解码失败 → 0×0，前端占位）
    let (width, height) = match ImageReader::open(path).and_then(|r| r.with_guessed_format()) {
        Ok(reader) => reader.into_dimensions().unwrap_or((0, 0)),
        Err(_) => (0, 0),
    };
    Ok(ProbeMeta {
        ext,
        width,
        height,
        size,
        duration: 0.0,
    })
}

fn probe_video(path: &Path, ext: String, size: u64) -> AppResult<ProbeMeta> {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height:format=duration",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()?;

    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut width = 0u32;
    let mut height = 0u32;
    let mut duration = 0.0f64;
    for line in stdout.lines() {
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() == 2 {
            if let (Ok(w), Ok(h)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
                width = w;
                height = h;
            }
        } else if parts.len() == 1 {
            if let Ok(d) = parts[0].parse::<f64>() {
                duration = d;
            }
        }
    }
    Ok(ProbeMeta {
        ext,
        width,
        height,
        size,
        duration,
    })
}
