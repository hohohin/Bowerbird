//! Normalize the primary HEIC/HEIF still image for browser previews and AI inputs.
use std::{fs::File, io::Read, path::Path};

use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder};

use crate::error::{AppError, AppResult};

const MAX_BYTES: u64 = 50 * 1024 * 1024;
const MAX_PIXELS: u64 = 100_000_000;

pub fn is_path(path: &Path) -> bool {
    path.extension().and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("heic") || ext.eq_ignore_ascii_case("heif"))
}

/// Inspect the container, never trust a browser's filename or MIME type.
pub fn is_heic(bytes: &[u8]) -> bool {
    heic_rs::ftyp::parse(bytes).is_ok_and(|kind| kind.effective.is_decodable())
}

pub fn convert_to_png(source: &Path, destination: &Path) -> AppResult<()> {
    let mut bytes = Vec::new();
    File::open(source)?.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(AppError::Other("HEIC 图片不能超过 50 MB".into()));
    }
    let options = heic_rs::DecodeOptions::default()
        .with_layout(heic_rs::PixelLayout::Rgba8)
        .with_max_pixels(Some(MAX_PIXELS))
        .with_strict(true);
    let decoded = heic_rs::decode(&bytes, &options).map_err(|error| {
        tracing::warn!("HEIC decode failed: {error}");
        AppError::Other("无法读取这张 HEIC 图片，请确认文件完整，或导出为 PNG、JPEG 后重试".into())
    })?;
    let mut encoder = PngEncoder::new(File::create(destination)?);
    // Preserve an embedded colour profile; orientation is already baked into pixels.
    if let Ok(context) = heic_rs::context::Context::open(&bytes) {
        if let Some(icc) = context.props(context.meta.primary).ok().and_then(|props| props.icc) {
            encoder.set_icc_profile(icc.to_vec()).map_err(image::ImageError::Unsupported)?;
        }
    }
    encoder.write_image(&decoded.data, decoded.width, decoded.height, ExtendedColorType::Rgba8)?;
    Ok(())
}
