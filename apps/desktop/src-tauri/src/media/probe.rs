//! 探测媒体元数据（尺寸 / 大小 / 扩展名 / 时长）。
//! Phase 2：图片走 image crate；视频走 ffprobe；SVG/PSD 暂不取尺寸（前端/占位渲染）。
//! 视频探测已改为无外部依赖：mp4/mov/m4v 进程内解析 ISO BMFF（创作提交、生成入库
//! 不再要求本机装有 ffprobe），解析不了的罕见变体及 webm/mkv/avi 仍回退 ffprobe。

use std::path::Path;
use super::tools::{self, Tool};

use image::ImageReader;

use crate::error::{AppError, AppResult};

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
    if matches!(ext.as_str(), "mp4" | "mov" | "m4v") {
        match probe_iso_native(path, &ext, size) {
            Ok(meta) => return Ok(meta),
            Err(error) => tracing::debug!(
                "native mp4 probe failed for {}: {error}; falling back to ffprobe",
                path.display()
            ),
        }
    }
    probe_video_ffprobe(path, ext, size)
}

/// 纯 Rust 解析 ISO BMFF（mp4/mov/m4v）：mvhd 取时长，视频轨取宽高。
fn probe_iso_native(path: &Path, ext: &str, size: u64) -> AppResult<ProbeMeta> {
    let file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let reader = mp4::Mp4Reader::read_header(file, len)
        .map_err(|e| AppError::Media(format!("mp4 解析失败：{e}")))?;
    let track = reader
        .tracks()
        .values()
        .filter(|t| matches!(t.track_type(), Ok(mp4::TrackType::Video)))
        .max_by_key(|t| (t.width() as u64) * (t.height() as u64))
        .or_else(|| {
            reader
                .tracks()
                .values()
                .find(|t| t.width() > 0 && t.height() > 0)
        });
    let mvhd = &reader.moov.mvhd;
    // 版本 0 里「未知时长」记为全 1（u32::MAX），不能当有效值。
    let raw_duration = if mvhd.duration >= u64::from(u32::MAX) {
        0
    } else {
        mvhd.duration
    };
    let duration = raw_duration as f64 / mvhd.timescale as f64;
    let (width, height) = track
        .map(|t| (u32::from(t.width()), u32::from(t.height())))
        .unwrap_or((0, 0));
    if width == 0 || height == 0 || !duration.is_finite() || duration <= 0.0 {
        return Err(AppError::Media("视频没有有效尺寸或时长".into()));
    }
    Ok(ProbeMeta {
        ext: ext.to_string(),
        width,
        height,
        size,
        duration,
    })
}

fn probe_video_ffprobe(path: &Path, ext: String, size: u64) -> AppResult<ProbeMeta> {
    let binary = tools::resolve(Tool::Ffprobe)?;
    let out = tools::command(binary)
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
        .output().map_err(|e| tools::spawn_error(Tool::Ffprobe, binary, e))?;

    if !out.status.success() {
        return Err(AppError::Media(format!(
            "ffprobe 无法读取视频：{}",
            String::from_utf8_lossy(&out.stderr)
                .chars()
                .take(300)
                .collect::<String>()
        )));
    }

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
    if width == 0 || height == 0 || !duration.is_finite() || duration <= 0.0 {
        return Err(AppError::Media("视频没有有效尺寸或时长".into()));
    }
    Ok(ProbeMeta {
        ext,
        width,
        height,
        size,
        duration,
    })
}

#[cfg(test)]
#[path = "probe_tests.rs"]
mod tests;
