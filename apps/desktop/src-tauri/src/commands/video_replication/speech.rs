use super::*;
use crate::media::{
    audio,
    tools::{self, Tool},
};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::process::Command;

pub(crate) const MAX_SECONDS: f64 = 120.2;
pub(crate) const MAX_LONG_SECONDS: f64 = 1800.0;
pub(crate) const MAX_FULL_AUDIO_SECONDS: f64 = 7200.0;
pub(crate) const MAX_FULL_AUDIO_BYTES: u64 = 32_000_000;
const SEGMENT_MS: u64 = 115_000;
const MP3_PADDING_SECONDS: f64 = 0.25;

#[derive(Debug)]
pub(crate) struct FullMp3 {
    pub duration_seconds: f64,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Segment {
    pub start_ms: u64,
    pub end_ms: u64,
}

pub(crate) fn plan_segments(duration: f64) -> AppResult<Vec<Segment>> {
    if !duration.is_finite() || duration <= 0.0 {
        return Err(error("无法确认视频时长，请检查原文件后重试"));
    }
    if duration > MAX_LONG_SECONDS {
        return Err(error("视频超过 30 分钟，请先裁剪后再转录"));
    }
    let end_ms = (duration * 1000.0).ceil() as u64;
    if duration <= MAX_SECONDS {
        return Ok(vec![Segment {
            start_ms: 0,
            end_ms,
        }]);
    }
    Ok((0..end_ms)
        .step_by(SEGMENT_MS as usize)
        .map(|start_ms| Segment {
            start_ms,
            end_ms: (start_ms + SEGMENT_MS).min(end_ms),
        })
        .collect())
}

fn media_command(tool: Tool) -> AppResult<Command> {
    let mut command = Command::new(tools::resolve(tool)?);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command.kill_on_drop(true);
    Ok(command)
}

pub(crate) async fn has_audio_track(source: &Path) -> AppResult<bool> {
    let probe = tokio::time::timeout(
        Duration::from_secs(30),
        media_command(Tool::Ffprobe)?
            .args([
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=index",
                "-of",
                "json",
            ])
            .arg(source)
            .output(),
    )
    .await
    .map_err(|_| error("检查音轨超时"))??;
    if !probe.status.success() {
        return Err(error("无法检查视频音轨"));
    }
    let info: Value = serde_json::from_slice(&probe.stdout)?;
    let streams = info["streams"]
        .as_array()
        .ok_or_else(|| error("无法读取视频音轨信息"))?;
    Ok(!streams.is_empty())
}

/// Prepare a bounded copy of the first audio track on the video's playback timeline.
/// The caller owns the source identity and the validated target's lifetime.
pub(crate) async fn prepare_full_mp3(
    source: &Path,
    target: &Path,
    source_duration_seconds: f64,
) -> AppResult<Option<FullMp3>> {
    if !source_duration_seconds.is_finite() || source_duration_seconds <= 0.0 {
        return Err(error("无法确认视频时长，请检查原文件后重试"));
    }
    if source_duration_seconds > MAX_FULL_AUDIO_SECONDS {
        return Err(error("视频超过 2 小时，请先裁剪后再转录"));
    }
    if !has_audio_track(source).await? {
        return Ok(None);
    }

    let temporary = target.with_extension("pending.mp3");
    let duration = format!("{source_duration_seconds:.6}");
    // Keep original PTS, including a positive media start, so utterances can
    // seek directly on the player's clock. Trim before padding any gaps.
    let filter = format!("atrim=end={duration},aresample=16000:async=1:first_pts=0");
    let file_cap = MAX_FULL_AUDIO_BYTES.to_string();
    let result = async {
        let output = tokio::time::timeout(
            Duration::from_secs(600),
            media_command(Tool::Ffmpeg)?
                .args([
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-nostdin",
                    "-xerror",
                    "-y",
                    "-copyts",
                    "-i",
                ])
                .arg(source)
                .args([
                    "-map",
                    "0:a:0",
                    "-vn",
                    "-map_metadata",
                    "-1",
                    "-map_chapters",
                    "-1",
                    "-t",
                    &duration,
                    "-af",
                    &filter,
                    "-ac",
                    "1",
                    "-c:a",
                    "libmp3lame",
                    "-b:a",
                    "32k",
                    "-fs",
                    &file_cap,
                    "-f",
                    "mp3",
                ])
                .arg(&temporary)
                .output(),
        )
        .await
        .map_err(|_| error("整段音轨提取超时，请检查文件是否可用后重试"))??;
        if !output.status.success() {
            return Err(error("无法提取整段音轨，请检查原文件和 FFmpeg 后重试"));
        }
        let size_bytes = fs::metadata(&temporary)?.len();
        // Hitting the muxer's stop limit can leave a valid but truncated MP3.
        if size_bytes == 0 || size_bytes >= MAX_FULL_AUDIO_BYTES {
            return Err(error("提取的音轨容量不符合要求，请先裁剪视频后重试"));
        }
        let duration_seconds = probe_full_mp3(&temporary).await?;
        if duration_seconds > source_duration_seconds + MP3_PADDING_SECONDS {
            return Err(error("提取的音轨时长超出原片范围，请检查视频后重试"));
        }
        fs::rename(&temporary, target)?;
        Ok(Some(FullMp3 {
            duration_seconds,
            size_bytes,
        }))
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

async fn probe_full_mp3(path: &Path) -> AppResult<f64> {
    let probe = tokio::time::timeout(
        Duration::from_secs(30),
        media_command(Tool::Ffprobe)?
            .args([
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_name,sample_rate,channels:format=duration",
                "-of",
                "json",
            ])
            .arg(path)
            .output(),
    )
    .await
    .map_err(|_| error("核对提取音轨超时，请重试"))??;
    if !probe.status.success() {
        return Err(error("无法核对提取的音轨，请检查视频时间轴后重试"));
    }
    let info: Value = serde_json::from_slice(&probe.stdout)
        .map_err(|_| error("无法读取提取的音轨信息，请重试"))?;
    let stream = &info["streams"][0];
    if stream["codec_name"] != "mp3" || stream["sample_rate"] != "16000" || stream["channels"] != 1
    {
        return Err(error("提取的音轨格式无效，请检查 FFmpeg 后重试"));
    }
    info["format"]["duration"]
        .as_str()
        .and_then(|duration| duration.parse::<f64>().ok())
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .ok_or_else(|| error("无法确认提取的音轨时长，请检查视频后重试"))
}

async fn write_wav(source: &Path, target: &Path, segment: Option<Segment>) -> AppResult<()> {
    let mut command = media_command(Tool::Ffmpeg)?;
    command.args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y"]);
    if let Some(segment) = segment {
        command
            .args(["-xerror", "-ss"])
            .arg(format!("{}ms", segment.start_ms));
    }
    command.arg("-i").arg(source).args(["-map", "0:a:0", "-vn"]);
    if let Some(segment) = segment {
        let length = format!("{}ms", segment.end_ms - segment.start_ms);
        // Discard packets from the next window before filling gaps. Otherwise a
        // future audio track could synthesize an entire silent WAV here.
        command
            .args(["-map_metadata", "-1", "-t", &length, "-af"])
            .arg(format!(
                "atrim=end={length},aresample=16000:async=1:first_pts=0"
            ));
    }
    command
        .args([
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-fs",
            "3900000",
        ])
        .arg(target);

    let result = tokio::time::timeout(Duration::from_secs(300), command.output()).await;
    if !matches!(result, Ok(Ok(ref output)) if output.status.success()) {
        let _ = fs::remove_file(target);
        return Err(error("视频音轨提取失败，请检查文件后重试"));
    }
    Ok(())
}

/// Build the existing Cloud ASR input. A decoder failure is distinct from a missing audio track.
pub(crate) async fn prepare(source: &Path, target: &Path) -> AppResult<Option<Value>> {
    if !has_audio_track(source).await? {
        return Ok(None);
    }

    if !target.exists() {
        let temporary = target.with_extension("pending.wav");
        write_wav(source, &temporary, None).await?;
        fs::rename(temporary, target)?;
    }

    let duration = audio::decode(target)?.duration;
    if duration <= 0.0 || duration > MAX_SECONDS {
        return Err(error("提取音轨时长超出两分钟限制"));
    }
    Ok(Some(request(duration, fs::read(target)?)))
}

/// Extract only one frozen video window. Short or delayed tracks can leave a
/// window empty even when FFprobe found an audio track for the original.
pub(crate) async fn prepare_segment(
    source: &Path,
    target: &Path,
    segment: Segment,
) -> AppResult<Option<Value>> {
    let length_ms = segment.end_ms.saturating_sub(segment.start_ms);
    if length_ms == 0
        || length_ms > SEGMENT_MS
        || segment.end_ms > (MAX_LONG_SECONDS * 1000.0) as u64
    {
        return Err(error("视频转录分段范围无效，请重新准备转录"));
    }
    let temporary = target.with_extension("pending.wav");
    write_wav(source, &temporary, Some(segment)).await?;

    let result = (|| {
        let bytes = fs::read(&temporary)?;
        let data = wave_data(&bytes).ok_or_else(|| error("无法读取分段音轨，请检查视频后重试"))?;
        if data.is_empty() {
            return Ok(None);
        }
        let wave = audio::decode(&temporary)?;
        // This FFmpeg command always emits exactly 16 mono PCM samples per ms.
        if wave.sample_rate != 16000 || wave.channels != 1 || wave.total_frames > length_ms * 16 {
            return Err(error("分段音轨时间或格式无效，请检查视频后重试"));
        }
        fs::rename(&temporary, target)?;
        Ok(Some(request(wave.duration, bytes)))
    })();
    if !matches!(result, Ok(Some(_))) {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn wave_data(bytes: &[u8]) -> Option<&[u8]> {
    if !bytes.starts_with(b"RIFF") || bytes.get(8..12)? != b"WAVE" {
        return None;
    }
    let mut remaining = bytes.get(12..)?;
    loop {
        let header = remaining.get(..8)?;
        let size = u32::from_le_bytes(header[4..8].try_into().ok()?) as usize;
        remaining = remaining.get(8..)?;
        let data = remaining.get(..size)?;
        if &header[..4] == b"data" {
            return Some(data);
        }
        remaining = remaining.get(size.checked_add(size % 2)?..)?;
    }
}

fn request(duration: f64, bytes: Vec<u8>) -> Value {
    json!({"operation":"speech-transcription","image":null,"audio":{"mime":"audio/wav",
        "duration":duration,"base64":base64::engine::general_purpose::STANDARD.encode(bytes)}})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires local FFmpeg; synthetic files only"]
    async fn video_transcript_full_mp3_preserves_first_audio_on_video_timeline() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("original.mp4");
        let target = directory.path().join("audio.mp3");
        let input_title = "synthetic-private-title";
        let out = media_command(Tool::Ffmpeg)
            .unwrap()
            .args([
                "-v",
                "error",
                "-nostdin",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=s=16x16:r=2:d=9",
                "-itsoffset",
                "5",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=700:sample_rate=16000:duration=4",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=600:sample_rate=16000:duration=3",
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-map",
                "2:a:0",
                "-metadata",
            ])
            .arg(format!("title={input_title}"))
            .args(["-c:v", "mpeg4", "-c:a", "aac", "-output_ts_offset", "19"])
            .arg(&source)
            .output()
            .await
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );

        let source_duration = crate::media::probe::probe(&source).unwrap().duration;
        assert_eq!(source_duration, 28.0);
        let mp3 = prepare_full_mp3(&source, &target, source_duration)
            .await
            .unwrap()
            .unwrap();
        assert!((mp3.duration_seconds - 28.0).abs() < 0.25);
        let bytes = fs::read(&target).unwrap();
        assert_eq!(mp3.size_bytes, bytes.len() as u64);
        assert!(mp3.size_bytes < MAX_FULL_AUDIO_BYTES);
        assert!(!bytes
            .windows(input_title.len())
            .any(|window| window == input_title.as_bytes()));

        let normal = directory.path().join("zero-start.mp4");
        let out = media_command(Tool::Ffmpeg)
            .unwrap()
            .args(["-v", "error", "-nostdin", "-i"])
            .arg(&source)
            .args(["-map", "0", "-c", "copy"])
            .arg(&normal)
            .output()
            .await
            .unwrap();
        assert!(out.status.success());
        let regular_target = directory.path().join("zero-start.mp3");
        let normal_duration = crate::media::probe::probe(&normal).unwrap().duration;
        assert!((normal_duration - 9.0).abs() < 0.25);
        let regular = prepare_full_mp3(&normal, &regular_target, normal_duration)
            .await
            .unwrap()
            .unwrap();
        assert!((regular.duration_seconds - 9.0).abs() < 0.25);

        for (path, first_speech) in [(&target, 24), (&regular_target, 5)] {
            let decoded = media_command(Tool::Ffmpeg)
                .unwrap()
                .args(["-v", "error", "-nostdin", "-i"])
                .arg(path)
                .args(["-f", "s16le", "pipe:1"])
                .output()
                .await
                .unwrap();
            assert!(decoded.status.success());
            let peak = |second: usize| {
                decoded.stdout[second * 32_000..second * 32_000 + 16_000]
                    .chunks_exact(2)
                    .map(|sample| i16::from_le_bytes([sample[0], sample[1]]).unsigned_abs())
                    .max()
                    .unwrap()
            };
            assert!(
                peak(first_speech - 4) < 50,
                "ignore the earlier secondary track"
            );
            assert!(
                peak(first_speech - 1) < 50,
                "retain the delayed first track"
            );
            assert!(
                peak(first_speech) > 500,
                "seek to the first track on the playback clock"
            );
            assert!(
                peak(first_speech + 3) > 500,
                "retain audio at the end of the video"
            );
        }

        let invalid = directory.path().join("bad-time.mp3");
        assert!(prepare_full_mp3(&source, &invalid, 3.0).await.is_err());
        assert!(
            prepare_full_mp3(&source, &invalid, MAX_FULL_AUDIO_SECONDS + 0.001)
                .await
                .is_err()
        );
        assert!(!invalid.exists());

        let silent = directory.path().join("no-track.mp4");
        let out = media_command(Tool::Ffmpeg)
            .unwrap()
            .args(["-v", "error", "-nostdin", "-i"])
            .arg(&source)
            .args(["-map", "0:v:0", "-c", "copy"])
            .arg(&silent)
            .output()
            .await
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(prepare_full_mp3(&silent, &invalid, 9.0)
            .await
            .unwrap()
            .is_none());
        assert!(!invalid.exists());
    }

    #[test]
    fn video_transcript_segment_plan_keeps_short_inputs_and_rounds_the_tail_up() {
        for short in [116.0, MAX_SECONDS] {
            assert_eq!(
                plan_segments(short).unwrap(),
                vec![Segment {
                    start_ms: 0,
                    end_ms: (short * 1000.0) as u64,
                }]
            );
        }
        assert_eq!(
            plan_segments(120.2001).unwrap(),
            vec![
                Segment {
                    start_ms: 0,
                    end_ms: 115_000
                },
                Segment {
                    start_ms: 115_000,
                    end_ms: 120_201
                },
            ]
        );
        let long = plan_segments(MAX_LONG_SECONDS).unwrap();
        assert_eq!(long.len(), 16);
        assert_eq!(long.first().unwrap().start_ms, 0);
        assert_eq!(long.last().unwrap().end_ms, 1_800_000);
        assert!(long
            .windows(2)
            .all(|pair| pair[0].end_ms == pair[1].start_ms));
        for invalid in [0.0, f64::NAN, f64::INFINITY, MAX_LONG_SECONDS + 0.001] {
            assert!(plan_segments(invalid).is_err());
        }
    }

    #[tokio::test]
    #[ignore = "requires local FFmpeg; synthetic files only"]
    async fn video_transcript_extracts_delayed_audio_without_charging_empty_windows() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("delayed.mp4");
        let out = media_command(Tool::Ffmpeg)
            .unwrap()
            .args([
                "-v",
                "error",
                "-nostdin",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=s=16x16:r=1:d=235",
                "-itsoffset",
                "118",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=700:sample_rate=16000:duration=3",
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-metadata",
                "title=synthetic-private-title",
                "-c:v",
                "mpeg4",
                "-c:a",
                "aac",
            ])
            .arg(&source)
            .output()
            .await
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(has_audio_track(&source).await.unwrap());
        let plan = plan_segments(235.0).unwrap();
        let target = directory.path().join("segment.wav");
        assert!(prepare_segment(&source, &target, plan[0])
            .await
            .unwrap()
            .is_none());

        let audio = prepare_segment(&source, &target, plan[1])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(audio["audio"]["mime"], "audio/wav");
        assert!((audio["audio"]["duration"].as_f64().unwrap() - 6.0).abs() < 0.04);
        let wav = fs::read(&target).unwrap();
        assert!(!wav
            .windows(b"synthetic-private-title".len())
            .any(|w| w == b"synthetic-private-title"));
        let samples = wave_data(&wav).unwrap();
        assert!(samples[..2 * 16_000 * 2].iter().all(|sample| *sample == 0));
        assert!(samples[4 * 16_000 * 2..].iter().any(|sample| *sample != 0));

        fs::remove_file(&target).unwrap();
        assert!(prepare_segment(&source, &target, plan[2])
            .await
            .unwrap()
            .is_none());
        let unavailable = directory.path().join("damaged.mp4");
        fs::write(&unavailable, b"not a video").unwrap();
        assert!(has_audio_track(&unavailable).await.is_err());
        assert!(prepare_segment(&unavailable, &target, plan[0])
            .await
            .is_err());
        assert!(!target.exists());
    }
}
