//! 探测媒体元数据（尺寸 / 大小 / 扩展名 / 时长）。
//! 图片走 image crate；视频依次尝试 ISO BMFF、系统媒体接口、可选 ffprobe。

use std::path::Path;
use super::tools::{self, Tool};

use image::ImageReader;

use crate::error::{AppError, AppResult};

#[path = "probe_native.rs"]
mod native;
pub use native::video_probe_worker;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
                "mp4 probe failed for {}: {error}; trying system metadata",
                path.display()
            ),
        }
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    match native::probe_system(path, &ext, size) {
        Ok(meta) => return Ok(meta),
        Err(error) => tracing::debug!("system video probe failed for {}: {error}; trying optional ffprobe", path.display()),
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
    let raw_duration = if (mvhd.version == 0 && mvhd.duration == u64::from(u32::MAX)) || mvhd.duration == u64::MAX {
        0
    } else {
        mvhd.duration
    };
    let duration = if reader.is_fragmented() {
        // Fragmented MP4 often leaves mvhd duration empty. Windows may then expose
        // only the presentation offset as duration; read actual fragment timing.
        let mut duration = 0.0f64;
        for track in reader.tracks().values() {
            let mut end = 0u64;
            let mut first = None;
            for fragment in reader.moofs.iter().flat_map(|moof| &moof.trafs)
                .filter(|fragment| fragment.tfhd.track_id == track.track_id()) {
                let run = fragment.trun.as_ref().ok_or_else(|| AppError::Media("视频分片缺少时序".into()))?;
                let default = fragment.tfhd.default_sample_duration.or_else(|| reader.moov.mvex.as_ref()
                    .filter(|mvex| mvex.trex.track_id == track.track_id()).map(|mvex| mvex.trex.default_sample_duration));
                let span = if run.sample_durations.len() == run.sample_count as usize {
                    run.sample_durations.iter().map(|value| u64::from(*value)).sum()
                } else if run.sample_durations.is_empty() {
                    u64::from(default.unwrap_or(0)) * u64::from(run.sample_count)
                } else { 0 };
                if span == 0 { return Err(AppError::Media("视频分片时长未知".into())); }
                let start = fragment.tfdt.as_ref().map(|tfdt| tfdt.base_media_decode_time).unwrap_or(end);
                first = Some(first.map_or(start, |previous: u64| previous.min(start)));
                end = end.max(start.checked_add(span).ok_or_else(|| AppError::Media("视频分片时长溢出".into()))?);
            }
            if let Some(first) = first {
                let seconds = (end - first) as f64 / f64::from(track.timescale());
                if !seconds.is_finite() { return Err(AppError::Media("视频分片时间基无效".into())); }
                duration = duration.max(seconds);
            }
        }
        duration
    } else {
        raw_duration as f64 / mvhd.timescale as f64
    };
    let (mut width, mut height) = track
        .map(|t| (u32::from(t.width()), u32::from(t.height())))
        .unwrap_or((0, 0));
    if let Some(track) = track {
        let matrix = &track.trak.tkhd.matrix;
        // Normal 90/270-degree display transforms swap coded dimensions.
        if matrix.a == 0 && matrix.d == 0 && matrix.b.unsigned_abs() == 65536 && matrix.c.unsigned_abs() == 65536 {
            std::mem::swap(&mut width, &mut height);
        }
    }
    checked_meta(ext, size, width, height, duration)
}

fn checked_meta(ext: &str, size: u64, width: u32, height: u32, duration: f64) -> AppResult<ProbeMeta> {
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
    let mut command = tools::command(binary);
    command
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height:stream_side_data=rotation:format=duration",
            "-of",
            "json",
        ])
        .arg(path);
    let bytes = native::run_probe(&mut command, std::time::Duration::from_secs(15))?;
    parse_ffprobe(&bytes, &ext, size)
}

fn parse_ffprobe(bytes: &[u8], ext: &str, size: u64) -> AppResult<ProbeMeta> {
    #[derive(serde::Deserialize)]
    struct Rotation { rotation: Option<i32> }
    #[derive(serde::Deserialize)]
    struct Stream {
        width: u32, height: u32,
        #[serde(default)]
        side_data_list: Vec<Rotation>,
    }
    #[derive(serde::Deserialize)]
    struct Format { duration: String }
    #[derive(serde::Deserialize)]
    struct Output { streams: Vec<Stream>, format: Format }
    let output: Output = serde_json::from_slice(bytes)
        .map_err(|e| AppError::Media(format!("ffprobe 视频信息无效：{e}")))?;
    let stream = output.streams.first().ok_or_else(|| AppError::Media("视频没有有效视频轨".into()))?;
    let (mut width, mut height) = (stream.width, stream.height);
    if stream.side_data_list.iter().any(|data| data.rotation.is_some_and(|angle| angle.rem_euclid(180) == 90)) {
        std::mem::swap(&mut width, &mut height);
    }
    let duration = output.format.duration.parse().unwrap_or(f64::NAN);
    checked_meta(ext, size, width, height, duration)
}

#[cfg(test)]
#[path = "probe_tests.rs"]
mod tests;
