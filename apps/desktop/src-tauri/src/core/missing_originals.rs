//! Bounded reconciliation of missing originals; never a filesystem deletion task.
use crate::{
    core::{external_files, material_catalog::catalog_visibility, paths::LibraryPaths},
    db::Database,
    error::AppResult,
};
use std::{
    collections::HashMap,
    path::Path,
    time::{Duration, Instant},
};

const BATCH_SIZE: usize = 128;
const CONFIRM_AFTER: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct MissingOriginalSweep {
    after: Option<String>,
    pending: HashMap<String, Observation>,
    round: u64,
}
struct Observation {
    signature: (String, String, i64, u32),
    first: Instant,
    round: u64,
}
struct Candidate {
    id: String,
    path: String,
    fingerprint: String,
    created: i64,
    removed: bool,
}

#[derive(Default, Debug)]
pub struct MissingOriginalBatch {
    pub checked: usize,
    pub removed: usize,
    pub restored: usize,
    pub more: bool,
    pub pending: bool,
}

impl MissingOriginalSweep {
    pub fn check_batch(
        &mut self,
        db: &Database,
        paths: &LibraryPaths,
        now: Instant,
    ) -> AppResult<MissingOriginalBatch> {
        let mut rows = candidates(db, self.after.as_deref())?;
        let extra = rows.len() > BATCH_SIZE;
        rows.truncate(BATCH_SIZE);
        let mut result = MissingOriginalBatch::default();
        let mut probe = LocalProbe::default();
        for row in &rows {
            result.checked += 1;
            self.after = Some(row.id.clone());
            if self.check_candidate(db, paths, now, row, &mut probe, &mut result) {
                break;
            }
        }
        result.more = extra || result.checked < rows.len();
        if !result.more {
            self.after = None;
            self.pending
                .retain(|_, observation| observation.round == self.round);
            self.round = self.round.wrapping_add(1);
        }
        result.pending = !self.pending.is_empty();
        Ok(result)
    }
    fn check_candidate(
        &mut self,
        db: &Database,
        paths: &LibraryPaths,
        now: Instant,
        row: &Candidate,
        probe: &mut LocalProbe,
        result: &mut MissingOriginalBatch,
    ) -> bool {
        match probe.check(Path::new(&row.path)) {
            PathState::Present if row.removed => {
                self.pending.remove(&row.id);
                match restore_candidate(db, paths, row) {
                    Ok((restored, indexed)) => {
                        result.restored += restored;
                        return indexed;
                    }
                    Err(error) => {
                        tracing::debug!("missing original restoration: {error}");
                        return true;
                    }
                }
            }
            PathState::Missing(volume) if !row.removed => {
                if self.confirmed(row, volume, now) {
                    match clean_candidate(db, row, volume) {
                        Ok(removed) => {
                            result.removed += removed;
                            self.pending.remove(&row.id);
                        }
                        Err(error) => tracing::debug!("missing original cleanup: {error}"),
                    }
                }
            }
            _ => {
                self.pending.remove(&row.id);
            }
        }
        false
    }
    fn confirmed(&mut self, row: &Candidate, volume: u32, now: Instant) -> bool {
        let signature = (
            row.path.clone(),
            row.fingerprint.clone(),
            row.created,
            volume,
        );
        let observed = self
            .pending
            .entry(row.id.clone())
            .or_insert_with(|| Observation {
                signature: signature.clone(),
                first: now,
                round: self.round,
            });
        if observed.signature != signature {
            observed.signature = signature;
            observed.first = now;
        }
        observed.round = self.round;
        now.saturating_duration_since(observed.first) >= CONFIRM_AFTER
    }
}

