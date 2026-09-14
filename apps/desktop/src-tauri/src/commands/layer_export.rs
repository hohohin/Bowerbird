//! External editor files. AI is written by Illustrator, never by renaming a PDF.
use crate::error::AppError;
use base64::Engine;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use ulid::Ulid;

#[tauri::command]
pub async fn layer_export_font_names(
    fonts: Vec<String>,
) -> Result<std::collections::HashMap<String, String>, AppError> {
    if fonts.len() > 17 || fonts.iter().any(|font| font.len() > 256) {
        return Err(AppError::Other("导出字体参数无效".into()));
    }
    tokio::task::spawn_blocking(move || {
        let mut names = std::collections::HashMap::new();
        let installed = super::layer_text::installed_fonts().unwrap_or_default();
        for family in fonts {
            if !installed.contains(&family) {
                continue;
            }
            if let Some(name) = postscript_font_name(&family) {
                names.insert(family, name);
            }
        }
        names
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))
}

#[cfg(not(windows))]
fn postscript_font_name(_: &str) -> Option<String> {
    None
}

#[cfg(windows)]
fn postscript_font_name(family: &str) -> Option<String> {
    use windows::Win32::Graphics::Gdi::*;
    unsafe {
        let dc = GetDC(None);
        if dc.is_invalid() {
            return None;
        }
        let mut descriptor = LOGFONTW {
            lfHeight: -32,
            lfWeight: 400,
            lfCharSet: DEFAULT_CHARSET,
            ..Default::default()
        };
        for (target, value) in descriptor
            .lfFaceName
            .iter_mut()
            .take(31)
            .zip(family.encode_utf16())
        {
            *target = value;
        }
        let font = CreateFontIndirectW(&descriptor);
        if font.is_invalid() {
            ReleaseDC(None, dc);
            return None;
        }
        let previous = SelectObject(dc, HGDIOBJ(font.0));
        let table = u32::from_le_bytes(*b"name");
        let size = GetFontData(dc, table, 0, None, 0);
        let mut data = Vec::new();
        if size < 1024 * 1024 {
            data.resize(size as usize, 0);
            if GetFontData(dc, table, 0, Some(data.as_mut_ptr().cast()), size) != size {
                data.clear();
            }
        }
        SelectObject(dc, previous);
        let _ = DeleteObject(HGDIOBJ(font.0));
        ReleaseDC(None, dc);
        let word = |offset: usize| -> Option<usize> {
            Some(u16::from_be_bytes(data.get(offset..offset + 2)?.try_into().ok()?) as usize)
        };
        let count = word(2)?;
        let storage = word(4)?;
        let mut fallback = None;
        for index in 0..count {
            let offset = 6 + index * 12;
            if word(offset + 6)? != 6 {
                continue;
            }
            let platform = word(offset)?;
            let length = word(offset + 8)?;
            let start = storage + word(offset + 10)?;
            let bytes = data.get(start..start + length)?;
            let name = if platform == 0 || platform == 3 {
                String::from_utf16(
                    &bytes
                        .chunks_exact(2)
                        .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
                        .collect::<Vec<_>>(),
                )
                .ok()?
            } else {
                String::from_utf8(bytes.to_vec()).ok()?
            };
            if platform == 3 && word(offset + 4)? == 0x409 {
                return Some(name);
            }
            fallback = Some(name);
        }
        fallback
    }
}

fn export_path(path: &str, extension: &str) -> Result<PathBuf, AppError> {
    let path = PathBuf::from(path);
    if !path.is_absolute()
        || !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case(extension))
        || !path.parent().is_some_and(Path::is_dir)
    {
        return Err(AppError::Other(format!(
            "请选择有效的 .{extension} 文件保存路径"
        )));
    }
    Ok(path)
}

