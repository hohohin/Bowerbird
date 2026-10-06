use std::{path::Path, sync::Arc};
use rusqlite::OptionalExtension;
use tauri::State;
use crate::{core::paths::LibraryPaths, db::Database, error::AppError, media};

// Waiting happens asynchronously, before entering the blocking pool or taking a DB lock.
static POSTER_QUEUE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[tauri::command]
pub async fn video_poster(
    db: State<'_, Arc<Database>>, paths: State<'_, Arc<LibraryPaths>>, source_path: String,
) -> Result<Option<String>, AppError> {
    let db = db.inner().clone();
    let paths = paths.inner().clone();
    let permit = POSTER_QUEUE.acquire().await.map_err(|e| AppError::Other(e.to_string()))?;
    tokio::task::spawn_blocking(move || {
        // Keep the slot until decoding ends, even if the requesting view goes away.
        let _permit = permit;
        ensure_poster(&db, &paths, &source_path, |source, destination| media::thumb::generate_video(source, destination, 480))
    }).await.map_err(|e| AppError::Other(e.to_string()))?
}

fn ensure_poster(
    db: &Database, paths: &LibraryPaths, source: &str,
    generate: impl FnOnce(&Path, &Path) -> Result<(), AppError>,
) -> Result<Option<String>, AppError> {
    let ext = Path::new(source).extension().and_then(|ext| ext.to_str()).unwrap_or("").to_lowercase();
    if !media::probe::is_video(&ext) { return Ok(None); }
    // Only material already in this library is eligible; the caller cannot extract arbitrary files.
    let asset: Option<(String, Option<String>)> = {
        let conn = db.conn.lock().unwrap();
        conn.query_row("SELECT id, thumb_path FROM assets WHERE store_path = ?1 LIMIT 1", [source],
            |row| Ok((row.get(0)?, row.get(1)?))).optional()?
    };
    let Some((id, thumbnail)) = asset else { return Ok(None); };
    if let Some(thumbnail) = thumbnail.filter(|value| Path::new(value).is_file()) { return Ok(Some(thumbnail)); }
    let destination = paths.thumb_path(&id);
    if !destination.is_file() { generate(Path::new(source), &destination)?; }
    let destination_string = destination.to_string_lossy().into_owned();
    // Extraction holds no database lock. Do not attach its result to a deleted/renamed source.
    let changed = db.conn.lock().unwrap().execute(
        "UPDATE assets SET thumb_path = ?1 WHERE id = ?2 AND store_path = ?3",
        rusqlite::params![destination_string, id, source],
    )?;
    Ok((changed == 1).then_some(destination_string))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn video_poster_repairs_once_without_holding_database_lock() {
        let temp = std::env::temp_dir().join(format!("bowerbird-poster-test-{}", ulid::Ulid::new()));
        let paths = LibraryPaths::init(temp.clone()).unwrap();
        let db = Database::open_in_memory().unwrap();
        db.conn.lock().unwrap().execute_batch("CREATE TABLE assets (id TEXT, store_path TEXT, thumb_path TEXT); INSERT INTO assets VALUES ('video', '/test/clip.mp4', NULL);").unwrap();
        let poster = ensure_poster(&db, &paths, "/test/clip.mp4", |_, path| {
            assert!(db.conn.try_lock().is_ok(), "decoder must not hold the shared DB lock");
            std::fs::create_dir_all(path.parent().unwrap())?;
            image::RgbImage::new(8, 4).save(path)?;
            Ok(())
        }).unwrap().unwrap();
        assert!(Path::new(&poster).is_file());
        assert_eq!(ensure_poster(&db, &paths, "/test/clip.mp4", |_, _| panic!("cache was not reused")).unwrap(), Some(poster));
        assert_eq!(ensure_poster(&db, &paths, "/unregistered.mp4", |_, _| panic!("unregistered file")).unwrap(), None);
        std::fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn video_poster_does_not_reattach_a_deleted_asset() {
        let temp = std::env::temp_dir().join(format!("bowerbird-poster-test-{}", ulid::Ulid::new()));
        let paths = LibraryPaths::init(temp.clone()).unwrap();
        let db = Database::open_in_memory().unwrap();
        db.conn.lock().unwrap().execute_batch("CREATE TABLE assets (id TEXT, store_path TEXT, thumb_path TEXT); INSERT INTO assets VALUES ('video', '/test/clip.mp4', NULL);").unwrap();
        assert_eq!(ensure_poster(&db, &paths, "/test/clip.mp4", |_, _| {
            db.conn.lock().unwrap().execute("DELETE FROM assets", [])?;
            Ok(())
        }).unwrap(), None);
        std::fs::remove_dir_all(temp).unwrap();
    }
}
