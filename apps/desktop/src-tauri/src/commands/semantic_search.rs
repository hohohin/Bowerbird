use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::{
    core::{
        catalog_browser::CatalogFilter,
        paths::LibraryPaths,
        semantic_search::{
            query::Hit,
            runtime::{wire_error, Operation, SearchResponse, SemanticSearch, Status},
        },
    },
    db::Database,
};

#[tauri::command]
pub(crate) async fn semantic_status(
    app: AppHandle,
    search: State<'_, Arc<SemanticSearch>>,
    db: State<'_, Arc<Database>>,
) -> Result<Status, String> {
    let search = search.inner().clone();
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        search.sync_preferences(&app, &db).map_err(wire_error)?;
        search.status(&db).map_err(wire_error)
    })
        .await
        .map_err(|_| "internal_error".to_owned())?
}

#[tauri::command]
pub(crate) async fn semantic_model_control(
    app: AppHandle,
    search: State<'_, Arc<SemanticSearch>>,
    db: State<'_, Arc<Database>>,
    action: String,
) -> Result<Operation, String> {
    let search = search.inner().clone();
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        search.model_action(app, db, &action).map_err(wire_error)
    })
    .await
    .map_err(|_| "internal_error".to_owned())?
}

#[tauri::command]
pub(crate) async fn semantic_index_control(
    app: AppHandle,
    search: State<'_, Arc<SemanticSearch>>,
    db: State<'_, Arc<Database>>,
    action: String,
) -> Result<Operation, String> {
    let search = search.inner().clone();
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        search.index_action(&app, &db, &action).map_err(wire_error)
    })
    .await
    .map_err(|_| "internal_error".to_owned())?
}

#[tauri::command]
pub(crate) async fn semantic_search_start(
    app: AppHandle,
    search: State<'_, Arc<SemanticSearch>>,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    request_id: String,
    pane_id: String,
    text: String,
    filter: CatalogFilter,
    top_k: Option<usize>,
) -> Result<SearchResponse, String> {
    search.sync_preferences(&app, &db).map_err(wire_error)?;
    search
        .inner()
        .start(
            paths.db.clone(),
            request_id,
            pane_id,
            text,
            filter,
            top_k.unwrap_or(crate::core::semantic_search::query::MAX_RESULTS),
        )
        .await
        .map_err(wire_error)
}

#[tauri::command]
pub(crate) async fn semantic_search_page(
    app: AppHandle,
    search: State<'_, Arc<SemanticSearch>>,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    session_id: String,
    offset: usize,
    limit: usize,
) -> Result<Vec<Hit>, String> {
    search.sync_preferences(&app, &db).map_err(wire_error)?;
    search
        .read_session(paths.db.clone(), session_id, move |snapshot, path| {
            snapshot.page(path, offset, limit)
        })
        .await
        .map_err(wire_error)
}

#[tauri::command]
pub(crate) async fn semantic_search_ids(
    app: AppHandle,
    search: State<'_, Arc<SemanticSearch>>,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    session_id: String,
    offset: usize,
    limit: usize,
) -> Result<Vec<String>, String> {
    search.sync_preferences(&app, &db).map_err(wire_error)?;
    search
        .read_session(paths.db.clone(), session_id, move |snapshot, path| {
            snapshot.ids(path, offset, limit)
        })
        .await
        .map_err(wire_error)
}

#[tauri::command]
pub(crate) fn semantic_search_cancel(
    search: State<'_, Arc<SemanticSearch>>,
    request_id: Option<String>,
    session_id: Option<String>,
) {
    search.cancel(request_id.as_deref(), session_id.as_deref());
}
