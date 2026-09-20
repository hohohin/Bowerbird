//! Resolve once, then use the same absolute executable for preflight and media work.
//! No installation or PATH mutation. Only successful resolutions are cached.
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use crate::error::{AppError, AppResult};

static FFMPEG: OnceLock<PathBuf> = OnceLock::new();
static FFPROBE: OnceLock<PathBuf> = OnceLock::new();

#[derive(Clone, Copy)]
pub(crate) enum Tool {
    Ffmpeg,
    Ffprobe,
}

impl Tool {
    fn name(self) -> &'static str {
        match self {
            Self::Ffmpeg => "ffmpeg",
            Self::Ffprobe => "ffprobe",
        }
    }
    fn variable(self) -> &'static str {
        match self {
            Self::Ffmpeg => "BOWERBIRD_FFMPEG_BINARY",
            Self::Ffprobe => "BOWERBIRD_FFPROBE_BINARY",
        }
    }
    fn cache(self) -> &'static OnceLock<PathBuf> {
        match self {
            Self::Ffmpeg => &FFMPEG,
            Self::Ffprobe => &FFPROBE,
        }
    }
    fn names(self) -> Vec<String> {
        let name = self.name();
        #[cfg(target_os = "windows")]
        {
            vec![
                format!("{name}.exe"),
                format!("{name}-{}-pc-windows-msvc.exe", std::env::consts::ARCH),
            ]
        }
        #[cfg(not(target_os = "windows"))]
        {
            vec![name.to_owned()]
        }
    }
}

pub(crate) fn command(path: &Path) -> Command {
    let mut command = Command::new(path);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

pub(crate) fn spawn_error(tool: Tool, path: &Path, error: std::io::Error) -> AppError {
    AppError::Media(format!(
        "{} 已定位但无法启动：{}（{error}）",
        tool.name(),
        path.display()
    ))
}

fn validate(tool: Tool, path: &Path) -> AppResult<()> {
    let output = command(path)
        .arg("-version")
        .output()
        .map_err(|e| spawn_error(tool, path, e))?;
    if !output.status.success() {
        return Err(AppError::Media(format!(
            "{} 已定位但运行失败：{}（退出状态 {}）",
            tool.name(),
            path.display(),
            output.status
        )));
    }
    if !String::from_utf8_lossy(&output.stdout).starts_with(&format!("{} version ", tool.name())) {
        return Err(AppError::Media(format!(
            "{} 返回了无法识别的版本信息：{}",
            tool.name(),
            path.display()
        )));
    }
    Ok(())
}

fn select(tool: Tool, explicit: Option<PathBuf>, dirs: &[PathBuf]) -> AppResult<PathBuf> {
    if let Some(path) = explicit {
        // A configured but broken tool must not silently fall back to a different binary.
        let path = std::fs::canonicalize(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::Media(format!(
                    "{} 指定的 {} 路径不存在：{}",
                    tool.variable(),
                    tool.name(),
                    path.display()
                ))
            } else {
                spawn_error(tool, &path, e)
            }
        })?;
        validate(tool, &path)?;
        return Ok(path);
    }
    let mut failure = None;
    for dir in dirs {
        for name in tool.names() {
            let path = dir.join(name);
            if !path.is_file() {
                continue;
            }
            let result = std::fs::canonicalize(&path)
                .map_err(|e| spawn_error(tool, &path, e))
                .and_then(|path| {
                    validate(tool, &path)?;
                    Ok(path)
                });
            match result {
                Ok(path) => return Ok(path),
                Err(error) if failure.is_none() => failure = Some(error),
                Err(_) => {}
            }
        }
    }
    Err(failure.unwrap_or_else(|| AppError::Media(format!(
        "应用未找到 {}；已检查应用工具目录、PATH 和常见安装位置。这不代表本机未安装。请确认已有安装中的 {} 路径（可通过 {} 指定）",
        tool.name(), tool.name(), tool.variable()
    ))))
}

fn push_dir(dirs: &mut Vec<PathBuf>, dir: PathBuf) {
    // Empty/relative PATH entries must not search an arbitrary working directory.
    if dir.is_absolute() && !dirs.contains(&dir) {
        dirs.push(dir);
    }
}

fn add_path(dirs: &mut Vec<PathBuf>, path: &std::ffi::OsStr) {
    for dir in std::env::split_paths(path) {
        push_dir(dirs, dir);
    }
}

