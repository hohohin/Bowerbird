//! Bounded local screenshot history. Records own their files, never library assets.
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::{Path, PathBuf}};

const MAX_RECORDS: usize = 50;
const MAX_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: String,
    pub created_at: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

pub struct HistoryStore { root: PathBuf }

impl HistoryStore {
    pub fn new(root: PathBuf) -> Self { Self { root } }

    fn path(&self, id: &str, suffix: &str) -> Result<PathBuf, String> {
        if ulid::Ulid::from_string(id).ok().is_none_or(|value| value.to_string() != id) {
            return Err("这条截图记录无效，请重新打开历史。".into());
        }
        Ok(self.root.join(format!("{id}.{suffix}")))
    }

    pub fn list(&self) -> Result<Vec<HistoryEntry>, String> {
        if !self.root.exists() { return Ok(Vec::new()); }
        let mut entries = Vec::new();
        for file in fs::read_dir(&self.root).map_err(|e| e.to_string())? {
            let file = file.map_err(|e| e.to_string())?;
            if !file.file_type().map_err(|e| e.to_string())?.is_file() { continue; }
            let path = file.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()) else { continue; };
            let Ok(png) = self.path(id, "png") else { continue; };
            let Ok(data) = fs::read(&path) else { continue; };
            let Ok(entry) = serde_json::from_slice::<HistoryEntry>(&data) else { continue; };
            if entry.id == id && regular_file(&png) { entries.push(entry); }
        }
        entries.sort_by(|a, b| b.id.cmp(&a.id));
        Ok(entries)
    }

    pub fn image(&self, id: &str, thumbnail: bool) -> Result<Vec<u8>, String> {
        let metadata = self.path(id, "json")?;
        let path = self.path(id, if thumbnail { "thumb.png" } else { "png" })?;
        if !regular_file(&metadata) || !regular_file(&path) {
            return Err("这张截图已不在历史中。".into());
        }
        fs::read(path).map_err(|e| e.to_string())
    }

    pub fn save(&self, id: &str, png: &[u8], width: u32, height: u32) -> Result<HistoryEntry, String> {
        self.save_with_limits(id, png, width, height, MAX_RECORDS, MAX_BYTES)
    }

    fn save_with_limits(&self, id: &str, png: &[u8], width: u32, height: u32, max_records: usize, max_bytes: u64) -> Result<HistoryEntry, String> {
        let path = self.path(id, "png")?;
        if png.len() as u64 > max_bytes { return Err("截图过大，无法存入历史，请缩小选区后重试。".into()); }
        if let Some(entry) = self.list()?.into_iter().find(|entry| entry.id == id) {
            if self.image(id, false)? != png { return Err("这次截图已保存，请重新开始截图。".into()); }
            self.prune(max_records, max_bytes)?;
            return Ok(entry);
        }
        let image = image::load_from_memory(png).map_err(|e| e.to_string())?;
        let mut thumb = std::io::Cursor::new(Vec::new());
        image.thumbnail(240, 240).write_to(&mut thumb, image::ImageFormat::Png).map_err(|e| e.to_string())?;
        fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        let entry = HistoryEntry { id: id.into(), created_at: chrono::Utc::now().to_rfc3339(), width, height, bytes: png.len() as u64 };
        let published = (|| {
            atomic_write(&path, png)?;
            atomic_write(&self.path(id, "thumb.png")?, &thumb.into_inner())?;
            // Publishing metadata last makes incomplete writes invisible to readers.
            atomic_write(&self.path(id, "json")?, &serde_json::to_vec(&entry).map_err(|e| e.to_string())?)
        })();
        if let Err(error) = published {
            // Only this unpublished record belongs to this failed operation.
            for suffix in ["png", "thumb.png"] { let _ = fs::remove_file(self.path(id, suffix)?); }
            return Err(error);
        }
        self.prune(max_records, max_bytes)?;
        Ok(entry)
    }

    fn prune(&self, max_records: usize, max_bytes: u64) -> Result<(), String> {
        let mut total = 0u64;
        for (index, record) in self.list()?.into_iter().enumerate() {
            total = total.saturating_add(record.bytes);
            if index >= max_records || total > max_bytes { self.delete(&record.id)?; }
        }
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        for suffix in ["json", "png", "thumb.png"] {
            match fs::remove_file(self.path(id, suffix)?) {
                Ok(()) => {},
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                Err(error) => return Err(error.to_string()),
            }
        }
        Ok(())
    }

    pub fn clear(&self) -> Result<(), String> {
        if !self.root.exists() { return Ok(()); }
        let mut ids = std::collections::HashSet::new();
        for file in fs::read_dir(&self.root).map_err(|e| e.to_string())? {
            let file = file.map_err(|e| e.to_string())?;
            let name = file.file_name();
            let Some(name) = name.to_str() else { continue; };
            let id = name.strip_suffix(".thumb.png").or_else(|| name.strip_suffix(".png")).or_else(|| name.strip_suffix(".json"));
            if let Some(id) = id.filter(|id| self.path(id, "png").is_ok()) { ids.insert(id.to_string()); }
        }
        // Include interrupted writes/deletes without touching arbitrary files in this directory.
        for id in ids { self.delete(&id)?; }
        Ok(())
    }
}

