//! Finite, unencrypted browser streams are downloaded completely before local remuxing.
use crate::error::{AppError, AppResult};
use std::{collections::BTreeMap, path::{Path, PathBuf}, time::{Duration, Instant}};
use super::{source_browser_jobs::CaptureControl, source_browser_network::{CaptureResource, browser_capture_resource, browser_capture_resource_silent, resolve_video_source}};

const MAX_BYTES: usize = 200 * 1024 * 1024;
const MAX_MANIFEST: usize = 2 * 1024 * 1024;
const MAX_SEGMENTS: usize = 10_000;
const MAX_DURATION: f64 = 6.0 * 3600.0;
fn invalid() -> AppError { AppError::Other("视频播放清单不完整或无效，请刷新网页后重试。".into()) }
fn unsupported(reason: &str) -> AppError { AppError::Other(format!("暂不支持{reason}，请使用完整视频文件链接。")) }
fn checked_url(base: &str, relative: &str) -> AppResult<String> {
    let url = tauri::Url::parse(base).and_then(|base| base.join(relative)).map_err(|_| invalid())?;
    if !["https", "http"].contains(&url.scheme()) || !url.username().is_empty() || url.password().is_some() || url.as_str().len() > 8192 { return Err(invalid()); }
    Ok(url.to_string())
}

