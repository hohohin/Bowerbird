use super::*;

/// 用 mp4 crate 的 writer 离线生成一个最小 MP4（不依赖本机 ffmpeg）。
fn write_fixture_mp4(path: &Path, width: u16, height: u16, sample_ms: u32) {
    let file = std::fs::File::create(path).unwrap();
    let mut writer = mp4::Mp4Writer::write_start(
        file,
        &mp4::Mp4Config {
            major_brand: (*b"isom").into(),
            minor_version: 512,
            compatible_brands: vec![(*b"isom").into(), (*b"mp41").into()],
            timescale: 1000,
        },
    )
    .unwrap();
    writer
        .add_track(&mp4::TrackConfig {
            track_type: mp4::TrackType::Video,
            timescale: 1000,
            language: "und".to_string(),
            media_conf: mp4::MediaConfig::AvcConfig(mp4::AvcConfig {
                width,
                height,
                // AvcCBox::new 读 sps[1..=3]，空 SPS 会越界；给最小占位 NAL。
                seq_param_set: vec![0x67, 0x42, 0x00, 0x1e],
                pic_param_set: vec![0x68],
            }),
        })
        .unwrap();
    writer
        .write_sample(
            1,
            &mp4::Mp4Sample {
                start_time: 0,
                duration: sample_ms,
                rendering_offset: 0,
                is_sync: true,
                bytes: mp4::Bytes::new(),
            },
        )
        .unwrap();
    writer.write_end().unwrap();
}

#[test]
fn native_probe_reads_mp4_without_ffprobe() {
    let dir = std::env::temp_dir().join(format!("bb-probe-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("clip.mp4");
    write_fixture_mp4(&path, 120, 240, 400);

    let meta = probe(&path).unwrap();
    assert_eq!(meta.ext, "mp4");
    assert_eq!((meta.width, meta.height), (120, 240));
    assert!((meta.duration - 0.4).abs() < 1e-6);
    assert_eq!(meta.size, std::fs::metadata(&path).unwrap().len());

    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn native_probe_rejects_garbage_file() {
    let dir = std::env::temp_dir().join(format!("bb-probe-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("broken.mp4");
    std::fs::write(&path, b"not a video").unwrap();

    assert!(probe_iso_native(&path, "mp4", 14).is_err());

    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn mp4_display_rotation_swaps_width_and_height() {
    let dir = std::env::temp_dir().join(format!("bb-probe-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("rotated.mp4");
    write_fixture_mp4(&path, 240, 120, 400);
    let mut bytes = std::fs::read(&path).unwrap();
    let tkhd = bytes.windows(4).position(|part| part == b"tkhd").unwrap();
    assert_eq!(bytes[tkhd + 4], 0, "fixture uses version 0 tkhd");
    // tkhd version 0: matrix starts 44 bytes after its four-character type.
    let matrix = [0i32, 65536, 0, -65536, 0, 0, 0, 0, 0x40000000];
    for (index, value) in matrix.iter().enumerate() {
        bytes[tkhd + 44 + index * 4..tkhd + 48 + index * 4].copy_from_slice(&value.to_be_bytes());
    }
    std::fs::write(&path, bytes).unwrap();
    let meta = probe_iso_native(&path, "mp4", 0).unwrap();
    assert_eq!((meta.width, meta.height), (120, 240));
    assert_eq!(meta.duration, 0.4);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn fragmented_mp4_uses_sample_timing_not_presentation_offset() {
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/media");
    for (name, duration) in [("fragmented.mp4", 0.4), ("fragmented-audio.mp4", 1.28)] {
        let meta = probe_iso_native(&fixtures.join(name), "mp4", 0).unwrap();
        assert_eq!((meta.width, meta.height), (320, 240));
        assert!((meta.duration - duration).abs() < 0.025, "{name}: {meta:?}");
    }
}

#[test]
fn invalid_metadata_is_not_accepted_as_zero_duration() {
    for duration in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        assert!(checked_meta("mp4", 10, 120, 240, duration).is_err());
    }
    assert!(checked_meta("mp4", 10, 0, 240, 1.0).is_err());
    assert!(checked_meta("mp4", 10, 120, 0, 1.0).is_err());
}

#[test]
fn ffprobe_json_preserves_rotation_and_rejects_unknown_duration() {
    let meta = parse_ffprobe(br#"{"streams":[{"width":960,"height":540,"side_data_list":[{}, {"rotation":-90}]}],"format":{"duration":"0.2"}}"#, "mkv", 123).unwrap();
    assert_eq!((meta.width, meta.height), (540, 960));
    assert_eq!(meta.duration, 0.2);
    assert_eq!(meta.size, 123);
    for duration in ["N/A", "NaN", "inf", "0", "-1"] {
        let json = format!(r#"{{"streams":[{{"width":120,"height":240}}],"format":{{"duration":"{duration}"}}}}"#);
        assert!(parse_ffprobe(json.as_bytes(), "mkv", 0).is_err());
    }
    assert!(parse_ffprobe(br#"{"streams":[],"format":{"duration":"1"}}"#, "mkv", 0).is_err());
}

#[test]
fn probe_worker_timeout_kills_and_reaps_child() {
    use std::time::{Duration, Instant};
    #[cfg(windows)]
    let mut command = {
        let mut command = tools::command(Path::new("powershell.exe"));
        command.args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 20"]);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = tools::command(Path::new("/bin/sleep"));
        command.arg("20");
        command
    };
    let start = Instant::now();
    let error = native::run_probe(&mut command, Duration::from_millis(80)).unwrap_err();
    assert!(error.to_string().contains("超时"), "{error}");
    assert!(start.elapsed() < Duration::from_secs(5));
}
