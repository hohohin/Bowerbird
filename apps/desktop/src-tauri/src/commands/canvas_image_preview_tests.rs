use super::*;
use image::{Rgba, RgbaImage};
use std::{
    io::Write,
    time::{Duration, SystemTime},
};

fn source(root: &Path, width: u32, height: u32) -> PathBuf {
    let path = root.join("transparent.png");
    RgbaImage::from_fn(width, height, |x, _| {
        Rgba([30, 80, 140, if x < width / 2 { 0 } else { 127 }])
    })
    .save(&path)
    .unwrap();
    path
}

#[test]
fn canvas_preview_preserves_alpha_aspect_ratio_and_original() {
    let dir = tempfile::tempdir().unwrap();
    let source = source(dir.path(), 1600, 800);
    let original = fs::read(&source).unwrap();
    let cache = dir.path().join("cache");
    let preview = image_preview(&source, &cache, 512).unwrap();
    let image = image::open(&preview).unwrap().into_rgba8();
    assert_eq!(image.dimensions(), (512, 256));
    assert_eq!(image.get_pixel(20, 20)[3], 0);
    let pixel = image.get_pixel(490, 20);
    assert_eq!(pixel[3], 127);
    // Integer alpha premultiply/unpremultiply can round a color channel by one.
    assert!(pixel.0[..3]
        .iter()
        .zip([30u8, 80, 140])
        .all(|(&actual, expected)| actual.abs_diff(expected) <= 1));
    let larger = image_preview(&source, &cache, 1024).unwrap();
    assert_ne!(preview, larger);
    assert_eq!(image::image_dimensions(larger).unwrap(), (1024, 512));
    assert_eq!(fs::read(&source).unwrap(), original);
}

#[test]
fn canvas_preview_transparent_colors_do_not_bleed_into_visible_edges() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("alpha-edge.png");
    RgbaImage::from_fn(1600, 800, |x, _| {
        if x < 799 {
            Rgba([255, 0, 0, 0])
        } else {
            Rgba([0, 0, 255, 255])
        }
    })
    .save(&source)
    .unwrap();
    let preview = image_preview(&source, &dir.path().join("cache"), 512).unwrap();
    let image = image::open(preview).unwrap().into_rgba8();
    let edges: Vec<_> = image
        .pixels()
        .filter(|pixel| pixel[3] > 0 && pixel[3] < 255)
        .collect();
    assert!(!edges.is_empty());
    assert!(
        edges.iter().all(|pixel| pixel[0] == 0 && pixel[2] >= 250),
        "transparent red must not tint the blue edge"
    );
}

#[test]
fn canvas_preview_reuses_cache_and_repairs_invalid_files() {
    let dir = tempfile::tempdir().unwrap();
    let source = source(dir.path(), 800, 600);
    let cache = dir.path().join("cache");
    let preview = image_preview(&source, &cache, 512).unwrap();
    let stamp = SystemTime::UNIX_EPOCH + Duration::from_secs(12345);
    fs::OpenOptions::new()
        .write(true)
        .open(&preview)
        .unwrap()
        .set_modified(stamp)
        .unwrap();
    assert_eq!(image_preview(&source, &cache, 512).unwrap(), preview);
    assert_eq!(fs::metadata(&preview).unwrap().modified().unwrap(), stamp);
    fs::write(&preview, b"broken cache").unwrap();
    assert_eq!(image_preview(&source, &cache, 512).unwrap(), preview);
    assert_eq!(image::image_dimensions(&preview).unwrap(), (512, 384));
    assert_eq!(
        fs::read_dir(cache).unwrap().count(),
        1,
        "temporary files are cleaned"
    );
}

#[test]
fn canvas_preview_cache_key_tracks_path_size_mtime_and_tier() {
    let dir = tempfile::tempdir().unwrap();
    let source = source(dir.path(), 800, 600);
    let key = cache_key(&source, &fs::metadata(&source).unwrap(), 512).unwrap();
    let key_for = |path: &Path, size| cache_key(path, &fs::metadata(path).unwrap(), size).unwrap();
    assert_ne!(key, key_for(&source, 1024));
    let copy = dir.path().join("copy.png");
    fs::copy(&source, &copy).unwrap();
    assert_ne!(key, key_for(&copy, 512));
    let cache = dir.path().join("cache");
    let first = image_preview(&source, &cache, 512).unwrap();
    let modified = fs::metadata(&source).unwrap().modified().unwrap() + Duration::from_secs(2);
    fs::OpenOptions::new()
        .write(true)
        .open(&source)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    let second = image_preview(&source, &cache, 512).unwrap();
    assert_ne!(first, second);
    let before = key_for(&source, 512);
    fs::OpenOptions::new()
        .append(true)
        .open(&source)
        .unwrap()
        .write_all(b"extra")
        .unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&source)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    assert_ne!(
        before,
        key_for(&source, 512),
        "length invalidates even with equal mtime"
    );
}

#[test]
fn canvas_preview_retains_small_and_unsupported_originals() {
    let dir = tempfile::tempdir().unwrap();
    let source = source(dir.path(), 40, 20);
    let cache = dir.path().join("cache");
    assert_eq!(image_preview(&source, &cache, 512).unwrap(), source);
    for extension in ["gif", "svg", "ico", "avif"] {
        let original = dir.path().join(format!("original.{extension}"));
        fs::write(&original, b"original passed through without decoding").unwrap();
        assert_eq!(image_preview(&original, &cache, 512).unwrap(), original);
    }
    assert!(!cache.exists());
    assert!(image_preview(&dir.path().join("database.db"), &cache, 512).is_err());
}

