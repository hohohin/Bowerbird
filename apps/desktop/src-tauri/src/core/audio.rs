//! Registered audio originals and disposable, bounded waveform cache.
use crate::{
    core::{external_files, paths::LibraryPaths},
    db::Database,
    error::{AppError, AppResult},
    media::audio::Waveform,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex, Weak},
    time::{SystemTime, UNIX_EPOCH},
};

const ALGORITHM: &str = "audio-merged-extrema-v3-2048";
const CACHE_BUDGET: u64 = 128 * 1024 * 1024;
const MAX_CACHE_ITEM: u64 = 512 * 1024;
static CACHE_WRITER: Mutex<()> = Mutex::new(());
static SOURCES: LazyLock<Mutex<HashMap<String, Weak<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioWaveform {
    pub source_version: String,
    #[serde(flatten)]
    pub waveform: Waveform,
    #[serde(skip)]
    pub(crate) source_path: PathBuf,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct Stamp {
    bytes: u64,
    modified_nanos: String,
}
impl Stamp {
    fn read(path: &Path) -> AppResult<Self> {
        let value = fs::metadata(path)?;
        if !value.is_file() {
            return Err(changed());
        }
        let modified = value
            .modified()?
            .duration_since(UNIX_EPOCH)
            .map_err(|error| AppError::Media(error.to_string()))?;
        Ok(Self {
            bytes: value.len(),
            modified_nanos: modified.as_nanos().to_string(),
        })
    }
}

#[derive(Serialize, Deserialize)]
struct Cached {
    algorithm: String,
    version: String,
    stamp: Stamp,
    waveform: Waveform,
}
struct Source {
    stored: String,
    path: PathBuf,
    version: String,
}
fn changed() -> AppError {
    AppError::Other("音频已变化，请刷新素材库后重试".into())
}

fn source_lock(id: &str) -> Arc<Mutex<()>> {
    let mut sources = SOURCES.lock().unwrap();
    sources.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = sources.get(id).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    sources.insert(id.to_string(), Arc::downgrade(&lock));
    lock
}

fn record(db: &Database, id: &str) -> AppResult<(String, Option<String>)> {
    db.conn.lock().unwrap().query_row(
        "SELECT a.store_path,COALESCE(e.fingerprint,f.sha256) FROM assets a LEFT JOIN external_assets e ON e.asset_id=a.id LEFT JOIN creative_file_fingerprints f ON f.asset_id=a.id WHERE a.id=?1",
        [id], |row| Ok((row.get(0)?, row.get(1)?))).optional()?.ok_or_else(|| AppError::Other("音频已不存在，请刷新素材库".into()))
}

fn source(db: &Database, id: &str) -> AppResult<Source> {
    let (stored, mut version) = record(db, id)?;
    let path = fs::canonicalize(&stored)
        .map_err(|_| AppError::Other("原音频不可用，请检查文件权限或重新定位".into()))?;
    if !external_files::audio_path(&path) {
        return Err(AppError::Other("请选择支持的音频文件".into()));
    }
    // Newly saved originals may precede their sidecar fingerprint. Establish it once,
    // without holding the database lock while reading source bytes.
    if version.is_none() {
        let before = Stamp::read(&path)?;
        let hash = external_files::fingerprint(&path)?;
        if Stamp::read(&path)? != before {
            return Err(changed());
        }
        let mtime = fs::metadata(&path)?
            .modified()?
            .duration_since(UNIX_EPOCH)
            .map_err(|error| AppError::Media(error.to_string()))?
            .as_secs() as i64;
        db.conn.lock().unwrap().execute("INSERT INTO creative_file_fingerprints(asset_id,sha256,asset_size,asset_mtime) SELECT id,?2,?3,?4 FROM assets WHERE id=?1 AND store_path=?5 ON CONFLICT(asset_id) DO NOTHING",
            params![id,hash,before.bytes as i64,mtime,stored])?;
        let current = record(db, id)?;
        if current.0 != stored {
            return Err(changed());
        }
        version = current.1;
    }
    Ok(Source {
        stored,
        path,
        version: version.ok_or_else(changed)?,
    })
}

fn verify(db: &Database, id: &str, source: &Source, stamp: &Stamp) -> AppResult<()> {
    let current = record(db, id)?;
    if current.0 != source.stored
        || current.1.as_deref() != Some(source.version.as_str())
        || Stamp::read(&source.path)? != *stamp
    {
        return Err(changed());
    }
    Ok(())
}

fn read_cache(path: &Path, source: &Source, stamp: &Stamp) -> Option<Waveform> {
    if fs::metadata(path).ok()?.len() > MAX_CACHE_ITEM {
        return None;
    }
    let cached: Cached = serde_json::from_reader(BufReader::new(File::open(path).ok()?)).ok()?;
    (cached.algorithm == ALGORITHM
        && cached.version == source.version
        && cached.stamp == *stamp
        && cached.waveform.valid())
    .then_some(cached.waveform)
}

fn touch(path: &Path) {
    if fs::metadata(path)
        .and_then(|value| value.modified())
        .ok()
        .and_then(|time| time.elapsed().ok())
        .is_some_and(|age| age.as_secs() >= 60)
    {
        if let Ok(file) = File::options().write(true).open(path) {
            let _ = file.set_modified(SystemTime::now());
        }
    }
}

/// Only our regular, hashed JSON entries participate; never follow symlinks or
/// remove source files. Cold publication serializes eviction; hot reads never scan.
fn prune_cache(directory: &Path, budget: u64, keep: &Path) -> AppResult<()> {
    let mut files = Vec::new();
    let mut bytes = 0u64;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let path = entry.path();
        let name = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if path.extension().and_then(|value| value.to_str()) != Some("json")
            || name.len() != 64
            || !name.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            continue;
        }
        let metadata = entry.metadata()?;
        bytes += metadata.len();
        files.push((
            metadata.modified().unwrap_or(UNIX_EPOCH),
            path,
            metadata.len(),
        ));
    }
    files.sort_by_key(|entry| entry.0);
    for (_, path, length) in files {
        if bytes <= budget {
            break;
        }
        if path != keep {
            fs::remove_file(&path)?;
            bytes = bytes.saturating_sub(length);
        }
    }
    Ok(())
}

