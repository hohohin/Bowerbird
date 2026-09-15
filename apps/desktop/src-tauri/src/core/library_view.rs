//! Homepage browsing: filter canonical assets before grouping by project membership.
use serde::{Deserialize, Serialize};

use crate::core::library::Asset;
use crate::db::Database;
use crate::error::AppResult;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryViewFilter {
    pub search: Option<String>,
    pub smart: Option<String>,
    pub folder_id: Option<String>,
    pub collection_id: Option<String>,
    pub color: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMembership {
    pub asset_id: String,
    pub project_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryView {
    pub assets: Vec<Asset>,
    pub memberships: Vec<ProjectMembership>,
    pub total: i64,
}

impl Database {
    pub fn library_view(&self, filter: LibraryViewFilter) -> AppResult<LibraryView> {
        // SQLite LIMIT -1 avoids clipping a project at the old 500-asset page boundary.
        // Grouping must happen before generation-session collapse: a session can span projects.
        let mut assets = if let Some(search) = filter.search.as_deref().filter(|s| !s.is_empty()) {
            self.search_assets_ex(search, None, false, -1)?
        } else if let Some(smart) = filter.smart.as_deref() {
            self.list_assets_smart_ex(smart, None, false, -1, 0)?
        } else if let Some(collection) = filter.collection_id.as_deref() {
            self.list_assets_by_collection_ex(collection, None, false, -1, 0)?
        } else if let Some(color) = filter.color.as_deref() {
            self.list_assets_by_color_ex(filter.folder_id.as_deref(), None, color, false, -1, 0)?
        } else {
            self.list_assets_ex(filter.folder_id.as_deref(), None, false, -1, 0)?
        };
        // The generated-image control also applies when a search is active.
        if let Some(mode @ ("source:generated" | "source:!generated")) = filter.smart.as_deref() {
            assets.retain(|asset| {
                let generated = asset.generation_session_id.is_some();
                generated == (mode == "source:generated")
            });
        }
        let total = self.count_assets(None)?;
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT pa.asset_id, pa.project_id FROM project_assets pa \
             JOIN projects p ON p.id = pa.project_id WHERE p.archived_at IS NULL",
        )?;
        let memberships = stmt
            .query_map([], |row| {
                Ok(ProjectMembership {
                    asset_id: row.get(0)?,
                    project_id: row.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(LibraryView {
            assets,
            memberships,
            total,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Database {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.create_project("a", "Project A", "/a", "/a", "user")
            .unwrap();
        db.create_project("b", "Project B", "/b", "/b", "user")
            .unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch(
                "INSERT INTO assets(id, name, source, generation_session_id, created_at) VALUES
                ('global', 'poster global', 'imported', NULL, 1),
                ('shared', 'poster shared', 'imported', NULL, 2),
                ('gen-a', 'poster generated A', 'codex', 'same-session', 3),
                ('gen-b', 'poster generated B', 'codex', 'same-session', 4);
                INSERT INTO project_assets(project_id, asset_id, created_at) VALUES
                ('a', 'shared', 1), ('b', 'shared', 1), ('a', 'gen-a', 1), ('b', 'gen-b', 1);",
            )
            .unwrap();
        }
        db
    }

    #[test]
    fn homepage_preserves_shared_membership_and_sessions_across_projects() {
        let db = fixture();
        let view = db.library_view(LibraryViewFilter::default()).unwrap();
        assert_eq!(view.total, 4);
        assert_eq!(view.assets.len(), 4);
        assert_eq!(
            view.memberships
                .iter()
                .filter(|m| m.asset_id == "shared")
                .count(),
            2
        );
        assert_eq!(
            view.assets
                .iter()
                .filter(|a| a.generation_session_id.is_some())
                .count(),
            2
        );
    }

    #[test]
    fn homepage_search_and_generated_filter_apply_together() {
        let db = fixture();
        for (smart, expected) in [("source:generated", 2), ("source:!generated", 2)] {
            let view = db
                .library_view(LibraryViewFilter {
                    search: Some("poster".into()),
                    smart: Some(smart.into()),
                    ..Default::default()
                })
                .unwrap();
            assert_eq!(view.assets.len(), expected);
            assert!(view
                .assets
                .iter()
                .all(|a| a.generation_session_id.is_some() == (smart == "source:generated")));
        }
        let view = db
            .library_view(LibraryViewFilter {
                search: Some("not-present".into()),
                ..Default::default()
            })
            .unwrap();
        assert!(view.assets.is_empty());
        assert_eq!(view.total, 4);
    }

    #[test]
    fn homepage_does_not_clip_project_members_at_500_or_hide_archived_assets() {
        let db = fixture();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("UPDATE projects SET archived_at = 1 WHERE id = 'b'", [])
                .unwrap();
            for index in 0..510 {
                conn.execute(
                    "INSERT INTO assets(id, name) VALUES (?1, 'extra')",
                    [format!("extra-{index}")],
                )
                .unwrap();
            }
        }
        let view = db.library_view(LibraryViewFilter::default()).unwrap();
        assert_eq!(view.assets.len(), 514);
        assert!(view.memberships.iter().all(|m| m.project_id == "a"));
        assert!(view.assets.iter().any(|a| a.id == "gen-b"));
    }
}
