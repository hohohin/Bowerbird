//! Uses only supplied fixture files; does not initialize Tauri or a user library.
#![allow(dead_code, unused_imports)]
#[path = "../src/error.rs"]
mod error;
#[path = "../src/media/tools.rs"]
mod tools;
#[path = "../src/media/probe.rs"]
mod probe;

#[cfg(target_os = "macos")]
#[link(name = "AVFoundation", kind = "framework")]
#[link(name = "Foundation", kind = "framework")]
#[link(name = "CoreMedia", kind = "framework")]
#[link(name = "CoreGraphics", kind = "framework")]
#[link(name = "ImageIO", kind = "framework")]
#[link(name = "objc")]
extern "C" {}

fn main() {
    if let Some(code) = probe::video_probe_worker() { std::process::exit(code); }
    let args: Vec<_> = std::env::args_os().collect();
    assert_eq!(args.len(), 5, "usage: video_probe_smoke VIDEO WIDTH HEIGHT SECONDS (0 0 0 expects failure)");
    let width: u32 = args[2].to_str().unwrap().parse().unwrap();
    let height: u32 = args[3].to_str().unwrap().parse().unwrap();
    let duration: f64 = args[4].to_str().unwrap().parse().unwrap();
    let path = std::path::Path::new(&args[1]);
    let result = probe::probe(path);
    if width == 0 {
        assert!(result.is_err(), "invalid media must fail: {result:?}");
    } else {
        let meta = result.expect("probe fixture");
        assert_eq!((meta.width, meta.height), (width, height));
        assert!((meta.duration - duration).abs() < 0.025, "wrong duration: {meta:?}");
        assert_eq!(meta.size, std::fs::metadata(path).unwrap().len());
        assert_eq!(meta.ext, path.extension().unwrap().to_str().unwrap().to_lowercase());
        println!("{meta:?}");
    }
    println!("PASS: {}", path.display());
}