fn regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png() -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(320, 120, image::Rgba([10, 50, 80, 255])).write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    #[test]
    fn history_reopens_exact_pixels_thumbnail_and_idempotent_session() {
        let temp = tempfile::tempdir().unwrap();
        let store = HistoryStore::new(temp.path().join("history"));
        let id = ulid::Ulid::new().to_string();
        let data = png();
        store.save(&id, &data, 320, 120).unwrap();
        store.save(&id, &data, 320, 120).unwrap();
        let reopened = HistoryStore::new(temp.path().join("history"));
        assert_eq!(reopened.list().unwrap().len(), 1);
        assert_eq!(reopened.image(&id, false).unwrap(), data);
        let thumb = image::load_from_memory(&reopened.image(&id, true).unwrap()).unwrap();
        assert_eq!((thumb.width(), thumb.height()), (240, 90));
    }

    #[test]
    fn retention_and_clear_only_touch_owned_history() {
        let temp = tempfile::tempdir().unwrap();
        let store = HistoryStore::new(temp.path().join("history"));
        let asset = temp.path().join("library.png");
        fs::write(&asset, png()).unwrap();
        for n in 1..=3 { store.save_with_limits(&ulid::Ulid::from(n as u128).to_string(), &png(), 320, 120, 2, MAX_BYTES).unwrap(); }
        let entries = store.list().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, ulid::Ulid::from(3u128).to_string());
        assert!(store.image(&ulid::Ulid::from(1u128).to_string(), false).is_err());
        store.clear().unwrap();
        store.clear().unwrap();
        assert!(store.list().unwrap().is_empty());
        assert_eq!(fs::read(asset).unwrap(), png());
    }

    #[test]
    fn invalid_ids_incomplete_writes_and_size_limits_are_safe() {
        let temp = tempfile::tempdir().unwrap();
        let store = HistoryStore::new(temp.path().to_path_buf());
        assert!(store.image("../private", false).is_err());
        assert!(store.delete("../private").is_err());
        let id = ulid::Ulid::new().to_string();
        fs::write(store.path(&id, "png").unwrap(), png()).unwrap();
        assert!(store.list().unwrap().is_empty());
        assert!(store.image(&id, false).is_err());
        assert!(store.save_with_limits(&id, &png(), 320, 120, 50, 1).is_err());
        store.save(&id, &png(), 320, 120).unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
    }

    #[test]
    fn failed_metadata_publish_removes_unpublished_pixels() {
        let temp = tempfile::tempdir().unwrap();
        let store = HistoryStore::new(temp.path().to_path_buf());
        let id = ulid::Ulid::new().to_string();
        fs::create_dir(store.path(&id, "json").unwrap()).unwrap();
        assert!(store.save(&id, &png(), 320, 120).is_err());
        assert!(!store.path(&id, "png").unwrap().exists());
        assert!(!store.path(&id, "thumb.png").unwrap().exists());
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn retention_also_obeys_pixel_byte_budget() {
        let temp = tempfile::tempdir().unwrap();
        let store = HistoryStore::new(temp.path().to_path_buf());
        let data = png();
        for n in 1..=2 {
            store.save_with_limits(&ulid::Ulid::from(n as u128).to_string(), &data, 320, 120, 50, data.len() as u64 + 1).unwrap();
        }
        assert_eq!(store.list().unwrap().len(), 1);
        assert_eq!(store.list().unwrap()[0].id, ulid::Ulid::from(2u128).to_string());
    }

    #[test]
    fn clear_removes_owned_orphans_but_not_other_files() {
        let temp = tempfile::tempdir().unwrap();
        let store = HistoryStore::new(temp.path().to_path_buf());
        let id = ulid::Ulid::new().to_string();
        fs::write(store.path(&id, "png").unwrap(), png()).unwrap();
        fs::write(store.path(&id, "thumb.png").unwrap(), png()).unwrap();
        let unrelated = temp.path().join("user-image.png");
        fs::write(&unrelated, png()).unwrap();
        store.clear().unwrap();
        assert!(!store.path(&id, "png").unwrap().exists());
        assert!(!store.path(&id, "thumb.png").unwrap().exists());
        assert!(unrelated.exists());
    }
}
