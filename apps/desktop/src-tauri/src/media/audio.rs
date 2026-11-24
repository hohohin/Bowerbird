//! Streamed audio overviews. Only small peak data survives decoding.
use crate::error::{AppError, AppResult};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};
use symphonia::core::{
    audio::{AudioBufferRef, SampleBuffer},
    codecs::{CodecType, DecoderOptions, CODEC_TYPE_MP3, CODEC_TYPE_NULL},
    errors::Error as DecodeError,
    formats::{FormatOptions, FormatReader},
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
};
const MAX_PEAKS: usize = 2048;
pub fn is_audio(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "wav" | "mp3" | "flac" | "m4a" | "ogg"
    )
}
pub fn decode(path: &Path) -> AppResult<Waveform> {
    decode_inner(path).map_err(|error| AppError::Media(format!("无法读取音频波形：{error:#}")))
}

pub(crate) fn duration(path: &Path) -> AppResult<f64> {
    let (frames, sample_rate, _) = read_frames(path, |_| Ok(()))
        .map_err(|error| AppError::Media(format!("无法读取音频时长：{error:#}")))?;
    Ok(frames as f64 / sample_rate as f64)
}

pub(crate) fn codec(path: &Path) -> AppResult<CodecType> {
    let file = File::open(path)?;
    let format = open_gapless_format(path, file)
        .map_err(|error| AppError::Media(format!("无法读取音频格式：{error:#}")))?;
    format.default_track().map(|track| track.codec_params.codec)
        .ok_or_else(|| AppError::Media("文件没有可读取的音轨".into()))
}

pub(crate) fn mp3_gapless_duration(path: &Path) -> Option<f64> {
    let format = open_gapless_format(path, File::open(path).ok()?).ok()?;
    let params = &format.default_track()?.codec_params;
    if params.codec != CODEC_TYPE_MP3 || params.delay.is_none() || params.padding.is_none() {
        return None;
    }
    let frames = params.n_frames?;
    let rate = params.sample_rate?;
    (frames > 0 && rate > 0).then(|| frames as f64 / f64::from(rate))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Waveform {
    pub schema_version: u32,
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: usize,
    pub peaks: Vec<[f32; 2]>,
    pub frames_per_peak: u64,
    pub total_frames: u64,
}

impl Waveform {
    pub(crate) fn valid(&self) -> bool {
        self.schema_version == 1
            && self.duration.is_finite()
            && self.duration > 0.0
            && self.sample_rate > 0
            && self.channels > 0
            && self.channels <= 32
            && self.total_frames > 0
            && self.frames_per_peak > 0
            && !self.peaks.is_empty()
            && self.peaks.len() <= MAX_PEAKS
            && self.total_frames.div_ceil(self.frames_per_peak) == self.peaks.len() as u64
            && (self.duration - self.total_frames as f64 / self.sample_rate as f64).abs() < 1e-9
            && self.peaks.iter().all(|[min, max]| {
                min.is_finite() && max.is_finite() && min <= max && *min >= -1.0 && *max <= 1.0
            })
    }
}

/// Fixed-capacity min/max blocks are merged in place as their time span grows.
/// Channels are never averaged, so antiphase audio cannot disappear.
struct Overview {
    peaks: Vec<[f32; 2]>,
    frames_per_peak: u64,
    pending: [f32; 2],
    pending_frames: u64,
    total: u64,
}
impl Overview {
    fn new() -> Self {
        Self {
            peaks: Vec::with_capacity(MAX_PEAKS),
            frames_per_peak: 1,
            pending: [f32::INFINITY, f32::NEG_INFINITY],
            pending_frames: 0,
            total: 0,
        }
    }
    fn frame(&mut self, channels: &[f32]) -> Result<()> {
        for &sample in channels {
            ensure!(sample.is_finite(), "audio contains non-finite samples");
            let sample = sample.clamp(-1.0, 1.0);
            self.pending[0] = self.pending[0].min(sample);
            self.pending[1] = self.pending[1].max(sample);
        }
        self.pending_frames += 1;
        self.total += 1;
        if self.pending_frames == self.frames_per_peak {
            self.peaks.push(self.pending);
            self.pending = [f32::INFINITY, f32::NEG_INFINITY];
            self.pending_frames = 0;
            if self.peaks.len() == MAX_PEAKS {
                for i in 0..MAX_PEAKS / 2 {
                    let a = self.peaks[i * 2];
                    let b = self.peaks[i * 2 + 1];
                    self.peaks[i] = [a[0].min(b[0]), a[1].max(b[1])];
                }
                self.peaks.truncate(MAX_PEAKS / 2);
                self.frames_per_peak *= 2;
            }
        }
        Ok(())
    }
    fn finish(mut self, sample_rate: u32, channels: usize) -> Result<Waveform> {
        ensure!(
            self.total > 0 && sample_rate > 0,
            "audio has no decoded frames"
        );
        if self.pending_frames > 0 {
            self.peaks.push(self.pending);
        }
        Ok(Waveform {
            schema_version: 1,
            duration: self.total as f64 / sample_rate as f64,
            sample_rate,
            channels,
            peaks: self.peaks,
            frames_per_peak: self.frames_per_peak,
            total_frames: self.total,
        })
    }
}

fn decode_inner(path: &Path) -> Result<Waveform> {
    let mut overview = Overview::new();
    let mut buffer: Option<SampleBuffer<f32>> = None;
    let mut buffer_capacity = 0;
    let (_, sample_rate, channels) = read_frames(path, |decoded| {
        let spec = *decoded.spec();
        if buffer_capacity < decoded.capacity() {
            buffer_capacity = decoded.capacity();
            buffer = Some(SampleBuffer::new(buffer_capacity as u64, spec));
        }
        let buffer = buffer.as_mut().context("empty decoded block")?;
        buffer.copy_interleaved_ref(decoded);
        for frame in buffer.samples().chunks_exact(spec.channels.count()) {
            overview.frame(frame)?;
        }
        Ok(())
    })?;
    overview.finish(sample_rate, channels)
}

fn open_gapless_format(path: &Path, source: File) -> Result<Box<dyn FormatReader>> {
    let stream = MediaSourceStream::new(Box::new(source), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|v| v.to_str()) {
        hint.with_extension(ext);
    }
    Ok(symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions {
                enable_gapless: true,
                ..Default::default()
            },
            &MetadataOptions::default(),
        )?
        .format)
}

