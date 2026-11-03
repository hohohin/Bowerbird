use library_audio_preview::preview;
use std::{
    fs::{self, File},
    io::Write,
    path::Path,
    sync::atomic::{AtomicUsize, Ordering},
};

fn wav(path: &Path, frames: u32, channels: u16, sample: impl Fn(u32, u16) -> i16) {
    let mut out = File::create(path).unwrap();
    let bytes = frames * u32::from(channels) * 2;
    out.write_all(b"RIFF").unwrap();
    out.write_all(&(36 + bytes).to_le_bytes()).unwrap();
    out.write_all(b"WAVEfmt \x10\0\0\0\x01\0").unwrap();
    out.write_all(&channels.to_le_bytes()).unwrap();
    out.write_all(&8000u32.to_le_bytes()).unwrap();
    out.write_all(&(8000 * u32::from(channels) * 2).to_le_bytes())
        .unwrap();
    out.write_all(&(channels * 2).to_le_bytes()).unwrap();
    out.write_all(&16u16.to_le_bytes()).unwrap();
    out.write_all(b"data").unwrap();
    out.write_all(&bytes.to_le_bytes()).unwrap();
    let mut block = Vec::with_capacity(16384);
    for frame in 0..frames {
        for channel in 0..channels {
            block.extend_from_slice(&sample(frame, channel).to_le_bytes());
        }
        if block.len() >= 16384 {
            out.write_all(&block).unwrap();
            block.clear();
        }
    }
    out.write_all(&block).unwrap();
}

fn run(path: &Path, cache: &Path) -> serde_json::Value {
    preview(path, cache, None, &|| false).unwrap()
}

#[test]
fn normal_waveform_has_real_duration_and_bounded_peaks() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("normal.wav");
    wav(
        &path,
        16000,
        1,
        |i, _| if i % 2 == 0 { 16384 } else { -16384 },
    );
    let result = run(&path, &dir.path().join("cache"));
    assert_eq!(result["duration"], 2.0);
    assert_eq!(result["totalFrames"], 16000);
    let peaks = result["peaks"].as_array().unwrap();
    assert!(!peaks.is_empty() && peaks.len() <= 2048);
    assert!(peaks
        .iter()
        .all(|p| p[0].as_f64().unwrap() == -0.5 && p[1].as_f64().unwrap() == 0.5));
}

#[test]
fn silent_first_channel_and_antiphase_are_not_silence() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");
    for antiphase in [false, true] {
        let path = dir.path().join(format!("stereo-{antiphase}.wav"));
        wav(&path, 8000, 2, |_, c| {
            if c == 1 {
                16384
            } else if antiphase {
                -16384
            } else {
                0
            }
        });
        let result = run(&path, &cache);
        assert!(result["peaks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p[1] == 0.5));
        if antiphase {
            assert!(result["peaks"]
                .as_array()
                .unwrap()
                .iter()
                .all(|p| p[0] == -0.5));
        }
    }
}

#[test]
fn single_frame_file_stays_a_real_peak() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("short.wav");
    wav(&path, 1, 1, |_, _| 8192);
    let result = run(&path, &dir.path().join("cache"));
    assert_eq!(result["peaks"], serde_json::json!([[0.25, 0.25]]));
    assert_eq!(result["totalFrames"], 1);
    assert_eq!(result["duration"], 1.0 / 8000.0);
}

#[test]
fn warm_cache_does_not_read_or_decode_audio() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("source.wav");
    let cache = dir.path().join("cache");
    wav(&path, 8000, 1, |_, _| 8192);
    let cold = preview(&path, &cache, Some("verified-content-v1"), &|| false).unwrap();
    let warm = preview(&path, &cache, Some("verified-content-v1"), &|| false).unwrap();
    assert_eq!(cold["diagnostics"]["cacheHit"], false);
    assert_eq!(warm["diagnostics"]["cacheHit"], true);
    assert_eq!(warm["diagnostics"]["decodedFrames"], 0);
    assert_eq!(warm["diagnostics"]["sourceBytesRead"], 0);
    assert_eq!(cold["peaks"], warm["peaks"]);
}

