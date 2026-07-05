//! 媒体处理：探测 / 缩略图 / pHash（去重）。
//! Phase 1 覆盖常见光栅图；视频/PSD/SVG 在 Phase 2 接入。

pub mod color;
pub mod phash;
pub mod probe;
pub mod thumb;

/// 判断扩展名是否为支持的图片格式（用于文件夹导入过滤）。
pub fn is_image_ext(ext: &str) -> bool {
    matches!(
        ext.to_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "tiff" | "tif"
    )
}
