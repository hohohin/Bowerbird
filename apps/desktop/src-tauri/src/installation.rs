//! The installer writes a fresh pending marker on every install, including same-version reinstalls.
use std::path::Path;
use crate::error::AppResult;

pub(crate) const PENDING: &str = "installation-auth-reset.pending";

pub(crate) fn finish_pending(app_dir: &Path, clear: impl FnOnce() -> AppResult<()>) -> AppResult<()> {
    if !app_dir.join(PENDING).try_exists()? { return Ok(()); }
    clear()?;
    crate::cli_credentials::remove_file_if_present(&app_dir.join(PENDING))?;
    Ok(())
}

pub(crate) fn reset_pending(app_dir: &Path) -> AppResult<()> {
    finish_pending(app_dir, || {
        #[cfg(windows)]
        crate::cli_credentials::stop_owned_cli(app_dir)?;
        crate::cloud::AuthClient::clear_saved_login()?;
        crate::cli_credentials::clear_files(app_dir)?;
        #[cfg(windows)]
        crate::cli_credentials::clear_dreamina_registry()?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn each_reinstall_resets_once_and_failure_keeps_startup_gate() {
        let dir = std::env::temp_dir().join(format!("bb-install-test-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        finish_pending(&dir, || panic!("ordinary startup must not log out")).unwrap();
        for _ in 0..2 {
            std::fs::write(dir.join(PENDING), b"1").unwrap();
            assert!(finish_pending(&dir, || Err(crate::error::AppError::Other("fixture failure".into()))).is_err());
            assert!(dir.join(PENDING).exists());
            finish_pending(&dir, || Ok(())).unwrap();
            assert!(!dir.join(PENDING).exists());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