#[derive(Debug, Clone, PartialEq)]
struct Segment { url: String, duration: f64 }
#[derive(Debug, Clone)]
struct Track { kind: &'static str, init: Option<String>, segments: Vec<Segment>, duration: f64, start: f64, bounded_period: bool }
#[derive(Debug)]
enum Hls { Master { video: String, audio: Option<String> }, Track(Track) }
#[path = "source_browser_stream_hls.rs"] mod hls;
#[path = "source_browser_stream_dash.rs"] mod dash;
use hls::parse_hls;
use dash::parse_dash;

fn manifest(resource: &CaptureResource) -> AppResult<&str> {
    if resource.bytes.len() > MAX_MANIFEST { return Err(unsupported("过大的视频播放清单")); }
    std::str::from_utf8(&resource.bytes).map(str::trim).map_err(|_| invalid())
}

fn receive(resource: &CaptureResource, received: &mut usize) -> AppResult<()> {
    if resource.bytes.is_empty() || resource.total_bytes.is_some_and(|expected| expected != resource.bytes.len() as u64) {
        return Err(AppError::Other("视频片段下载不完整，未保存视频，请重试。".into()));
    }
    *received = received.checked_add(resource.bytes.len()).ok_or_else(invalid)?;
    if *received > MAX_BYTES { return Err(AppError::Other("视频超过 200 MiB 上限。".into())); }
    Ok(())
}

async fn plan<F, Fut>(first: &CaptureResource, received: &mut usize, fetch: &mut F) -> AppResult<Vec<Track>>
where F: FnMut(String, usize) -> Fut, Fut: std::future::Future<Output=AppResult<CaptureResource>> {
    let text = manifest(first)?;
    if text.trim_start_matches('\u{feff}').starts_with("#EXTM3U") {
        match parse_hls(text, &first.url, "video")? {
            Hls::Track(track) => Ok(vec![track]),
            Hls::Master { video, audio } => {
                let mut tracks = Vec::new();
                for (url, kind) in std::iter::once((video, "video")).chain(audio.map(|url|(url, "audio"))) {
                    let resource = fetch(url, MAX_MANIFEST.min(MAX_BYTES.saturating_sub(*received))).await?;
                    receive(&resource, received)?;
                    match parse_hls(manifest(&resource)?, &resource.url, kind)? {
                        Hls::Track(track) => tracks.push(track),
                        Hls::Master { .. } => return Err(unsupported("多层嵌套的视频播放清单")),
                    }
                }
                Ok(tracks)
            }
        }
    } else { parse_dash(text, &first.url) }
}

struct Downloaded { _temporary: tempfile::TempDir, inputs: Vec<(PathBuf, &'static str, f64)>, duration: f64, bounded_period: bool, bytes: usize }

fn segment_extension(bytes: &[u8]) -> AppResult<&'static str> {
    // A downloaded segment must never become another playlist interpreted by FFmpeg.
    if bytes.len() >= 8 && [b"ftyp", b"styp", b"moof", b"moov", b"sidx", b"free"].iter().any(|kind|bytes.get(4..8) == Some(kind.as_slice())) { return Ok("mp4"); }
    if bytes.len() >= 188 && bytes[0] == 0x47 && (bytes.len() < 376 || bytes[188] == 0x47) { return Ok("ts"); }
    let offset = if bytes.starts_with(b"ID3") && bytes.len() >= 10 {
        if bytes[6..10].iter().any(|byte|byte & 0x80 != 0) { return Err(invalid()); }
        10 + bytes[6..10].iter().fold(0usize, |size,byte|(size << 7) | *byte as usize)
    } else { 0 };
    if bytes.get(offset) == Some(&0xff) && bytes.get(offset+1).is_some_and(|byte|byte & 0xf6 == 0xf0) { return Ok("aac"); }
    Err(AppError::Other("视频片段不是支持的媒体文件，未保存视频。".into()))
}

async fn download<F, Fut>(first: CaptureResource, control: &CaptureControl, mut fetch: F) -> AppResult<Downloaded>
where F: FnMut(String, usize) -> Fut, Fut: std::future::Future<Output=AppResult<CaptureResource>> {
    control.check()?;
    control.report("resolving", 0, None, None, None);
    let mut received = 0;
    receive(&first, &mut received)?;
    let tracks = plan(&first, &mut received, &mut fetch).await?;
    let total = tracks.iter().map(|track|track.segments.len() + usize::from(track.init.is_some())).sum::<usize>();
    if total == 0 || total > MAX_SEGMENTS { return Err(unsupported("片段数量过多的视频")); }
    let temporary = tempfile::Builder::new().prefix("bowerbird-stream-").tempdir()?;
    let mut inputs = Vec::new();
    let mut completed = 0;
    let video = tracks.iter().find(|track|track.kind == "video").ok_or_else(invalid)?;
    let duration = video.duration;
    let bounded_period = video.bounded_period;
    for (index, track) in tracks.iter().enumerate() {
        let target_duration = track.segments.iter().map(|segment|segment.duration.ceil() as u64).max().ok_or_else(invalid)?;
        let mut playlist = format!("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:{target_duration}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n");
        for (part, (url, seconds)) in track.init.iter().map(|url|(url, None)).chain(track.segments.iter().map(|segment|(&segment.url, Some(segment.duration)))).enumerate() {
            control.check()?;
            let resource = fetch(url.clone(), MAX_BYTES.saturating_sub(received)).await?;
            receive(&resource, &mut received)?;
            control.check()?;
            // Names are generated locally. Original URLs never reach FFmpeg or the filesystem.
            let extension = segment_extension(&resource.bytes)?;
            if track.init.is_some() && extension != "mp4" { return Err(unsupported("初始化片段与媒体格式不一致的视频")); }
            let name = format!("track-{index}-{part}.{extension}");
            tokio::fs::write(temporary.path().join(&name), &resource.bytes).await?;
            if let Some(seconds) = seconds { playlist.push_str(&format!("#EXTINF:{seconds:.9},\n{name}\n")); }
            else { playlist.push_str(&format!("#EXT-X-MAP:URI=\"{name}\"\n")); }
            completed += 1;
            control.report("downloading", received as u64, None, Some(completed), Some(total as u32));
        }
        playlist.push_str("#EXT-X-ENDLIST\n");
        let path = temporary.path().join(format!("track-{index}.m3u8"));
        tokio::fs::write(&path, playlist).await?;
        inputs.push((path, track.kind, track.start));
    }
    Ok(Downloaded { _temporary: temporary, inputs, duration, bounded_period, bytes: received })
}

async fn run_ffmpeg(command: &mut tokio::process::Command, log: &Path, control: &CaptureControl) -> AppResult<()> {
    use std::process::Stdio;
    command.kill_on_drop(true).stdin(Stdio::null()).stdout(Stdio::null()).stderr(std::fs::File::create(log)?);
    #[cfg(windows)] command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|error| { tracing::warn!(diagnostic=%error, "stream ffmpeg spawn failed"); AppError::Other("无法启动本机视频处理工具，请检查安装后重试。".into()) })?;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if let Err(error) = control.check() { let _ = child.kill().await; return Err(error); }
        if let Some(status) = child.try_wait()? {
            if status.success() { return Ok(()); }
            tracing::warn!(diagnostic=%std::fs::read_to_string(log).unwrap_or_default().chars().take(4000).collect::<String>(), "stream ffmpeg failed");
            return Err(AppError::Other("视频片段不完整或编码暂不支持，未保存视频。".into()));
        }
        if Instant::now() >= deadline { let _ = child.kill().await; return Err(AppError::Other("视频合并超时，请重试或选择较短的视频。".into())); }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn remux(downloaded: Downloaded, control: &CaptureControl) -> AppResult<Vec<u8>> {
    control.check()?;
    control.report("merging", downloaded.bytes as u64, None, None, None);
    let binary = ffmpeg()?;
    let root = downloaded._temporary.path();
    let output = root.join("video.mp4");
    // TS audio can contain two initial AAC packets whose DTS both round to zero
    // in MP4. Validate the complete inputs first, then allow the muxer to repair
    // timestamps; treating that repair as corruption would reject valid HLS.
    for (index,(input,kind,_)) in downloaded.inputs.iter().enumerate() {
        let mut decode = tokio::process::Command::new(binary);
        decode.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-err_detect", "explode",
            "-protocol_whitelist", "file", "-allowed_extensions", "mp4,ts,m4s,aac", "-i"]).arg(input);
        if *kind == "audio" { decode.args(["-map","0:a:0"]); }
        else { decode.args(["-map","0:v:0","-map","0:a:0?"]); }
        decode.args(["-f","null","-"]);
        run_ffmpeg(&mut decode,&root.join(format!("input-{index}.log")),control).await?;
    }
    let mut command = tokio::process::Command::new(binary);
    command.args(["-nostdin", "-hide_banner", "-loglevel", "warning", "-y"]);
    for (input, _, start) in &downloaded.inputs {
        if *start > 0.0 { command.args(["-ss", &format!("{start:.9}")]); }
        command.args(["-protocol_whitelist", "file", "-allowed_extensions", "mp4,ts,m4s,aac", "-i"]).arg(input);
    }
    command.args(["-map", "0:v:0"]);
    if let Some(index) = downloaded.inputs.iter().position(|(_, kind, _)|*kind == "audio") { command.args(["-map", &format!("{index}:a:0")]); }
    else { command.args(["-map", "0:a:0?"]); }
    if downloaded.bounded_period { command.args(["-t", &format!("{:.9}",downloaded.duration)]); }
    command.args(["-c", "copy", "-sn", "-dn", "-movflags", "+faststart"]).arg(&output);
    run_ffmpeg(&mut command, &root.join("merge.log"), control).await?;
    control.check()?;
    let metadata = crate::media::probe::probe(&output)?;
    if metadata.size == 0 || metadata.size > MAX_BYTES as u64 || metadata.width == 0 || metadata.height == 0
        || !metadata.duration.is_finite() || (metadata.duration - downloaded.duration).abs() > 0.5_f64.max(downloaded.duration * 0.02) {
        return Err(AppError::Other("合并后的视频校验失败，未保存视频。".into()));
    }
    // Decoding catches damaged packets which remuxing alone can copy successfully.
    let mut decode = tokio::process::Command::new(binary);
    decode.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-err_detect", "explode", "-protocol_whitelist", "file", "-i"]).arg(&output)
        .args(["-map", "0:v:0", "-map", "0:a:0?", "-f", "null", "-"]);
    run_ffmpeg(&mut decode, &root.join("decode.log"), control).await?;
    control.check()?;
    Ok(tokio::fs::read(&output).await?)
}

pub(crate) async fn capture_stream(webview: &tauri::Webview, first: CaptureResource, control: &CaptureControl) -> AppResult<Vec<u8>> {
    control.check()?;
    ffmpeg()?;
    let downloaded = download(first, control, |url, maximum| async move {
        browser_capture_resource_silent(webview, &url, maximum, control).await
    }).await?;
    remux(downloaded, control).await
}

fn ffmpeg() -> AppResult<&'static Path> {
    crate::media::tools::resolve(crate::media::tools::Tool::Ffmpeg).map_err(|error| {
        tracing::warn!(diagnostic=%error, "stream ffmpeg unavailable");
        AppError::Other("合并分段视频需要本机视频处理工具，请先安装 FFmpeg。".into())
    })
}

pub(crate) async fn capture_video(webview: &tauri::Webview, source: &str, page_url: &str, control: &CaptureControl) -> AppResult<Vec<u8>> {
    control.check()?;
    let source = resolve_video_source(webview, source, page_url, control).await?;
    let resource = browser_capture_resource(webview, &source, MAX_BYTES, control).await?;
    if resource.is_manifest() {
        capture_stream(webview, resource, control).await
    } else {
        receive(&resource, &mut 0)?;
        control.check()?;
        Ok(resource.bytes)
    }
}

#[cfg(test)]
#[path = "source_browser_stream_tests.rs"]
mod tests;
