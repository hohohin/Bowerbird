//! Local screen capture, global shortcuts and ephemeral always-on-top image windows.
use crate::core::settings::SettingsState;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    collections::HashMap,
    io::Cursor,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ScreenshotShortcuts {
    pub capture: String,
    pub paste: String,
}
impl Default for ScreenshotShortcuts {
    fn default() -> Self {
        Self {
            capture: "F1".into(),
            paste: "F3".into(),
        }
    }
}
#[derive(Default)]
pub struct ScreenshotState {
    active: AtomicBool,
    recording: AtomicBool,
    images: Mutex<HashMap<String, String>>,
    shortcuts: Mutex<ShortcutStatus>,
    clipboard: Mutex<Option<arboard::Clipboard>>,
}
#[derive(Clone, Default, Serialize)]
pub struct ShortcutStatus {
    pub error: Option<String>,
}

fn local_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main"
        || window.label().starts_with("snip-")
        || window.label().starts_with("pin-")
    {
        Ok(())
    } else {
        Err("此窗口不能使用截图工具".into())
    }
}
fn parse_shortcuts(value: &ScreenshotShortcuts) -> Result<Vec<(Shortcut, bool)>, String> {
    let mut result = Vec::new();
    for (text, paste) in [(&value.capture, false), (&value.paste, true)] {
        if text.is_empty() {
            continue;
        }
        let shortcut = Shortcut::from_str(text).map_err(|_| "快捷键格式无效".to_string())?;
        if result.iter().any(|(existing, _)| existing == &shortcut) {
            return Err("截图与贴图不能使用同一快捷键".into());
        }
        result.push((shortcut, paste));
    }
    Ok(result)
}
fn register(app: &AppHandle, shortcut: Shortcut) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, pressed, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            if app
                .state::<ScreenshotState>()
                .recording
                .load(Ordering::SeqCst)
                && app
                    .get_webview_window("main")
                    .is_some_and(|window| window.is_focused().unwrap_or(false))
            {
                return;
            }
            let bindings = app.state::<SettingsState>().get().screenshot_shortcuts;
            let Some((_, paste)) = parse_shortcuts(&bindings)
                .ok()
                .and_then(|items| items.into_iter().find(|(key, _)| key == pressed))
            else {
                return;
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let result = if paste {
                    paste_clipboard(app.clone()).await
                } else {
                    start_capture(app.clone()).await
                };
                if let Err(error) = result {
                    app.dialog().message(error).title("截图工具").show(|_| {});
                }
            });
        })
        .map_err(|e| format!("快捷键无法注册，可能已被其他程序占用：{e}"))
}
pub fn initialize(app: &AppHandle) {
    app.manage(ScreenshotState::default());
    let value = app.state::<SettingsState>().get().screenshot_shortcuts;
    let result = parse_shortcuts(&value).and_then(|shortcuts| {
        for (shortcut, _) in shortcuts {
            register(app, shortcut)?;
        }
        Ok(())
    });
    if let Err(error) = result {
        app.state::<ScreenshotState>()
            .shortcuts
            .lock()
            .unwrap()
            .error = Some(error);
    }
}
#[tauri::command]
pub fn screenshot_record_shortcut(
    window: WebviewWindow,
    app: AppHandle,
    recording: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("仅主窗口可录入快捷键".into());
    }
    app.state::<ScreenshotState>()
        .recording
        .store(recording, Ordering::SeqCst);
    Ok(())
}
#[tauri::command]
pub fn screenshot_shortcut_status(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<ShortcutStatus, String> {
    local_window(&window)?;
    Ok(app
        .state::<ScreenshotState>()
        .shortcuts
        .lock()
        .unwrap()
        .clone())
}
#[tauri::command]
pub async fn screenshot_set_shortcuts(
    window: WebviewWindow,
    app: AppHandle,
    shortcuts: ScreenshotShortcuts,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("仅主窗口可修改快捷键".into());
    }
    let next = parse_shortcuts(&shortcuts)?;
    let state = app.state::<ScreenshotState>();
    let mut status = state.shortcuts.lock().unwrap();
    let settings = app.state::<SettingsState>();
    let old = parse_shortcuts(&settings.get().screenshot_shortcuts)?;
    // Keep the old binding live until every new binding and the file write succeed.
    let mut added = Vec::new();
    for (key, _) in &next {
        if app.global_shortcut().is_registered(*key) {
            continue;
        }
        if let Err(error) = register(&app, *key) {
            for key in added {
                let _ = app.global_shortcut().unregister(key);
            }
            status.error = Some(error.clone());
            return Err(error);
        }
        added.push(*key);
    }
    if let Err(error) = settings.update_with(|saved| saved.screenshot_shortcuts = shortcuts) {
        for key in added {
            let _ = app.global_shortcut().unregister(key);
        }
        return Err(error.to_string());
    }
    // Callbacks resolve the current action, so swapping keys needs no unregister gap.
    for (key, _) in &old {
        if !next.iter().any(|(new, _)| new == key) {
            let _ = app.global_shortcut().unregister(*key);
        }
    }
    status.error = None;
    Ok(())
}
fn encode(image: &image::RgbaImage) -> Result<String, String> {
    let mut png = Cursor::new(Vec::new());
    image
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(png.into_inner())
    ))
}
fn decode(data: &str) -> Result<image::RgbaImage, String> {
    if data.len() > 90 * 1024 * 1024 {
        return Err("截图超过大小限制".into());
    }
    let bytes = STANDARD
        .decode(
            data.strip_prefix("data:image/png;base64,")
                .ok_or("截图必须是 PNG")?,
        )
        .map_err(|e| e.to_string())?;
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(32768);
    limits.max_image_height = Some(32768);
    limits.max_alloc = Some(400 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map(|im| im.to_rgba8())
        .map_err(|e| e.to_string())
}
fn cleanup_on_close(app: &AppHandle, window: &WebviewWindow) {
    let app = app.clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let state = app.state::<ScreenshotState>();
            let mut images = state.images.lock().unwrap();
            let removed = images.remove(&label).is_some();
            if removed
                && label.starts_with("snip-")
                && !images.keys().any(|key| key.starts_with("snip-"))
            {
                state.active.store(false, Ordering::SeqCst);
            }
        }
    });
}
fn screen_capture_permission() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGPreflightScreenCaptureAccess() -> bool;
            fn CGRequestScreenCaptureAccess() -> bool;
        }
        if !unsafe { CGPreflightScreenCaptureAccess() }
            && !unsafe { CGRequestScreenCaptureAccess() }
        {
            return Err(
                "请在系统设置 → 隐私与安全性 → 屏幕与系统音频录制中允许园丁鸟，然后重新打开应用。"
                    .into(),
            );
        }
    }
    Ok(())
}
pub async fn start_capture(app: AppHandle) -> Result<(), String> {
    if app
        .state::<ScreenshotState>()
        .active
        .swap(true, Ordering::SeqCst)
    {
        return Ok(());
    }
    let capture_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        screen_capture_permission()?;
        let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
        if monitors.is_empty() {
            return Err("没有可截图的屏幕".to_string());
        }
        // Freeze all displays before showing any overlay.
        let frames = monitors
            .into_iter()
            .map(|monitor| {
                let image = monitor
                    .capture_image()
                    .map_err(|e| format!("无法截取屏幕，请检查系统的屏幕录制权限：{e}"))?;
                Ok((
                    monitor.x().map_err(|e| e.to_string())?,
                    monitor.y().map_err(|e| e.to_string())?,
                    monitor.width().map_err(|e| e.to_string())?,
                    monitor.height().map_err(|e| e.to_string())?,
                    encode(&image)?,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;
        for (x, y, width, height, data) in frames {
            if !capture_app
                .state::<ScreenshotState>()
                .active
                .load(Ordering::SeqCst)
            {
                return Ok(());
            }
            let label = format!("snip-{}", ulid::Ulid::new());
            capture_app
                .state::<ScreenshotState>()
                .images
                .lock()
                .unwrap()
                .insert(label.clone(), data);
            let window = WebviewWindowBuilder::new(
                &capture_app,
                &label,
                WebviewUrl::App("index.html?screenshot=capture".into()),
            )
            .title("园丁鸟截图")
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?;
            cleanup_on_close(&capture_app, &window);
            if !capture_app
                .state::<ScreenshotState>()
                .active
                .load(Ordering::SeqCst)
            {
                let _ = window.destroy();
                capture_app
                    .state::<ScreenshotState>()
                    .images
                    .lock()
                    .unwrap()
                    .remove(&label);
                return Ok(());
            }
            #[cfg(target_os = "macos")]
            {
                window
                    .set_position(tauri::LogicalPosition::new(x as f64, y as f64))
                    .map_err(|e| e.to_string())?;
                window
                    .set_size(tauri::LogicalSize::new(width as f64, height as f64))
                    .map_err(|e| e.to_string())?;
            }
            #[cfg(not(target_os = "macos"))]
            {
                window
                    .set_position(tauri::PhysicalPosition::new(x, y))
                    .map_err(|e| e.to_string())?;
                window
                    .set_size(tauri::PhysicalSize::new(width, height))
                    .map_err(|e| e.to_string())?;
            }
            // The frontend shows the window only after the image has decoded.
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    if result.is_err() {
        close_capture(&app);
    }
    result
}
fn close_capture(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with("snip-") {
            let _ = window.destroy();
        }
    }
    app.state::<ScreenshotState>()
        .images
        .lock()
        .unwrap()
        .retain(|key, _| !key.starts_with("snip-"));
    app.state::<ScreenshotState>()
        .active
        .store(false, Ordering::SeqCst);
}
#[tauri::command]
pub async fn screenshot_start(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    local_window(&window)?;
    start_capture(app).await
}
#[tauri::command]
pub fn screenshot_image(window: WebviewWindow, app: AppHandle) -> Result<String, String> {
    local_window(&window)?;
    app.state::<ScreenshotState>()
        .images
        .lock()
        .unwrap()
        .get(window.label())
        .cloned()
        .ok_or("截图已结束".into())
}
#[tauri::command]
pub fn screenshot_cancel(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    local_window(&window)?;
    close_capture(&app);
    Ok(())
}
fn pin(app: &AppHandle, data: String, width: u32, height: u32) -> Result<(), String> {
    let label = format!("pin-{}", ulid::Ulid::new());
    let scale = (600.0 / width as f64).min(500.0 / height as f64).min(1.0);
    app.state::<ScreenshotState>()
        .images
        .lock()
        .unwrap()
        .insert(label.clone(), data);
    let result = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App("index.html?screenshot=pin".into()),
    )
    .title("园丁鸟贴图")
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .inner_size(
        (width as f64 * scale).max(180.0),
        (height as f64 * scale + 40.0).max(120.0),
    )
    .center()
    .visible(false)
    .build();
    match result {
        Ok(window) => {
            cleanup_on_close(app, &window);
            Ok(())
        }
        Err(error) => {
            app.state::<ScreenshotState>()
                .images
                .lock()
                .unwrap()
                .remove(&label);
            Err(error.to_string())
        }
    }
}
async fn paste_clipboard(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ScreenshotState>();
        let mut clipboard = state.clipboard.lock().unwrap();
        if clipboard.is_none() {
            *clipboard = Some(arboard::Clipboard::new().map_err(|e| e.to_string())?);
        }
        let image = clipboard
            .as_mut()
            .unwrap()
            .get_image()
            .map_err(|_| "剪贴板中没有可贴出的图片".to_string())?;
        let image = image::RgbaImage::from_raw(
            image.width as u32,
            image.height as u32,
            image.bytes.into_owned(),
        )
        .ok_or("剪贴板图片无效")?;
        drop(clipboard);
        pin(&app, encode(&image)?, image.width(), image.height())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn screenshot_paste(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    local_window(&window)?;
    paste_clipboard(app).await
}
#[tauri::command]
pub async fn screenshot_output(
    window: WebviewWindow,
    app: AppHandle,
    data: String,
    action: String,
) -> Result<bool, String> {
    local_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let image = decode(&data)?;
        match action.as_str() {
            "copy" => {
                let state = app.state::<ScreenshotState>();
                let mut clipboard = state.clipboard.lock().unwrap();
                if clipboard.is_none() {
                    *clipboard = Some(arboard::Clipboard::new().map_err(|e| e.to_string())?);
                }
                clipboard
                    .as_mut()
                    .unwrap()
                    .set_image(arboard::ImageData {
                        width: image.width() as usize,
                        height: image.height() as usize,
                        bytes: Cow::Borrowed(image.as_raw()),
                    })
                    .map_err(|e| e.to_string())?;
            }
            "pin" => pin(&app, data, image.width(), image.height())?,
            "save" => {
                let path = app
                    .dialog()
                    .file()
                    .set_parent(&window)
                    .add_filter("PNG 图片", &["png"])
                    .set_file_name(format!(
                        "截图-{}.png",
                        chrono::Local::now().format("%Y%m%d-%H%M%S")
                    ))
                    .blocking_save_file();
                let Some(path) = path else {
                    return Ok(false);
                };
                let path = path.into_path().map_err(|e| e.to_string())?;
                image
                    .save_with_format(path, image::ImageFormat::Png)
                    .map_err(|e| e.to_string())?;
            }
            _ => return Err("未知截图操作".into()),
        }
        if window.label().starts_with("snip-") {
            close_capture(&app);
        }
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shortcut_duplicates_and_disabled() {
        assert!(parse_shortcuts(&ScreenshotShortcuts {
            capture: "Control+KeyA".into(),
            paste: "Ctrl+A".into()
        })
        .is_err());
        assert_eq!(
            parse_shortcuts(&ScreenshotShortcuts {
                capture: "".into(),
                paste: "".into()
            })
            .unwrap()
            .len(),
            0
        );
        assert_eq!(
            parse_shortcuts(&ScreenshotShortcuts::default())
                .unwrap()
                .len(),
            2
        );
        assert!(parse_shortcuts(&ScreenshotShortcuts {
            capture: "nonsense".into(),
            paste: "".into()
        })
        .is_err());
    }
    #[test]
    fn png_roundtrip_and_reject_invalid_input() {
        let image = image::RgbaImage::from_pixel(7, 9, image::Rgba([1, 2, 3, 255]));
        assert_eq!(decode(&encode(&image).unwrap()).unwrap(), image);
        assert!(decode("data:image/png;base64,eA==").is_err());
        assert!(decode("file:///etc/passwd").is_err());
    }
}
