//! Disposable, alpha-preserving canvas previews. Asset originals and JPEG thumbnails stay untouched.
use crate::{
    core::{external_files, paths::LibraryPaths},
    db::Database,
    error::{AppError, AppResult},
};
use fast_image_resize as resize;
use image::{
    codecs::{
        bmp::BmpDecoder,
        png::{CompressionType, FilterType, PngDecoder, PngEncoder},
        webp::WebPDecoder,
    },
    DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{BufReader, Seek},
    num::NonZeroU32,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex, Weak,
    },
    time::SystemTime,
};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{Mutex as AsyncMutex, OnceCell, Semaphore};

const CACHE_VERSION: &str = "canvas-image-previews-v1";
const MAX_PIXELS: u64 = 32_000_000;
const MAX_DECODE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_CACHE_FILES: usize = 512;
const MAX_CACHE_BYTES: u64 = 512 * 1024 * 1024;

const TRIM_EVERY_WRITES: usize = 16;

pub(crate) struct PreviewCache {
    directory: OnceCell<PathBuf>,
    decodes: Arc<Semaphore>,
    flights: Mutex<HashMap<PathBuf, Weak<AsyncMutex<()>>>>,
    recent: Mutex<HashMap<PathBuf, SystemTime>>,
    writes: AtomicUsize,
    trimming: Mutex<()>,
}

impl Default for PreviewCache {
    fn default() -> Self {
        Self {
            directory: OnceCell::new(),
            decodes: Arc::new(Semaphore::new(2)),
            flights: Mutex::new(HashMap::new()),
            recent: Mutex::new(HashMap::new()),
            writes: AtomicUsize::new(0),
            trimming: Mutex::new(()),
        }
    }
}

enum PreviewPlan {
    Ready(PathBuf),
    Generate {
        source: PathBuf,
        destination: PathBuf,
        key: String,
    },
}

impl PreviewCache {
    fn flight(&self, destination: &Path) -> Arc<AsyncMutex<()>> {
        let mut flights = self.flights.lock().unwrap();
        if let Some(flight) = flights.get(destination).and_then(Weak::upgrade) {
            return flight;
        }
        flights.retain(|_, flight| flight.strong_count() > 0);
        let flight = Arc::new(AsyncMutex::new(()));
        flights.insert(destination.to_owned(), Arc::downgrade(&flight));
        flight
    }

    fn record_access(&self, path: &Path) {
        self.recent
            .lock()
            .unwrap()
            .insert(path.to_owned(), SystemTime::now());
    }

    fn reuse(&self, path: &Path, max_size: u32) -> bool {
        if !is_cached(path, max_size) {
            return false;
        }
        let mut recent = self.recent.lock().unwrap();
        if !path.is_file() {
            return false; // A trim completed between opening the file and taking this lock.
        }
        recent.insert(path.to_owned(), SystemTime::now());
        true
    }

    async fn preview(
        self: &Arc<Self>,
        cache: PathBuf,
        max_size: u32,
        resolve: impl FnOnce() -> AppResult<PathBuf> + Send + 'static,
    ) -> AppResult<PathBuf> {
        let workers = self.clone();
        let directory = cache.clone();
        let plan = tokio::task::spawn_blocking(move || {
            let source = resolve()?;
            if !previewable(&source)? {
                return Ok::<_, AppError>(PreviewPlan::Ready(source));
            }
            let key = cache_key(&source, &fs::metadata(&source)?, max_size)?;
            let destination = directory.join(format!("{key}.png"));
            Ok(if workers.reuse(&destination, max_size) {
                PreviewPlan::Ready(destination)
            } else {
                PreviewPlan::Generate {
                    source,
                    destination,
                    key,
                }
            })
        })
        .await
        .map_err(join_error)??;
        let (source, destination, key) = match plan {
            PreviewPlan::Ready(path) => return Ok(path),
            PreviewPlan::Generate {
                source,
                destination,
                key,
            } => (source, destination, key),
        };
        let flight = self.flight(&destination).lock_owned().await;
        let worker = self.clone();
        let cached = destination.clone();
        if tokio::task::spawn_blocking(move || worker.reuse(&cached, max_size))
            .await
            .map_err(join_error)?
        {
            return Ok(destination);
        }
        let permit = self
            .decodes
            .clone()
            .acquire_owned()
            .await
            .map_err(join_error)?;
        let workers = self.clone();
        tokio::task::spawn_blocking(move || {
            // Retain both guards until blocking work exits, even if the IPC request is cancelled.
            let (_flight, _permit) = (flight, permit);
            let result = generate_preview(&source, &cache, &destination, &key, max_size)?;
            if result == destination {
                workers.record_access(&result);
                if workers.writes.fetch_add(1, Ordering::Relaxed) % TRIM_EVERY_WRITES == 0 {
                    let keep = result.clone();
                    tokio::task::spawn_blocking(move || {
                        let Ok(_trim) = workers.trimming.try_lock() else {
                            return;
                        };
                        trim_cache(
                            &cache,
                            &keep,
                            MAX_CACHE_FILES,
                            MAX_CACHE_BYTES,
                            &workers.recent,
                        );
                    });
                }
            }
            Ok(result)
        })
        .await
        .map_err(join_error)?
    }
}