fn atomic_export(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    use std::io::Write;
    let temporary = path.with_file_name(format!(".bowerbird-export-{}.tmp", Ulid::new()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(AppError::from)
}

#[tauri::command]
pub async fn layer_export_psd(path: String, base64: String) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let path = export_path(&path, "psd")?;
        if base64.len() > 360_000_000 {
            return Err(AppError::Other("PSD 超出 256 MB 导出限制".into()));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64)
            .map_err(|_| AppError::Other("PSD 编码无效".into()))?;
        if bytes.len() > 256 * 1024 * 1024 || bytes.len() < 26 || !bytes.starts_with(b"8BPS\0\x01")
        {
            return Err(AppError::Other("PSD 数据无效或超出导出限制".into()));
        }
        atomic_export(&path, &bytes)
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))?
}

#[tauri::command]
pub async fn layer_export_ai(path: String, document: Value) -> Result<String, AppError> {
    #[cfg(not(windows))]
    {
        let _ = (path, document);
        return Err(AppError::Other("AI 导出目前需要 Windows 本机安装 Adobe Illustrator；也可导出 PSD 后在 Illustrator 中打开".into()));
    }
    #[cfg(windows)]
    {
        static EXPORT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let _guard = EXPORT_LOCK
            .try_lock()
            .map_err(|_| AppError::Other("已有 AI 导出正在执行，请稍后重试".into()))?;
        let path = export_path(&path, "ai")?;
        if !document["layers"].is_array() {
            return Err(AppError::Other("缺少图层工程".into()));
        }
        super::layers::validate_workspace(&json!({"document":document,"pending":null}))?;
        if document["layers"].as_array().unwrap().iter().any(|layer| {
            layer["width"].as_f64().unwrap() > 16348.0
                || layer["height"].as_f64().unwrap() > 16348.0
        }) {
            return Err(AppError::Other(
                "图层尺寸超出 Illustrator 支持范围，请缩小后导出".into(),
            ));
        }
        let directory = std::env::temp_dir().join(format!("bowerbird-ai-{}", Ulid::new()));
        std::fs::create_dir(&directory)?;
        let prepared_directory = directory.clone();
        let prepared =
            tokio::task::spawn_blocking(move || prepare_ai(&prepared_directory, document))
                .await
                .map_err(|error| AppError::Other(error.to_string()))?;
        if let Err(error) = prepared {
            let _ = std::fs::remove_dir_all(&directory);
            return Err(error);
        }
        let mut command = tokio::process::Command::new("powershell.exe");
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(directory.join("export.ps1"))
            .arg(directory.join("export.jsx"))
            .creation_flags(0x08000000)
            .kill_on_drop(true);
        let result =
            tokio::time::timeout(std::time::Duration::from_secs(180), command.output()).await;
        // A timed-out Illustrator script may still be using its embedded inputs. Keep only
        // this isolated staging directory; it cannot overwrite the user's destination.
        if result.is_err() {
            return Err(AppError::Other(
                "Illustrator 未在 3 分钟内响应。请完成其启动或登录后重试；目标文件未改动".into(),
            ));
        }
        let result = (|| {
            let output = result.unwrap()?;
            let message = String::from_utf8_lossy(&output.stdout);
            let Some((_, warnings)) = message.split_once("BOWERBIRD_AI_OK") else {
                return Err(AppError::Other(format!(
                    "AI 导出失败，请确认 Illustrator 已安装且能正常启动。{}",
                    String::from_utf8_lossy(&output.stderr)
                        .chars()
                        .take(1200)
                        .collect::<String>()
                )));
            };
            if !output.status.success() {
                return Err(AppError::Other(
                    "Illustrator 保存失败，目标文件未改动".into(),
                ));
            }
            let bytes = std::fs::read(directory.join("output.ai"))?;
            if !bytes.starts_with(b"%PDF-") {
                return Err(AppError::Other("Illustrator 未返回有效工程文件".into()));
            }
            atomic_export(&path, &bytes)?;
            Ok(warnings.trim().to_string())
        })();
        let _ = std::fs::remove_dir_all(&directory);
        result
    }
}

