use super::*;
use crate::core::file_workspace::FileWorkspace;
use std::fs;

struct Fixture {
    root: PathBuf,
    paths: LibraryPaths,
    db: Database,
    files: Arc<FileWorkspace>,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("bowerbird-image-read-{}", Ulid::new()));
        let mut paths = LibraryPaths::init(root.join("database")).unwrap();
        let files = Arc::new(FileWorkspace::open(paths.root.join("files.json"), root.join("BowerbirdLibrary")).unwrap());
        files.ensure_root().unwrap();
        paths.files = Some(files.clone());
        let db = Database::open(&paths.db).unwrap();
        db.migrate().unwrap();
        Self { root, paths, db, files }
    }

    fn image(&self, path: PathBuf) -> PathBuf {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        image::RgbImage::from_pixel(10, 20, image::Rgb([12, 34, 56])).save(&path).unwrap();
        path
    }

    fn read(&self, path: &Path) -> Result<PathBuf, AppError> {
        readable_image_path(&self.paths, &self.db, path.to_str().unwrap())
    }
}

impl Drop for Fixture {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); }
}

#[test]
fn reads_project_global_inbox_and_legacy_images() {
    let f = Fixture::new();
    let project = f.files.project_directory("p1", "信息流").unwrap();
    let root = f.files.ensure_root().unwrap();
    for directory in [project.clone(), root.join("全局素材"), root.join("收集箱"), f.paths.images.clone()] {
        let path = f.image(directory.join("image.png"));
        assert_eq!(f.read(&path).unwrap(), path.canonicalize().unwrap());
        // Windows canonical paths include the verbatim prefix shown in the reported error.
        assert_eq!(f.read(&path.canonicalize().unwrap()).unwrap(), path.canonicalize().unwrap());
    }
    // Choosing a new root does not invalidate previously created project directories.
    f.files.configure(&f.root.join("new-root")).unwrap();
    assert!(f.read(&project.join("image.png")).is_ok());
}

#[test]
fn browsing_places_and_unmanaged_siblings_do_not_grant_read_access() {
    let f = Fixture::new();
    let root = f.files.ensure_root().unwrap();
    let project = f.files.project_directory("p1", "信息流").unwrap();
    let place = f.image(f.root.join("browsed/image.png"));
    f.files.set_place(place.parent().unwrap(), true).unwrap();
    for path in [place, f.image(root.join("other.png")), f.image(project.parent().unwrap().join("other.png"))] {
        assert!(f.read(&path).unwrap_err().to_string().contains("只允许读取"));
    }
    assert!(f.read(&project.join("../other.png")).is_err());
}

#[test]
fn registered_external_images_still_require_unchanged_fingerprint() {
    let f = Fixture::new();
    let path = f.image(f.root.join("external.png"));
    assert!(f.read(&path).is_err());
    f.db.index_external(&f.paths, &path).unwrap();
    assert!(f.read(&path).is_ok());
    image::RgbImage::from_pixel(10, 20, image::Rgb([90, 80, 70])).save(&path).unwrap();
    assert!(f.read(&path).unwrap_err().to_string().contains("已修改"));
}
