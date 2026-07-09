//! K-Means 主色提取（LAB 空间，开发计划 §2.3 / §5.3）。
//!
//! 缩到 80×80 → 转 LAB → K-Means(k=5, 8 次迭代) → 中心色转回 sRGB hex。

use std::path::Path;

use image::imageops::FilterType;
use palette::{IntoColor, Lab, Srgb};

use crate::error::AppResult;

pub fn extract(path: &Path, k: usize) -> AppResult<Vec<String>> {
    let img = image::open(path)?;
    Ok(extract_from_image(&img, k))
}

pub fn extract_from_image(img: &image::DynamicImage, k: usize) -> Vec<String> {
    let small = img.resize_exact(80, 80, FilterType::Nearest);
    let pixels: Vec<Lab> = small
        .to_rgb8()
        .pixels()
        .map(|p| {
            Srgb::new(p.0[0] as f32 / 255.0, p.0[1] as f32 / 255.0, p.0[2] as f32 / 255.0)
                .into_color()
        })
        .collect();
    let centers = kmeans(&pixels, k, 8);
    centers.iter().map(|&c| lab_to_hex(c)).collect()
}

fn lab_to_hex(lab: Lab) -> String {
    let srgb: Srgb = lab.into_color();
    let r = (srgb.red * 255.0).round().clamp(0.0, 255.0) as u8;
    let g = (srgb.green * 255.0).round().clamp(0.0, 255.0) as u8;
    let b = (srgb.blue * 255.0).round().clamp(0.0, 255.0) as u8;
    format!("#{r:02x}{g:02x}{b:02x}")
}

pub(crate) fn lab_dist(a: &Lab, b: &Lab) -> f32 {
    ((a.l - b.l).powi(2) + (a.a - b.a).powi(2) + (a.b - b.b).powi(2)).sqrt()
}

fn kmeans(pixels: &[Lab], k: usize, iters: usize) -> Vec<Lab> {
    if pixels.is_empty() {
        return vec![];
    }
    let k = k.max(1);
    let mut centers: Vec<Lab> = (0..k)
        .map(|i| pixels[((i * pixels.len()) / k).min(pixels.len() - 1)])
        .collect();
    for _ in 0..iters {
        let mut sums: Vec<(f32, f32, f32, usize)> = vec![(0.0, 0.0, 0.0, 0); k];
        for p in pixels {
            let nearest = centers
                .iter()
                .enumerate()
                .min_by(|(_, a), (_, b)| {
                    lab_dist(a, p)
                        .partial_cmp(&lab_dist(b, p))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|(i, _)| i)
                .unwrap_or(0);
            sums[nearest].0 += p.l;
            sums[nearest].1 += p.a;
            sums[nearest].2 += p.b;
            sums[nearest].3 += 1;
        }
        for (i, s) in sums.iter().enumerate() {
            if s.3 > 0 {
                centers[i] = Lab::new(s.0 / s.3 as f32, s.1 / s.3 as f32, s.2 / s.3 as f32);
            }
        }
    }
    centers
}

/// 12 个命名色桶（key, 代表 hex）。量化时取 LAB ΔE 最近桶。
/// 略降饱和 / 避开纯红纯黑，更贴近真实照片主色。key 用英文（DB 存 key），前端做中文映射。
pub const BUCKETS: &[(&str, &str)] = &[
    ("red", "#D92424"),
    ("orange", "#E8722C"),
    ("yellow", "#E8C62A"),
    ("green", "#3DA535"),
    ("cyan", "#1FB5C4"),
    ("blue", "#2D5BD9"),
    ("purple", "#7B3FD9"),
    ("pink", "#E056B0"),
    ("brown", "#7A4A1E"),
    ("gray", "#8A8A8A"),
    ("white", "#F2F2F2"),
    ("black", "#1A1A1A"),
];

/// hex(`#rrggbb`) → Lab。非 6 位 hex 返回 None。
fn hex_to_lab(hex: &str) -> Option<Lab> {
    let h = hex.trim().trim_start_matches('#');
    if h.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&h[0..2], 16).ok()?;
    let g = u8::from_str_radix(&h[2..4], 16).ok()?;
    let b = u8::from_str_radix(&h[4..6], 16).ok()?;
    Some(Srgb::new(r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0).into_color())
}

/// 把一个 hex 量化到最近的命名桶（LAB ΔE 最小，CIE76）。非法 hex → None。
pub fn hex_to_bucket(hex: &str) -> Option<&'static str> {
    let target = hex_to_lab(hex)?;
    let mut best: Option<(&'static str, f32)> = None;
    for (key, bhex) in BUCKETS {
        let Some(blab) = hex_to_lab(bhex) else { continue };
        let d = lab_dist(&target, &blab);
        match best {
            Some((_, bd)) if d >= bd => {}
            _ => best = Some((key, d)),
        }
    }
    best.map(|(k, _)| k)
}

/// `assets.colors` 的 JSON（hex 数组）→ 去重保序的桶 key 列表（入库 + 回填共用）。
pub fn colors_to_buckets(colors_json: &str) -> Vec<&'static str> {
    let Ok(arr) = serde_json::from_str::<Vec<String>>(colors_json) else {
        return Vec::new();
    };
    let mut out: Vec<&'static str> = Vec::new();
    for hex in arr {
        if let Some(b) = hex_to_bucket(&hex) {
            if !out.contains(&b) {
                out.push(b);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_to_bucket_maps_primary_colors() {
        assert_eq!(hex_to_bucket("#D92424"), Some("red")); // 桶代表色本身
        assert_eq!(hex_to_bucket("#ff0000"), Some("red")); // 纯红 → red
        assert_eq!(hex_to_bucket("#ffffff"), Some("white"));
        assert_eq!(hex_to_bucket("#000000"), Some("black"));
        assert_eq!(hex_to_bucket("#1FB5C4"), Some("cyan"));
        assert_eq!(hex_to_bucket("#2D5BD9"), Some("blue"));
    }

    #[test]
    fn hex_to_bucket_rejects_invalid() {
        assert_eq!(hex_to_bucket("not-a-color"), None);
        assert_eq!(hex_to_bucket("#abc"), None); // 非 6 位
    }

    #[test]
    fn colors_to_buckets_dedups_same_bucket() {
        // 两个不同红 hex 都归 red → 去重为一个 red；cyan 单独保留。
        let bs = colors_to_buckets(r##"["#ff0000","#ee2222","#1FB5C4"]"##);
        assert_eq!(bs, vec!["red", "cyan"]);
    }

    #[test]
    fn colors_to_buckets_handles_bad_json() {
        assert!(colors_to_buckets("not json").is_empty());
        assert!(colors_to_buckets(r##"["#bad"]"##).is_empty());
    }
}
