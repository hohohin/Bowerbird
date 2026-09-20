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
