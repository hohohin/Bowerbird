//! Native filesystem notices are hints; reconciliation remains the existing conservative scan.
use super::{queue_refresh, request_originals_check};
use crate::core::folder_connections::connection_root_readable;
use crate::{core::paths::LibraryPaths, db::Database, error::AppResult};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone)]
struct Root {
    id: String,
    path: PathBuf,
    indexed_available: bool,
    // A reference may point outside all connected roots. Watch its original's parent too.
    originals: Vec<PathBuf>,
}
fn roots(db: &Database) -> AppResult<Vec<Root>> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare("SELECT id,path,available FROM connected_roots ORDER BY rowid")?;
    let mut roots = stmt
        .query_map([], |row| {
            Ok(Root {
                id: row.get(0)?,
                path: PathBuf::from(row.get::<_, String>(1)?),
                indexed_available: row.get(2)?,
                originals: Vec::new(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut stmt = conn.prepare("SELECT DISTINCT f.root_id,a.store_path FROM connected_entries e JOIN connected_folders f ON f.id=e.folder_id JOIN assets a ON a.id=e.asset_id WHERE e.is_reference=1 AND a.store_path IS NOT NULL")?;
    for value in stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            PathBuf::from(row.get::<_, String>(1)?),
        ))
    })? {
        let (id, path) = value?;
        if let Some(root) = roots.iter_mut().find(|root| root.id == id) {
            root.originals.push(path);
        }
    }
    Ok(roots)
}
fn ignored(path: &Path) -> bool {
    path.components().any(|part| {
        let value = part.as_os_str().to_string_lossy();
        value.eq_ignore_ascii_case(".bowerbird")
            || value.to_ascii_lowercase().starts_with(".bowerbird-")
    })
}
fn affected(event: &Event, roots: &[Root]) -> HashSet<String> {
    if matches!(event.kind, EventKind::Access(_)) {
        return HashSet::new();
    }
    roots
        .iter()
        .filter(|root| {
            event.need_rescan()
                || event
                    .paths
                    .iter()
                    .filter(|path| !ignored(path))
                    .any(|path| {
                        path.starts_with(&root.path)
                            || root.path.starts_with(path)
                            || root
                                .originals
                                .iter()
                                .any(|original| original == path || original.starts_with(path))
                    })
        })
        .map(|root| root.id.clone())
        .collect()
}
fn invalidated_watches(event: &Event, watched: &HashMap<PathBuf, RecursiveMode>) -> Vec<PathBuf> {
    let replaced = matches!(
        event.kind,
        EventKind::Remove(_) | EventKind::Modify(notify::event::ModifyKind::Name(_))
    );
    watched
        .keys()
        .filter(|watch| {
            event.need_rescan()
                || (replaced && event.paths.iter().any(|path| watch.starts_with(path)))
        })
        .cloned()
        .collect()
}
fn desired_watches(
    roots: &[Root],
    readable: &HashSet<PathBuf>,
    watched: &HashMap<PathBuf, RecursiveMode>,
) -> HashMap<PathBuf, RecursiveMode> {
    let mut watches = HashMap::new();
    let mut parents = HashSet::new();
    for root in roots {
        if readable.contains(&root.path) {
            watches.insert(root.path.clone(), RecursiveMode::Recursive);
        }
        // Watching the parent detects replacement/deletion of a watched directory itself.
        for path in std::iter::once(&root.path).chain(root.originals.iter()) {
            if let Some(parent) = path.parent() {
                parents.insert(parent.to_path_buf());
            }
        }
    }
    for parent in parents {
        if watches
            .iter()
            .any(|(root, mode)| *mode == RecursiveMode::Recursive && parent.starts_with(root))
        {
            continue;
        }
        if watched.contains_key(&parent) {
            watches.entry(parent).or_insert(RecursiveMode::NonRecursive);
        } else if let Some(parent) = parent.ancestors().find(|path| path.is_dir()) {
            watches
                .entry(parent.to_path_buf())
                .or_insert(RecursiveMode::NonRecursive);
        }
    }
    watches
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionAvailability {
    root_id: String,
    available: bool,
}

fn reconcile_availability(
    db: &Database,
    roots: &[Root],
    observed: &mut HashMap<String, bool>,
    mut notify: impl FnMut(ConnectionAvailability),
    mut rescan: impl FnMut(String),
) -> HashSet<PathBuf> {
    let mut readable = HashSet::new();
    for root in roots {
        let online = connection_root_readable(&root.path);
        if online {
            readable.insert(root.path.clone());
        }
        let previous = observed.get(&root.id).copied();
        if previous == Some(online) && root.indexed_available == online {
            continue;
        }
        if root.indexed_available != online {
            match db.set_connection_root_available(&root.id, &root.path, online) {
                Ok(true) => (),
                Ok(false) => continue, // path was relocated/disconnected or a scan just updated it
                Err(error) => {
                    tracing::warn!("connection availability: {error}");
                    continue;
                }
            }
        }
        observed.insert(root.id.clone(), online);
        if previous.is_some() || root.indexed_available != online || !online {
            notify(ConnectionAvailability {
                root_id: root.id.clone(),
                available: online,
            });
        }
        // Even after a fresh app launch the indexed entries can reflect an
        // older unavailable disk. Reconcile once on initial attachment too.
        if online {
            rescan(root.id.clone());
        }
    }
    observed.retain(|id, _| roots.iter().any(|r| &r.id == id));
    readable
}
#[derive(Default)]
struct Pending {
    roots: HashSet<String>,
    first: Option<Instant>,
    last: Option<Instant>,
}
impl Pending {
    fn add(&mut self, roots: HashSet<String>, now: Instant) {
        if roots.is_empty() {
            return;
        }
        self.roots.extend(roots);
        self.first.get_or_insert(now);
        self.last = Some(now);
    }
    fn take_ready(&mut self, now: Instant) -> Option<HashSet<String>> {
        if self
            .last
            .is_some_and(|last| now.duration_since(last) >= Duration::from_millis(750))
            || self
                .first
                .is_some_and(|first| now.duration_since(first) >= Duration::from_secs(2))
        {
            self.first = None;
            self.last = None;
            return Some(std::mem::take(&mut self.roots));
        }
        None
    }
}
pub fn watch(app: AppHandle, db: Arc<Database>, paths: Arc<LibraryPaths>) {
    if let Some(main) = app.get_webview_window("main") {
        let (app, db, paths) = (app.clone(), db.clone(), paths.clone());
        main.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Focused(true)) {
                request_originals_check(app.clone(), db.clone(), paths.clone(), true);
            }
        });
    }
    // Enumeration/watch registration can block on a disconnected network mount.
    // Keep that IO on one dedicated background thread, away from the async runtime.
    let result = std::thread::Builder::new()
        .name("connection-watch".into())
        .spawn(move || {
            let (send, receive) = std::sync::mpsc::sync_channel(256);
            let overflow = Arc::new(AtomicBool::new(false));
            let overflow_handler = overflow.clone();
            let mut native = match notify::recommended_watcher(move |event| {
                if send.try_send(event).is_err() {
                    overflow_handler.store(true, Ordering::Release);
                }
            }) {
                Ok(value) => Some(value),
                Err(error) => {
                    tracing::warn!("connection watcher unavailable: {error}");
                    None
                }
            };
            let mut watched = HashMap::<PathBuf, RecursiveMode>::new();
            let mut known_roots = Vec::new();
            let mut available = HashMap::<String, bool>::new();
            let mut pending = Pending::default();
            let generated = crate::core::folder_connections::generated_connection_paths(&paths);
            let mut sync_at = Instant::now() - Duration::from_secs(30);
            let mut fallback_at = Instant::now();
            let mut originals_at = Instant::now() - Duration::from_secs(1);
            loop {
                std::thread::sleep(Duration::from_millis(250));
                let now = Instant::now();
                // Polling the queue is cheap even with no connected roots. The shared
                // worker limits actual IO to 30s confirmation/focus or 300s routine checks.
                if now.duration_since(originals_at) >= Duration::from_secs(1) {
                    request_originals_check(app.clone(), db.clone(), paths.clone(), false);
                    originals_at = now;
                }
                if sync_at.elapsed() >= Duration::from_secs(2) {
                    if let Ok(values) = roots(&db) {
                        known_roots = values;
                    }
                    let readable = reconcile_availability(
                        &db,
                        &known_roots,
                        &mut available,
                        |value| {
                            let _ = app.emit("library://connection-availability", value);
                            super::changed(&app);
                        },
                        |root| pending.add(HashSet::from([root]), now),
                    );
                    let desired = desired_watches(&known_roots, &readable, &watched);
                    if let Some(native) = native.as_mut() {
                        let stale: Vec<_> = watched
                            .iter()
                            .filter(|(path, mode)| desired.get(*path) != Some(mode))
                            .map(|(path, _)| path.clone())
                            .collect();
                        for path in stale {
                            let _ = native.unwatch(&path);
                            watched.remove(&path);
                        }
                        for (path, mode) in desired {
                            if !watched.contains_key(&path) {
                                match native.watch(&path, mode) {
                                    Ok(()) => {
                                        // Reconcile once after registration: changes between the
                                        // preceding scan and attaching the OS watch must not be lost.
                                        pending.add(
                                            known_roots
                                                .iter()
                                                .filter(|root| {
                                                    root.path.starts_with(&path)
                                                        || path.starts_with(&root.path)
                                                        || root.originals.iter().any(|original| {
                                                            original.starts_with(&path)
                                                        })
                                                })
                                                .map(|root| root.id.clone())
                                                .collect(),
                                            now,
                                        );
                                        watched.insert(path, mode);
                                    }
                                    Err(error) => {
                                        tracing::debug!("connection watch registration: {error}")
                                    }
                                }
                            }
                        }
                    }
                    sync_at = now;
                }
                while let Ok(event) = receive.try_recv() {
                    match event {
                        Ok(mut event) => {
                            event.paths.retain(|path| {
                                !generated
                                    .iter()
                                    .any(|generated| path.starts_with(generated))
                            });
                            pending.add(affected(&event, &known_roots), now);
                            // A root can be removed and recreated between availability polls.
                            // Reattach its OS handle even when the same path already exists again.
                            for path in invalidated_watches(&event, &watched) {
                                if let Some(native) = native.as_mut() {
                                    let _ = native.unwatch(&path);
                                }
                                watched.remove(&path);
                            }
                        }
                        Err(error) => {
                            tracing::warn!("connection watcher: {error}");
                            pending.add(
                                known_roots.iter().map(|root| root.id.clone()).collect(),
                                now,
                            );
                            // An OS watch can become invalid after a mount/root is replaced.
                            if let Some(native) = native.as_mut() {
                                for path in watched.keys() {
                                    let _ = native.unwatch(path);
                                }
                            }
                            watched.clear();
                        }
                    }
                }
                if overflow.swap(false, Ordering::AcqRel) {
                    pending.add(
                        known_roots.iter().map(|root| root.id.clone()).collect(),
                        now,
                    );
                }
                // Native notifications can be absent on NAS mounts. A bounded fallback plus
                // focus/manual checks also recover missed events without a hot full-tree poll.
                let fallback = if native.is_some() {
                    Duration::from_secs(300)
                } else {
                    Duration::from_secs(30)
                };
                if fallback_at.elapsed() >= fallback {
                    pending.add(
                        known_roots.iter().map(|root| root.id.clone()).collect(),
                        now,
                    );
                    fallback_at = now;
                }
                if let Some(roots) = pending.take_ready(now) {
                    queue_refresh(
                        app.clone(),
                        db.clone(),
                        paths.clone(),
                        Some(roots),
                        None,
                        true,
                    );
                }
            }
        });
    if let Err(error) = result {
        tracing::warn!("connection watcher thread: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, ModifyKind};
    #[test]
    fn removable_root_round_trip() {
        use std::fs;
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("index.db");
        let db = Database::open(&db_path).unwrap();
        db.migrate().unwrap();
        let paths = LibraryPaths::init(temp.path().join("internal")).unwrap();
        let external = std::env::var_os("BOWERBIRD_QA_CONNECTION_ROOT").map(PathBuf::from);
        let signals = std::env::var_os("BOWERBIRD_QA_CONNECTION_SIGNALS").map(PathBuf::from);
        assert_eq!(external.is_some(), signals.is_some());
        let source = if let Some(dir) = external.as_ref() {
            assert!(signals.as_ref().unwrap().is_dir());
            assert_eq!(fs::read_dir(signals.as_ref().unwrap()).unwrap().count(), 0);
            // This branch never writes, moves or dismounts the mounted device.
            // Mount/unmount is controlled by the release operator outside this process.
            assert!(dir.join("TEST.PNG").is_file());
            dir.clone()
        } else {
            let dir = temp.path().join("connected-media");
            fs::create_dir(&dir).unwrap();
            image::RgbImage::from_pixel(4, 4, image::Rgb([25, 50, 75]))
                .save(dir.join("TEST.PNG"))
                .unwrap();
            dir
        };
        let source = fs::canonicalize(source).unwrap();
        let root = db.connect_directory(&source, None).unwrap();
        let ids = |db: &Database| {
            db.connection_entry_ids(Some(&root), None, None, 0, 2000)
                .unwrap()
        };
        let mut observed = HashMap::new();
        let poll = |db: &Database, observed: &mut HashMap<String, bool>| {
            let mut changes = Vec::new();
            let mut rescans = Vec::new();
            reconcile_availability(
                db,
                &roots(db).unwrap(),
                observed,
                |v| changes.push((v.root_id, v.available)),
                |id| rescans.push(id),
            );
            for id in &rescans {
                db.scan_connection(&paths, id).unwrap();
            }
            (changes, rescans)
        };
        assert_eq!(poll(&db, &mut observed).1, vec![root.clone()]);
        let before = ids(&db);
        assert!(!before.is_empty());
        let entry = db
            .read_connection_entries(&before)
            .unwrap()
            .into_iter()
            .find(|row| row.name.eq_ignore_ascii_case("TEST.PNG"))
            .unwrap();
        let original = PathBuf::from(entry.asset.store_path.as_deref().unwrap());
        let bytes = fs::read(&original).unwrap();
        db.create_project(
            "connection-qa",
            "QA",
            temp.path().to_str().unwrap(),
            "qa",
            "user",
        )
        .unwrap();
        db.add_assets_to_project("connection-qa", std::slice::from_ref(&entry.asset_id))
            .unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO analyses(id,asset_id,kind,payload) VALUES('qa-note',?1,'caption','QA note')", [&entry.asset_id]).unwrap();
        let park = temp.path().join("parked-root");
        let wait = |online: bool| {
            let until = Instant::now() + Duration::from_secs(90);
            while connection_root_readable(&source) != online && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(100));
            }
            assert_eq!(connection_root_readable(&source), online);
        };
        if let Some(dir) = signals.as_ref() {
            fs::write(dir.join("ready-to-unmount"), b"ok").unwrap();
            wait(false);
        } else {
            fs::rename(&source, &park).unwrap();
        }
        assert_eq!(
            poll(&db, &mut observed),
            (vec![(root.clone(), false)], vec![])
        );
        assert_eq!(poll(&db, &mut observed), (vec![], vec![]));
        assert!(!db.connected_folder(&root).unwrap().available);
        assert!(db.original_under_offline_connection(&original).unwrap());
        assert_eq!(
            ids(&db),
            before,
            "offline cache still serves collection entries"
        );
        assert!(db
            .read_connection_entries(&before)
            .unwrap()
            .iter()
            .all(|e| !e.available));
        // An offline connected root is not evidence that the original was deleted.
        let mut sweep = crate::core::missing_originals::MissingOriginalSweep::default();
        let now = Instant::now();
        for elapsed in [0, 31] {
            assert_eq!(
                sweep
                    .check_batch(&db, &paths, now + Duration::from_secs(elapsed))
                    .unwrap()
                    .removed,
                0
            );
        }
        let seed_legacy_offline_cache = |db: &Database| {
            db.conn
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO removed_missing_asset_originals(asset_id,path) VALUES(?1,?2)",
                    rusqlite::params![entry.asset_id, entry.path],
                )
                .unwrap();
            db.conn
                .lock()
                .unwrap()
                .execute(
                    "UPDATE connected_folders SET available=0 WHERE root_id=?1",
                    [&root],
                )
                .unwrap();
            db.conn
                .lock()
                .unwrap()
                .execute(
                    "UPDATE connected_entries SET available=0 WHERE id=?1",
                    [&entry.id],
                )
                .unwrap();
        };
        seed_legacy_offline_cache(&db);
        if let Some(dir) = signals.as_ref() {
            fs::write(dir.join("unmounted"), b"ok").unwrap();
            wait(true);
        } else {
            // A same-named directory elsewhere (for example on another drive) is never chosen.
            let other = temp
                .path()
                .join("different-location")
                .join(source.file_name().unwrap());
            fs::create_dir_all(&other).unwrap();
            fs::write(other.join("TEST.PNG"), &bytes).unwrap();
            assert_eq!(poll(&db, &mut HashMap::new()).1, Vec::<String>::new());
            assert!(!db.connected_folder(&root).unwrap().available);
            fs::rename(&park, &source).unwrap();
        }
        // Same application, same connection, same watcher: a returning root rescans itself.
        assert_eq!(
            poll(&db, &mut observed),
            (vec![(root.clone(), true)], vec![root.clone()])
        );
        assert_eq!(ids(&db), before);
        assert_eq!(poll(&db, &mut observed), (vec![], vec![]));
        // Also cover an upgrade from a 1101 snapshot which already saved the stale state.
        seed_legacy_offline_cache(&db);
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE connected_roots SET available=0 WHERE id=?1",
                [&root],
            )
            .unwrap();
        drop(db);
        // Fresh watcher state, as after upgrading/restarting while the drive was absent.
        let db = Database::open(&db_path).unwrap();
        assert_eq!(
            poll(&db, &mut HashMap::new()),
            (vec![(root.clone(), true)], vec![root.clone()])
        );
        assert_eq!(ids(&db), before);
        let after = db
            .read_connection_entries(std::slice::from_ref(&entry.id))
            .unwrap()
            .pop()
            .unwrap();
        assert!(after.available && db.connected_folder(&root).unwrap().available);
        assert_eq!(after.asset_id, entry.asset_id);
        assert_eq!(fs::read(after.path).unwrap(), bytes);
        let conn = db.conn.lock().unwrap();
        let count = |sql| {
            conn.query_row(sql, [&entry.asset_id], |r| r.get::<_, i64>(0))
                .unwrap()
        };
        assert_eq!(count("SELECT COUNT(*) FROM project_assets WHERE asset_id=?1 AND project_id='connection-qa'"),1);
        assert_eq!(count("SELECT COUNT(*) FROM analyses WHERE asset_id=?1 AND id='qa-note' AND payload='QA note'"),1);
        assert_eq!(
            count("SELECT COUNT(*) FROM removed_missing_asset_originals WHERE asset_id=?1"),
            0
        );
        eprintln!("connected root round trip: real_mounted_fixture={}, restored_members={}, identity/content/notes/project preserved",external.is_some(),before.len());
    }
    #[test]
    fn filters_sidecar_and_reads_but_tracks_reference_files_and_external_originals() {
        let root = Root {
            id: "a".into(),
            indexed_available: true,
            path: PathBuf::from("/media"),
            originals: vec![PathBuf::from("/outside/source.png")],
        };
        for path in [
            "/media/.bowerbird/id.json",
            "/media/.bowerbird-cache/file",
            "/other/file",
        ] {
            assert!(affected(
                &Event::new(EventKind::Modify(ModifyKind::Any)).add_path(path.into()),
                &[root.clone()]
            )
            .is_empty());
        }
        for path in [
            "/media/photo.png.bowerbird",
            "/media/photo.png",
            "/outside/source.png",
            "/media",
        ] {
            assert_eq!(
                affected(
                    &Event::new(EventKind::Modify(ModifyKind::Any)).add_path(path.into()),
                    &[root.clone()]
                ),
                HashSet::from(["a".into()])
            );
        }
        assert!(affected(
            &Event::new(EventKind::Access(AccessKind::Read)).add_path("/media/photo.png".into()),
            &[root]
        )
        .is_empty());
    }
    #[test]
    fn debounces_bursts_without_starving_continuous_writes() {
        let start = Instant::now();
        let mut pending = Pending::default();
        pending.add(HashSet::from(["a".into()]), start);
        pending.add(
            HashSet::from(["b".into()]),
            start + Duration::from_millis(500),
        );
        assert!(pending.take_ready(start + Duration::from_secs(1)).is_none());
        assert_eq!(
            pending
                .take_ready(start + Duration::from_millis(1250))
                .unwrap()
                .len(),
            2
        );
        assert!(pending.take_ready(start + Duration::from_secs(3)).is_none());
        pending.add(HashSet::from(["a".into()]), start);
        pending.add(
            HashSet::from(["a".into()]),
            start + Duration::from_millis(1900),
        );
        assert_eq!(
            pending
                .take_ready(start + Duration::from_secs(2))
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn root_replacement_invalidates_only_affected_watch_handles() {
        use notify::event::{RemoveKind, RenameMode};
        let watched = HashMap::from([
            (PathBuf::from("/media"), RecursiveMode::Recursive),
            (PathBuf::from("/other"), RecursiveMode::Recursive),
            (PathBuf::from("/"), RecursiveMode::NonRecursive),
        ]);
        assert!(invalidated_watches(
            &Event::new(EventKind::Remove(RemoveKind::File)).add_path("/media/a.png".into()),
            &watched
        )
        .is_empty());
        for kind in [
            EventKind::Remove(RemoveKind::Folder),
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
        ] {
            assert_eq!(
                invalidated_watches(&Event::new(kind).add_path("/media".into()), &watched),
                vec![PathBuf::from("/media")]
            );
        }
    }
    #[test]
    fn native_watcher_detects_real_temporary_file_changes() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let mut watcher = notify::recommended_watcher(send).unwrap();
        watcher.watch(&root, RecursiveMode::Recursive).unwrap();
        let path = root.join("new.png");
        std::fs::write(&path, b"temporary watcher test").unwrap();
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            let event = receive
                .recv_timeout(until.saturating_duration_since(Instant::now()))
                .unwrap()
                .unwrap();
            if !matches!(event.kind, EventKind::Access(_)) && event.paths.iter().any(|p| p == &path)
            {
                break;
            }
        }
    }
}