fn candidates(db: &Database, after: Option<&str>) -> AppResult<Vec<Candidate>> {
    let global = catalog_visibility(false);
    let project = catalog_visibility(true);
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare(&format!("SELECT a.id,a.store_path,COALESCE(e.fingerprint,f.sha256,''),COALESCE(a.created_at,0),m.asset_id IS NOT NULL
        FROM assets a LEFT JOIN external_assets e ON e.asset_id=a.id LEFT JOIN creative_file_fingerprints f ON f.asset_id=a.id
        LEFT JOIN removed_missing_asset_originals m ON m.asset_id=a.id
        WHERE a.id>?1 AND a.store_path IS NOT NULL
        AND (m.asset_id IS NOT NULL OR ({global}) OR ({project} AND a.library_hidden=0 AND EXISTS(SELECT 1 FROM project_assets p WHERE p.asset_id=a.id)))
        ORDER BY a.id LIMIT ?2"))?;
    let rows = stmt
        .query_map(
            rusqlite::params![after.unwrap_or(""), BATCH_SIZE as i64 + 1],
            |r| {
                Ok(Candidate {
                    id: r.get(0)?,
                    path: r.get(1)?,
                    fingerprint: r.get(2)?,
                    created: r.get(3)?,
                    removed: r.get(4)?,
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
fn clean_candidate(db: &Database, candidate: &Candidate, volume: u32) -> AppResult<usize> {
    // Recheck the volume outside the lock. The shared transaction then checks exact identity
    // and NotFound again; this API has no route to a filesystem deletion callback.
    if !matches!(LocalProbe::default().check(Path::new(&candidate.path)), PathState::Missing(current) if current == volume)
    {
        return Ok(0);
    }
    if db.original_under_offline_connection(Path::new(&candidate.path))? {
        return Ok(0);
    }
    let originals = db.preview_asset_originals(std::slice::from_ref(&candidate.id))?;
    let original = &originals[0];
    if !original.missing
        || original.path != candidate.path
        || original.fingerprint != candidate.fingerprint
    {
        return Ok(0);
    }
    db.cleanup_missing_original(original)
}
fn marked_at_path(db: &Database, names: &[String; 3]) -> AppResult<usize> {
    Ok(db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM removed_missing_asset_originals m JOIN assets a ON a.id=m.asset_id WHERE a.store_path IN (?1,?2,?3)", rusqlite::params![names[0],names[1],names[2]], |row| row.get(0))?)
}
fn has_visible_identity(db: &Database, id: &str, names: &[String; 3]) -> AppResult<bool> {
    let visible = catalog_visibility(false);
    Ok(db.conn.lock().unwrap().query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM assets a WHERE a.id<>?4 AND a.store_path IN (?1,?2,?3) AND {visible})"),
        rusqlite::params![names[0],names[1],names[2],id], |r| r.get(0))?)
}
fn restore_candidate(
    db: &Database,
    paths: &LibraryPaths,
    candidate: &Candidate,
) -> AppResult<(usize, bool)> {
    let canonical = std::fs::canonicalize(&candidate.path)?;
    let names = external_files::connection_path_spellings(Path::new(&candidate.path), &canonical);
    // One verified visible identity is sufficient; do not repeatedly hash legacy duplicates.
    if has_visible_identity(db, &candidate.id, &names)? {
        return Ok((0, false));
    }
    let originals = db.preview_asset_originals(std::slice::from_ref(&candidate.id))?;
    let original = &originals[0];
    if original.missing || Path::new(&original.path) != canonical {
        return Ok((0, true));
    }
    let before = marked_at_path(db, &names)?;
    // Preview verifies the registered fingerprint before indexing can accept changed content.
    db.index_connected_file(paths, &canonical, None)?;
    Ok((before.saturating_sub(marked_at_path(db, &names)?), true))
}

enum PathState {
    Present,
    Missing(u32),
    Unknown,
}
#[derive(Default)]
struct LocalProbe {
    #[cfg(target_os = "windows")]
    volumes: HashMap<u8, Option<u32>>,
}
impl LocalProbe {
    #[cfg(not(target_os = "windows"))]
    fn check(&mut self, _path: &Path) -> PathState {
        // Historical paths have no volume identity. Do not infer that an unmounted NAS
        // was a local missing directory; manual cleanup remains available on these hosts.
        PathState::Unknown
    }
    #[cfg(target_os = "windows")]
    fn check(&mut self, path: &Path) -> PathState {
        let Some((drive, parts)) = local_components(path) else {
            return PathState::Unknown;
        };
        let Some((root, volume)) = self.local_volume(drive) else {
            return PathState::Unknown;
        };
        walk_local_path(root, &parts, volume)
    }
    #[cfg(target_os = "windows")]
    fn local_volume(&mut self, drive: u8) -> Option<(std::path::PathBuf, u32)> {
        use windows::{
            core::HSTRING,
            Win32::Storage::FileSystem::{GetDriveTypeW, GetVolumeInformationW},
        };
        let root = format!("{}:\\", drive as char);
        let volume = self.volumes.entry(drive).or_insert_with(|| {
            let root = HSTRING::from(&root);
            // DRIVE_FIXED only: mapped, removable, disconnected, and unknown volumes are skipped.
            if unsafe { GetDriveTypeW(&root) } != 3 {
                return None;
            }
            let mut serial = 0;
            unsafe { GetVolumeInformationW(&root, None, Some(&mut serial), None, None, None) }
                .ok()?;
            Some(serial)
        });
        let volume = (*volume)?;
        let root = std::path::PathBuf::from(format!(r"\\?\{root}"));
        let meta = std::fs::symlink_metadata(&root).ok()?;
        if safe_kind(&meta) != Some(LocalKind::Directory) {
            return None;
        }
        Some((root, volume))
    }
}
#[cfg(target_os = "windows")]
fn local_components(path: &Path) -> Option<(u8, Vec<std::ffi::OsString>)> {
    use std::path::{Component, Prefix};
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return None;
    };
    let drive = match prefix.kind() {
        Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive,
        _ => return None,
    };
    if components.next() != Some(Component::RootDir) {
        return None;
    }
    // Validate the entire path before inspecting a missing prefix (including trailing '..').
    let parts = components
        .map(|component| match component {
            Component::Normal(part) => Some(part.to_owned()),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    (!parts.is_empty()).then_some((drive, parts))
}
#[cfg(target_os = "windows")]
#[derive(PartialEq)]
enum LocalKind {
    File,
    Directory,
}
#[cfg(target_os = "windows")]
fn safe_kind(meta: &std::fs::Metadata) -> Option<LocalKind> {
    use std::os::windows::fs::MetadataExt;
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    if meta.file_type().is_symlink() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
    {
        return None;
    }
    if meta.is_file() {
        Some(LocalKind::File)
    } else if meta.is_dir() {
        Some(LocalKind::Directory)
    } else {
        None
    }
}
#[cfg(target_os = "windows")]
fn walk_local_path(
    mut current: std::path::PathBuf,
    parts: &[std::ffi::OsString],
    volume: u32,
) -> PathState {
    use std::fs;
    for (index, part) in parts.iter().enumerate() {
        let parent = current.clone();
        current.push(part);
        let meta = match fs::symlink_metadata(&current) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return if fs::read_dir(parent).is_ok() {
                    PathState::Missing(volume)
                } else {
                    PathState::Unknown
                };
            }
            Err(_) => return PathState::Unknown,
        };
        match (safe_kind(&meta), index + 1 == parts.len()) {
            (Some(LocalKind::File), true) => return PathState::Present,
            (Some(LocalKind::Directory), false) => (),
            _ => return PathState::Unknown,
        }
    }
    PathState::Unknown
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf, time::Duration};

    struct Fixture {
        _temp: tempfile::TempDir,
        db: Database,
        paths: LibraryPaths,
        original: PathBuf,
        moved: PathBuf,
        id: String,
    }
    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = fs::canonicalize(temp.path()).unwrap();
            let paths = LibraryPaths::init(root.join("library")).unwrap();
            let db = Database::open_in_memory().unwrap();
            db.migrate().unwrap();
            let original = root.join("original.png");
            image::RgbImage::from_pixel(8, 8, image::Rgb([20, 40, 60]))
                .save(&original)
                .unwrap();
            let id = db.index_connected_file(&paths, &original, None).unwrap().id;
            let moved = root.join("moved.png");
            Self {
                _temp: temp,
                db,
                paths,
                original,
                moved,
                id,
            }
        }
        fn visible(&self) -> usize {
            self.db
                .material_catalog_assets("tags", None, None)
                .unwrap()
                .len()
        }
    }

    #[test]
    fn sweep_verifies_originals_with_both_recycled_and_cleaned_markers() {
        let f = Fixture::new();
        let ids = [f.id.clone()];
        let original = f.db.preview_asset_originals(&ids).unwrap().remove(0);
        fs::rename(&f.original, &f.moved).unwrap();
        f.db.conn.lock().unwrap().execute("INSERT INTO trashed_asset_originals(asset_id,path,fingerprint) VALUES(?1,?2,?3)",
            rusqlite::params![f.id,original.path,original.fingerprint]).unwrap();
        // The sweeper must not auto-clean references solely because the original was recycled.
        assert!(candidates(&f.db,None).unwrap().is_empty());
        let missing = f.db.preview_asset_originals(&ids).unwrap().remove(0);
        f.db.cleanup_missing_original(&missing).unwrap();
        let mut sweep = MissingOriginalSweep::default();
        let now = Instant::now();
        image::RgbImage::from_pixel(8, 8, image::Rgb([7u8,8,9])).save(&f.original).unwrap();
        assert_eq!(sweep.check_batch(&f.db,&f.paths,now).unwrap().restored, 0);
        assert_eq!(f.visible(), 0);
        fs::remove_file(&f.original).unwrap();
        fs::rename(&f.moved,&f.original).unwrap();
        assert_eq!(sweep.check_batch(&f.db,&f.paths,now + Duration::from_secs(31)).unwrap().restored, 1);
        assert_eq!(f.visible(), 1);
    }

    #[test]
    fn automatic_missing_cleanup_requires_separated_observations_and_restores_verified_original() {
        let f = Fixture::new();
        let before = serde_json::to_value(f.db.get_asset(&f.id).unwrap()).unwrap();
        fs::rename(&f.original, &f.moved).unwrap();
        let mut sweep = MissingOriginalSweep::default();
        let start = Instant::now();
        let first = sweep.check_batch(&f.db, &f.paths, start).unwrap();
        assert_eq!(first.removed, 0);
        assert_eq!(f.visible(), 1);
        assert_eq!(
            sweep
                .check_batch(&f.db, &f.paths, start + Duration::from_secs(29))
                .unwrap()
                .removed,
            0
        );
        let confirmed = sweep
            .check_batch(&f.db, &f.paths, start + Duration::from_secs(31))
            .unwrap();
        assert_eq!(
            confirmed.removed, 1,
            "two stable missing observations must clean the library entry"
        );
        assert_eq!(f.visible(), 0);
        assert_eq!(
            serde_json::to_value(f.db.get_asset(&f.id).unwrap()).unwrap(),
            before
        );
        assert!(f.moved.is_file());
        fs::rename(&f.moved, &f.original).unwrap();
        assert_eq!(
            sweep
                .check_batch(&f.db, &f.paths, start + Duration::from_secs(32))
                .unwrap()
                .restored,
            1
        );
        assert_eq!(f.visible(), 1);
    }

    #[test]
    fn automatic_missing_cleanup_resets_confirmation_after_registered_path_changes() {
        let f = Fixture::new();
        fs::rename(&f.original, &f.moved).unwrap();
        let mut sweep = MissingOriginalSweep::default();
        let start = Instant::now();
        sweep.check_batch(&f.db, &f.paths, start).unwrap();
        let next = f.original.with_file_name("another-missing.png");
        f.db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE assets SET store_path=?2 WHERE id=?1",
                rusqlite::params![f.id, next.to_string_lossy()],
            )
            .unwrap();
        assert_eq!(
            sweep
                .check_batch(&f.db, &f.paths, start + Duration::from_secs(31))
                .unwrap()
                .removed,
            0
        );
        assert_eq!(f.visible(), 1);
        assert_eq!(
            sweep
                .check_batch(&f.db, &f.paths, start + Duration::from_secs(62))
                .unwrap()
                .removed,
            1
        );
        assert_eq!(f.visible(), 0);
    }

    #[test]
    fn automatic_missing_cleanup_paginates_legacy_rows_and_releases_each_batch() {
        let f = Fixture::new();
        // Keep one existing original and add 130 distinct missing historical paths.
        for index in 0..130 {
            let id = format!("legacy-{index:03}");
            let path = f.original.with_file_name(format!("absent-{index}.png"));
            f.db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,ext,store_path,source,created_at) VALUES(?1,'legacy','png',?2,'external',NULL)", rusqlite::params![id,path.to_string_lossy()]).unwrap();
            f.db.conn.lock().unwrap().execute("INSERT INTO external_assets(asset_id,fingerprint,library_member) VALUES(?1,'legacy-fingerprint',1)", [&id]).unwrap();
        }
        let mut sweep = MissingOriginalSweep::default();
        let now = Instant::now();
        let first = sweep.check_batch(&f.db, &f.paths, now).unwrap();
        assert_eq!(first.checked, 128);
        assert!(first.more);
        assert_eq!(first.removed, 0);
        let tail = sweep.check_batch(&f.db, &f.paths, now).unwrap();
        assert_eq!(tail.checked, 3);
        assert!(!tail.more);
        assert!(tail.pending);
        let first = sweep
            .check_batch(&f.db, &f.paths, now + CONFIRM_AFTER)
            .unwrap();
        let tail = sweep
            .check_batch(&f.db, &f.paths, now + CONFIRM_AFTER)
            .unwrap();
        assert_eq!(first.removed + tail.removed, 130);
        assert_eq!(f.visible(), 1);
        assert!(f.original.is_file());
        assert!(!tail.pending);
    }

    #[test]
    fn automatic_missing_cleanup_restarts_grace_after_transient_recovery() {
        let f = Fixture::new();
        let start = Instant::now();
        let mut sweep = MissingOriginalSweep::default();
        fs::rename(&f.original, &f.moved).unwrap();
        assert!(sweep.check_batch(&f.db, &f.paths, start).unwrap().pending);
        fs::rename(&f.moved, &f.original).unwrap();
        assert!(
            !sweep
                .check_batch(&f.db, &f.paths, start + Duration::from_secs(20))
                .unwrap()
                .pending
        );
        fs::rename(&f.original, &f.moved).unwrap();
        assert_eq!(
            sweep
                .check_batch(&f.db, &f.paths, start + Duration::from_secs(31))
                .unwrap()
                .removed,
            0
        );
        assert_eq!(
            sweep
                .check_batch(&f.db, &f.paths, start + Duration::from_secs(60))
                .unwrap()
                .removed,
            0
        );
        assert_eq!(
            sweep
                .check_batch(&f.db, &f.paths, start + Duration::from_secs(61))
                .unwrap()
                .removed,
            1
        );
    }

    #[test]
    fn automatic_missing_cleanup_handles_missing_directory_on_online_fixed_disk() {
        let f = Fixture::new();
        let parent = f.original.parent().unwrap().join("old-library");
        fs::create_dir(&parent).unwrap();
        let path = parent.join("original.png");
        fs::rename(&f.original, &path).unwrap();
        f.db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE assets SET store_path=?2 WHERE id=?1",
                rusqlite::params![f.id, path.to_string_lossy()],
            )
            .unwrap();
        fs::rename(&parent, parent.with_file_name("relocated-library")).unwrap();
        let now = Instant::now();
        let mut sweep = MissingOriginalSweep::default();
        assert!(sweep.check_batch(&f.db, &f.paths, now).unwrap().pending);
        assert_eq!(
            sweep
                .check_batch(&f.db, &f.paths, now + CONFIRM_AFTER)
                .unwrap()
                .removed,
            1
        );
        assert_eq!(f.visible(), 0);
    }

    #[test]
    fn automatic_missing_cleanup_rejects_unknown_paths_before_filesystem_access() {
        let f = Fixture::new();
        // PathBuf::push normalizes '..' for verbatim Windows paths; retain the raw input.
        let traversal = format!(
            r"{}\absent-directory\..\original.png",
            f.original.parent().unwrap().display()
        );
        for path in [
            r"\\server\share\absent.png",
            r"\\?\UNC\server\share\absent.png",
            r"\\.\C:\absent.png",
            r"C:absent.png",
            r"relative\absent.png",
            traversal.as_str(),
        ] {
            assert!(
                matches!(
                    LocalProbe::default().check(Path::new(path)),
                    PathState::Unknown
                ),
                "{path}"
            );
        }
        f.db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE assets SET store_path='relative/absent.png' WHERE id=?1",
                [&f.id],
            )
            .unwrap();
        let now = Instant::now();
        let mut sweep = MissingOriginalSweep::default();
        for time in [now, now + CONFIRM_AFTER] {
            let batch = sweep.check_batch(&f.db, &f.paths, time).unwrap();
            assert_eq!(batch.removed, 0);
            assert!(!batch.pending);
        }
        assert_eq!(f.visible(), 1);
    }

    #[test]
    fn automatic_missing_cleanup_skips_directory_junctions() {
        let f = Fixture::new();
        let target = f.original.parent().unwrap().join("target");
        fs::create_dir(&target).unwrap();
        let alias = f.original.parent().unwrap().join("junction");
        let spellings = external_files::connection_path_spellings(&alias, &alias);
        let target_spellings = external_files::connection_path_spellings(&target, &target);
        let output = std::process::Command::new("cmd.exe")
            .args([
                "/D",
                "/C",
                "mklink",
                "/J",
                &spellings[2],
                &target_spellings[2],
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(matches!(
            LocalProbe::default().check(&alias.join("absent.png")),
            PathState::Unknown
        ));
        // Remove just the test junction, never its target; TempDir owns both isolated paths.
        fs::remove_dir(&alias).unwrap();
        assert!(target.is_dir());
    }

    #[test]
    fn automatic_missing_cleanup_rolls_back_sql_failure_and_retries_without_touching_cache() {
        let f = Fixture::new();
        let cache = f.paths.thumbnails.join("kept.jpg");
        fs::write(&cache, b"cached bytes").unwrap();
        fs::rename(&f.original, &f.moved).unwrap();
        f.db.conn.lock().unwrap().execute_batch("CREATE TEMP TRIGGER reject_cleanup BEFORE INSERT ON removed_missing_asset_originals BEGIN SELECT RAISE(FAIL,'injected'); END;").unwrap();
        let mut sweep = MissingOriginalSweep::default();
        let now = Instant::now();
        sweep.check_batch(&f.db, &f.paths, now).unwrap();
        let rejected = sweep
            .check_batch(&f.db, &f.paths, now + CONFIRM_AFTER)
            .unwrap();
        assert_eq!(rejected.removed, 0);
        assert!(rejected.pending);
        assert_eq!(f.visible(), 1);
        assert_eq!(fs::read(&cache).unwrap(), b"cached bytes");
        assert!(f.moved.is_file());
        f.db.conn
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER reject_cleanup;")
            .unwrap();
        assert_eq!(
            sweep
                .check_batch(&f.db, &f.paths, now + CONFIRM_AFTER)
                .unwrap()
                .removed,
            1
        );
        assert_eq!(fs::read(cache).unwrap(), b"cached bytes");
    }

    #[test]
    fn automatic_missing_cleanup_transaction_refuses_recovered_original() {
        let f = Fixture::new();
        fs::rename(&f.original, &f.moved).unwrap();
        let missing =
            f.db.preview_asset_originals(std::slice::from_ref(&f.id))
                .unwrap()
                .remove(0);
        fs::rename(&f.moved, &f.original).unwrap();
        assert!(f.db.cleanup_missing_original(&missing).is_err());
        assert_eq!(f.visible(), 1);
        assert!(f.original.is_file());
        let present =
            f.db.preview_asset_originals(std::slice::from_ref(&f.id))
                .unwrap()
                .remove(0);
        assert!(f.db.cleanup_missing_original(&present).is_err());
    }

    #[test]
    fn automatic_missing_cleanup_does_not_restore_different_content_at_old_path() {
        let f = Fixture::new();
        fs::rename(&f.original, &f.moved).unwrap();
        let mut sweep = MissingOriginalSweep::default();
        let now = Instant::now();
        sweep.check_batch(&f.db, &f.paths, now).unwrap();
        assert_eq!(
            sweep
                .check_batch(&f.db, &f.paths, now + CONFIRM_AFTER)
                .unwrap()
                .removed,
            1
        );
        image::RgbImage::from_pixel(8, 8, image::Rgb([200, 10, 80]))
            .save(&f.original)
            .unwrap();
        assert_eq!(
            sweep
                .check_batch(&f.db, &f.paths, now + CONFIRM_AFTER)
                .unwrap()
                .restored,
            0
        );
        assert_eq!(f.visible(), 0);
        assert!(f.original.is_file());
        assert!(f.moved.is_file());
    }

    #[test]
    fn automatic_missing_cleanup_restores_one_visible_identity_for_duplicate_paths() {
        let f = Fixture::new();
        let mut duplicate = f.db.get_asset(&f.id).unwrap().unwrap();
        duplicate.id = "duplicate".into();
        f.db.insert_asset(&duplicate).unwrap();
        let hash = external_files::fingerprint(&f.original).unwrap();
        f.db.conn.lock().unwrap().execute("INSERT INTO external_assets(asset_id,fingerprint,library_member) VALUES('duplicate',?1,1)",[hash]).unwrap();
        fs::rename(&f.original, &f.moved).unwrap();
        let mut sweep = MissingOriginalSweep::default();
        let now = Instant::now();
        sweep.check_batch(&f.db, &f.paths, now).unwrap();
        assert_eq!(
            sweep
                .check_batch(&f.db, &f.paths, now + CONFIRM_AFTER)
                .unwrap()
                .removed,
            2
        );
        fs::rename(&f.moved, &f.original).unwrap();
        let restored = sweep
            .check_batch(&f.db, &f.paths, now + CONFIRM_AFTER)
            .unwrap();
        assert_eq!(restored.restored, 1);
        for _ in 0..3 {
            assert_eq!(
                sweep
                    .check_batch(&f.db, &f.paths, now + CONFIRM_AFTER)
                    .unwrap()
                    .restored,
                0
            );
        }
        assert_eq!(f.visible(), 1);
    }

    #[test]
    fn automatic_missing_cleanup_includes_project_only_visible_originals() {
        let f = Fixture::new();
        f.db.conn.lock().unwrap().execute_batch("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','fixture','fixture',0);").unwrap();
        {
            let conn = f.db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO disconnected_library_assets(asset_id) VALUES(?1)",
                [&f.id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO project_assets(project_id,asset_id,created_at) VALUES('p',?1,0)",
                [&f.id],
            )
            .unwrap();
        }
        assert_eq!(f.visible(), 0);
        assert_eq!(
            f.db.material_catalog_assets("tags", None, Some("p"))
                .unwrap()
                .len(),
            1
        );
        fs::rename(&f.original, &f.moved).unwrap();
        let mut sweep = MissingOriginalSweep::default();
        let now = Instant::now();
        sweep.check_batch(&f.db, &f.paths, now).unwrap();
        assert_eq!(
            sweep
                .check_batch(&f.db, &f.paths, now + CONFIRM_AFTER)
                .unwrap()
                .removed,
            1
        );
        assert!(f
            .db
            .material_catalog_assets("tags", None, Some("p"))
            .unwrap()
            .is_empty());
        let members: i64 =
            f.db.conn
                .lock()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM project_assets WHERE asset_id=?1",
                    [&f.id],
                    |r| r.get(0),
                )
                .unwrap();
        assert_eq!(members, 1);
    }

    struct DeniedDirectory {
        path: PathBuf,
        account: String,
    }
    impl DeniedDirectory {
        fn new(path: PathBuf) -> Self {
            let user = std::process::Command::new("whoami.exe").output().unwrap();
            assert!(user.status.success());
            let account = String::from_utf8(user.stdout).unwrap().trim().to_owned();
            let denied = Self { path, account };
            let rule = format!("{}:(OI)(CI)(R)", denied.account);
            let output = std::process::Command::new("icacls.exe")
                .arg(&denied.path)
                .args(["/deny", &rule])
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            denied
        }
    }
    impl Drop for DeniedDirectory {
        fn drop(&mut self) {
            let output = std::process::Command::new("icacls.exe")
                .arg(&self.path)
                .args(["/remove:d", &self.account])
                .output()
                .expect("restore isolated test directory ACL");
            assert!(
                output.status.success(),
                "restore isolated test directory ACL"
            );
        }
    }
    #[test]
    fn automatic_missing_cleanup_skips_permission_denied_without_hiding() {
        let f = Fixture::new();
        let directory = f.original.parent().unwrap().join("restricted");
        fs::create_dir(&directory).unwrap();
        let path = directory.join("original.png");
        fs::rename(&f.original, &path).unwrap();
        f.db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE assets SET store_path=?2 WHERE id=?1",
                rusqlite::params![f.id, path.to_string_lossy()],
            )
            .unwrap();
        let denied = DeniedDirectory::new(directory);
        assert_eq!(
            fs::symlink_metadata(&path).unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
        let now = Instant::now();
        let mut sweep = MissingOriginalSweep::default();
        for time in [now, now + CONFIRM_AFTER] {
            let batch = sweep.check_batch(&f.db, &f.paths, time).unwrap();
            assert_eq!(batch.removed, 0);
            assert!(!batch.pending);
        }
        assert_eq!(f.visible(), 1);
        drop(denied);
        assert!(path.is_file());
    }
}
