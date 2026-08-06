//! 感知哈希（dHash，差值哈希），仅用于采集/导入去重（开发计划 §4.2 / §5.2）。
//!
//! 注：计划 §2.3 写的是 img_hash crate；实际 img_hash 3.2 绑定 image 0.23，
//! 与本项目 image 0.25 不兼容，故自实现 dHash。dHash 对亮度/对比度变化比 aHash
//! 更鲁棒，去重场景足够（完全重复 / 扩展重复抓取）。

use std::path::Path;

use image::imageops::FilterType;

use crate::error::AppResult;

/// 计算 64-bit dHash（hex 字符串）。解码失败返回 None（非图片等）。
pub fn compute(path: &Path) -> AppResult<Option<String>> {
    let img = match image::open(path) {
        Ok(i) => i,
        Err(_) => return Ok(None),
    };
    Ok(Some(compute_from_image(&img)))
}

/// 同 `compute`，但从已解码的 `DynamicImage` 计算（省一次 decode）。
pub fn compute_from_image(img: &image::DynamicImage) -> String {
    // 9×8 灰度，比较水平相邻像素 → 64 bit。
    let small = img
        .resize_exact(9, 8, FilterType::Nearest)
        .into_luma8();
    let mut bits: u64 = 0;
    let mut idx = 0u32;
    for y in 0..8 {
        for x in 0..8 {
            let left = small.get_pixel(x, y).0[0];
            let right = small.get_pixel(x + 1, y).0[0];
            if left > right {
                bits |= 1 << idx;
            }
            idx += 1;
        }
    }
    format!("{bits:016x}")
}

/// 海明距离（两 dHash 差异 bit 数，0=完全相同）。
/// 去重判定：dHash 差值 ≤ [`DEDUP_HAMMING_MAX`] 视为同一张图。
pub fn hamming(a: &str, b: &str) -> Option<u32> {
    let a = u64::from_str_radix(a, 16).ok()?;
    let b = u64::from_str_radix(b, 16).ok()?;
    Some((a ^ b).count_ones())
}

/// 该 dHash 是否「信息量足够」用于近重复判定。
///
/// 纯色 / 平滑渐变等低熵图，9×8 邻域比较会产生退化哈希（大量 bit 相同，甚至全 0，
/// 如纯色图全 0），两张不同的低熵图可能落到同值 → 模糊匹配会误判为重复。
/// 去重时对低熵哈希只做精确匹配（见 `find_asset_by_phash`）。
pub fn is_high_entropy(phash: &str) -> bool {
    u64::from_str_radix(phash, 16)
        .map(|value| value.count_ones() >= LOW_ENTROPY_MIN_BITS)
        .unwrap_or(false)
}

/// 低熵判定阈值：置位 bit 少于该值即视为退化哈希，仅精确匹配。
/// 64-bit dHash 均匀分布的期望置位数约 32；纯色/平滑渐变实测可低至 0。
/// 真实照片/插画的置位数实测 ≥ 12（存量库最小 12），故取 12：低于 12 个置位 bit
/// 说明图像几乎没有空间细节，模糊匹配不可信，退化为精确匹配。
const LOW_ENTROPY_MIN_BITS: u32 = 12;

/// 采集去重的 dHash 海明距离上限。
///
/// 同一张图被以不同分辨率采集（浏览器网格缩略图 vs 原图 / srcset 变体，如 Pinterest
/// 236w 与 474w）时，dHash 距离实测在个位数（远低于不同图），而真实不同图的最近距离
/// 在本库实测 ≥ 11。取 8 兼顾「抓全同图变体」与「不误并不同图」——若距离 = 该阈值仍
/// 命中候选，返回该候选（宁可归并到低清变体，也不让瀑布流出现两张一样的素材）。
pub const DEDUP_HAMMING_MAX: u32 = 8;

/// 测试共用：生成「照片感」测试图。
///
/// 粗网格（64×64）随机场 + 双线性放大（有限带宽纹理）。真实照片 = 构图（低频）+ 细节
/// （中高频）；dHash 在 9×8 采样下感知低频结构，因此同一场景不同分辨率应保持稳定
/// （低 hamming），不同 seed 的场景显著不同。
/// 注：直接随机噪声对缩放过于敏感；纯色/平滑渐变则低熵退化——都不代表真实素材。
#[cfg(test)]
pub(crate) mod testutil {
    use image::RgbImage;
    use std::path::{Path, PathBuf};

