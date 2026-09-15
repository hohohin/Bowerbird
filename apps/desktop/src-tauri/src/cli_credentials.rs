//! Bowerbird-owned CLI state; never imports credentials from the user's CLI.
use std::path::{Path, PathBuf};
use tokio::process::Command;

pub(crate) const DREAMINA_REGISTRY: &str = "Software\\Bowerbird\\CliAuth\\Dreamina";

pub(crate) fn root() -> PathBuf {
    crate::codex::codex_cli::app_data_dir()
        .expect("Bowerbird app data directory unavailable")
        .join("cli-profiles")
}

pub(crate) fn codex_home() -> PathBuf { root().join("codex") }

pub(crate) fn codex_environment(command: &mut Command) {
    command.env("CODEX_HOME", codex_home())
        .env_remove("OPENAI_API_KEY").env_remove("CODEX_API_KEY")
        .env_remove("OPENAI_BASE_URL").env_remove("CODEX_AUTH_JSON");
}

pub(crate) fn dreamina_environment(command: &mut Command) {
    let home = root().join("dreamina");
    command.env("USERPROFILE", &home).env("HOME", &home)
        .env("APPDATA", home.join("AppData/Roaming"))
        .env("LOCALAPPDATA", home.join("AppData/Local"))
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_DATA_HOME", home.join(".local/share"))
        .env("BOWERBIRD_DREAMINA_REGISTRY", DREAMINA_REGISTRY);
}

pub(crate) fn launcher() -> PathBuf {
    crate::codex::codex_cli::app_data_dir().expect("app data directory")
        .join("cli-runtime").join(env!("CARGO_PKG_VERSION")).join("cli-launcher.exe")
}

fn write_if_changed(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if std::fs::read(path).ok().as_deref() != Some(bytes) { std::fs::write(path, bytes)?; }
    Ok(())
}

pub(crate) fn initialize() -> std::io::Result<()> {
    check_private_paths(&crate::codex::codex_cli::app_data_dir().expect("app data directory"))?;
    for path in [codex_home(), root().join("dreamina/AppData/Roaming"), root().join("dreamina/AppData/Local")] {
        std::fs::create_dir_all(path)?;
    }
    // Fixed file storage prevents a user/global keyring configuration from being inherited.
    write_if_changed(&codex_home().join("config.toml"), b"cli_auth_credentials_store = \"file\"\n")?;
    #[cfg(windows)]
    {
        let launcher = launcher();
        let directory = launcher.parent().unwrap();
        std::fs::create_dir_all(directory)?;
        write_if_changed(&launcher, include_bytes!(concat!(env!("OUT_DIR"), "/cli-launcher.exe")))?;
        write_if_changed(&directory.join("cli-registry.dll"), include_bytes!(concat!(env!("OUT_DIR"), "/cli-registry.dll")))?;
    }
    Ok(())
}

pub(crate) fn remove_file_if_present(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Only credential files and paid-rights cache are reset. CLI sessions and library stay intact.
fn check_private_paths(app_dir: &Path) -> std::io::Result<()> {
    // Do not follow a replaced profile directory into the user's shared CLI home.
    for relative in ["cli-profiles", "cli-profiles/codex", "cli-profiles/codex/auth.json", "cli-profiles/codex/config.toml", "cli-runtime"] {
        let path = app_dir.join(relative);
        if let Ok(metadata) = std::fs::symlink_metadata(&path) {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Err(std::io::Error::other("CLI profile must not be a reparse point"));
                }
            }
            if metadata.file_type().is_symlink() {
                return Err(std::io::Error::other("CLI profile must not be a symbolic link"));
            }
        }
    }
    Ok(())
}

pub(crate) fn clear_files(app_dir: &Path) -> std::io::Result<()> {
    check_private_paths(app_dir)?;
    remove_file_if_present(&app_dir.join("cli-profiles/codex/auth.json"))?;
    remove_file_if_present(&app_dir.join("entitlement.json"))
}