fn join_error(error: impl std::fmt::Display) -> AppError {
    AppError::Other(error.to_string())
}

#[tauri::command]
pub async fn canvas_image_preview(
    app: AppHandle,
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    previews: State<'_, Arc<PreviewCache>>,
    path: String,
    max_size: u32,
) -> Result<String, AppError> {
    if ![512, 1024, 2048].contains(&max_size) {
        return Err(AppError::Other("不支持的画布预览尺寸".into()));
    }
    let cache = previews
        .directory
        .get_or_try_init(|| async {
            let cache = app
                .path()
                .app_cache_dir()
                .map_err(join_error)?
                .join(CACHE_VERSION);
            app.asset_protocol_scope()
                .allow_directory(&cache, false)
                .map_err(join_error)?;
            Ok::<_, AppError>(cache)
        })
        .await?;
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    let (source, heic_preview) = tokio::task::spawn_blocking({
        let paths = paths.clone();
        move || {
            let source = super::library::registered_image_path(&paths, &db, &path)?;
            let heic_preview = crate::media::heic::is_path(&source)
                .then(|| {
                    external_files::compatible_image_destination(
                        &paths.root.join("external-previews"),
                        &source,
                    )
                    .map(|destination| {
                        let warm = destination.is_file();
                        (destination, warm)
                    })
                })
                .transpose()?;
            Ok::<_, AppError>((source, heic_preview))
        }
    })
    .await
    .map_err(join_error)??;
    let source = if let Some((destination, warm)) = heic_preview {
        if warm {
            destination
        } else {
            let flight = previews.flight(&destination).lock_owned().await;
            if tokio::fs::metadata(&destination)
                .await
                .is_ok_and(|metadata| metadata.is_file())
            {
                destination
            } else {
                let permit = previews
                    .decodes
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(join_error)?;
                tokio::task::spawn_blocking(move || {
                    let (_flight, _permit) = (flight, permit);
                    external_files::compatible_image(&paths, &source)
                })
                .await
                .map_err(join_error)??
            }
        }
    } else {
        source
    };
    let preview = previews
        .inner()
        .preview(cache.clone(), max_size, || Ok(source))
        .await?;
    if preview.parent() != Some(cache.as_path()) {
        let scope = app.asset_protocol_scope();
        if !scope.is_allowed(&preview) {
            scope.allow_file(&preview).map_err(join_error)?;
        }
    }
    Ok(preview.to_string_lossy().into_owned())
}

fn cache_key(source: &Path, metadata: &fs::Metadata, max_size: u32) -> AppResult<String> {
    let mut digest = Sha256::new();
    digest.update(CACHE_VERSION.as_bytes());
    digest.update(source.as_os_str().as_encoded_bytes());
    digest.update(metadata.len().to_le_bytes());
    digest.update(format!("{:?}", metadata.modified()?).as_bytes());
    digest.update(max_size.to_le_bytes());
    Ok(format!("{:x}", digest.finalize()))
}

fn decoder_limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    limits
}

/// None means the browser should retain the original (including animations/unsupported codecs).
fn static_decoder(source: &Path) -> AppResult<Option<Box<dyn ImageDecoder>>> {
    let reader = ImageReader::new(BufReader::new(fs::File::open(source)?)).with_guessed_format()?;
    let format = reader.format();
    let mut file = reader.into_inner();
    file.rewind()?;
    let mut decoder: Box<dyn ImageDecoder> = match format {
        Some(ImageFormat::Png) => {
            let decoder = PngDecoder::with_limits(file, decoder_limits())?;
            if decoder.is_apng()? {
                return Ok(None);
            }
            Box::new(decoder)
        }
        Some(ImageFormat::WebP) => {
            let decoder = WebPDecoder::new(file)?;
            if decoder.has_animation() {
                return Ok(None);
            }
            Box::new(decoder)
        }
        Some(ImageFormat::Bmp) => Box::new(BmpDecoder::new(file)?),
        _ => return Ok(None),
    };
    decoder.set_limits(decoder_limits())?;
    Ok(Some(decoder))
}