#[test]
fn local_revision_is_scoped_to_the_original_file() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");
    let a = dir.path().join("a.wav");
    let b = dir.path().join("b.wav");
    wav(&a, 8000, 1, |_, _| 8192);
    wav(&b, 8000, 1, |_, _| -16384);
    let time = filetime::FileTime::from_last_modification_time(&fs::metadata(&a).unwrap());
    filetime::set_file_mtime(&b, time).unwrap();
    let first = preview(&a, &cache, Some("revision-1"), &|| false).unwrap();
    let second = preview(&b, &cache, Some("revision-1"), &|| false).unwrap();
    assert_eq!(second["diagnostics"]["cacheHit"], false);
    assert_ne!(first["peaks"], second["peaks"]);
    assert!(second["peaks"][0][1].as_f64().unwrap() < 0.0);
}

#[test]
fn truncated_wave_data_is_not_reported_as_a_complete_shorter_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("truncated.wav");
    let cache = dir.path().join("cache");
    wav(&path, 16000, 1, |_, _| 8192);
    File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(44 + 8000)
        .unwrap();
    assert!(preview(&path, &cache, None, &|| false).is_err());
    assert!(!cache.exists() || fs::read_dir(cache).unwrap().next().is_none());
}

#[test]
fn cli_cannot_overwrite_the_source_with_output_json() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("original.wav");
    wav(&path, 8, 1, |_, _| 8192);
    let before = fs::read(&path).unwrap();
    let result = std::process::Command::new(env!("CARGO_BIN_EXE_library-audio-preview"))
        .arg(&path)
        .arg("--cache-dir")
        .arg(dir.path().join("cache"))
        .arg("--output")
        .arg(&path)
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn source_change_invalidates_cache_and_revision_handles_preserved_mtime() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mutable.wav");
    let cache = dir.path().join("cache");
    wav(&path, 8000, 1, |_, _| 8192);
    let first = run(&path, &cache);
    wav(&path, 16000, 1, |_, _| 16384);
    let second = run(&path, &cache);
    assert_eq!(second["diagnostics"]["cacheHit"], false);
    assert_ne!(first["peaks"], second["peaks"]);
    let time = filetime::FileTime::from_last_modification_time(&fs::metadata(&path).unwrap());
    preview(&path, &cache, Some("sha-before"), &|| false).unwrap();
    wav(&path, 16000, 1, |_, _| -16384);
    filetime::set_file_mtime(&path, time).unwrap();
    let changed = preview(&path, &cache, Some("sha-after"), &|| false).unwrap();
    assert_eq!(changed["diagnostics"]["cacheHit"], false);
    assert!(changed["peaks"][0][0].as_f64().unwrap() < 0.0);
}

#[test]
fn damaged_and_empty_audio_never_publish_cache() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bad.wav");
    let cache = dir.path().join("cache");
    fs::write(&path, b"not an audio container").unwrap();
    assert!(preview(&path, &cache, None, &|| false).is_err());
    wav(&path, 0, 1, |_, _| 0);
    assert!(preview(&path, &cache, None, &|| false).is_err());
    assert!(!cache.exists() || fs::read_dir(cache).unwrap().next().is_none());
}

#[test]
fn cancellation_and_mid_decode_change_do_not_publish() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("changing.wav");
    let cache = dir.path().join("cache");
    wav(&path, 80000, 1, |_, _| 8192);
    let calls = AtomicUsize::new(0);
    let cancelled = preview(&path, &cache, None, &|| {
        calls.fetch_add(1, Ordering::Relaxed) >= 4
    })
    .unwrap_err();
    assert!(cancelled.to_string().contains("cancelled"));
    let calls = AtomicUsize::new(0);
    let changed = preview(&path, &cache, None, &|| {
        if calls.fetch_add(1, Ordering::Relaxed) == 4 {
            filetime::set_file_mtime(&path, filetime::FileTime::from_unix_time(123456, 0)).unwrap();
        }
        false
    })
    .unwrap_err();
    assert!(changed.to_string().contains("changed"));
    assert!(!cache.exists() || fs::read_dir(cache).unwrap().next().is_none());
}

#[test]
fn longer_file_does_not_grow_peak_or_decode_buffers() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");
    let short = dir.path().join("short.wav");
    let long = dir.path().join("long.wav");
    wav(&short, 8000, 2, |_, _| 8192);
    wav(&long, 8000 * 120, 2, |_, _| 8192);
    let a = run(&short, &cache);
    let b = run(&long, &cache);
    assert!(b["peaks"].as_array().unwrap().len() <= 2048);
    assert!(b["diagnostics"]["peakBytes"].as_u64().unwrap() <= 2048 * 8);
    assert_eq!(
        a["diagnostics"]["maxDecodedBlockFrames"],
        b["diagnostics"]["maxDecodedBlockFrames"]
    );
    assert_eq!(b["diagnostics"]["decodedFrames"], 8000 * 120);
}