fn publish(directory: &Path, destination: &Path, record: &Cached) -> AppResult<()> {
    let _writer = CACHE_WRITER.lock().unwrap();
    fs::create_dir_all(directory)?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    {
        let mut writer = BufWriter::new(temporary.as_file_mut());
        serde_json::to_writer(&mut writer, record)?;
        writer.flush()?;
    }
    temporary
        .persist(destination)
        .map_err(|error| error.error)?;
    prune_cache(directory, CACHE_BUDGET, destination)
}

pub fn waveform(
    paths: &LibraryPaths,
    db: &Database,
    asset: &str,
    expected: Option<&str>,
) -> AppResult<AudioWaveform> {
    waveform_using(paths, db, asset, expected, &crate::media::audio::decode)
}

fn waveform_using(
    paths: &LibraryPaths,
    db: &Database,
    asset: &str,
    expected: Option<&str>,
    decode: &dyn Fn(&Path) -> AppResult<Waveform>,
) -> AppResult<AudioWaveform> {
    let lock = source_lock(asset);
    let _source_guard = lock.lock().unwrap();
    let source = source(db, asset)?;
    if expected.is_some_and(|value| value != source.version) {
        return Err(changed());
    }
    let stamp = Stamp::read(&source.path)?;
    let key = format!(
        "{:x}",
        Sha256::digest(
            format!("{ALGORITHM}:{}:{}", source.path.display(), source.version).as_bytes()
        )
    );
    let directory = paths.root.join("audio-waveforms");
    let destination = directory.join(format!("{key}.json"));
    let waveform = if let Some(waveform) = read_cache(&destination, &source, &stamp) {
        touch(&destination);
        waveform
    } else {
        // Validate the already indexed revision on cache miss only. Hot requests do
        // not hash or decode the original again, including across folder references.
        if external_files::fingerprint(&source.path)? != source.version {
            return Err(changed());
        }
        verify(db, asset, &source, &stamp)?;
        let waveform = decode(&source.path)?;
        if !waveform.valid() {
            return Err(AppError::Media("音频波形无效，请检查文件是否完整".into()));
        }
        verify(db, asset, &source, &stamp)?;
        publish(
            &directory,
            &destination,
            &Cached {
                algorithm: ALGORITHM.into(),
                version: source.version.clone(),
                stamp: stamp.clone(),
                waveform: waveform.clone(),
            },
        )?;
        waveform
    };
    verify(db, asset, &source, &stamp)?;
    db.conn.lock().unwrap().execute("UPDATE assets SET duration=?2 WHERE id=?1 AND store_path=?3 AND COALESCE((SELECT fingerprint FROM external_assets WHERE asset_id=?1),(SELECT sha256 FROM creative_file_fingerprints WHERE asset_id=?1))=?4 AND COALESCE(duration,0)<>?2",
        params![asset,waveform.duration,source.stored,source.version])?;
    verify(db, asset, &source, &stamp)?;
    Ok(AudioWaveform {
        source_version: source.version,
        waveform,
        source_path: source.path,
    })
}

#[cfg(test)]
#[path = "audio_tests.rs"]
mod tests;
