use std::path::Path;

pub struct DragImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub scale: f64,
}

/// Decode only the registered cache on a worker; never generate a preview during a drag.
pub fn load(path: &Path, scale: f64, light: bool) -> Option<DragImage> {
    use std::io::{Cursor, Read};
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > 8 * 1024 * 1024 {
        return None;
    }
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().ok()?;
    let scale = if scale.is_finite() {
        scale.clamp(1.0, 3.0)
    } else {
        1.0
    };
    let factor = (144.0 * scale / image.width() as f64)
        .min(180.0 * scale / image.height() as f64)
        .min(1.0);
    let width = (image.width() as f64 * factor).round().max(1.0) as u32;
    let height = (image.height() as f64 * factor).round().max(1.0) as u32;
    let mut pixels = image
        .resize_exact(width, height, image::imageops::FilterType::Triangle)
        .into_rgba8();
    mark_edges(&mut pixels, scale, light);
    Some(DragImage {
        width,
        height,
        rgba: pixels.into_raw(),
        scale,
    })
}

fn mark_edges(pixels: &mut image::RgbaImage, scale: f64, light: bool) {
    let (w, h) = pixels.dimensions();
    let dot = (3.0 * scale) as u32;
    let line = scale.round() as u32;
    let color = if light {
        [43, 43, 43, 255]
    } else {
        [220, 220, 220, 255]
    };
    for y in 0..h {
        for x in 0..w {
            let dx = x.min(w - 1 - x);
            let dy = y.min(h - 1 - y);
            if (dx < dot && dy < dot)
                || (dy < line && dx < (16.0 * scale) as u32)
                || (dx < line && dy < (12.0 * scale) as u32)
            {
                pixels.put_pixel(x, y, image::Rgba(color));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cached_thumbnail_keeps_ratio_color_and_transparency_without_padding() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("cached.png");
        let mut original = image::RgbaImage::from_pixel(100, 200, image::Rgba([40, 80, 160, 128]));
        original.put_pixel(50, 100, image::Rgba([0, 0, 0, 0]));
        original.save(&path).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let result = load(&path, 2.0, false).expect("cached thumbnail produces a native image");
        assert_eq!((result.width, result.height), (100, 200));
        assert_eq!(
            &result.rgba[(20 * 100 + 20) * 4..][..4],
            &[40, 80, 160, 128]
        );
        assert_eq!(result.rgba[(100 * 100 + 50) * 4 + 3], 0);
        assert_eq!(result.rgba[3], 255, "square corner marks stay visible");
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
    #[test]
    fn large_cache_is_bounded_and_corrupt_or_excessive_images_fall_back() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("cached.png");
        image::RgbaImage::new(800, 400).save(&path).unwrap();
        let result = load(&path, 1.0, true).unwrap();
        assert_eq!((result.width, result.height), (144, 72));
        std::fs::write(&path, b"broken image").unwrap();
        assert!(load(&path, 1.0, false).is_none());
        image::RgbaImage::new(4097, 1).save(&path).unwrap();
        assert!(load(&path, 1.0, false).is_none());
    }
}
