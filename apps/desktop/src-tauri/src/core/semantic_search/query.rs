use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

use rusqlite::{
    params_from_iter,
    types::{Value, ValueRef},
    Connection, OptionalExtension, Transaction,
};
use serde::Serialize;

use crate::{
    core::{
        catalog_browser::CatalogFilter,
        library::{asset_from_row, Asset},
    },
    db::Database,
    error::{AppError, AppResult},
};

use super::{
    embedding::{Embedding, RankedImage, TopImages},
    index::{self, INDEXABLE_FORMAT, VECTOR_JOINS},
    model,
    scope::Policy,
};

pub(crate) const MAX_RESULTS: usize = 240;
const MAX_PAGE: usize = 60;
const READ_BATCH: i64 = 256;

pub(crate) struct SearchSnapshot {
    pub library_id: String,
    pub model_key: String,
    pub index_revision: i64,
    pub eligible: usize,
    pub indexed: usize,
    pub truncated: bool,
    policy_revision: i64,
    filter: CatalogFilter,
    ranked: Vec<RankedImage>,
}

#[derive(Serialize)]
pub(crate) struct Hit {
    asset: Asset,
    score: f32,
}

fn code(name: &str) -> AppError {
    AppError::Other(name.into())
}

pub(crate) fn validated_filter(mut filter: CatalogFilter) -> AppResult<CatalogFilter> {
    if filter.kind != "all"
        || filter.id.is_some()
        || !matches!(filter.media.as_str(), "all" | "images")
        || filter
            .query
            .as_ref()
            .is_some_and(|name| name.chars().take(513).count() > 512)
        || filter.color.as_ref().is_some_and(|color| {
            !crate::media::color::BUCKETS
                .iter()
                .any(|(bucket, _)| bucket == color)
        })
    {
        return Err(code("invalid_scope"));
    }
    filter.media = "images".into();
    Ok(filter)
}

fn project_exists(conn: &Connection, filter: &CatalogFilter) -> AppResult<bool> {
    let Some(project) = &filter.project_id else {
        return Ok(true);
    };
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
        [project],
        |row| row.get(0),
    )?)
}

