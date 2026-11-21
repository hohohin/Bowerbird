use rusqlite::{Connection, Transaction};

use crate::{
    core::{
        catalog_browser::GENERATED,
        generation_gallery::{catalog_provenance, WORKFLOW_GALLERY_CTE},
    },
    error::AppResult,
};

pub(super) struct Policy {
    pub(super) include_generated: bool,
    pub(super) revision: i64,
}

impl Policy {
    pub(super) fn read(conn: &Connection) -> AppResult<Self> {
        Ok(conn.query_row(
            "SELECT include_generated,policy_revision FROM semantic_index_preferences WHERE id=1",
            [],
            |row| {
                Ok(Self {
                    include_generated: row.get(0)?,
                    revision: row.get(1)?,
                })
            },
        )?)
    }

    pub(super) fn provenance(
        &self,
        tx: &Transaction<'_>,
        explicit_filter: bool,
    ) -> AppResult<&'static str> {
        if self.include_generated && !explicit_filter {
            Ok(WORKFLOW_GALLERY_CTE)
        } else {
            catalog_provenance(tx)
        }
    }

    pub(super) fn condition(&self) -> String {
        if self.include_generated {
            "1".into()
        } else {
            format!("NOT {GENERATED}")
        }
    }
}
