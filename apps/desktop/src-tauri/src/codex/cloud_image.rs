use std::path::Path;

use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{ExtendedColorType, ImageBuffer, ImageReader, Rgb};

use crate::error::AppError;

const CLOUD_IMAGE_MAX_EDGE: u32 = 1_600;
const CLOUD_IMAGE_JPEG_QUALITY: u8 = 88;
const ARK_REFERENCE_MAX_BYTES: usize = 10 * 1024 * 1024;

/// 把本地素材规范化为请求期内存 JPEG。原始文件不变；容器元数据、动画帧与透明通道
/// 不会上传。生成参考图额外执行方舟的最小尺寸与宽高比约束。
pub(super) async fn read_cloud_jpeg(
    path: &Path,
    generation_reference: bool,
) -> Result<serde_json::Value, AppError> {
    let path = path.to_path_buf();
    let bytes =
        tokio::task::spawn_blocking(move || prepare_cloud_jpeg(&path, generation_reference))
            .await
            .map_err(|error| AppError::Cloud(format!("图片预处理任务失败: {error}")))??;
    Ok(serde_json::json!({
        "mime": "image/jpeg",
        "base64": base64::engine::general_purpose::STANDARD.encode(bytes),
    }))
}

/// Agent Run 上传沿用 Cloud 生图的隐私与兼容处理：解码后缩边、扁平透明通道、
/// 重新编码 JPEG，从而不上传原文件容器元数据或 EXIF。
pub(crate) async fn read_agent_reference_jpeg(path: &Path) -> Result<Vec<u8>, AppError> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || prepare_cloud_jpeg(&path, true))
        .await
        .map_err(|error| AppError::Cloud(format!("图片预处理任务失败: {error}")))?
}

fn prepare_cloud_jpeg(path: &Path, generation_reference: bool) -> Result<Vec<u8>, AppError> {
    let decoded = ImageReader::open(path)
        .and_then(|reader| reader.with_guessed_format())
        .map_err(|error| AppError::Cloud(format!("读取图片 {} 失败: {error}", path.display())))?
        .decode()
        .map_err(|error| AppError::Cloud(format!("解析图片 {} 失败: {error}", path.display())))?;

    if generation_reference {
        let (width, height) = (decoded.width(), decoded.height());
        if width <= 14 || height <= 14 {
            return Err(AppError::Cloud(format!(
                "参考图 {} 尺寸过小，宽高都必须大于 14 像素",
                path.display()
            )));
        }
        let long = width.max(height) as f64;
        let short = width.min(height) as f64;
        if long / short > 3.0 {
            return Err(AppError::Cloud(format!(
                "参考图 {} 宽高比超出方舟支持范围（1:3–3:1）",
                path.display()
            )));
        }
    }

    let longest = decoded.width().max(decoded.height());
    let normalized = if longest > CLOUD_IMAGE_MAX_EDGE {
        let width =
            ((decoded.width() as u64 * CLOUD_IMAGE_MAX_EDGE as u64) / longest as u64).max(1) as u32;
        let height = ((decoded.height() as u64 * CLOUD_IMAGE_MAX_EDGE as u64) / longest as u64)
            .max(1) as u32;
        decoded.resize(width, height, FilterType::Lanczos3)
    } else {
        decoded
    };

    let rgba = normalized.to_rgba8();
    let (width, height) = rgba.dimensions();
    let rgb = ImageBuffer::<Rgb<u8>, Vec<u8>>::from_fn(width, height, |x, y| {
        let pixel = rgba.get_pixel(x, y).0;
        let alpha = pixel[3] as u16;
        let blend = |channel: u8| ((channel as u16 * alpha + 255 * (255 - alpha)) / 255) as u8;
        Rgb([blend(pixel[0]), blend(pixel[1]), blend(pixel[2])])
    });

    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, CLOUD_IMAGE_JPEG_QUALITY)
        .encode(&rgb, width, height, ExtendedColorType::Rgb8)
        .map_err(|error| AppError::Cloud(format!("编码云端图片失败: {error}")))?;
    if bytes.len() > ARK_REFERENCE_MAX_BYTES {
        return Err(AppError::Cloud(format!(
            "参考图 {} 转换后超过方舟 10 MB 限制",
            path.display()
        )));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use base64::Engine;
    use image::{DynamicImage, GenericImageView, ImageBuffer, ImageFormat, Rgba};

    use super::{read_cloud_jpeg, CLOUD_IMAGE_MAX_EDGE};

    #[tokio::test]
    async fn webp_is_resized_flattened_and_encoded_as_real_jpeg() {
        let path = std::env::temp_dir().join(format!(
            "bowerbird-cloud-reference-{}.webp",
            ulid::Ulid::new()
        ));
        let source =
            DynamicImage::ImageRgba8(ImageBuffer::from_pixel(3_200, 1_600, Rgba([10, 20, 30, 0])));
        source.save_with_format(&path, ImageFormat::WebP).unwrap();

        let payload = read_cloud_jpeg(&path, true).await.unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload["base64"].as_str().unwrap())
            .unwrap();
        let output = image::load_from_memory_with_format(&bytes, ImageFormat::Jpeg).unwrap();

        assert_eq!(payload["mime"], "image/jpeg");
        assert!(bytes.starts_with(&[0xff, 0xd8, 0xff]));
        assert_eq!(output.dimensions(), (CLOUD_IMAGE_MAX_EDGE, 800));
        let pixel = output.to_rgb8().get_pixel(0, 0).0;
        assert!(pixel.iter().all(|channel| *channel > 245));
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn generation_reference_rejects_unsupported_aspect_ratio() {
        let path = std::env::temp_dir().join(format!(
            "bowerbird-cloud-reference-{}.png",
            ulid::Ulid::new()
        ));
        DynamicImage::new_rgb8(400, 100)
            .save_with_format(&path, ImageFormat::Png)
            .unwrap();

        let error = read_cloud_jpeg(&path, true).await.unwrap_err();
        assert!(error.to_string().contains("宽高比超出"));
        let _ = std::fs::remove_file(path);
    }
}