#[cfg(any(windows, test))]
fn prepare_ai(directory: &Path, mut document: Value) -> Result<(), AppError> {
    for (index, layer) in document["layers"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        if layer["text"].is_null() {
            let bytes = super::layers::image_bytes(layer["dataUrl"].as_str().unwrap())?;
            let file = directory.join(format!(
                "layer-{index}.{}",
                if bytes.starts_with(b"\x89PNG") {
                    "png"
                } else {
                    "jpg"
                }
            ));
            std::fs::write(&file, bytes)?;
            layer["file"] = json!(file.to_string_lossy().replace('\\', "/"));
        }
        layer.as_object_mut().unwrap().remove("dataUrl");
        layer.as_object_mut().unwrap().remove("textBackup");
    }
    document["output"] = json!(directory
        .join("output.ai")
        .to_string_lossy()
        .replace('\\', "/"));
    let literal = serde_json::to_string(&document)?
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    std::fs::write(
        directory.join("export.jsx"),
        format!(
            "\u{feff}var data = {literal};\n{}",
            include_str!("layer_export_ai.jsx")
        ),
    )?;
    std::fs::write(
        directory.join("export.ps1"),
        r#"param([string]$ScriptPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$illustrator = New-Object -ComObject Illustrator.Application
$illustrator.DoJavaScriptFile($ScriptPath)
"#,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn resolves_installed_font_postscript_names() {
        assert_eq!(postscript_font_name("Arial").as_deref(), Some("ArialMT"));
        assert!(postscript_font_name("Microsoft YaHei").is_some());
    }

    #[test]
    fn validates_destination_and_replaces_only_complete_files() {
        let directory = std::env::temp_dir().join(format!("bowerbird-export-test-{}", Ulid::new()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("工程.psd");
        assert!(export_path("relative.psd", "psd").is_err());
        assert!(export_path(directory.join("wrong.ai").to_str().unwrap(), "psd").is_err());
        atomic_export(&path, b"old").unwrap();
        atomic_export(&path, b"new complete file").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new complete file");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn invalid_psd_does_not_overwrite_destination() {
        let directory = std::env::temp_dir().join(format!("bowerbird-export-test-{}", Ulid::new()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("existing.psd");
        std::fs::write(&path, b"previous file").unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        assert!(runtime
            .block_on(layer_export_psd(
                path.to_string_lossy().to_string(),
                "invalid".into()
            ))
            .is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"previous file");
        std::fs::remove_dir_all(directory).unwrap();
    }

    /// Explicit local integration run; only the synthetic UI fixture is accepted as input.
    #[cfg(windows)]
    #[test]
    #[ignore = "requires installed Illustrator and BOWERBIRD_EXPORT_SMOKE fixture directory"]
    fn native_adobe_export_smoke() {
        let directory = PathBuf::from(std::env::var("BOWERBIRD_EXPORT_SMOKE").unwrap());
        let document: Value =
            serde_json::from_slice(&std::fs::read(directory.join("document.json")).unwrap())
                .unwrap();
        assert_eq!(document["width"], 1024);
        assert_eq!(
            document["layers"][2]["text"]["content"],
            "可编辑文字\nBOWERBIRD"
        );
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let bytes = std::fs::read(directory.join("sample.psd")).unwrap();
        runtime
            .block_on(layer_export_psd(
                directory
                    .join("native-output.psd")
                    .to_string_lossy()
                    .to_string(),
                base64::engine::general_purpose::STANDARD.encode(bytes),
            ))
            .unwrap();
        let warning = runtime
            .block_on(layer_export_ai(
                directory
                    .join("native-output.ai")
                    .to_string_lossy()
                    .to_string(),
                document,
            ))
            .unwrap();
        assert!(warning.is_empty(), "{warning}");
        assert!(
            std::fs::metadata(directory.join("native-output.ai"))
                .unwrap()
                .len()
                > 1000
        );
    }
}