fn resize_rgba(image: DynamicImage, max_size: u32) -> AppResult<resize::Image<'static>> {
    let dimension =
        |value| NonZeroU32::new(value).ok_or_else(|| AppError::Media("图片尺寸无效".into()));
    let (width, height) = (image.width(), image.height());
    let scale = f64::from(max_size) / f64::from(width.max(height));
    let mut source = resize::Image::from_vec_u8(
        dimension(width)?,
        dimension(height)?,
        image.into_rgba8().into_raw(),
        resize::PixelType::U8x4,
    )
    .map_err(|e| AppError::Media(e.to_string()))?;
    let mut result = resize::Image::new(
        dimension((f64::from(width) * scale).round().max(1.) as u32)?,
        dimension((f64::from(height) * scale).round().max(1.) as u32)?,
        resize::PixelType::U8x4,
    );
    // Filter premultiplied colors so invisible RGB cannot leave a fringe at alpha edges.
    let alpha = resize::MulDiv::default();
    alpha
        .multiply_alpha_inplace(&mut source.view_mut())
        .map_err(|e| AppError::Media(e.to_string()))?;
    resize::Resizer::new(resize::ResizeAlg::Convolution(resize::FilterType::Lanczos3))
        .resize(&source.view(), &mut result.view_mut())
        .map_err(|e| AppError::Media(e.to_string()))?;
    alpha
        .divide_alpha_inplace(&mut result.view_mut())
        .map_err(|e| AppError::Media(e.to_string()))?;
    Ok(result)
}

// Eviction runs off the request path. Unknown files stay untouched.
fn trim_cache(
    cache: &Path,
    keep: &Path,
    max_files: usize,
    max_bytes: u64,
    recent: &Mutex<HashMap<PathBuf, SystemTime>>,
) {
    let access = recent.lock().unwrap().clone();
    let Ok(entries) = fs::read_dir(cache) else {
        return;
    };
    let mut files: Vec<_> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            if name.len() != 68
                || !name.ends_with(".png")
                || !name.as_bytes()[..64]
                    .iter()
                    .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(value))
                || !entry.file_type().ok()?.is_file()
            {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            let path = entry.path();
            let accessed = access
                .get(&path)
                .copied()
                .or_else(|| metadata.modified().ok())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            Some((accessed, path, metadata.len()))
        })
        .collect();
    let mut count = files.len();
    let mut bytes: u64 = files.iter().map(|(_, _, size)| *size).sum();
    files.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    for (accessed, path, size) in files {
        if count <= max_files && bytes <= max_bytes {
            break;
        }
        let mut recent = recent.lock().unwrap();
        if path != keep
            && recent.get(&path).is_none_or(|at| *at <= accessed)
            && fs::remove_file(&path).is_ok()
        {
            recent.remove(&path);
            count -= 1;
            bytes -= size;
        }
    }
}

fn previewable(source: &Path) -> AppResult<bool> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" | "webp" | "bmp" => Ok(true),
        // Keep browser-native handling of vector, animated and unsupported formats.
        "avif" | "ico" | "gif" | "svg" => Ok(false),
        _ => Err(AppError::Other("不支持的画布图片格式".into())),
    }
}

fn is_cached(destination: &Path, max_size: u32) -> bool {
    fs::symlink_metadata(destination).is_ok_and(|metadata| metadata.is_file())
        && image::image_dimensions(destination)
            .is_ok_and(|(w, h)| w > 0 && h > 0 && w.max(h) <= max_size)
}

fn generate_preview(
    source: &Path,
    cache: &Path,
    destination: &Path,
    key: &str,
    max_size: u32,
) -> AppResult<PathBuf> {
    let Some(mut decoder) = static_decoder(source)? else {
        return Ok(source.to_path_buf());
    };
    let (width, height) = decoder.dimensions();
    if width.max(height) <= max_size {
        return Ok(source.to_path_buf());
    }
    if u64::from(width) * u64::from(height) > MAX_PIXELS || decoder.total_bytes() > MAX_DECODE_BYTES
    {
        return Ok(source.to_path_buf());
    }
    let profile = decoder.icc_profile()?;
    let orientation = decoder.orientation()?;
    let mut decoded = DynamicImage::from_decoder(decoder)?;
    decoded.apply_orientation(orientation);
    let resized = resize_rgba(decoded, max_size)?;
    fs::create_dir_all(cache)?;
    let mut temporary = tempfile::NamedTempFile::new_in(cache)?;
    let mut encoder = PngEncoder::new_with_quality(
        temporary.as_file_mut(),
        CompressionType::Fast,
        FilterType::Adaptive,
    );
    if let Some(profile) = profile {
        encoder
            .set_icc_profile(profile)
            .map_err(image::ImageError::Unsupported)?;
    }
    encoder.write_image(
        resized.buffer(),
        resized.width().get(),
        resized.height().get(),
        image::ExtendedColorType::Rgba8,
    )?;
    if cache_key(source, &fs::metadata(source)?, max_size)? != key {
        return Err(AppError::Other("图片正在变化，请重新载入预览".into()));
    }
    // Both platforms replace only after encoding completes. A reader may hold an old file open on Windows.
    if let Err(error) = temporary.persist(destination) {
        if !is_cached(destination, max_size) {
            return Err(error.error.into());
        }
    }
    Ok(destination.to_owned())
}

#[cfg(test)]
#[path = "canvas_image_preview_tests.rs"]
mod tests;
