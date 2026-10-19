//! File-view color filtering shares the library's LAB palette, without indexing assets.
use crate::{core::{external_files, paths::LibraryPaths}, error::AppError, media::color};
use std::{path::Path, sync::Arc};
use tauri::State;

fn read_colors(paths: &LibraryPaths, path: &Path) -> Result<Vec<String>, AppError> {
    let preview = external_files::preview(paths, path)?;
    let mut buckets = Vec::new();
    for hex in color::extract(Path::new(&preview), 5)? {
        if let Some(key) = color::hex_to_bucket(&hex) {
            if !buckets.iter().any(|item| item == key) { buckets.push(key.to_string()); }
        }
    }
    Ok(buckets)
}

#[tauri::command]
pub async fn file_colors(paths: State<'_, Arc<LibraryPaths>>, path: String) -> Result<Vec<String>, AppError> {
    static GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    let permit = GATE.acquire().await.map_err(|e| AppError::Other(e.to_string()))?;
    let paths = paths.inner().clone();
    tokio::task::spawn_blocking(move || { let _permit = permit; read_colors(&paths, Path::new(&path)) })
        .await.map_err(|e| AppError::Other(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_palette_is_read_only_and_refreshes_changed_files() {
        let temp = std::env::temp_dir().join(format!("bowerbird-file-colors-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&temp).unwrap();
        let paths = LibraryPaths::init(temp.as_path().join("cache")).unwrap();
        let source = temp.as_path().join("source.png");
        image::RgbImage::from_pixel(32, 32, image::Rgb([217, 36, 36])).save(&source).unwrap();
        let before = std::fs::read(&source).unwrap();
        assert_eq!(read_colors(&paths, &source).unwrap(), vec!["red"]);
        assert_eq!(std::fs::read(&source).unwrap(), before);
        assert!(!paths.db.exists());
        assert_eq!(std::fs::read_dir(&paths.images).unwrap().count(), 0);
        image::RgbImage::from_pixel(48, 48, image::Rgb([45, 91, 217])).save(&source).unwrap();
        assert_eq!(read_colors(&paths, &source).unwrap(), vec!["blue"]);
        assert!(read_colors(&paths, &temp.as_path().join("missing.png")).is_err());
        assert!(read_colors(&paths, temp.as_path()).is_err());
        assert!(temp.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(temp).unwrap();
    }
}
