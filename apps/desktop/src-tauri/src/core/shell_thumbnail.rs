//! Read the shared Windows Shell cache, without invoking thumbnail providers.
//! A miss falls back to our bounded image/video extraction path.
#[cfg(not(windows))]
pub(super) fn cached(_source: &std::path::Path, _destination: &std::path::Path) -> bool { false }

#[cfg(windows)]
pub(super) fn cached(source: &std::path::Path, destination: &std::path::Path) -> bool {
    use windows::{core::PCWSTR, Win32::{
        Graphics::Gdi::{GetDC, GetDIBits, ReleaseDC, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS},
        System::Com::{CoInitializeEx, CoUninitialize, CoCreateInstance, COINIT_MULTITHREADED, CLSCTX_INPROC_SERVER},
        UI::Shell::{SHCreateItemFromParsingName, IShellItem, IThumbnailCache, LocalThumbnailCache, WTS_INCACHEONLY},
    }};
    use std::os::windows::ffi::OsStrExt;
    struct Apartment;
    impl Drop for Apartment { fn drop(&mut self) { unsafe { CoUninitialize(); } } }
    // Each blocking-pool thread owns its COM lifetime; never pass interfaces across threads.
    unsafe {
        if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() { return false; }
        let _apartment = Apartment;
        let result = (|| -> Option<()> {
            let path: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
            let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(path.as_ptr()), None).ok()?;
            let cache: IThumbnailCache = CoCreateInstance(&LocalThumbnailCache, None, CLSCTX_INPROC_SERVER).ok()?;
            let mut bitmap = None;
            cache.GetThumbnail(&item, 480, WTS_INCACHEONLY, Some(&mut bitmap), None, None).ok()?;
            let bitmap = bitmap?;
            let size = bitmap.GetSize().ok()?;
            if size.cx <= 0 || size.cy <= 0 || size.cx > 2048 || size.cy > 2048 { return None; }
            // ISharedBitmap owns this HBITMAP; do not DeleteObject it.
            let handle = bitmap.GetSharedBitmap().ok()?;
            let mut info = BITMAPINFO { bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: size.cx, biHeight: -size.cy, biPlanes: 1, biBitCount: 32,
                biCompression: BI_RGB.0, ..Default::default()
            }, ..Default::default() };
            let mut pixels = vec![0u8; size.cx as usize * size.cy as usize * 4];
            let dc = GetDC(None);
            if dc.0.is_null() { return None; }
            let lines = GetDIBits(dc, handle, 0, size.cy as u32, Some(pixels.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);
            ReleaseDC(None, dc);
            if lines != size.cy { return None; }
            let rgb: Vec<u8> = pixels.chunks_exact(4).flat_map(|pixel| [pixel[2], pixel[1], pixel[0]]).collect();
            let image = image::RgbImage::from_raw(size.cx as u32, size.cy as u32, rgb)?;
            crate::media::thumb::generate_from_image(&image::DynamicImage::ImageRgb8(image), destination, 480).ok()?;
            Some(())
        })();
        result.is_some()
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires the Windows Shell cache; creates only a temporary synthetic image"]
    fn reads_real_windows_shared_thumbnail_cache() {
        use std::os::windows::ffi::OsStrExt;
        use windows::{core::PCWSTR, Win32::{
            System::Com::{CoInitializeEx, CoUninitialize, CoCreateInstance, COINIT_MULTITHREADED, CLSCTX_INPROC_SERVER},
            UI::Shell::{SHCreateItemFromParsingName, IShellItem, IThumbnailCache, LocalThumbnailCache, WTS_EXTRACT},
        }};
        let root = std::env::temp_dir().join(format!("bb-shell-preview-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("sample.jpg"); let destination = root.join("preview.jpg");
        image::RgbImage::from_pixel(960, 640, image::Rgb([220, 30, 10])).save(&source).unwrap();
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
            {
                let path: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
                let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(path.as_ptr()), None).unwrap();
                let cache: IThumbnailCache = CoCreateInstance(&LocalThumbnailCache, None, CLSCTX_INPROC_SERVER).unwrap();
                let mut bitmap = None;
                cache.GetThumbnail(&item, 480, WTS_EXTRACT, Some(&mut bitmap), None, None).unwrap();
            }
            CoUninitialize();
        }
        assert!(cached(&source, &destination));
        let thumb = image::open(destination).unwrap().to_rgb8();
        assert!(thumb.width() <= 480 && thumb.height() <= 480);
        let pixel = thumb.get_pixel(thumb.width()/2, thumb.height()/2);
        assert!(pixel[0] > 200 && pixel[1] < 50 && pixel[2] < 30, "preserves RGB channel order");
        std::fs::remove_dir_all(root).unwrap();
    }
}
