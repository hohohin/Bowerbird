use super::SourceBrowserBounds;
use crate::error::{AppError, AppResult};

#[derive(Clone, Copy, Debug, serde::Deserialize)]
pub(super) struct OverlayBounds { pub x: f64, pub y: f64, pub width: f64, pub height: f64 }

impl OverlayBounds {
    pub fn valid(self, width: f64, height: f64) -> bool {
        [(self.x, width - self.width), (self.y, height - self.height), (self.width, 64.0), (self.height, 128.0)]
            .iter().all(|(value, maximum)| value.is_finite() && *value >= 0.0 && value <= maximum)
    }
}

// Keep the page's layout width intact; reveal the main WebView only under its tab.
pub(super) async fn apply(webview: &tauri::Webview, bounds: SourceBrowserBounds) -> AppResult<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    webview.with_webview(move |view| {
        #[cfg(target_os = "windows")]
        let result = unsafe {
            let mut hwnd = windows::Win32::Foundation::HWND::default();
            view.controller().ParentWindow(&mut hwnd).and_then(|_| set_region(hwnd, bounds))
                .map_err(|error| AppError::Other(format!("更新探索把手遮挡失败：{error}")))
        };
        #[cfg(target_os = "macos")]
        let result = unsafe {
            unsafe extern "C" { fn bb_browser_overlay(view: *mut std::ffi::c_void, x: f64, y: f64, width: f64, height: f64) -> bool; }
            let rect = bounds.overlay.unwrap_or(OverlayBounds { x: 0.0, y: 0.0, width: 0.0, height: 0.0 });
            if bb_browser_overlay(view.inner(), rect.x, rect.y, rect.width, rect.height) { Ok(()) }
            else { Err(AppError::Other("更新探索把手遮挡失败".into())) }
        };
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let result: AppResult<()> = { let _ = (view, bounds); Ok(()) };
        let _ = tx.send(result);
    }).map_err(|error| AppError::Other(format!("更新探索把手遮挡失败：{error}")))?;
    rx.await.map_err(|_| AppError::Other("探索窗口已关闭".into()))?
}

#[cfg(target_os = "windows")]
unsafe fn set_region(hwnd: windows::Win32::Foundation::HWND, bounds: SourceBrowserBounds) -> windows::core::Result<()> {
    use windows::Win32::{Foundation::RECT, Graphics::Gdi::{CreateRectRgn, CombineRgn, DeleteObject, SetWindowRgn, HGDIOBJ, RGN_DIFF}, UI::WindowsAndMessaging::GetClientRect};
    let Some(overlay) = bounds.overlay else {
        return if SetWindowRgn(hwnd, None, true) != 0 { Ok(()) } else { Err(windows::core::Error::from_win32()) };
    };
    let mut client = RECT::default(); GetClientRect(hwnd, &mut client)?;
    let scale_x = client.right as f64 / bounds.width; let scale_y = client.bottom as f64 / bounds.height;
    let region = CreateRectRgn(0, 0, client.right, client.bottom);
    let cut = CreateRectRgn((overlay.x * scale_x).floor() as i32, (overlay.y * scale_y).floor() as i32,
        ((overlay.x + overlay.width) * scale_x).ceil() as i32, ((overlay.y + overlay.height) * scale_y).ceil() as i32);
    let combined = CombineRgn(Some(region), Some(region), Some(cut), RGN_DIFF);
    let _ = DeleteObject(HGDIOBJ(cut.0));
    if combined.0 != 0 && SetWindowRgn(hwnd, Some(region), true) != 0 { return Ok(()); } // Windows owns region on success.
    let _ = DeleteObject(HGDIOBJ(region.0));
    Err(windows::core::Error::from_win32())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overlay_rejects_unbounded_or_invalid_holes() {
        let rect = OverlayBounds { x: 380.0, y: 100.0, width: 20.0, height: 98.0 };
        assert!(rect.valid(400.0, 600.0));
        assert!(OverlayBounds { x: 0.0, y: 0.0, ..rect }.valid(400.0, 600.0));
        for bad in [OverlayBounds { x: f64::NAN, ..rect }, OverlayBounds { x: -1.0, ..rect },
            OverlayBounds { width: 65.0, ..rect }, OverlayBounds { height: 129.0, ..rect },
            OverlayBounds { x: 390.0, ..rect }, OverlayBounds { y: 590.0, ..rect }] {
            assert!(!bad.valid(400.0, 600.0));
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn native_region_preserves_full_width_above_and_below_overlay_at_both_scales() {
        use windows::{core::w, Win32::{Foundation::HWND, Graphics::Gdi::{CreateRectRgn, GetWindowRgn, PtInRegion, DeleteObject, HGDIOBJ}, UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WINDOW_EX_STYLE, WS_POPUP}}};
        for scale in [1, 2] { unsafe {
            let hwnd = CreateWindowExW(WINDOW_EX_STYLE::default(), w!("STATIC"), w!("Bowerbird isolated region test"), WS_POPUP,
                0, 0, 400 * scale, 600 * scale, None, None, None, None).unwrap();
            let bounds = SourceBrowserBounds { x: 0.0, y: 0.0, width: 400.0, height: 600.0,
                overlay: Some(OverlayBounds { x: 380.0, y: 100.0, width: 20.0, height: 98.0 }) };
            set_region(hwnd, bounds).unwrap();
            let region = CreateRectRgn(0, 0, 0, 0);
            assert_ne!(GetWindowRgn(hwnd, region).0, 0);
            assert!(!PtInRegion(region, 390 * scale, 150 * scale).as_bool());
            for (x, y) in [(390, 50), (390, 250), (200, 150)] { assert!(PtInRegion(region, x * scale, y * scale).as_bool()); }
            set_region(hwnd, SourceBrowserBounds { overlay: None, ..bounds }).unwrap();
            assert_eq!(GetWindowRgn(hwnd, region).0, 0, "removing the overlay restores a rectangular window");
            let _ = DeleteObject(HGDIOBJ(region.0)); DestroyWindow(hwnd).unwrap();
            assert!(set_region(HWND::default(), bounds).is_err());
        } }
    }
}
