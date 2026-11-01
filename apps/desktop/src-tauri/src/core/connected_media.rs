//! Cheap connection indexing; expensive media work runs only for a requested preview.
use super::*;

// Windows canonicalization adds a verbatim prefix; older assets keep ordinary
// drive/UNC paths. Match both spellings without rewriting their saved paths.
fn connection_path_spellings(source: &Path, canonical: &Path) -> [String; 3] {
    let canonical = canonical.to_string_lossy().into_owned();
    #[cfg(target_os = "windows")]
    let ordinary = canonical
        .strip_prefix(r"\\?\UNC\")
        .map(|suffix| format!(r"\\{suffix}"))
        .or_else(|| canonical.strip_prefix(r"\\?\").map(str::to_owned))
        .unwrap_or_else(|| canonical.clone());
    #[cfg(not(target_os = "windows"))]
    let ordinary = canonical.clone();
    [canonical, source.to_string_lossy().into_owned(), ordinary]
}

impl Database {
    pub fn connected_preview_pending(&self, source: &Path, preview: &str) -> AppResult<bool> {
        let path = original(source)?;
        let names = connection_path_spellings(source, &path);
        Ok(self.conn.lock().unwrap().query_row(
            "SELECT EXISTS(SELECT 1 FROM assets a LEFT JOIN external_assets e ON e.asset_id=a.id LEFT JOIN creative_file_fingerprints f ON f.asset_id=a.id WHERE a.store_path IN (?1,?2,?3) AND COALESCE(e.fingerprint,f.sha256) IS NOT NULL AND (a.thumb_path IS NULL OR a.thumb_path<>?4))",
            params![names[0],names[1],names[2],preview], |row| row.get(0))?)
    }

    pub fn ensure_connected_preview(
        &self,
        paths: &LibraryPaths,
        id: &str,
    ) -> AppResult<Option<Asset>> {
        let Some(asset) = self.get_asset(id)? else {
            return Ok(None);
        };
        let Some(source) = asset.store_path.as_deref() else {
            return Ok(Some(asset));
        };
        let preview = preview_with_index(paths, Some(self), Path::new(source))?;
        match self.complete_connected_preview(paths, Path::new(source), &preview)? {
            Some(value) => Ok(Some(value)),
            None => self.get_asset(id),
        }
    }

    pub fn index_connected_file(
        &self,
        paths: &LibraryPaths,
        source: &Path,
        preferred_id: Option<&str>,
    ) -> AppResult<Asset> {
        let path = original(source)?;
        let names = connection_path_spellings(source, &path);
        let metadata = fs::metadata(&path)?;
        let version = preview_key(&path, &metadata)?;
        let hash = fingerprint(&path)?;
        let ext = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        // Header reads do not render images. HEIC and video metadata are completed with
        // their requested preview, without starting decoders/processes for a whole tree.
        let dimensions = if video_path(&path) || audio_path(&path) || crate::media::heic::is_path(&path) {
            (0, 0)
        } else {
            let meta = crate::media::probe::probe(&path)?;
            if !matches!(ext.as_str(), "svg" | "psd") && (meta.width == 0 || meta.height == 0) {
                return Err(invalid("无法读取这张图片，请确认文件完整"));
            }
            (meta.width, meta.height)
        };
        if preview_key(&path, &fs::metadata(&path)?)? != version {
            return Err(invalid("文件正在变化，请稍后重试"));
        }
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|time| time.as_secs() as i64);
        // SVG is rendered directly by the browser; it needs no raster extraction.
        let direct_thumb = (ext == "svg").then(|| path.to_string_lossy().into_owned());
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let existing: Option<(String, Option<String>, bool)> = tx.query_row(
            "SELECT a.id,COALESCE(e.fingerprint,f.sha256),e.asset_id IS NOT NULL FROM assets a LEFT JOIN external_assets e ON e.asset_id=a.id LEFT JOIN creative_file_fingerprints f ON f.asset_id=a.id WHERE a.store_path IN (?1,?2,?3)",
            params![names[0],names[1],names[2]], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
        let id = if let Some((id, expected, external)) = existing {
            if expected.as_deref().is_some_and(|value| value != hash) {
                // Creative records belong to the stable asset, not to one content revision.
                // Only derived visual data is invalidated; manual text/analysis stays intact.
                tx.execute("UPDATE assets SET thumb_path=?4,width=?2,height=?3,duration=0,phash=NULL,colors=NULL WHERE id=?1", params![id,dimensions.0,dimensions.1,direct_thumb])?;
                tx.execute("DELETE FROM asset_colors WHERE asset_id=?1", [&id])?;
                if !audio_path(&path) {
                    crate::core::local_classification::data::requeue_changed_connected_asset(&tx, &id)?;
                }
            }
            tx.execute(
                "UPDATE assets SET size=?2,file_mtime=?3,ext=?4,library_hidden=0 WHERE id=?1",
                params![id, metadata.len() as i64, mtime, ext],
            )?;
            if external {
                tx.execute(
                    "UPDATE external_assets SET fingerprint=?2,library_member=1 WHERE asset_id=?1",
                    params![id, hash],
                )?;
            }
            id
        } else {
            // A historical alias may now hold another file; never silently retarget its asset.
            let aliased: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM external_asset_paths WHERE path IN (?1,?2,?3))",
                params![names[0], names[1], names[2]],
                |row| row.get(0),
            )?;
            if aliased {
                return Err(invalid("此位置已有素材引用，请先重新定位原文件"));
            }
            if path.starts_with(fs::canonicalize(&paths.images)?) {
                return Err(invalid("这是库内文件，请从素材库引用"));
            }
            let id = preferred_id
                .map(str::to_owned)
                .unwrap_or_else(|| ulid::Ulid::new().to_string());
            if tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1)",
                [&id],
                |row| row.get::<_, bool>(0),
            )? {
                return Err(invalid(
                    "分身指向的素材标识已被另一个文件占用，请重新选择原文件",
                ));
            }
            tx.execute("INSERT INTO assets(id,name,ext,origin_path,store_path,size,width,height,duration,file_mtime,source,library_hidden,created_at,thumb_path) VALUES(?1,?2,?3,?4,?4,?5,?6,?7,0,?8,'external',0,?9,?10)",
                params![id,path.file_stem().unwrap_or_default().to_string_lossy(),ext,path.to_string_lossy(),metadata.len() as i64,dimensions.0,dimensions.1,mtime,chrono::Utc::now().timestamp(),direct_thumb])?;
            tx.execute(
                "INSERT INTO external_assets(asset_id,fingerprint,library_member) VALUES(?1,?2,1)",
                params![id, hash],
            )?;
            tx.execute(
                "INSERT INTO external_asset_paths(asset_id,path) VALUES(?1,?2)",
                params![id, path.to_string_lossy()],
            )?;
            id
        };
        tx.execute("INSERT INTO creative_file_fingerprints(asset_id,sha256,asset_size,asset_mtime) VALUES(?1,?2,?3,?4) ON CONFLICT(asset_id) DO UPDATE SET sha256=excluded.sha256,asset_size=excluded.asset_size,asset_mtime=excluded.asset_mtime", params![id,hash,metadata.len() as i64,mtime])?;
        tx.commit()?;
        drop(conn);
        self.get_asset(&id)?.ok_or_else(|| invalid("素材已不存在"))
    }

    /// Complete only an indexed original whose current preview is requested. Cache hits
    /// with a persisted thumbnail do no decoding or hashing. Stale requests never write.
    pub fn complete_connected_preview(
        &self,
        paths: &LibraryPaths,
        source: &Path,
        preview: &str,
    ) -> AppResult<Option<Asset>> {
        let path = original(source)?;
        let names = connection_path_spellings(source, &path);
        let row: Option<(String, String, Option<String>, String)> = self.conn.lock().unwrap().query_row(
            "SELECT a.id,COALESCE(e.fingerprint,f.sha256),a.thumb_path,a.store_path FROM assets a LEFT JOIN external_assets e ON e.asset_id=a.id LEFT JOIN creative_file_fingerprints f ON f.asset_id=a.id WHERE a.store_path IN (?1,?2,?3) AND COALESCE(e.fingerprint,f.sha256) IS NOT NULL",
            params![names[0],names[1],names[2]], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional()?;
        let Some((id, expected, old_thumb, stored_path)) = row else {
            return Ok(None);
        };
        if old_thumb.as_deref() == Some(preview) {
            return Ok(None);
        }
        let version = preview_key(&path, &fs::metadata(&path)?)?;
        let current_preview = paths
            .root
            .join("external-previews")
            .join(format!("{version}.jpg"));
        if Path::new(preview) != current_preview
            || !current_preview.is_file()
            || fingerprint(&path)? != expected
        {
            return Err(invalid("文件正在变化，请刷新后重试缩略图"));
        }
        let input = compatible_image(paths, &path)?;
        let meta = crate::media::probe::probe(&input)?;
        let (phash, colors) = if video_path(&path) {
            (None, None)
        } else {
            (
                crate::media::phash::compute(&input).ok().flatten(),
                crate::media::color::extract(&input, 5)
                    .ok()
                    .and_then(|value| serde_json::to_string(&value).ok()),
            )
        };
        if preview_key(&path, &fs::metadata(&path)?)? != version {
            return Err(invalid("文件正在变化，请刷新后重试缩略图"));
        }
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let changed = tx.execute("UPDATE assets SET thumb_path=?2,width=?3,height=?4,duration=?5,phash=?6,colors=?7 WHERE id=?1 AND store_path=?8 AND COALESCE((SELECT fingerprint FROM external_assets WHERE asset_id=?1),(SELECT sha256 FROM creative_file_fingerprints WHERE asset_id=?1))=?9",
            params![id,preview,meta.width,meta.height,meta.duration,phash,colors,stored_path,expected])?;
        if changed == 0 {
            return Err(invalid("文件正在变化，请刷新后重试缩略图"));
        }
        tx.execute("DELETE FROM asset_colors WHERE asset_id=?1", [&id])?;
        if let Some(colors) = colors.as_deref() {
            for bucket in crate::media::color::colors_to_buckets(colors) {
                tx.execute(
                    "INSERT OR IGNORE INTO asset_colors(asset_id,bucket) VALUES(?1,?2)",
                    params![id, bucket],
                )?;
            }
        }
        tx.commit()?;
        drop(conn);
        self.get_asset(&id)
    }
}

#[cfg(test)]
#[path = "connected_media_tests.rs"]
mod tests;
