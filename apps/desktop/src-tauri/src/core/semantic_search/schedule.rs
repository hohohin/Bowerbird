use rusqlite::{params, Connection};

use crate::{core::settings::SemanticIndexPreferences, db::Database, error::AppResult};

use super::index;

pub(super) struct Schedule {
    pub preferences: SemanticIndexPreferences,
    round_kind: Option<String>,
    pub round_started_at: Option<i64>,
    pub audit_pending: bool,
    pub last_update_at: Option<i64>,
    pub next_update_at: Option<i64>,
}

impl Schedule {
    pub fn read(conn: &Connection) -> rusqlite::Result<Self> {
        conn.query_row(
            "SELECT automatic_enabled,interval_minutes,include_generated,round_kind,
                    round_started_at,audit_pending,last_update_at,next_update_at
             FROM semantic_index_preferences WHERE id=1",
            [],
            |row| {
                Ok(Self {
                    preferences: SemanticIndexPreferences {
                        automatic: row.get(0)?,
                        interval_minutes: row.get(1)?,
                        include_generated: row.get(2)?,
                    },
                    round_kind: row.get(3)?,
                    round_started_at: row.get(4)?,
                    audit_pending: row.get(5)?,
                    last_update_at: row.get(6)?,
                    next_update_at: row.get(7)?,
                })
            },
        )
    }

    pub fn active(&self) -> bool {
        self.round_started_at.is_some()
    }

    pub fn due(&self, now: i64) -> bool {
        self.preferences.automatic && self.next_update_at.is_none_or(|next| next <= now)
    }
}

pub(super) enum PreferenceChange {
    None,
    Cadence,
    Scope,
}

pub(super) fn reconcile(
    db: &Database,
    read_settings: impl FnOnce() -> SemanticIndexPreferences,
    now: i64,
) -> AppResult<PreferenceChange> {
    let mut conn = db.conn.lock().unwrap();
    let current = Schedule::read(&conn)?;
    // Read the authoritative settings after acquiring the library lock. A
    // delayed save notification cannot put an earlier preference back in use.
    let preferences = read_settings();
    if current.preferences == preferences {
        return Ok(PreferenceChange::None);
    }
    let policy_changed = current.preferences.include_generated != preferences.include_generated;
    let stop_automatic = !preferences.automatic && current.round_kind.as_deref() == Some("automatic");
    let enabled: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM semantic_index_state WHERE id=1 AND run_state='running')",
        [],
        |row| row.get(0),
    )?;
    let next = (preferences.automatic && enabled)
        .then_some(now + i64::from(preferences.interval_minutes) * 60);
    let tx = conn.transaction()?;
    if stop_automatic {
        index::revoke_leases(&tx)?;
    }
    tx.execute(
        "UPDATE semantic_index_preferences SET automatic_enabled=?1,interval_minutes=?2,
            include_generated=?3,policy_revision=policy_revision+?4,
            round_kind=CASE WHEN ?5 THEN NULL ELSE round_kind END,
            round_started_at=CASE WHEN ?5 THEN NULL ELSE round_started_at END,
            audit_pending=CASE WHEN ?5 THEN 0 ELSE audit_pending END,
            next_update_at=?6 WHERE id=1",
        params![
            preferences.automatic,
            preferences.interval_minutes,
            preferences.include_generated,
            policy_changed,
            stop_automatic,
            next,
        ],
    )?;
    if policy_changed {
        tx.execute("UPDATE semantic_index_state SET revision=revision+1 WHERE id=1", [])?;
    }
    tx.commit()?;
    Ok(if policy_changed {
        PreferenceChange::Scope
    } else {
        PreferenceChange::Cadence
    })
}

pub(super) fn begin(conn: &Connection, manual: bool, audit: bool, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE semantic_index_preferences SET round_kind=?1,audit_pending=?2,round_started_at=?3,next_update_at=NULL
         WHERE id=1",
        params![if manual { "manual" } else { "automatic" }, audit, now],
    )?;
    Ok(())
}

pub(super) fn keep_manual(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE semantic_index_preferences SET round_kind='manual'
         WHERE id=1 AND round_kind='automatic'",
        [],
    )?;
    Ok(())
}

pub(super) fn stop(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE semantic_index_preferences SET round_kind=NULL,round_started_at=NULL,audit_pending=0,next_update_at=NULL WHERE id=1",
        [],
    )?;
    Ok(())
}

pub(super) fn complete(conn: &Connection, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE semantic_index_preferences SET round_kind=NULL,round_started_at=NULL,audit_pending=0,last_update_at=?1,
         next_update_at=CASE WHEN automatic_enabled=1 THEN ?1+interval_minutes*60 ELSE NULL END WHERE id=1",
        [now],
    )?;
    Ok(())
}