fn active_index(conn: &Connection) -> AppResult<Option<(String, i64)>> {
    Ok(conn
        .query_row(
            "SELECT model_key,revision FROM semantic_index_state WHERE id=1 AND run_state<>'off'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

fn with_snapshot<T>(
    conn: &Connection,
    read: impl FnOnce(&Transaction<'_>, &Policy) -> AppResult<T>,
) -> AppResult<T> {
    let tx = conn.unchecked_transaction()?;
    let scope = Policy::read(&tx)?;
    let result = read(&tx, &scope)?;
    tx.commit()?;
    Ok(result)
}

fn check_time(cancel: &AtomicBool, deadline: Instant) -> AppResult<()> {
    if cancel.load(Ordering::Acquire) {
        return Err(code("cancelled"));
    }
    if Instant::now() >= deadline {
        return Err(code("resource_limit"));
    }
    Ok(())
}

pub(crate) fn search(
    path: &Path,
    filter: CatalogFilter,
    text: Vec<f32>,
    top_k: usize,
    truncated: bool,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
) -> AppResult<SearchSnapshot> {
    let readonly = Database::open_read_only(path)?;
    let conn = readonly.conn.lock().unwrap();
    let guard = cancel.clone();
    conn.progress_handler(
        3_000,
        Some(move || guard.load(Ordering::Acquire) || Instant::now() >= deadline),
    );
    let text = Embedding::normalize(text).ok_or_else(|| code("model_corrupt"))?;
    check_time(&cancel, deadline)?;
    let filter = validated_filter(filter)?;
    let result = with_snapshot(&conn, |conn, scope| {
        let library_id = index::library_id(conn)?;
        if !project_exists(conn, &filter)? {
            return Err(code("invalid_scope"));
        }
        let (model_key, index_revision) = active_index(conn)?.ok_or_else(|| code("index_empty"))?;
        if model_key != model::MODEL_ID {
            return Err(code("model_missing"));
        }
        let provenance = scope.provenance(conn, filter.generated.is_some())?;
        let (condition, values) = filter.sql()?;
        let source_policy = scope.condition();
        let valid = index::valid_vector_condition();
        let mut sql = conn.prepare(&format!(
            "WITH {provenance}
            SELECT a.id,sv.content_sha256,CASE WHEN {valid} THEN sv.vec_f32le END
            FROM assets a {VECTOR_JOINS} WHERE {condition} AND {INDEXABLE_FORMAT}
              AND {source_policy} AND COALESCE(sj.status,'')<>'unsupported'
              AND a.id>? ORDER BY a.id LIMIT ?"
        ))?;
        let mut bindings = vec![Value::Text(model_key.clone())];
        bindings.extend(values);
        let cursor = bindings.len();
        bindings.extend([Value::Text(String::new()), Value::Integer(READ_BATCH)]);
        let mut eligible = 0;
        let mut indexed = 0;
        let mut heap = TopImages::new(top_k.clamp(1, MAX_RESULTS));
        loop {
            check_time(&cancel, deadline)?;
            let mut rows = sql.query(params_from_iter(&bindings))?;
            let mut scanned = 0;
            let mut last = String::new();
            while let Some(row) = rows.next()? {
                scanned += 1;
                eligible += 1;
                last = row.get(0)?;
                if let ValueRef::Blob(bytes) = row.get_ref(2)? {
                    if let Some(vector) = Embedding::from_bytes(bytes) {
                        indexed += 1;
                        let score = text.similarity(&vector);
                        if score >= model::SEARCH_MIN_COSINE {
                            heap.insert(RankedImage {
                                id: last.clone(),
                                score,
                                content_sha256: row.get(1)?,
                            });
                        }
                    } else {
                        tracing::warn!("semantic search skipped a corrupt vector");
                    }
                }
            }
            if scanned < READ_BATCH {
                break;
            }
            bindings[cursor] = Value::Text(last);
        }
        check_time(&cancel, deadline)?;
        Ok(SearchSnapshot {
            library_id,
            model_key,
            index_revision,
            policy_revision: scope.revision,
            eligible,
            indexed,
            truncated,
            filter: filter.clone(),
            ranked: heap.finish(),
        })
    });
    check_time(&cancel, deadline)?;
    result
}

impl SearchSnapshot {
    pub(crate) fn len(&self) -> usize {
        self.ranked.len()
    }

    pub(super) fn validate_policy(&self, path: &Path) -> AppResult<()> {
        let readonly = Database::open_read_only(path)?;
        let conn = readonly.conn.lock().unwrap();
        if Policy::read(&conn)?.revision != self.policy_revision {
            return Err(code("stale_session"));
        }
        Ok(())
    }

    fn slice(&self, offset: usize, limit: usize) -> &[RankedImage] {
        let start = offset.min(self.ranked.len());
        let end = (start + limit.min(MAX_PAGE)).min(self.ranked.len());
        &self.ranked[start..end]
    }

    /// Check the whole frozen result set before serving any page or selection.
    /// Additions do not reshuffle it, and losses cannot silently shift offsets.
    fn read<T>(
        &self,
        path: &Path,
        action: impl FnOnce(&Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        let readonly = Database::open_read_only(path)?;
        let conn = readonly.conn.lock().unwrap();
        let deadline = Instant::now() + std::time::Duration::from_secs(10);
        conn.progress_handler(3_000, Some(move || Instant::now() >= deadline));
        let result = with_snapshot(&conn, |conn, scope| {
            let same_library = index::library_id(conn)? == self.library_id;
            let same_model = active_index(conn)?.is_some_and(|(key, _)| key == self.model_key);
            if scope.revision != self.policy_revision
                || !same_library
                || !same_model
                || !project_exists(conn, &self.filter)?
            {
                return Err(code("stale_session"));
            }
            if self.ranked.is_empty() {
                return action(conn);
            }
            let provenance = scope.provenance(conn, self.filter.generated.is_some())?;
            let (condition, values) = self.filter.sql()?;
            let source_policy = scope.condition();
            let placeholders = vec!["?"; self.ranked.len()].join(",");
            let valid = index::valid_vector_condition();
            let mut query = conn.prepare(&format!(
                "WITH {provenance} SELECT a.id,sv.content_sha256 FROM assets a {VECTOR_JOINS}
                WHERE {condition} AND {INDEXABLE_FORMAT} AND {valid} AND {source_policy}
                AND COALESCE(sj.status,'')<>'unsupported' AND a.id IN ({placeholders})"
            ))?;
            let mut bindings = vec![Value::Text(self.model_key.clone())];
            bindings.extend(values);
            bindings.extend(self.ranked.iter().map(|hit| Value::Text(hit.id.clone())));
            let current: HashMap<String, String> = query
                .query_map(params_from_iter(bindings), |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<_, _>>()?;
            if self
                .ranked
                .iter()
                .any(|hit| current.get(&hit.id) != Some(&hit.content_sha256))
            {
                return Err(code("stale_session"));
            }
            action(conn)
        });
        if Instant::now() >= deadline {
            return Err(code("resource_limit"));
        }
        result
    }

    pub(crate) fn page(&self, path: &Path, offset: usize, limit: usize) -> AppResult<Vec<Hit>> {
        self.read(path, |conn| {
            let mut stmt = conn.prepare("SELECT * FROM assets WHERE id=?1")?;
            self.slice(offset, limit)
                .iter()
                .map(|hit| {
                    Ok(Hit {
                        asset: stmt.query_row([&hit.id], asset_from_row)?,
                        score: hit.score,
                    })
                })
                .collect()
        })
    }

    pub(crate) fn ids(&self, path: &Path, offset: usize, limit: usize) -> AppResult<Vec<String>> {
        self.read(path, |_| {
            Ok(self
                .slice(offset, limit)
                .iter()
                .map(|hit| hit.id.clone())
                .collect())
        })
    }
}
