//! Disposable, alpha-preserving canvas previews. Asset originals and JPEG thumbnails stay untouched.
use crate::{
    core::paths::LibraryPaths,
    db::Database,
    error::{AppError, AppResult},
};
use fast_image_resize as resize;
use image::{
    codecs::{
        bmp::BmpDecoder,
        png::{PngDecoder, PngEncoder},
        webp::WebPDecoder,
    },
    DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits,
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::BufReader,
    num::NonZeroU32,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{AppHandle, Manager, State};

// A single decode bounds peak memory and lets queued duplicate keys reuse the first result.
static PREVIEW_QUEUE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
const CACHE_VERSION: &str = "canvas-image-previews-v1";
const MAX_PIXELS: u64 = 32_000_000;
const MAX_DECODE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_CACHE_FILES: usize = 512;
const MAX_CACHE_BYTES: u64 = 512 * 1024 * 1024;

#[tauri::command]
pub async fn canvas_image_preview(
    app: AppHandle,
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    path: String,
    max_size: u32,
) -> Result<String, AppError> {
    if ![512, 1024, 2048].contains(&max_size) {
        return Err(AppError::Other("不支持的画布预览尺寸".into()));
    }
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Other(e.to_string()))?
        .join(CACHE_VERSION);
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    let permit = PREVIEW_QUEUE
        .acquire()
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;
    let preview = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let source = super::library::readable_image_path(&paths, &db, &path)?;
        image_preview(&source, &cache, max_size)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    app.asset_protocol_scope()
        .allow_file(&preview)
        .map_err(|e| AppError::Other(e.to_string()))?;
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
    let format = ImageReader::open(source)?.with_guessed_format()?.format();
    let file = BufReader::new(fs::File::open(source)?);
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

// Scan only after a new write; cache hits do no directory work. Unknown files stay untouched.
fn trim_cache(cache: &Path, keep: &Path, max_files: usize, max_bytes: u64) {
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
            Some((
                metadata
                    .modified()
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
                entry.path(),
                metadata.len(),
            ))
        })
        .collect();
    let mut count = files.len();
    let mut bytes: u64 = files.iter().map(|(_, _, size)| *size).sum();
    files.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    for (_, path, size) in files {
        if count <= max_files && bytes <= max_bytes {
            break;
        }
        if path != keep && fs::remove_file(&path).is_ok() {
            count -= 1;
            bytes -= size;
        }
    }
}

fn image_preview(source: &Path, cache: &Path, max_size: u32) -> AppResult<PathBuf> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" | "webp" | "bmp" => {}
        // Do not add native codec dependencies or freeze vector/animated originals for previews.
        "avif" | "ico" | "gif" | "svg" => return Ok(source.to_path_buf()),
        _ => return Err(AppError::Other("不支持的画布图片格式".into())),
    }
    let key = cache_key(source, &fs::metadata(source)?, max_size)?;
    let destination = cache.join(format!("{key}.png"));
    if image::image_dimensions(&destination)
        .is_ok_and(|(w, h)| w > 0 && h > 0 && w.max(h) <= max_size)
    {
        return Ok(destination);
    }
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
    let mut encoder = PngEncoder::new(temporary.as_file_mut());
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
    // Only complete files become visible. An invalid old cache entry is safe to replace.
    if destination.exists() {
        fs::remove_file(&destination)?;
    }
    match temporary.persist_noclobber(&destination) {
        Ok(_) => {}
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.error.into()),
    }
    trim_cache(cache, &destination, MAX_CACHE_FILES, MAX_CACHE_BYTES);
    Ok(destination)
}

#[cfg(test)]
#[path = "canvas_image_preview_tests.rs"]
mod tests;
