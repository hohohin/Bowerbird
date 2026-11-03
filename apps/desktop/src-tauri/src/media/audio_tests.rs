use super::*;
use std::{fs, io::Write};

pub(crate) fn write_wav(path: &Path, frames: u32, stereo: bool) {
    let channels = if stereo { 2u16 } else { 1u16 };
    let bytes = frames * u32::from(channels) * 2;
    let mut file = fs::File::create(path).unwrap();
    file.write_all(b"RIFF").unwrap();
    file.write_all(&(36 + bytes).to_le_bytes()).unwrap();
    file.write_all(b"WAVEfmt \x10\0\0\0\x01\0").unwrap();
    file.write_all(&channels.to_le_bytes()).unwrap();
    file.write_all(&8000u32.to_le_bytes()).unwrap();
    file.write_all(&(8000 * u32::from(channels) * 2).to_le_bytes())
        .unwrap();
    file.write_all(&(channels * 2).to_le_bytes()).unwrap();
    file.write_all(&16u16.to_le_bytes()).unwrap();
    file.write_all(b"data").unwrap();
    file.write_all(&bytes.to_le_bytes()).unwrap();
    let data: Vec<u8> = (0..frames)
        .flat_map(|frame| {
            (0..channels).flat_map(move |channel| {
                let sample = if stereo && channel == 0 {
                    0i16
                } else if frame % 2 == 0 {
                    16384i16
                } else {
                    -16384i16
                };
                sample.to_le_bytes()
            })
        })
        .collect();
    file.write_all(&data).unwrap();
}

#[test]
fn audio_extensions_match_the_verified_formats() {
    for ext in ["wav", "MP3", "flac", "m4a", "ogg"] {
        assert!(is_audio(ext), "{ext}");
    }
    for ext in ["aac", "opus", "mp4", "png", "txt"] {
        assert!(!is_audio(ext), "{ext}");
    }
}

#[test]
fn audio_waveform_keeps_real_time_and_silent_first_channel() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stereo.wav");
    write_wav(&path, 16000, true);
    let value = decode(&path).unwrap();
    assert_eq!(value.duration, 2.0);
    assert_eq!(value.total_frames, 16000);
    assert!(value.peaks.len() <= 2048);
    assert!(value.peaks.iter().all(|peak| *peak == [-0.5, 0.5]));
}

#[test]
fn audio_waveform_rejects_truncated_wav() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("truncated.wav");
    write_wav(&path, 16000, false);
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(8044)
        .unwrap();
    assert!(decode(&path).is_err());
}

#[test]
fn audio_verified_codecs_decode_without_external_tools() {
    let fixtures: &[(&str, &[u8])] = &[
        (
            "wav",
            include_bytes!("../../tests/fixtures/media/audio-preview-wav.wav"),
        ),
        (
            "mp3",
            include_bytes!("../../tests/fixtures/media/audio-preview-mp3.mp3"),
        ),
        (
            "flac",
            include_bytes!("../../tests/fixtures/media/audio-preview-flac.flac"),
        ),
        (
            "m4a",
            include_bytes!("../../tests/fixtures/media/audio-preview-m4a.m4a"),
        ),
        (
            "ogg",
            include_bytes!("../../tests/fixtures/media/audio-preview-ogg.ogg"),
        ),
    ];
    let dir = tempfile::tempdir().unwrap();
    for (extension, data) in fixtures {
        let path = dir.path().join(format!("source.{extension}"));
        fs::write(&path, data).unwrap();
        let value = decode(&path).unwrap();
        assert!(
            value.duration >= 0.14 && value.duration <= 0.3,
            "{extension}: {}",
            value.duration
        );
        assert!(value.peaks.iter().any(|peak| peak[1] > 0.01), "{extension}");
    }
}

#[test]
fn audio_float_pcm_overflow_is_clipped_for_waveform_display() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("float.wav");
    let mut bytes = b"RIFF".to_vec();
    bytes.extend_from_slice(&44u32.to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt \x10\0\0\0\x03\0\x01\0");
    bytes.extend_from_slice(&8000u32.to_le_bytes());
    bytes.extend_from_slice(&32000u32.to_le_bytes());
    bytes.extend_from_slice(&4u16.to_le_bytes());
    bytes.extend_from_slice(&32u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&8u32.to_le_bytes());
    bytes.extend_from_slice(&(-2.0f32).to_le_bytes());
    bytes.extend_from_slice(&2.0f32.to_le_bytes());
    fs::write(&path, bytes).unwrap();
    assert_eq!(decode(&path).unwrap().peaks, vec![[-1.0, -1.0], [1.0, 1.0]]);
}
