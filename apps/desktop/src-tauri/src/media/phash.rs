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

/// 海明距离（用于后续按阈值模糊匹配；Phase 1 去重暂用精确匹配）。
#[allow(dead_code)]
pub fn hamming(a: &str, b: &str) -> Option<u32> {
    let a = u64::from_str_radix(a, 16).ok()?;
    let b = u64::from_str_radix(b, 16).ok()?;
    Some((a ^ b).count_ones())
}
