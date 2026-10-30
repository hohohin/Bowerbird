use super::*;

const STRIPS: &[u8] = include_bytes!("../../tests/fixtures/heic/rgb-strips-96.heic");
const GRID: &[u8] = include_bytes!("../../tests/fixtures/heic/checker-1024.heic");

fn setup() -> (tempfile::TempDir, LibraryPaths, Database) {
    let directory = tempfile::tempdir().unwrap();
    let paths = LibraryPaths::init(directory.path().join("library")).unwrap();
    let db = Database::open_in_memory().unwrap();
    db.migrate().unwrap();
    (directory, paths, db)
}

#[test]
fn heic_import_preserves_source_and_produces_usable_png() {
    let (directory, paths, db) = setup();
    let source = directory.path().join("手机照片.HEIC");
    fs::write(&source, STRIPS).unwrap();
    let asset = ingest_file(&paths, &db, &source).unwrap();
    assert_eq!(fs::read(&source).unwrap(), STRIPS);
    assert_eq!(asset.name, "手机照片");
    assert_eq!(asset.ext.as_deref(), Some("png"));
    assert_eq!(asset.origin_path.as_deref(), source.to_str());
    assert_eq!((asset.width, asset.height), (Some(96), Some(32)));
    let stored = Path::new(asset.store_path.as_deref().unwrap());
    assert_eq!(asset.size, Some(fs::metadata(stored).unwrap().len() as i64));
    let image = image::open(stored).unwrap().to_rgb8();
    for (x, channel) in [(16, 0), (48, 1), (80, 2)] {
        let pixel = image.get_pixel(x, 16).0;
        assert!(pixel[channel] > 220, "{pixel:?}");
        assert!(pixel[(channel + 1) % 3] < 40, "{pixel:?}");
    }
    assert!(image::open(asset.thumb_path.as_deref().unwrap()).is_ok());
    assert!(asset.phash.is_some());
    assert!(asset.colors.is_some());
    // Repeated HEIC and the same image arriving through the byte upload share an asset.
    assert_eq!(ingest_file(&paths, &db, &source).unwrap().id, asset.id);
    let uploaded = ingest_from_bytes(&paths, &db, STRIPS, "", Some("其他.heif"), None, "imported").unwrap();
    assert_eq!(uploaded.id, asset.id);
    assert_eq!(uploaded.origin_path, asset.origin_path);
}

#[test]
fn heic_upload_uses_bytes_and_clears_temporary_origin() {
    let (_directory, paths, db) = setup();
    assert_eq!(uploaded_image_extension(STRIPS, Some("application/octet-stream")).unwrap(), "heic");
    assert_eq!(downloaded_image_extension(None, STRIPS).unwrap(), "heic");
    let asset = ingest_from_bytes(&paths, &db, STRIPS, "", Some("拖入.jpg"), Some("image/jpeg"), "imported").unwrap();
    assert_eq!(asset.name, "拖入");
    assert_eq!(asset.ext.as_deref(), Some("png"));
    assert_eq!(asset.origin_path, None);
    assert!(image::open(asset.store_path.unwrap()).is_ok());
    assert!(uploaded_image_extension(b"not a picture", Some("image/heic")).is_err());
}

#[test]
fn heic_folder_import_decodes_grid_and_heif_extension() {
    let (directory, paths, db) = setup();
    let input = directory.path().join("input");
    fs::create_dir_all(input.join("nested")).unwrap();
    fs::write(input.join("phone.HEIC"), STRIPS).unwrap();
    fs::write(input.join("nested/grid.HeIf"), GRID).unwrap();
    fs::write(input.join("ignored.txt"), STRIPS).unwrap();
    assert_eq!(walk_media(&input).len(), 2);
    let assets = ingest_dir(&paths, &db, &input).unwrap();
    assert_eq!(assets.len(), 2);
    let grid = assets.iter().find(|a| a.name == "grid").unwrap();
    assert_eq!((grid.width, grid.height), (Some(1024), Some(1024)));
    let image = image::open(grid.store_path.as_deref().unwrap()).unwrap().to_rgb8();
    // Exercise pixels in all four coded tiles, away from lossy block boundaries.
    for (x, y) in [(32,32), (544,32), (32,544), (544,544)] {
        assert!(image.get_pixel(x, y).0[0] > 220);
        assert!(image.get_pixel(x + 64, y).0[0] < 30);
    }
}

#[test]
fn heic_import_applies_orientation_before_dimensions_and_thumbnail() {
    let (directory, paths, db) = setup();
    let mut bytes = STRIPS.to_vec();
    let offset = bytes.windows(4).position(|value| value == b"irot").unwrap();
    bytes[offset + 4] = 1; // HEIF irot: 90 degrees counterclockwise.
    let source = directory.path().join("portrait.heic");
    fs::write(&source, bytes).unwrap();
    let asset = ingest_file(&paths, &db, &source).unwrap();
    assert_eq!((asset.width, asset.height), (Some(32), Some(96)));
    let image = image::open(asset.store_path.unwrap()).unwrap().to_rgb8();
    assert!(image.get_pixel(16, 16).0[2] > 220); // Blue strip now at the top.
    assert!(image.get_pixel(16, 80).0[0] > 220);
    let thumb = image::open(asset.thumb_path.unwrap()).unwrap();
    assert!(thumb.height() > thumb.width());
}

#[test]
fn heic_failure_leaves_no_asset_or_managed_file() {
    let (directory, paths, db) = setup();
    let source = directory.path().join("broken.heic");
    fs::write(&source, &STRIPS[..STRIPS.len() / 2]).unwrap();
    assert!(ingest_file(&paths, &db, &source).is_err());
    assert!(ingest_from_bytes(&paths, &db, &STRIPS[..32], "", Some("broken.heic"), None, "imported").is_err());
    assert!(walk_media(&paths.images).is_empty());
    let count: i64 = db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 0);
}

#[test]
fn heic_import_rejects_excessive_size_before_decoding() {
    let (directory, paths, db) = setup();
    let source = directory.path().join("too-large.heic");
    fs::File::create(&source).unwrap().set_len(50 * 1024 * 1024 + 1).unwrap();
    assert!(ingest_file(&paths, &db, &source).unwrap_err().to_string().contains("50 MB"));
    let mut bytes = STRIPS.to_vec();
    let offset = bytes.windows(4).position(|value| value == b"ispe").unwrap();
    bytes[offset + 8..offset + 12].copy_from_slice(&100_001u32.to_be_bytes());
    bytes[offset + 12..offset + 16].copy_from_slice(&100_001u32.to_be_bytes());
    fs::write(&source, bytes).unwrap();
    assert!(ingest_file(&paths, &db, &source).is_err());
    assert!(walk_media(&paths.images).is_empty());
}