fn read_frames(
    path: &Path,
    mut consume: impl FnMut(AudioBufferRef<'_>) -> Result<()>,
) -> Result<(u64, u32, usize)> {
    let mut source = File::open(path)?;
    let length = source.metadata()?.len();
    let mut header = [0u8; 12];
    source.read_exact(&mut header)?;
    source.seek(SeekFrom::Start(0))?;
    let is_wave = &header[..4] == b"RIFF" && &header[8..] == b"WAVE";
    if is_wave {
        let declared = u32::from_le_bytes(header[4..8].try_into()?) as u64 + 8;
        ensure!(declared <= length, "truncated WAVE container");
    }
    let mut format = open_gapless_format(path, source)?;
    let track = format
        .tracks()
        .iter()
        .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        .context("no supported audio track")?;
    let id = track.id;
    let expected_frames = is_wave.then_some(track.codec_params.n_frames).flatten();
    let mut decoder =
        symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default())?;
    let mut frames = 0;
    let mut sample_rate = 0;
    let mut channels = 0;
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(DecodeError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(error) => return Err(error.into()),
        };
        if packet.track_id() != id {
            continue;
        }
        let decoded = decoder.decode(&packet)?;
        let spec = *decoded.spec();
        let count = spec.channels.count();
        ensure!(
            count > 0 && count <= 32 && spec.rate > 0,
            "unsupported audio layout"
        );
        ensure!(
            sample_rate == 0 || (sample_rate == spec.rate && channels == count),
            "audio layout changes mid-stream"
        );
        sample_rate = spec.rate;
        channels = count;
        frames += decoded.frames() as u64;
        consume(decoded)?;
    }
    if let Some(expected) = expected_frames {
        ensure!(frames == expected, "truncated WAVE audio data");
    }
    ensure!(frames > 0 && sample_rate > 0, "audio has no decoded frames");
    Ok((frames, sample_rate, channels))
}

#[cfg(test)]
#[path = "audio_tests.rs"]
pub(crate) mod tests;
