use super::*;
use crate::core::{catalog_browser::CatalogFilter, external_files};
use std::{fs, path::PathBuf};

struct Fixture {
    _temp: tempfile::TempDir,
    paths: LibraryPaths,
    db: Database,
    source: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let paths = LibraryPaths::init(root.join("library")).unwrap();
        let db = Database::open(&paths.db).unwrap();
        db.migrate().unwrap();
        let source = root.join("sound.wav");
        crate::media::audio::tests::write_wav(&source, 16000, true);
        Self {
            _temp: temp,
            paths,
            db,
            source,
        }
    }
    fn index(&self) -> crate::core::library::Asset {
        self.db
            .index_connected_file(&self.paths, &self.source, None)
            .unwrap()
    }
}

#[test]
fn audio_connections_are_lightweight_and_never_image_classification_targets() {
    let f = Fixture::new();
    let original = fs::read(&f.source).unwrap();
    let asset = f.index();
    assert_eq!(asset.store_path.as_deref(), f.source.to_str());
    assert_eq!(asset.duration, Some(0.0));
    assert!(asset.thumb_path.is_none() && asset.phash.is_none() && asset.colors.is_none());
    assert!(!f.paths.root.join("audio-waveforms").exists());
    assert!(!f.paths.root.join("external-previews").exists());
    assert!(!f
        .db
        .local_targets_for_model(false, "test")
        .unwrap()
        .contains(&asset.id));
    assert_eq!(fs::read(&f.source).unwrap(), original);
    assert_eq!(fs::read_dir(&f.paths.images).unwrap().count(), 0);
}

#[test]
fn audio_catalog_count_and_pages_are_separate_from_images_and_videos() {
    let f = Fixture::new();
    let asset = f.index();
    for (media, expected) in [
        ("audios", vec![asset.id]),
        ("images", vec![]),
        ("videos", vec![]),
    ] {
        let filter = CatalogFilter {
            kind: "all".into(),
            media: media.into(),
            ..Default::default()
        };
        assert_eq!(f.db.catalog_ids(&filter, 0, 60).unwrap(), expected);
    }
}

#[test]
fn audio_originals_cannot_be_sent_as_image_model_references() {
    let f = Fixture::new();
    let asset = f.index();
    assert!(f
        .db
        .resolve_external_image_paths(&[asset.store_path.unwrap()])
        .is_err());
    assert!(f
        .db
        .resolve_external_image_paths(&["unregistered.mp3".into()])
        .is_err());
}

