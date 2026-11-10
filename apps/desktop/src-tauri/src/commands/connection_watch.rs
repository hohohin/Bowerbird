//! Native filesystem notices are hints; reconciliation remains the existing conservative scan.
use super::{queue_refresh, request_originals_check};
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
use tauri::{AppHandle, Manager};

#[derive(Clone)]
struct Root {
    id: String,
    path: PathBuf,
    // A reference may point outside all connected roots. Watch its original's parent too.
    originals: Vec<PathBuf>,
}
fn roots(db: &Database) -> AppResult<Vec<Root>> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare("SELECT id,path FROM connected_roots ORDER BY rowid")?;
    let mut roots = stmt
        .query_map([], |row| {
            Ok(Root {
                id: row.get(0)?,
                path: PathBuf::from(row.get::<_, String>(1)?),
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
    watched: &HashMap<PathBuf, RecursiveMode>,
) -> HashMap<PathBuf, RecursiveMode> {
    let mut watches = HashMap::new();
    let mut parents = HashSet::new();
    for root in roots {
        if root.path.is_dir() {
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
                    let desired = desired_watches(&known_roots, &watched);
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
                    for root in &known_roots {
                        let online = root.path.is_dir();
                        if available
                            .insert(root.id.clone(), online)
                            .is_some_and(|old| old != online)
                        {
                            pending.add(HashSet::from([root.id.clone()]), now);
                        }
                    }
                    available.retain(|id, _| known_roots.iter().any(|root| &root.id == id));
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
                    queue_refresh(app.clone(), db.clone(), paths.clone(), Some(roots), None, true);
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
    fn filters_sidecar_and_reads_but_tracks_reference_files_and_external_originals() {
        let root = Root {
            id: "a".into(),
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
