//! Isolated bounded overview extraction. It never copies or modifies the source.
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Instant, UNIX_EPOCH},
};
use symphonia::core::{
    audio::SampleBuffer,
    codecs::{DecoderOptions, CODEC_TYPE_NULL},
    errors::Error as DecodeError,
    formats::FormatOptions,
    io::{MediaSource, MediaSourceStream},
    meta::MetadataOptions,
    probe::Hint,
};

const MAX_PEAKS: usize = 2048;
const ALGORITHM: &str = "merged-channel-extrema-v2-2048";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stamp {
    bytes: u64,
    modified_nanos: String,
}

fn stamp(path: &Path) -> Result<Stamp> {
    let metadata = fs::metadata(path)?;
    ensure!(metadata.is_file(), "source is not a file");
    Ok(Stamp {
        bytes: metadata.len(),
        modified_nanos: metadata
            .modified()?
            .duration_since(UNIX_EPOCH)?
            .as_nanos()
            .to_string(),
    })
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Waveform {
    schema_version: u32,
    duration: f64,
    sample_rate: u32,
    channels: usize,
    peaks: Vec<[f32; 2]>,
    frames_per_peak: u64,
    total_frames: u64,
}

impl Waveform {
    fn valid(&self) -> bool {
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
            && self
                .peaks
                .iter()
                .all(|[min, max]| min.is_finite() && max.is_finite() && min <= max)
    }
}

#[derive(Serialize, Deserialize)]
struct Cached {
    algorithm: String,
    stamp: Stamp,
    waveform: Waveform,
}

#[derive(Default)]
struct Diagnostics {
    cache_hit: bool,
    source_bytes: u64,
    source_read: u64,
    max_block: usize,
    validation_ms: f64,
    decode_ms: f64,
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

struct CountedSource {
    file: File,
    bytes_read: Arc<AtomicU64>,
    length: u64,
}
impl Read for CountedSource {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        let count = self.file.read(bytes)?;
        self.bytes_read.fetch_add(count as u64, Ordering::Relaxed);
        Ok(count)
    }
}
impl Seek for CountedSource {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        self.file.seek(position)
    }
}
impl MediaSource for CountedSource {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        Some(self.length)
    }
}

fn check_cancel(cancelled: &dyn Fn() -> bool) -> Result<()> {
    ensure!(!cancelled(), "cancelled");
    Ok(())
}

fn decode(
    path: &Path,
    bytes_read: Arc<AtomicU64>,
    cancelled: &dyn Fn() -> bool,
) -> Result<(Waveform, usize)> {
    let file = File::open(path)?;
    let length = file.metadata()?.len();
    let mut source = CountedSource {
        file,
        bytes_read,
        length,
    };
    let mut header = [0u8; 12];
    source.read_exact(&mut header)?;
    source.seek(SeekFrom::Start(0))?;
    let is_wave = &header[..4] == b"RIFF" && &header[8..] == b"WAVE";
    if is_wave {
        let declared = u32::from_le_bytes(header[4..8].try_into()?) as u64 + 8;
        ensure!(declared <= length, "truncated WAVE container");
    }
    let stream = MediaSourceStream::new(Box::new(source), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|v| v.to_str()) {
        hint.with_extension(ext);
    }
    let mut format = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions {
                enable_gapless: true,
                ..Default::default()
            },
            &MetadataOptions::default(),
        )?
        .format;
    let track = format
        .tracks()
        .iter()
        .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        .context("no supported audio track")?;
    let id = track.id;
    let expected_frames = is_wave.then_some(track.codec_params.n_frames).flatten();
    let mut decoder =
        symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default())?;
    let mut overview = Overview::new();
    let mut sample_rate = 0;
    let mut channels = 0;
    let mut buffer: Option<SampleBuffer<f32>> = None;
    let mut buffer_capacity = 0;
    let mut max_block = 0;
    loop {
        check_cancel(cancelled)?;
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
        max_block = max_block.max(decoded.frames());
        if buffer_capacity < decoded.capacity() {
            buffer_capacity = decoded.capacity();
            buffer = Some(SampleBuffer::new(buffer_capacity as u64, spec));
        }
        let buffer = buffer.as_mut().context("empty decoded block")?;
        buffer.copy_interleaved_ref(decoded);
        for frame in buffer.samples().chunks_exact(channels) {
            overview.frame(frame)?;
        }
    }
    if let Some(expected) = expected_frames {
        ensure!(overview.total == expected, "truncated WAVE audio data");
    }
    Ok((overview.finish(sample_rate, channels)?, max_block))
}