#[cfg(target_os = "windows")]
fn registered_paths() -> Vec<std::ffi::OsString> {
    use std::os::windows::ffi::OsStringExt;
    // Read only the two Path values; RegGetValue expands REG_EXPAND_SZ.
    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(
            key: isize,
            subkey: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: *mut std::ffi::c_void,
            size: *mut u32,
        ) -> i32;
    }
    let mut paths = Vec::new();
    for (key, subkey) in [
        (0x80000001u32 as i32 as isize, "Environment"),
        (
            0x80000002u32 as i32 as isize,
            "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
        ),
    ] {
        let subkey: Vec<u16> = subkey.encode_utf16().chain(Some(0)).collect();
        let value: Vec<u16> = "Path".encode_utf16().chain(Some(0)).collect();
        let mut data = vec![0u16; 32768];
        let mut size = (data.len() * 2) as u32;
        // SAFETY: NUL-terminated inputs; writable buffer size in bytes; predefined HK handles.
        let status = unsafe {
            RegGetValueW(
                key,
                subkey.as_ptr(),
                value.as_ptr(),
                6,
                std::ptr::null_mut(),
                data.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status == 0 {
            let len = data.iter().position(|v| *v == 0).unwrap_or(data.len());
            paths.push(std::ffi::OsString::from_wide(&data[..len]));
        }
    }
    paths
}

#[cfg(target_os = "windows")]
fn winget_dirs(root: &Path, dirs: &mut Vec<PathBuf>) {
    // Known package ID + one version directory only, never a recursive disk scan.
    let Ok(packages) = std::fs::read_dir(root) else {
        return;
    };
    let mut packages: Vec<_> = packages
        .flatten()
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            name.starts_with("gyan.ffmpeg_") || name.starts_with("gyan.ffmpeg.essentials_")
        })
        .map(|entry| entry.path())
        .collect();
    packages.sort();
    for package in packages {
        push_dir(dirs, package.join("bin"));
        if let Ok(versions) = std::fs::read_dir(package) {
            let mut versions: Vec<_> = versions
                .flatten()
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .to_ascii_lowercase()
                        .starts_with("ffmpeg-")
                })
                .map(|entry| entry.path())
                .collect();
            versions.sort();
            for version in versions {
                push_dir(dirs, version.join("bin"));
            }
        }
    }
}

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            push_dir(&mut dirs, parent.to_path_buf());
            push_dir(&mut dirs, parent.join("binaries"));
        }
    }
    #[cfg(debug_assertions)]
    push_dir(
        &mut dirs,
        Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries"),
    );
    // ffprobe may be next to an explicitly configured/discovered ffmpeg, and vice versa.
    for tool in [Tool::Ffmpeg, Tool::Ffprobe] {
        let path = tool.cache().get().cloned().or_else(|| explicit(tool));
        if let Some(path) = path {
            if let Some(parent) = path.parent() {
                push_dir(&mut dirs, parent.to_path_buf());
            }
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        add_path(&mut dirs, &path);
    }
    #[cfg(target_os = "macos")]
    {
        // Finder does not inherit the interactive shell's Homebrew PATH.
        push_dir(&mut dirs, PathBuf::from("/opt/homebrew/bin"));
        push_dir(&mut dirs, PathBuf::from("/usr/local/bin"));
        if let Some(home) = std::env::var_os("HOME") {
            push_dir(&mut dirs, PathBuf::from(home).join(".local/bin"));
        }
    }
    #[cfg(target_os = "windows")]
    {
        for path in registered_paths() {
            add_path(&mut dirs, &path);
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let winget = PathBuf::from(local).join("Microsoft/WinGet");
            push_dir(&mut dirs, winget.join("Links"));
            winget_dirs(&winget.join("Packages"), &mut dirs);
        }
        if let Some(home) = std::env::var_os("USERPROFILE") {
            let scoop = PathBuf::from(home).join("scoop");
            push_dir(&mut dirs, scoop.join("shims"));
            push_dir(&mut dirs, scoop.join("apps/ffmpeg/current/bin"));
        }
        if let Some(choco) = std::env::var_os("ChocolateyInstall") {
            push_dir(&mut dirs, PathBuf::from(choco).join("bin"));
        }
    }
    dirs
}

fn explicit(tool: Tool) -> Option<PathBuf> {
    std::env::var_os(tool.variable())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub(crate) fn resolve(tool: Tool) -> AppResult<&'static Path> {
    let cache = tool.cache();
    if cache.get().is_none() {
        let path = select(tool, explicit(tool), &search_dirs())?;
        let _ = cache.set(path);
    }
    Ok(cache
        .get()
        .expect("successful resolution is cached")
        .as_path())
}

pub(crate) fn ensure_video_tools() -> AppResult<()> {
    // Check both independently so a missing ffprobe does not imply ffmpeg is missing too.
    let mut errors = Vec::new();
    let mut found = Vec::new();
    for tool in [Tool::Ffmpeg, Tool::Ffprobe] {
        match resolve(tool).and_then(|path| {
            validate(tool, path)?;
            Ok(path)
        }) {
            Ok(path) => found.push(format!("{}：{}", tool.name(), path.display())),
            Err(AppError::Media(message)) => errors.push(message),
            Err(error) => errors.push(error.to_string()),
        }
    }
    if errors.is_empty() {
        return Ok(());
    }
    if !found.is_empty() {
        errors.push(format!("已确认可用：{}", found.join("；")));
    }
    Err(AppError::Media(errors.join("；")))
}

#[cfg(test)]
#[path = "tools_tests.rs"]
mod tests;
