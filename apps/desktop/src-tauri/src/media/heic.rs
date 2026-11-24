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
    #[cfg(target_os = "macos")]
    if let Ok(context) = heic_rs::context::Context::open(&bytes) {
        if let Ok(props) = context.props(context.meta.primary) {
            if props.icc.is_some() || props.nclx.is_some_and(|n| matches!(n.primaries, 9 | 11 | 12) || matches!(n.transfer, 16 | 18)) {
                let (width, height) = (decoded.width, decoded.height);
                drop(decoded);
                let dst = native_path(destination)?;
                // ImageIO receives the same bytes accepted by the strict, size-limited decoder.
                let ok = unsafe { bb_heic_color_png(bytes.as_ptr(), bytes.len(), dst.as_ptr(), width, height) };
                return if ok { Ok(()) } else { Err(AppError::Other("无法生成 HEIC 颜色预览".into())) };
            }
        }
    }
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

#[cfg(target_os = "macos")]
extern "C" {
    fn bb_heic_color_png(bytes: *const u8, length: usize, dst: *const std::ffi::c_char, width: u32, height: u32) -> bool;
    fn bb_heic_srgb_thumbnail(png: *const std::ffi::c_char, dst: *const std::ffi::c_char, size: u32) -> bool;
}

#[cfg(target_os = "macos")]
fn native_path(path: &Path) -> AppResult<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| AppError::Other("图片文件路径无效".into()))
}

pub fn thumbnail(png: &Path, destination: &Path, size: u32) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        let src = native_path(png)?;
        let dst = native_path(destination)?;
        if unsafe { bb_heic_srgb_thumbnail(src.as_ptr(), dst.as_ptr(), size) } { Ok(()) }
        else { Err(AppError::Other("无法生成 HEIC 缩略图".into())) }
    }
    #[cfg(not(target_os = "macos"))]
    super::thumb::generate(png, destination, size)
}
