use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use super::{job_path, read, records, valid_id, Job, Voice};
use crate::error::AppResult;

const DIAGNOSTIC_LIMIT: usize = 30;
const DIAGNOSTIC_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const RECOVERY_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

#[derive(Default)]
pub(super) struct Jobs {
    by_project: HashMap<String, BTreeSet<String>>,
    by_request: HashMap<String, HashMap<String, String>>,
    ids: BTreeSet<String>,
    frozen_references: HashMap<String, (PathBuf, bool)>,
    clean_index: bool,
}

impl Jobs {
    pub fn load(base: &Path) -> AppResult<Self> {
        let mut index = Self {
            clean_index: true,
            ..Self::default()
        };
        let entries = match fs::read_dir(base.join("jobs")) {
            Ok(entries) => entries,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(index),
            Err(err) => return Err(err.into()),
        };
        for entry in entries {
            let path = entry?.path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            match read::<Job>(&path) {
                Ok(job) if valid_id(&job.id).is_ok() && path == job_path(base, &job.id) => {
                    index.insert(base, &job)
                }
                _ => {
                    index.clean_index = false;
                    tracing::warn!("Skipped an invalid local voice receipt");
                }
            }
        }
        Ok(index)
    }

    pub fn insert(&mut self, base: &Path, job: &Job) {
        self.ids.insert(job.id.clone());
        if job.purpose != "preview" {
            self.by_project
                .entry(job.project.clone())
                .or_default()
                .insert(job.id.clone());
        }
        if let Some(key) = &job.request_key {
            let original = self
                .by_request
                .entry(job.project.clone())
                .or_default()
                .entry(key.clone())
                .or_insert_with(|| job.id.clone());
            if *original > job.id {
                original.clone_from(&job.id);
            }
        }
        if let Some(reference) = job.reference.as_ref().filter(|_| {
            !matches!(job.status.as_str(), "succeeded" | "cancelled")
                && (job.status == "running"
                    || owned_file(&run_dir(base, &job.id).join("output.wav")))
        }) {
            self.frozen_references
                .insert(job.id.clone(), (reference.into(), job.status == "running"));
        } else {
            self.frozen_references.remove(&job.id);
        }
    }

    pub fn request(&self, project: &str, key: &str) -> Option<&str> {
        Some(self.by_request.get(project)?.get(key)?.as_str())
    }

    pub fn history(
        &self,
        project: &str,
        before: Option<&str>,
        limit: usize,
    ) -> (Vec<String>, bool, bool) {
        let Some(history) = self.by_project.get(project) else {
            return (Vec::new(), false, false);
        };
        let entries = match before {
            Some(before) => history.range::<str, _>((
                std::ops::Bound::Unbounded,
                std::ops::Bound::Excluded(before),
            )),
            None => history.range::<str, _>(..),
        };
        let mut page: Vec<_> = entries.rev().take(limit + 1).cloned().collect();
        let has_more = page.len() > limit;
        page.truncate(limit);
        (page, has_more, !history.is_empty())
    }

    pub fn ids(&self) -> Vec<String> {
        self.ids.iter().rev().cloned().collect()
    }
}

pub(super) fn owned_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir() && !is_redirect(&metadata))
}

pub(super) fn owned_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file() && !is_redirect(&metadata))
}

fn is_redirect(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Also reject junctions and mount points, which are not always reported as symlinks.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

pub(super) fn run_dir(base: &Path, id: &str) -> PathBuf {
    base.join("runs").join(id)
}

pub(super) fn remove_file(path: &Path) {
    if owned_file(path) {
        if let Err(err) = fs::remove_file(path) {
            tracing::warn!("Could not clean a local voice file: {err}");
        }
    }
}

fn owned_run(base: &Path, id: &str) -> Option<PathBuf> {
    let dir = run_dir(base, id);
    (valid_id(id).is_ok() && owned_dir(base) && owned_dir(&base.join("runs")) && owned_dir(&dir))
        .then_some(dir)
}

fn clear_intermediates(dir: &Path) {
    for file in [
        "output.partial.wav",
        "reference.wav",
        "reference.partial.wav",
        "reference.prepared.wav",
        "runner.py",
        "status.json",
    ] {
        remove_file(&dir.join(file));
    }
}

pub(super) fn cleanup_terminal(base: &Path, job: &Job) {
    if matches!(job.status.as_str(), "succeeded" | "cancelled") {
        if let Some(dir) = owned_run(base, &job.id) {
            clear_intermediates(&dir);
            remove_file(&dir.join("output.wav"));
        }
    }
}

pub(super) fn diagnostic(base: &Path, id: &str) -> Option<PathBuf> {
    let path = owned_run(base, id)?.join("diagnostic.log");
    owned_file(&path).then_some(path)
}

fn expired(path: &Path, age: Duration) -> bool {
    fs::symlink_metadata(path)
        .and_then(|metadata| metadata.modified())
        .is_ok_and(|modified| modified.elapsed().is_ok_and(|elapsed| elapsed >= age))
}

pub(super) fn prune_run(base: &Path, job: &Job, diagnostics: &mut usize) {
    let Some(dir) = owned_run(base, &job.id) else {
        return;
    };
    let output = dir.join("output.wav");
    clear_intermediates(&dir);
    if matches!(job.status.as_str(), "succeeded" | "cancelled") || expired(&output, RECOVERY_AGE) {
        remove_file(&output);
    }
    let log = dir.join("diagnostic.log");
    if owned_file(&log) {
        if *diagnostics >= DIAGNOSTIC_LIMIT || expired(&log, DIAGNOSTIC_AGE) {
            remove_file(&log);
        } else {
            *diagnostics += 1;
        }
    }
}

pub(super) fn cleanup_references(base: &Path, index: &Jobs) -> AppResult<()> {
    let references = base.join("references");
    let voices = base.join("voices");
    if !index.clean_index
        || !owned_dir(base)
        || !owned_dir(&references)
        || (voices.exists() && !owned_dir(&voices))
    {
        return Ok(());
    }
    let profiles: Vec<Voice> = records(&voices)?;
    let mut referenced: HashSet<PathBuf> = profiles
        .into_iter()
        .map(|voice| PathBuf::from(voice.reference))
        .collect();
    for (id, (reference, running)) in &index.frozen_references {
        if *running || owned_file(&run_dir(base, id).join("output.wav")) {
            referenced.insert(reference.clone());
        }
    }
    let canonical_references: HashSet<_> = referenced
        .iter()
        .filter_map(|path| path.canonicalize().ok())
        .collect();
    for entry in fs::read_dir(references)? {
        let path = entry?.path();
        if path.extension().is_some_and(|ext| ext == "wav")
            && path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .is_some_and(|stem| valid_id(stem).is_ok())
            && !referenced.contains(&path)
        {
            // Historic records can use a different case or a Windows verbatim prefix.
            if path
                .canonicalize()
                .is_ok_and(|canonical| canonical_references.contains(&canonical))
            {
                continue;
            }
            remove_file(&path);
        }
    }
    Ok(())
}