#[test]
fn canvas_preview_preserves_icc_and_applies_orientation_once() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("oriented.png");
    let data = RgbaImage::from_pixel(1200, 600, Rgba([20, 40, 80, 90]));
    let mut encoder = PngEncoder::new(fs::File::create(&source).unwrap());
    let profile = b"canvas preview ICC roundtrip".to_vec();
    encoder.set_icc_profile(profile.clone()).unwrap();
    // Little-endian TIFF IFD: orientation = 6 (90 degrees clockwise).
    let exif = vec![
        b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
    ];
    encoder.set_exif_metadata(exif).unwrap();
    encoder
        .write_image(data.as_raw(), 1200, 600, image::ExtendedColorType::Rgba8)
        .unwrap();
    let preview = image_preview(&source, &dir.path().join("cache"), 512).unwrap();
    let mut decoder = ImageReader::open(preview).unwrap().into_decoder().unwrap();
    assert_eq!(decoder.dimensions(), (256, 512));
    assert_eq!(decoder.icc_profile().unwrap(), Some(profile));
    assert_eq!(
        decoder.orientation().unwrap(),
        image::metadata::Orientation::NoTransforms
    );
}

#[test]
fn canvas_preview_does_not_freeze_animated_webp() {
    let dir = tempfile::tempdir().unwrap();
    let original = dir.path().join("animated.webp");
    let mut still = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut still)
        .write_image(&[10, 20, 30, 255], 1, 1, image::ExtendedColorType::Rgba8)
        .unwrap();
    let mut chunks = Vec::new();
    let mut chunk = |name: &[u8; 4], data: &[u8]| {
        chunks.extend(name);
        chunks.extend((data.len() as u32).to_le_bytes());
        chunks.extend(data);
        if data.len() % 2 != 0 {
            chunks.push(0);
        }
    };
    chunk(b"VP8X", &[2, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    chunk(b"ANIM", &[0, 0, 0, 0, 0, 0]);
    let mut frame = vec![0; 16];
    frame[12] = 100;
    frame.extend(&still[12..]);
    chunk(b"ANMF", &frame);
    let mut webp = b"RIFF".to_vec();
    webp.extend((chunks.len() as u32 + 4).to_le_bytes());
    webp.extend(b"WEBP");
    webp.extend(chunks);
    fs::write(&original, webp).unwrap();
    assert!(static_decoder(&original).unwrap().is_none());
    assert_eq!(
        image_preview(&original, &dir.path().join("cache"), 512).unwrap(),
        original
    );
}

#[test]
fn canvas_preview_large_decode_is_skipped_before_reading_pixels() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("oversized.bmp");
    let mut header = vec![0u8; 54];
    header[..2].copy_from_slice(b"BM");
    header[10..14].copy_from_slice(&54u32.to_le_bytes());
    header[14..18].copy_from_slice(&40u32.to_le_bytes());
    header[18..22].copy_from_slice(&10000i32.to_le_bytes());
    header[22..26].copy_from_slice(&10000i32.to_le_bytes());
    header[26..28].copy_from_slice(&1u16.to_le_bytes());
    header[28..30].copy_from_slice(&24u16.to_le_bytes());
    // No pixel payload: a decode attempt would fail, but metadata suffices to skip it.
    fs::write(&source, header).unwrap();
    assert_eq!(
        image_preview(&source, &dir.path().join("cache"), 512).unwrap(),
        source
    );
}

#[test]
fn canvas_preview_cache_eviction_respects_count_bytes_and_unknown_files() {
    for (max_files, max_bytes) in [(2, 100), (100, 8)] {
        let dir = tempfile::tempdir().unwrap();
        let mut paths = Vec::new();
        for index in 1..=3 {
            let path = dir.path().join(format!("{index:064x}.png"));
            fs::write(&path, b"data").unwrap();
            fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(index))
                .unwrap();
            paths.push(path);
        }
        let unknown = dir.path().join("original.png");
        fs::write(&unknown, b"keep unknown files").unwrap();
        let directory = dir.path().join(format!("{:064x}.png", 99));
        fs::create_dir(&directory).unwrap();
        // Even the oldest entry is retained when it is the result being returned.
        trim_cache(dir.path(), &paths[0], max_files, max_bytes);
        assert!(paths[0].is_file());
        assert!(!paths[1].exists());
        assert!(paths[2].is_file());
        assert_eq!(fs::read(unknown).unwrap(), b"keep unknown files");
        assert!(directory.is_dir());
    }
}

#[test]
#[ignore = "Synthetic cold-cache timing; run explicitly"]
fn canvas_preview_cold_cache_benchmark() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("4096x2048.png");
    RgbaImage::from_fn(4096, 2048, |x, y| {
        Rgba([
            (x * 13 + y * 7) as u8,
            (x / 16 + y / 8) as u8,
            (x / 3 + y / 5) as u8,
            if x % 512 < 96 { 0 } else { 220 },
        ])
    })
    .save(&source)
    .unwrap();
    for (index, size) in [512, 512, 512, 1024, 2048].into_iter().enumerate() {
        let cache = dir.path().join(format!("cache-{index}"));
        let start = std::time::Instant::now();
        let result = image_preview(&source, &cache, size).unwrap();
        let cold_ms = start.elapsed().as_secs_f64() * 1000.;
        let start = std::time::Instant::now();
        image_preview(&source, &cache, size).unwrap();
        eprintln!(
            "canvas preview 4096x2048 -> {size}: cold={cold_ms:.2}ms warm={:.2}ms bytes={}",
            start.elapsed().as_secs_f64() * 1000.,
            fs::metadata(result).unwrap().len()
        );
    }
}
