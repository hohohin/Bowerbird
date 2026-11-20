use super::*;
use crate::core::paths::LibraryPaths;
use sha2::{Digest, Sha256};
use windows::Win32::{
    System::{Com::*, Ole::{ReleaseStgMedium, CF_HDROP}},
    UI::Shell::{DragQueryFileW, HDROP},
};

/// Opens only an isolated synthetic directory, and leaves the fixture for Shell selection inspection.
#[tokio::test]
#[ignore = "opens Windows Explorer on a temporary fixture"]
async fn windows_reveals_and_publishes_thirteen_registered_verbatim_originals() {
    let root = PathBuf::from(std::env::var_os("BOWERBIRD_SHELL_TEST_ROOT").expect("isolated root required"));
    assert!(root.is_absolute() && root.file_name().is_some_and(|name| name == "shell-originals"));
    let paths = LibraryPaths::init(root.join("database")).unwrap();
    let db = Database::open(&paths.db).unwrap();
    db.migrate().unwrap();
    let project = root.join("已删除项目 中文, 空格");
    std::fs::create_dir_all(&project).unwrap();
    let mut ids = Vec::new();
    let mut originals = Vec::new();
    for index in 0..13 {
        let extension = if index % 2 == 0 { "webp" } else { "jpg" };
        let path = project.join(format!("采集 照片,{index:02}.{extension}"));
        image::RgbImage::from_pixel(16, 12, image::Rgb([index as u8, 34, 56])).save(&path).unwrap();
        let path = path.canonicalize().unwrap();
        let asset = db.index_connected_file(&paths, &path, None).unwrap();
        // Old origin is deliberately invalid, while the registered current file remains usable.
        db.conn.lock().unwrap().execute("UPDATE assets SET origin_path='D:/gone/source.jpg' WHERE id=?1", [&asset.id]).unwrap();
        ids.push(asset.id);
        originals.push(path);
    }
    let files = crate::core::external_drag::files(&db, &ids).unwrap();
    assert_eq!(files, originals);
    let mut report = Vec::new();
    {
        let _ole = crate::external_drag::windows::Ole::enter().unwrap();
        let object = crate::external_drag::windows::files_data_object(&files).unwrap();
        let format = FORMATETC {
            cfFormat: CF_HDROP.0,
            dwAspect: DVASPECT_CONTENT.0,
            tymed: TYMED_HGLOBAL.0 as u32,
            ..Default::default()
        };
        let mut medium = unsafe { object.GetData(&format) }.unwrap();
        let drop = HDROP(unsafe { medium.u.hGlobal }.0);
        assert_eq!(unsafe { DragQueryFileW(drop, u32::MAX, None) }, 13);
        for (index, original) in originals.iter().enumerate() {
            let length = unsafe { DragQueryFileW(drop, index as u32, None) };
            let mut buffer = vec![0u16; length as usize + 1];
            unsafe { DragQueryFileW(drop, index as u32, Some(&mut buffer)); }
            let delivered = PathBuf::from(String::from_utf16(&buffer[..length as usize]).unwrap());
            assert_eq!(delivered.canonicalize().unwrap(), *original);
            assert!(!delivered.to_string_lossy().starts_with(r"\\?\"));
            let source_hash = format!("{:x}", Sha256::digest(std::fs::read(original).unwrap()));
            assert_eq!(source_hash, format!("{:x}", Sha256::digest(std::fs::read(&delivered).unwrap())));
            report.push(serde_json::json!({"assetId":ids[index], "registered":original, "delivered":delivered, "sha256":source_hash}));
        }
        unsafe { ReleaseStgMedium(&mut medium); }
    }
    for original in &files {
        spawn_locate_or_open(original, true).await.unwrap();
    }
    let missing = project.join("不存在.jpg");
    assert!(spawn_locate_or_open(&missing, true).await.is_err());
    std::fs::write(root.join("shell-results.json"), serde_json::to_vec_pretty(&report).unwrap()).unwrap();
}