    pub(crate) fn make_photo(size: u32, seed: u8) -> RgbImage {
        const GRID: u32 = 64;
        let mut rng: u32 = (seed as u32).wrapping_mul(2654435761).wrapping_add(1);
        let mut next = move || {
            rng ^= rng.wrapping_shl(13);
            rng ^= rng.wrapping_shr(17);
            rng ^= rng.wrapping_shl(5);
            rng
        };
        let mut field = Vec::with_capacity((GRID * GRID) as usize);
        for _ in 0..GRID * GRID {
            field.push([(next() % 256) as u8, (next() % 256) as u8, (next() % 256) as u8]);
        }
        let mut img = RgbImage::new(size, size);
        for y in 0..size {
            for x in 0..size {
                let fx = (x as f64 / size as f64) * GRID as f64;
                let fy = (y as f64 / size as f64) * GRID as f64;
                let x0 = (fx as usize).min(GRID as usize - 1);
                let y0 = (fy as usize).min(GRID as usize - 1);
                let x1 = (x0 + 1).min(GRID as usize - 1);
                let y1 = (y0 + 1).min(GRID as usize - 1);
                let tx = fx - x0 as f64;
                let ty = fy - y0 as f64;
                let mut px = [0u8; 3];
                for c in 0..3 {
                    let top = field[y0 * GRID as usize + x0][c] as f64 * (1.0 - tx)
                        + field[y0 * GRID as usize + x1][c] as f64 * tx;
                    let bot = field[y1 * GRID as usize + x0][c] as f64 * (1.0 - tx)
                        + field[y1 * GRID as usize + x1][c] as f64 * tx;
                    px[c] = (top * (1.0 - ty) + bot * ty) as u8;
                }
                img.put_pixel(x, y, image::Rgb(px));
            }
        }
        img
    }

    pub(crate) fn make_photo_file(dir: &Path, name: &str, size: u32, seed: u8) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        make_photo(size, seed).save(&path).unwrap();
        path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::RgbImage;

    use super::testutil::make_photo_file;

    /// 同图不同分辨率的 dHash 距离（应 ≤ DEDUP_HAMMING_MAX，否则阈值兜不住）。
    /// 覆盖浏览器采集的真实分辨率跨度：Pinterest 网格 236w、详情 564w、以及用户文件夹
    /// 导入的常见缩放。不含 ≤64px 的极端小图——dHash 本身对那样的小图就不可靠，
    /// 且浏览器扩展不会把它当作素材（见候选管线的最小尺寸过滤）。
    #[test]
    fn same_image_resize_variants_are_close() {
        let dir = std::env::temp_dir().join("bb-phash-resize");
        let original = make_photo_file(&dir, "img.png", 640, 42);
        let img = image::open(&original).unwrap();
        for (w, h) in [(236, 236), (160, 160), (120, 120)] {
            let small_path = dir.join(format!("r{w}.png"));
            let small = img.resize_exact(w, h, image::imageops::FilterType::Lanczos3);
            small.save(&small_path).unwrap();
            let a = compute(&original).unwrap().unwrap();
            let b = compute(&small_path).unwrap().unwrap();
            assert!(
                hamming(&a, &b).unwrap() <= DEDUP_HAMMING_MAX,
                "同图缩放 {w}x{h} 距离 {} 超过阈值 {DEDUP_HAMMING_MAX}",
                hamming(&a, &b).unwrap()
            );
        }
    }

    /// 两张不同的图（不同 seed）距离应 > 阈值，避免误合并。
    #[test]
    fn different_images_are_far() {
        let dir = std::env::temp_dir().join("bb-phash-diff");
        let a = make_photo_file(&dir, "a.png", 640, 0);
        let b = make_photo_file(&dir, "b.png", 640, 1);
        let ha = compute(&a).unwrap().unwrap();
        let hb = compute(&b).unwrap().unwrap();
        assert!(
            hamming(&ha, &hb).unwrap() > DEDUP_HAMMING_MAX,
            "不同图距离 {} 应大于阈值 {DEDUP_HAMMING_MAX}",
            hamming(&ha, &hb).unwrap()
        );
    }

    /// 低熵（纯色）图：置位 bit 少 → `is_high_entropy` 判 false，不去重（退化为不处理）。
    #[test]
    fn low_entropy_flat_images_are_not_high_entropy() {
        let dir = std::env::temp_dir().join("bb-phash-flat");
        std::fs::create_dir_all(&dir).unwrap();
        for (name, [r, g, b]) in [
            ("red", [255, 0, 0]),
            ("green", [0, 255, 0]),
            ("white", [255, 255, 255]),
        ] {
            let mut img = RgbImage::new(64, 64);
            for px in img.pixels_mut() {
                *px = image::Rgb([r, g, b]);
            }
            let path = dir.join(format!("{name}.png"));
            img.save(&path).unwrap();
            let h = compute(&path).unwrap().unwrap();
            assert!(
                !is_high_entropy(&h),
                "纯色图 {name} 的 dHash {h} 应被判为低熵"
            );
        }
    }

    /// 照片感测试图应足够「高熵」，能被模糊匹配使用。
    #[test]
    fn photo_like_is_high_entropy() {
        let dir = std::env::temp_dir().join("bb-phash-entropy");
        let p = make_photo_file(&dir, "img.png", 640, 0);
        let h = compute(&p).unwrap().unwrap();
        assert!(is_high_entropy(&h), "照片感图 dHash {h} 应被判为高熵");
    }
}
