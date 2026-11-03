//! App-owned CLI maintenance. Never block startup or a user task on the network.

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter};

const CHECK_INTERVAL: u64 = 24 * 60 * 60;
const RETRY_INTERVAL: u64 = 60 * 60;
const POLL_INTERVAL: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Copy, Default, serde::Serialize, serde::Deserialize)]
struct Schedule {
    checked_at: u64,
    next_check_at: u64,
}

fn now_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn check_due(now: u64, schedule: Schedule) -> bool {
    // Also recover if the system clock was moved backwards.
    now < schedule.checked_at || now >= schedule.next_check_at
        || schedule.next_check_at.saturating_sub(schedule.checked_at) > CHECK_INTERVAL
}

fn next_check(now: u64, succeeded: bool) -> Schedule {
    Schedule {
        checked_at: now,
        next_check_at: now.saturating_add(if succeeded { CHECK_INTERVAL } else { RETRY_INTERVAL }),
    }
}

fn read_schedule(path: &Path) -> Schedule {
    std::fs::read(path).ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_schedule(path: &Path, next: Schedule) -> std::io::Result<()> {
    let mut temporary = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    serde_json::to_writer(temporary.as_file_mut(), &next)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

pub(crate) fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Let startup and the first screen settle before doing any network I/O.
        tokio::time::sleep(Duration::from_secs(30)).await;
        let Some(data) = super::codex_cli::app_data_dir() else { return; };
        let schedule = data.join("codex-cli-update-check.json");
        let mut next = read_schedule(&schedule);
        loop {
            if check_due(now_seconds(), next) {
                let result = super::install::update_codex(&app).await;
                next = next_check(now_seconds(), result.is_ok());
                match result {
                    Ok(true) => {
                        tracing::info!("Bowerbird managed Codex CLI updated");
                        let _ = app.emit("codex://health-changed", ());
                    }
                    Ok(false) => {}
                    Err(error) => tracing::warn!(%error, "Codex CLI update deferred; keeping current version"),
                }
                if let Err(error) = save_schedule(&schedule, next) {
                    tracing::warn!(%error, "could not save Codex CLI update schedule");
                }
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daily_check_and_failure_retry_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let schedule = dir.path().join("check.json");
        let now = 1_800_000_000;
        assert!(check_due(now, read_schedule(&schedule)));
        save_schedule(&schedule, next_check(now, true)).unwrap();
        assert!(!check_due(now + CHECK_INTERVAL - 1, read_schedule(&schedule)));
        assert!(check_due(now + CHECK_INTERVAL, read_schedule(&schedule)));
        save_schedule(&schedule, next_check(now, false)).unwrap();
        assert!(!check_due(now + RETRY_INTERVAL - 1, read_schedule(&schedule)));
        assert!(check_due(now + RETRY_INTERVAL, read_schedule(&schedule)));
    }

    #[test]
    fn corrupt_schedule_and_clock_changes_do_not_suspend_updates() {
        let dir = tempfile::tempdir().unwrap();
        let schedule = dir.path().join("check.json");
        std::fs::write(&schedule, "interrupted write").unwrap();
        assert!(check_due(100, read_schedule(&schedule)));
        assert!(check_due(100, next_check(200, true)));
        // A two-hour clock rollback must not turn a one-hour retry into three hours.
        assert!(check_due(10_000, next_check(10_000 + 2 * RETRY_INTERVAL, false)));
        assert!(check_due(200 + CHECK_INTERVAL, next_check(100, true)));
    }
}
