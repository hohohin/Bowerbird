//! Isolated real-decoder smoke. Never initializes Tauri or opens a user library.
#![allow(dead_code, unused_imports, unused_mut)]
#[path = "../src/error.rs"]
mod error;
#[path = "../src/media/tools.rs"]
mod tools;
#[path = "../src/media/thumb.rs"]
mod thumb;

#[cfg(target_os = "macos")]
#[link(name = "AVFoundation", kind = "framework")]
#[link(name = "Foundation", kind = "framework")]
#[link(name = "CoreMedia", kind = "framework")]
#[link(name = "CoreGraphics", kind = "framework")]
#[link(name = "ImageIO", kind = "framework")]
#[link(name = "objc")]
extern "C" {}

fn main() {
    if let Some(code) = thumb::video_thumbnail_worker() { std::process::exit(code); }
    let args: Vec<_> = std::env::args_os().collect();
    assert_eq!(args.len(), 3, "usage: video_poster_smoke VIDEO OUTPUT.jpg");
    let source = std::path::Path::new(&args[1]);
    let output = std::path::Path::new(&args[2]);
    thumb::generate_video(source, output, 480).expect("extract cover in bounded child");
    let image = image::open(output).unwrap().to_rgb8();
    assert_eq!(image.dimensions(), (270, 480), "portrait transform and bounded size");
    let center = image.get_pixel(135, 240);
    assert!(center[0] > 180 && center[1] < 60 && center[2] < 60, "cover must contain the red video frame: {center:?}");
    let broken = output.with_extension("broken.mp4");
    let missing = output.with_extension("missing.jpg");
    std::fs::write(&broken, b"not a video").unwrap();
    assert!(thumb::generate_video(&broken, &missing, 480).is_err());
    assert!(!missing.exists());
    std::fs::remove_file(broken).unwrap();
    println!("PASS: real short video, portrait transform, 270x480 red JPEG, corrupt video fails without a partial cover");
}