#[cfg(windows)]
pub(crate) fn clear_dreamina_registry() -> std::io::Result<()> {
    use windows::Win32::System::Registry::{RegDeleteTreeW, HKEY_CURRENT_USER};
    let key: Vec<u16> = DREAMINA_REGISTRY.encode_utf16().chain(Some(0)).collect();
    let result = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, windows::core::PCWSTR(key.as_ptr())) };
    if result.0 == 0 || result.0 == 2 { Ok(()) } else { Err(std::io::Error::from_raw_os_error(result.0 as i32)) }
}

/// Stop only launchers under this installation's app-data runtime directory.
/// Their job handles kill the CLI child too, including a pending OAuth login.
#[cfg(windows)]
pub(crate) fn stop_owned_cli(app_dir: &Path) -> std::io::Result<()> {
    use windows::Win32::{Foundation::CloseHandle, System::{
        Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS},
        Threading::{OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, PROCESS_SYNCHRONIZE, PROCESS_NAME_WIN32},
    }};
    let prefix = format!("{}\\", app_dir.join("cli-runtime").display()).to_lowercase();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)?;
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut next = Process32FirstW(snapshot, &mut entry);
        let mut failure = None;
        while next.is_ok() {
            if let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, false, entry.th32ProcessID) {
                let mut path = vec![0u16; 32768];
                let mut size = path.len() as u32;
                if QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, windows::core::PWSTR(path.as_mut_ptr()), &mut size).is_ok() {
                    let path = String::from_utf16_lossy(&path[..size as usize]).to_lowercase();
                    if path.starts_with(&prefix) && path.ends_with("\\cli-launcher.exe") {
                        if TerminateProcess(handle, 125).is_err() || WaitForSingleObject(handle, 30000).0 != 0 {
                            failure = Some(std::io::Error::other("Unable to stop Bowerbird CLI login"));
                        }
                    }
                }
                let _ = CloseHandle(handle);
            }
            next = Process32NextW(snapshot, &mut entry);
        }
        let _ = CloseHandle(snapshot);
        if let Some(error) = failure { return Err(error); }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reset_preserves_library_settings_and_cli_history() {
        let temp = std::env::temp_dir().join(format!("bb-auth-test-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(temp.join("cli-profiles/codex/sessions")).unwrap();
        let kept = ["library.db", "settings.json", "cli-profiles/codex/sessions/history.jsonl"];
        for file in kept { std::fs::write(temp.join(file), b"keep").unwrap(); }
        for file in ["entitlement.json", "cli-profiles/codex/auth.json"] { std::fs::write(temp.join(file), b"test-token").unwrap(); }
        clear_files(&temp).unwrap();
        clear_files(&temp).unwrap();
        assert!(!temp.join("entitlement.json").exists());
        assert!(!temp.join("cli-profiles/codex/auth.json").exists());
        for file in kept { assert_eq!(std::fs::read(temp.join(file)).unwrap(), b"keep"); }
        std::fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn child_environments_override_shared_credentials() {
        let mut command = Command::new("fixture");
        codex_environment(&mut command);
        let env: std::collections::HashMap<_, _> = command.as_std().get_envs().collect();
        assert_eq!(env.get(std::ffi::OsStr::new("CODEX_HOME")), Some(&Some(codex_home().as_os_str())));
        assert_eq!(env.get(std::ffi::OsStr::new("OPENAI_API_KEY")), Some(&None));
        let mut command = Command::new("fixture");
        dreamina_environment(&mut command);
        let env: std::collections::HashMap<_, _> = command.as_std().get_envs().collect();
        assert_eq!(env.get(std::ffi::OsStr::new("BOWERBIRD_DREAMINA_REGISTRY")), Some(&Some(std::ffi::OsStr::new(DREAMINA_REGISTRY))));
        assert!(env[std::ffi::OsStr::new("USERPROFILE")].unwrap().to_string_lossy().contains("cli-profiles"));
    }
}
