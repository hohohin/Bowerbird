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

fn lab_dist(a: &Lab, b: &Lab) -> f32 {
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