#[test]
fn audio_waveform_service_requires_current_registered_source_version() {
    let f = Fixture::new();
    let asset = f.index();
    let version = external_files::fingerprint(&f.source).unwrap();
    assert!(waveform(&f.paths, &f.db, &asset.id, Some("stale")).is_err());
    let result = waveform(&f.paths, &f.db, &asset.id, Some(&version)).unwrap();
    assert_eq!(result.source_version, version);
    assert_eq!(result.waveform.duration, 2.0);
    assert_eq!(
        f.db.get_asset(&asset.id).unwrap().unwrap().duration,
        Some(2.0)
    );
    assert_eq!(
        fs::read_dir(&f.paths.root.join("audio-waveforms"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn audio_hot_cache_never_decodes_again_and_recovers_corrupt_cache() {
    let f = Fixture::new();
    let asset = f.index();
    let first = waveform(&f.paths, &f.db, &asset.id, None).unwrap();
    let warm = waveform_using(&f.paths, &f.db, &asset.id, None, &|_| {
        panic!("warm cache decoded audio")
    })
    .unwrap();
    assert_eq!(first.waveform.peaks, warm.waveform.peaks);
    let cache = fs::read_dir(f.paths.root.join("audio-waveforms"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    fs::write(&cache, b"bad cache").unwrap();
    assert_eq!(
        waveform(&f.paths, &f.db, &asset.id, None)
            .unwrap()
            .waveform
            .peaks,
        first.waveform.peaks
    );
}

#[test]
fn audio_source_changes_during_decode_do_not_publish_old_waveform() {
    let f = Fixture::new();
    let asset = f.index();
    let result = waveform_using(&f.paths, &f.db, &asset.id, None, &|path| {
        let old = crate::media::audio::decode(path)?;
        crate::media::audio::tests::write_wav(&f.source, 24000, false);
        f.index(); // This would deadlock if decoding held the database mutex.
        Ok(old)
    });
    assert!(result.is_err());
    assert!(!f.paths.root.join("audio-waveforms").exists());
    assert_eq!(
        waveform(&f.paths, &f.db, &asset.id, None)
            .unwrap()
            .waveform
            .duration,
        3.0
    );
}

#[test]
fn audio_cache_eviction_only_removes_owned_regular_json_files() {
    let f = Fixture::new();
    let cache = f.paths.root.join("audio-waveforms");
    fs::create_dir_all(&cache).unwrap();
    let old = cache.join(format!("{}.json", "a".repeat(64)));
    let keep = cache.join(format!("{}.json", "b".repeat(64)));
    fs::write(&old, [0u8; 64]).unwrap();
    fs::write(&keep, [0u8; 64]).unwrap();
    fs::write(cache.join("notes.json"), b"user note").unwrap();
    prune_cache(&cache, 64, &keep).unwrap();
    assert!(!old.exists());
    assert!(keep.exists());
    assert!(cache.join("notes.json").exists());
    assert!(f.source.exists());
}

#[test]
fn audio_out_of_bounds_cached_peaks_are_rebuilt() {
    let f = Fixture::new();
    let asset = f.index();
    waveform(&f.paths, &f.db, &asset.id, None).unwrap();
    let path = fs::read_dir(f.paths.root.join("audio-waveforms"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    value["waveform"]["peaks"][0] = serde_json::json!([-2.0, 2.0]);
    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    let rebuilt = waveform(&f.paths, &f.db, &asset.id, None).unwrap();
    assert!(rebuilt
        .waveform
        .peaks
        .iter()
        .all(|peak| peak[0] >= -1.0 && peak[1] <= 1.0));
}

#[test]
fn audio_simultaneous_cold_requests_decode_once() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let f = Fixture::new();
    let asset = f.index();
    let calls = AtomicUsize::new(0);
    let decoder = |path: &std::path::Path| {
        calls.fetch_add(1, Ordering::Relaxed);
        std::thread::sleep(std::time::Duration::from_millis(30));
        crate::media::audio::decode(path)
    };
    std::thread::scope(|scope| {
        let first =
            scope.spawn(|| waveform_using(&f.paths, &f.db, &asset.id, None, &decoder).unwrap());
        let second =
            scope.spawn(|| waveform_using(&f.paths, &f.db, &asset.id, None, &decoder).unwrap());
        assert_eq!(
            first.join().unwrap().waveform.peaks,
            second.join().unwrap().waveform.peaks
        );
    });
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

#[test]
fn audio_folder_counts_and_entries_do_not_leak_into_images() {
    let f = Fixture::new();
    let folder =
        f.db.connect_directory(f.source.parent().unwrap(), None)
            .unwrap();
    f.db.scan_connection(&f.paths, &folder).unwrap();
    assert_eq!(
        f.db.connection_entry_ids(Some(&folder), None, Some("audios"), 0, 60)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        f.db.connection_entry_ids(Some(&folder), None, Some("images"), 0, 60)
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        f.db.connection_folders(None, Some("audios"))
            .unwrap()
            .iter()
            .find(|value| value.id == folder)
            .unwrap()
            .count,
        1
    );
    assert_eq!(
        f.db.connection_folders(None, Some("images"))
            .unwrap()
            .iter()
            .find(|value| value.id == folder)
            .unwrap()
            .count,
        0
    );
}

#[test]
#[ignore = "production service timing; uses only generated repository audio fixtures"]
fn audio_production_service_fixture_performance() {
    use std::time::Instant;
    let fixtures =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.tmp/audio-preview-fixtures");
    for name in ["long-vbr.mp3", "long.flac", "ten-minute.wav"] {
        let f = Fixture::new();
        let original = fs::canonicalize(fixtures.join(name)).unwrap();
        let before = external_files::fingerprint(&original).unwrap();
        let started = Instant::now();
        let asset =
            f.db.index_connected_file(&f.paths, &original, None)
                .unwrap();
        let index_ms = started.elapsed().as_secs_f64() * 1000.0;
        assert!(!f.paths.root.join("audio-waveforms").exists());
        assert_eq!(asset.store_path.as_deref(), original.to_str());
        let started = Instant::now();
        let cold = waveform(&f.paths, &f.db, &asset.id, Some(&before)).unwrap();
        let cold_ms = started.elapsed().as_secs_f64() * 1000.0;
        let mut warm_ms = Vec::new();
        for _ in 0..5 {
            let started = Instant::now();
            let warm = waveform_using(&f.paths, &f.db, &asset.id, Some(&before), &|_| {
                panic!("warm production service decoded the source")
            })
            .unwrap();
            warm_ms.push(started.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(warm.waveform.peaks, cold.waveform.peaks);
        }
        let after = external_files::fingerprint(&original).unwrap();
        assert_eq!(before, after);
        assert_eq!(fs::read_dir(&f.paths.images).unwrap().count(), 0);
        let cache_bytes: u64 = fs::read_dir(f.paths.root.join("audio-waveforms"))
            .unwrap()
            .map(|entry| entry.unwrap().metadata().unwrap().len())
            .sum();
        assert!(cache_bytes <= CACHE_BUDGET);
        println!(
            "{}",
            serde_json::json!({
                "file": name, "build": if cfg!(debug_assertions) { "debug" } else { "release" },
                "indexMs": index_ms, "coldMs": cold_ms, "warmMs": warm_ms,
                "duration": cold.waveform.duration, "peakCount": cold.waveform.peaks.len(),
                "cacheBytes": cache_bytes, "originalSha256Before": before,
                "originalSha256After": after, "copies": 0
            })
        );
    }
}