fn cached(path: &Path, expected: &Stamp) -> Option<Waveform> {
    if fs::metadata(path).ok()?.len() > 512 * 1024 {
        return None;
    }
    let value: Cached = serde_json::from_reader(BufReader::new(File::open(path).ok()?)).ok()?;
    (value.algorithm == ALGORITHM && &value.stamp == expected && value.waveform.valid())
        .then_some(value.waveform)
}

/// `version` is an already verified source revision from the library index. Without
/// it the identity is path/size/nanosecond mtime, which cannot detect preserved-mtime edits.
pub fn preview(
    input: &Path,
    cache: &Path,
    version: Option<&str>,
    cancelled: &dyn Fn() -> bool,
) -> Result<serde_json::Value> {
    let started = Instant::now();
    check_cancel(cancelled)?;
    let input = fs::canonicalize(input)?;
    let before = stamp(&input)?;
    let revision = version
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{}:{}", before.bytes, before.modified_nanos));
    let key = format!(
        "{:x}",
        Sha256::digest(format!("{ALGORITHM}:{}:{revision}", input.display()).as_bytes())
    );
    let destination = cache.join(format!("{key}.json"));
    let mut diagnostics = Diagnostics {
        source_bytes: before.bytes,
        validation_ms: started.elapsed().as_secs_f64() * 1000.0,
        ..Default::default()
    };
    if let Some(waveform) = cached(&destination, &before) {
        check_cancel(cancelled)?;
        ensure!(
            stamp(&input)? == before,
            "source changed while reading cache"
        );
        diagnostics.cache_hit = true;
        return output(waveform, diagnostics, started);
    }
    let reads = Arc::new(AtomicU64::new(0));
    let decode_started = Instant::now();
    let (waveform, max_block) = decode(&input, reads.clone(), cancelled)?;
    diagnostics.decode_ms = decode_started.elapsed().as_secs_f64() * 1000.0;
    diagnostics.max_block = max_block;
    diagnostics.source_read = reads.load(Ordering::Relaxed);
    check_cancel(cancelled)?;
    ensure!(stamp(&input)? == before, "source changed during decoding");
    ensure!(waveform.valid(), "invalid extracted waveform");
    fs::create_dir_all(cache)?;
    let mut temporary = tempfile::NamedTempFile::new_in(cache)?;
    let record = Cached {
        algorithm: ALGORITHM.into(),
        stamp: before.clone(),
        waveform,
    };
    {
        let mut writer = BufWriter::new(temporary.as_file_mut());
        serde_json::to_writer(&mut writer, &record)?;
        writer.flush()?;
    }
    check_cancel(cancelled)?;
    ensure!(
        stamp(&input)? == before,
        "source changed before cache publication"
    );
    temporary
        .persist(&destination)
        .map_err(|error| error.error)?;
    let waveform = record.waveform;
    output(waveform, diagnostics, started)
}

fn output(
    waveform: Waveform,
    diagnostics: Diagnostics,
    started: Instant,
) -> Result<serde_json::Value> {
    let peak_bytes = waveform.peaks.len() * std::mem::size_of::<[f32; 2]>();
    let decoded = if diagnostics.cache_hit {
        0
    } else {
        waveform.total_frames
    };
    let mut value = serde_json::to_value(waveform)?;
    value["diagnostics"] = serde_json::json!({ "cacheHit": diagnostics.cache_hit, "decodedFrames": decoded,
        "sourceBytes": diagnostics.source_bytes, "sourceBytesRead": diagnostics.source_read, "peakBytes": peak_bytes,
        "peakCapacityBytes": MAX_PEAKS * std::mem::size_of::<[f32; 2]>(), "maxDecodedBlockFrames": diagnostics.max_block,
        "timingsMs": { "validation": diagnostics.validation_ms, "decode": diagnostics.decode_ms, "total": started.elapsed().as_secs_f64() * 1000.0 } });
    Ok(value)
}
