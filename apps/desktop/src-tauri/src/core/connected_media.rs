//! Cheap connection indexing; expensive media work runs only for a requested preview.
use super::*;

pub(crate) const DEFERRED_FINGERPRINT_BYTES: u64 = 32 * 1024 * 1024;

pub(crate) struct ConnectedFileFingerprint {
    pub(crate) path: PathBuf,
    metadata: fs::Metadata,
    pub(crate) version: String,
    pub(crate) hash: String,
    ext: String,
    width: u32,
    height: u32,
    duration: f64,
}

fn indexed_mtime(metadata: &fs::Metadata) -> Option<i64> {
    metadata.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok().map(|time| time.as_secs() as i64)
}

// Windows canonicalization adds a verbatim prefix; older assets keep ordinary
// drive/UNC paths. Match both spellings without rewriting their saved paths.
pub(crate) fn connection_path_spellings(source: &Path, canonical: &Path) -> [String; 3] {
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
    pub(crate) fn current_preview_changes(&self, values: Vec<(Asset, String)>) -> AppResult<Vec<(Asset, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut query = conn.prepare("SELECT EXISTS(SELECT 1 FROM assets a LEFT JOIN external_assets e ON e.asset_id=a.id LEFT JOIN creative_file_fingerprints f ON f.asset_id=a.id WHERE a.id=?1 AND CASE WHEN a.size>33554432 AND a.connected_scan_key IS NOT NULL THEN 'preview:'||a.connected_scan_key ELSE COALESCE(e.fingerprint,f.sha256) END=?2 AND a.thumb_path IS ?3 AND a.store_path IS ?4 AND a.file_mtime IS ?5 AND a.size IS ?6)")?;
        let mut current = Vec::with_capacity(values.len());
        for (asset, version) in values {
            if query.query_row(params![asset.id,version,asset.thumb_path,asset.store_path,asset.file_mtime,asset.size], |row| row.get::<_, bool>(0))? {
                current.push((asset, version));
            }
        }
        Ok(current)
    }
    pub(crate) fn prepare_connected_file(source: &Path) -> AppResult<ConnectedFileFingerprint> {
        let path = original(source)?;
        let metadata = fs::metadata(&path)?;
        Self::prepare_connected_path(path, metadata, true)
    }

    pub(crate) fn prepare_connected_path(path: PathBuf, metadata: fs::Metadata, read_hash: bool) -> AppResult<ConnectedFileFingerprint> {
        let started = std::time::Instant::now();
        let version = preview_key(&path, &metadata)?;
        let hash = if read_hash { fingerprint(&path)? } else { String::new() };
        let ext = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
        let (width, height, duration) = if video_path(&path) {
            crate::media::probe::probe_connected_video_header(&path, &ext, metadata.len())
                .map_or((0, 0, 0.0), |meta| (meta.width, meta.height, meta.duration))
        } else if audio_path(&path) || crate::core::text_documents::text_path(&path) || crate::media::heic::is_path(&path) {
            (0, 0, 0.0)
        } else {
            let meta = crate::media::probe::probe(&path)?;
            if !matches!(ext.as_str(), "svg" | "psd") && (meta.width == 0 || meta.height == 0) {
                return Err(invalid("无法读取这张图片，请确认文件完整"));
            }
            (meta.width, meta.height, 0.0)
        };
        if preview_key(&path, &fs::metadata(&path)?)? != version {
            return Err(invalid("文件正在变化，请稍后重试"));
        }
        if read_hash {
            tracing::debug!(stage="connection_fingerprint", elapsed_ms=started.elapsed().as_millis() as u64, bytes=metadata.len());
        }
        Ok(ConnectedFileFingerprint { path, metadata, version, hash, ext, width, height, duration })
    }
    pub fn connected_preview_pending(&self, source: &Path, preview: &str) -> AppResult<bool> {
        let path = original(source)?;
        let names = connection_path_spellings(source, &path);
        Ok(self.conn.lock().unwrap().query_row(
            "SELECT EXISTS(SELECT 1 FROM assets a LEFT JOIN external_assets e ON e.asset_id=a.id LEFT JOIN creative_file_fingerprints f ON f.asset_id=a.id WHERE a.store_path IN (?1,?2,?3) AND COALESCE(e.fingerprint,f.sha256) IS NOT NULL AND (a.thumb_path IS NULL OR a.thumb_path<>?4 OR (lower(a.ext) IN ('png','jpg','jpeg','webp','gif','bmp','tif','tiff','heic','heif') AND (a.phash IS NULL OR a.colors IS NULL)) OR (lower(a.ext) IN ('mp4','mov','m4v','webm','mkv','avi') AND COALESCE(a.duration,0)<=0)))",
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
        self.index_prepared_connected_file(paths, source, preferred_id, Self::prepare_connected_file(source)?)
    }

    pub(crate) fn index_prepared_connected_file(
        &self, paths: &LibraryPaths, source: &Path, preferred_id: Option<&str>,
        prepared: ConnectedFileFingerprint,
    ) -> AppResult<Asset> {
        if original(source)? != prepared.path {
            return Err(invalid("文件正在变化，请稍后重试"));
        }
        let images = fs::canonicalize(&paths.images)?;
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let id = Self::index_connected_in(&tx, &images, source, preferred_id, &prepared)?;
        tx.commit()?;
        drop(conn);
        self.get_asset(&id)?.ok_or_else(|| invalid("素材已不存在"))
    }

    pub(crate) fn index_connected_in(
        tx: &rusqlite::Connection, images: &Path, source: &Path, preferred_id: Option<&str>,
        prepared: &ConnectedFileFingerprint,
    ) -> AppResult<String> {
        let ConnectedFileFingerprint { path, metadata, version, hash, ext, width, height, duration } = prepared;
        let names = connection_path_spellings(source, &path);
        let mtime = indexed_mtime(metadata);
        let direct_thumb = (ext == "svg").then(|| path.to_string_lossy().into_owned());
        let current = fs::symlink_metadata(path)?;
        if !current.is_file() || preview_key(&path, &current)? != *version {
            return Err(invalid("文件正在变化，请稍后重试"));
        }
        // Keep a known entry/reference identity; otherwise preserve registration
        // order across query-plan changes when historical path aliases coexist.
        let existing: Option<(String, Option<String>, bool, Option<String>)> = tx.query_row(
            "SELECT a.id,COALESCE(e.fingerprint,f.sha256),e.asset_id IS NOT NULL,a.connected_scan_key FROM assets a LEFT JOIN external_assets e ON e.asset_id=a.id LEFT JOIN creative_file_fingerprints f ON f.asset_id=a.id WHERE a.store_path IN (?1,?2,?3) ORDER BY a.id=?4 DESC,a.rowid LIMIT 1",
            params![names[0],names[1],names[2],preferred_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional()?;
        let mut retain_hash = false;
        let id = if let Some((id, expected, external, old_key)) = existing {
            if hash.is_empty() && !external { return Err(invalid("库内原件需要完整校验")); }
            restore_present_original(&tx, &id, &path, Some(&hash))?;
            let revision_changed = if hash.is_empty() { old_key.as_deref() != Some(version) }
                else { expected.as_deref().is_some_and(|value| !value.is_empty() && value != hash)
                    || (video_path(path) && old_key.as_deref().is_some_and(|key| key != version)) };
            retain_hash = hash.is_empty() && !revision_changed && expected.as_ref().is_some_and(|value| !value.is_empty());
            if revision_changed {
                // Creative records belong to the stable asset, not to one content revision.
                // Only derived visual data is invalidated; manual text/analysis stays intact.
                tx.execute("UPDATE assets SET thumb_path=?4,width=?2,height=?3,duration=?5,phash=NULL,colors=NULL WHERE id=?1", params![id,width,height,direct_thumb,duration])?;
                tx.execute("DELETE FROM asset_colors WHERE asset_id=?1", [&id])?;
                if !audio_path(&path) && !crate::core::text_documents::text_path(&path) {
                    crate::core::local_classification::data::requeue_changed_connected_asset(&tx, &id)?;
                }
            }
            tx.execute(
                "UPDATE assets SET size=?2,file_mtime=?3,ext=?4,library_hidden=0,connected_scan_key=?5,width=CASE WHEN ?8>0 THEN ?6 ELSE width END,height=CASE WHEN ?8>0 THEN ?7 ELSE height END,duration=CASE WHEN ?8>0 THEN ?8 ELSE duration END WHERE id=?1",
                params![id, metadata.len() as i64, mtime, ext, version, width, height, duration],
            )?;
            if external && !retain_hash {
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
            if path.starts_with(images) {
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
            tx.execute("INSERT INTO assets(id,name,ext,origin_path,store_path,size,width,height,duration,file_mtime,source,library_hidden,created_at,thumb_path,connected_scan_key) VALUES(?1,?2,?3,?4,?4,?5,?6,?7,?8,?9,'external',0,?10,?11,?12)",
                params![id,path.file_stem().unwrap_or_default().to_string_lossy(),ext,path.to_string_lossy(),metadata.len() as i64,width,height,duration,mtime,chrono::Utc::now().timestamp(),direct_thumb,version])?;
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
        if hash.is_empty() && !retain_hash {
            tx.execute("DELETE FROM creative_file_fingerprints WHERE asset_id=?1", [&id])?;
        } else if !hash.is_empty() {
            Self::write_connected_fingerprint(tx, &id, hash, metadata.len() as i64, mtime)?;
        }
        Ok(id)
    }

    fn write_connected_fingerprint(conn: &rusqlite::Connection, id: &str, hash: &str, size: i64, mtime: Option<i64>) -> AppResult<()> {
        conn.execute("INSERT INTO creative_file_fingerprints(asset_id,sha256,asset_size,asset_mtime) VALUES(?1,?2,?3,?4) ON CONFLICT(asset_id) DO UPDATE SET sha256=excluded.sha256,asset_size=excluded.asset_size,asset_mtime=excluded.asset_mtime", params![id,hash,size,mtime])?;
        Ok(())
    }

    pub(crate) fn pending_connected_fingerprints(&self, after: &str) -> AppResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut query = conn.prepare("SELECT e.asset_id FROM external_assets e JOIN assets a ON a.id=e.asset_id
            WHERE e.fingerprint='' AND a.connected_scan_key IS NOT NULL AND e.asset_id>?1
            AND EXISTS(SELECT 1 FROM connected_entries c JOIN connected_folders f ON f.id=c.folder_id
                JOIN connected_roots r ON r.id=f.root_id WHERE c.asset_id=e.asset_id AND c.is_reference=0
                AND c.available=1 AND f.available=1 AND r.available=1 AND r.scanning=0)
            ORDER BY e.asset_id LIMIT 32")?;
        let rows = query.query_map([after], |row| row.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn pending_fingerprint_source(&self, id: &str) -> AppResult<Option<(String, String)>> {
        Ok(self.conn.lock().unwrap().query_row(
            "SELECT a.store_path,a.connected_scan_key FROM assets a JOIN external_assets e ON e.asset_id=a.id
            WHERE a.id=?1 AND e.fingerprint='' AND a.connected_scan_key IS NOT NULL
            AND NOT EXISTS(SELECT 1 FROM removed_missing_asset_originals WHERE asset_id=a.id)
            AND NOT EXISTS(SELECT 1 FROM trashed_asset_originals WHERE asset_id=a.id)", [id],
            |row| Ok((row.get(0)?,row.get(1)?)),
        ).optional()?)
    }

    pub(crate) fn complete_connected_fingerprint(&self, id: &str) -> AppResult<()> {
        let Some((stored, key)) = self.pending_fingerprint_source(id)? else { return Ok(()); };
        let canonical = crate::core::folder_connections::registered_path_spelling(Path::new(&stored));
        let path = canonical.as_path();
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_file() || preview_key(path, &metadata)? != key { return Err(invalid("文件正在变化，请刷新后重试")); }
        let hash = fingerprint(path)?;
        self.register_connected_fingerprint(id, path, &key, &hash)
    }

    pub(crate) fn connected_source_matches(&self, id: &str, path: &Path) -> AppResult<bool> {
        let key: Option<String> = self.conn.lock().unwrap().query_row(
            "SELECT connected_scan_key FROM assets WHERE id=?1", [id], |row| row.get(0),
        ).optional()?.flatten();
        let canonical = crate::core::folder_connections::registered_path_spelling(path);
        Ok(key.is_none_or(|key| fs::symlink_metadata(&canonical).is_ok_and(|meta| meta.is_file()
            && preview_key(&canonical, &meta).is_ok_and(|version| version == key))))
    }

    /// Keep the measured SHA when a strict operation already read the entire file.
    pub(crate) fn register_connected_fingerprint(&self, id: &str, path: &Path, measured_key: &str, hash: &str) -> AppResult<()> {
        let Some((stored, key)) = self.pending_fingerprint_source(id)? else { return Ok(()); };
        let canonical = crate::core::folder_connections::registered_path_spelling(Path::new(&stored));
        let registered = canonical.as_path();
        let metadata = fs::symlink_metadata(registered)?;
        if !metadata.is_file() || measured_key != key || canonical != crate::core::folder_connections::registered_path_spelling(path)
            || preview_key(registered, &metadata)? != key {
            return Err(invalid("文件正在变化，请刷新后重试"));
        }
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        if preview_key(registered, &fs::symlink_metadata(registered)?)? != key { return Err(invalid("文件正在变化，请刷新后重试")); }
        let updated = tx.execute("UPDATE external_assets SET fingerprint=?2 WHERE asset_id=?1 AND fingerprint=''
            AND EXISTS(SELECT 1 FROM assets WHERE id=?1 AND store_path=?3 AND connected_scan_key=?4)
            AND NOT EXISTS(SELECT 1 FROM removed_missing_asset_originals WHERE asset_id=?1)
            AND NOT EXISTS(SELECT 1 FROM trashed_asset_originals WHERE asset_id=?1)", params![id,hash,stored,key])?;
        if updated > 0 {
            Self::write_connected_fingerprint(&tx, id, hash, metadata.len() as i64, indexed_mtime(&metadata))?;
        } else {
            let same: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM assets a JOIN external_assets e ON e.asset_id=a.id WHERE a.id=?1 AND e.fingerprint=?2 AND a.store_path=?3 AND a.connected_scan_key=?4)",params![id,hash,stored,key], |row| row.get(0))?;
            if !same { return Err(invalid("文件正在变化，请刷新后重试")); }
        }
        tx.commit()?;
        Ok(())
    }

    /// Complete only an indexed original whose current preview is requested. Cache hits
    /// with a persisted thumbnail do no decoding or hashing. Stale requests never write.
    pub fn complete_connected_preview(
        &self,
        paths: &LibraryPaths,
        source: &Path,
        preview: &str,
    ) -> AppResult<Option<Asset>> {
        Ok(self.complete_connected_preview_versioned(paths, source, preview)?.map(|(asset, _)| asset))
    }

    pub(crate) fn complete_connected_preview_versioned(
        &self, paths: &LibraryPaths, source: &Path, preview: &str,
    ) -> AppResult<Option<(Asset, String)>> {
        let path = original(source)?;
        let names = connection_path_spellings(source, &path);
        let row = self.conn.lock().unwrap().query_row(
            "SELECT a.id,COALESCE(e.fingerprint,f.sha256),a.thumb_path,a.store_path,a.phash,a.colors,
                a.size,a.file_mtime,a.connected_scan_key,e.fingerprint,f.sha256,a.width,a.height,COALESCE(a.duration,0)
             FROM assets a LEFT JOIN external_assets e ON e.asset_id=a.id LEFT JOIN creative_file_fingerprints f ON f.asset_id=a.id
             WHERE a.store_path IN (?1,?2,?3) AND COALESCE(e.fingerprint,f.sha256) IS NOT NULL ORDER BY a.rowid LIMIT 1",
            params![names[0],names[1],names[2]], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,String>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,Option<i64>>(6)?,r.get::<_,Option<i64>>(7)?,r.get::<_,Option<String>>(8)?,r.get::<_,Option<String>>(9)?,r.get::<_,Option<String>>(10)?,r.get::<_,Option<u32>>(11)?,r.get::<_,Option<u32>>(12)?,r.get::<_,f64>(13)?))).optional()?;
        let Some((id, expected, old_thumb, stored_path, old_phash, old_colors, size, mtime, scan_key, external_hash, creative_hash, width, height, duration)) = row else {
            return Ok(None);
        };
        let video = video_path(&path);
        let auxiliary = !video && !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("svg") || ext.eq_ignore_ascii_case("psd"));
        if old_thumb.as_deref() == Some(preview) && (!auxiliary || (old_phash.is_some() && old_colors.is_some()))
            && (!video || duration > 0.0) {
            return Ok(None);
        }
        let metadata = fs::metadata(&path)?;
        let version = preview_key(&path, &metadata)?;
        let current_preview = paths
            .root
            .join("external-previews")
            .join(format!("{version}.jpg"));
        if Path::new(preview) != current_preview
            || !current_preview.is_file()
            || size.is_some_and(|size| size != metadata.len() as i64)
            || (mtime.is_some() && mtime != indexed_mtime(&metadata))
            || scan_key.as_ref().is_some_and(|key| *key != version)
            || matches!((&external_hash,&creative_hash), (Some(a),Some(b)) if a != b && scan_key.is_some())
        {
            return Err(invalid("文件正在变化，请刷新后重试缩略图"));
        }
        let (width, height, duration, phash, colors) = if video {
            let meta = if duration > 0.0 && width.unwrap_or(0) > 0 && height.unwrap_or(0) > 0 { None }
                else { fs::read(current_preview.with_extension("json")).ok().and_then(|bytes| serde_json::from_slice::<crate::media::probe::ProbeMeta>(&bytes).ok())
                    .or_else(|| crate::media::probe::probe_connected_video_fallback(&path).ok()) };
            if meta.is_none() && duration <= 0.0 && old_thumb.as_deref() == Some(preview) { return Ok(None); }
            let (width,height,duration) = meta.map_or((width.unwrap_or(0),height.unwrap_or(0),duration), |meta| (meta.width,meta.height,meta.duration));
            (width,height,duration,None,None)
        } else {
            let input = compatible_image(paths, &path)?;
            let meta = crate::media::probe::probe(&input)?;
            let (phash, colors) = match image::open(&input) {
                Ok(image) => (Some(crate::media::phash::compute_from_image(&image)),
                    serde_json::to_string(&crate::media::color::extract_from_image(&image, 5)).ok()),
                Err(_) if !auxiliary => (None, None),
                Err(_) => return Err(invalid("缩略图资料暂时无法完成，请稍后重试")),
            };
            (meta.width,meta.height,meta.duration,phash,colors)
        };
        if preview_key(&path, &fs::metadata(&path)?)? != version {
            return Err(invalid("文件正在变化，请刷新后重试缩略图"));
        }
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        if preview_key(&path, &fs::metadata(&path)?)? != version {
            return Err(invalid("文件正在变化，请刷新后重试缩略图"));
        }
        let large = size.is_some_and(|size| size > DEFERRED_FINGERPRINT_BYTES as i64) && scan_key.is_some();
        let changed = tx.execute("UPDATE assets SET thumb_path=?2,width=?3,height=?4,duration=?5,phash=?6,colors=?7
            WHERE id=?1 AND store_path=?8 AND size IS ?10 AND file_mtime IS ?11 AND connected_scan_key IS ?12
            AND (?13 OR COALESCE((SELECT fingerprint FROM external_assets WHERE asset_id=?1),(SELECT sha256 FROM creative_file_fingerprints WHERE asset_id=?1))=?9)
            AND NOT EXISTS(SELECT 1 FROM removed_missing_asset_originals WHERE asset_id=?1)
            AND NOT EXISTS(SELECT 1 FROM trashed_asset_originals WHERE asset_id=?1)",
            params![id,preview,width,height,duration,phash,colors,stored_path,expected,size,mtime,scan_key,large])?;
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
        if video && width > 0 && height > 0 && duration > 0.0 {
            // The same revision now has durable metadata. Leave the sidecar available
            // until commit so a failed completion can retry without probing again.
            let _ = fs::remove_file(current_preview.with_extension("json"));
        }
        Ok(self.get_asset(&id)?.filter(|asset| asset.thumb_path.as_deref() == Some(preview))
            .map(|asset| (asset, if large { format!("preview:{version}") } else { expected })))
    }
}

#[cfg(test)]
#[path = "connected_media_tests.rs"]
mod tests;
