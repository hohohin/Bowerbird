//! 探测媒体元数据（尺寸 / 大小 / 扩展名 / 时长）。
//! 图片走 image crate；视频依次尝试 ISO BMFF、系统媒体接口、可选 ffprobe。

use std::{io::{Read, Seek}, path::Path};
use super::tools::{self, Tool};

use image::ImageReader;

use crate::error::{AppError, AppResult};

#[path = "probe_native.rs"]
pub(super) mod native;
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
    if super::audio::is_audio(&ext) {
        return Ok(ProbeMeta { ext, width: 0, height: 0, size, duration: 0.0 });
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
pub(super) fn probe_iso_native(path: &Path, ext: &str, size: u64) -> AppResult<ProbeMeta> {
    let file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    read_iso(file, len, ext, size)
}

/// Bounded header-only read for synchronous connection indexing. Large payload
/// boxes are skipped by seek, including mdat before a non-faststart moov.
pub(crate) fn probe_connected_video_header(path: &Path, ext: &str, size: u64) -> Option<ProbeMeta> {
    if !matches!(ext, "mp4" | "mov" | "m4v") { return None; }
    let file = std::fs::File::open(path).ok()?;
    let mut file = std::io::BufReader::with_capacity(8192, file);
    validate_scan_boxes(&mut file, size)?;
    file.rewind().ok()?;
    let mut input = HeaderBudget { file, bytes: 4 * 1024 * 1024, seeks: 2048 };
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| read_iso(&mut input, size, ext, size)))
        .ok()?.ok()
}

fn validate_scan_boxes(input: &mut (impl Read + Seek), len: u64) -> Option<()> {
    // The general parser can allocate from declared box sizes before reading
    // their contents. Cap the total size of parsed boxes before passing them in.
    validate_box_range(input, 0, len, b"root", 0, &mut 1024, &mut (4 * 1024 * 1024))
}

fn validate_box_range(
    input: &mut (impl Read + Seek), mut offset: u64, end: u64, parent: &[u8; 4], depth: u8,
    boxes: &mut usize, bytes: &mut u64,
) -> Option<()> {
    if depth > 8 { return None; }
    while offset < end {
        *boxes = boxes.checked_sub(1)?;
        if end - offset < 8 { return None; }
        input.seek(std::io::SeekFrom::Start(offset)).ok()?;
        let mut header = [0u8; 8];
        input.read_exact(&mut header).ok()?;
        let name: &[u8; 4] = header[4..].try_into().ok()?;
        let mut size = u64::from(u32::from_be_bytes(header[..4].try_into().ok()?));
        let mut header_size = 8;
        if size == 1 {
            let mut extended = [0u8; 8];
            input.read_exact(&mut extended).ok()?;
            size = u64::from_be_bytes(extended);
            header_size = 16;
        } else if size == 0 {
            // The general parser treats a zero-sized box as end of input.
            return (parent == b"root" && matches!(name, b"mdat" | b"free")).then_some(());
        }
        if size < header_size || size > end - offset { return None; }
        if parent == b"root" && matches!(name, b"moov" | b"moof" | b"ftyp" | b"emsg") {
            *bytes = bytes.checked_sub(size)?;
        }
        let content = offset + header_size;
        let next = offset + size;
        let child_header = match name {
            b"moov" | b"moof" | b"trak" | b"mdia" | b"minf" | b"stbl" | b"dinf" |
            b"mvex" | b"traf" | b"udta" | b"ilst" => Some(content),
            b"stsd" | b"dref" => Some(content.checked_add(8)?),
            b"meta" => {
                if next - content < 8 { return None; }
                let mut marker = [0u8; 8];
                input.read_exact(&mut marker).ok()?;
                // Some QuickTime files omit the meta full-box header.
                Some(if &marker[4..] == b"hdlr" { content } else if marker[..4] == [0; 4] { content + 4 } else { return None; })
            }
            _ if parent == b"ilst" => Some(content),
            _ => None,
        };
        if let Some(child) = child_header {
            if child > next { return None; }
            validate_box_range(input, child, next, name, depth + 1, boxes, bytes)?;
        }
        offset += size;
    }
    Some(())
}

pub(crate) fn probe_connected_video_fallback(path: &Path) -> AppResult<ProbeMeta> {
    let size = std::fs::metadata(path)?.len();
    let ext = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    if let Ok(meta) = native::probe_system(path, &ext, size) { return Ok(meta); }
    probe_video_ffprobe(path, ext, size)
}

struct HeaderBudget {
    file: std::io::BufReader<std::fs::File>,
    bytes: usize,
    seeks: usize,
}

impl std::io::Read for HeaderBudget {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if output.len() > self.bytes { return Err(std::io::Error::other("ISO header read budget exceeded")); }
        let read = self.file.read(output)?;
        self.bytes -= read;
        Ok(read)
    }
}

impl std::io::Seek for HeaderBudget {
    fn seek(&mut self, position: std::io::SeekFrom) -> std::io::Result<u64> {
        if self.seeks == 0 { return Err(std::io::Error::other("ISO header seek budget exceeded")); }
        self.seeks -= 1;
        self.file.seek(position)
    }

    fn stream_position(&mut self) -> std::io::Result<u64> {
        self.file.stream_position()
    }
}

fn read_iso(input: impl std::io::Read + std::io::Seek, len: u64, ext: &str, size: u64) -> AppResult<ProbeMeta> {
    let reader = mp4::Mp4Reader::read_header(input, len)
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

pub(super) fn checked_meta(ext: &str, size: u64, width: u32, height: u32, duration: f64) -> AppResult<ProbeMeta> {
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

pub(super) fn probe_video_ffprobe(path: &Path, ext: String, size: u64) -> AppResult<ProbeMeta> {
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
