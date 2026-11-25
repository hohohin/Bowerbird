//! Project canvas Tauri commands (`PROJECT-CANVAS-PLAN` PB2).

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::core::project_canvas::{
    CanvasBatchCreated, CanvasEdge, CanvasGroup, CanvasGroupBatchCreate, CanvasGroupItem,
    CanvasNode, CanvasNodeBatchLayout, CanvasNodeLayoutUpdate, CanvasNodeRemoval, CanvasView,
    CanvasViewInput, CreativeThread, NewCanvasEdge, NewCanvasGroup, NewCanvasNode,
    NewCreativeThread, ProjectCanvas, ProjectCanvasMaterializeInput, ProjectCanvasSnapshot,
};
use crate::db::Database;
use crate::error::{AppError, AppResult};

pub(super) async fn run_canvas_db<T: Send + 'static>(
    db: &Arc<Database>,
    action: impl FnOnce(&Database) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let db = db.clone();
    tokio::task::spawn_blocking(move || action(&db))
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
}

#[tauri::command]
pub async fn project_canvas_materialize(
    db: State<'_, Arc<Database>>,
    mut value: ProjectCanvasMaterializeInput,
    files: State<'_, Arc<crate::core::file_workspace::FileWorkspace>>,
    initial_threads: Vec<NewCreativeThread>,
    initial_nodes: Vec<NewCanvasNode>,
    initial_view: Option<CanvasViewInput>,
) -> AppResult<ProjectCanvas> {
    let files = files.inner().clone();
    run_canvas_db(db.inner(), move |db| {
        value.workspace_path = files
            .project_directory(&value.project_id, &value.name)?
            .to_string_lossy()
            .into_owned();
        db.materialize_project_canvas(
            &value,
            &initial_threads,
            &initial_nodes,
            initial_view.as_ref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn project_canvas_ensure(
    db: State<'_, Arc<Database>>,
    project_id: String,
) -> AppResult<ProjectCanvas> {
    run_canvas_db(db.inner(), move |db| db.ensure_project_canvas(&project_id)).await
}

#[tauri::command]
pub async fn project_canvas_get(
    db: State<'_, Arc<Database>>,
    project_id: String,
) -> AppResult<ProjectCanvasSnapshot> {
    run_canvas_db(db.inner(), move |db| {
        db.project_canvas_snapshot(&project_id)
    })
    .await
}

#[tauri::command]
pub async fn project_canvas_has_asset(
    db: State<'_, Arc<Database>>,
    project_id: String,
    asset_id: String,
) -> AppResult<bool> {
    run_canvas_db(db.inner(), move |db| {
        db.project_canvas_has_asset(&project_id, &asset_id)
    })
    .await
}

#[tauri::command]
pub async fn project_canvas_visible_nodes(
    db: State<'_, Arc<Database>>,
    project_id: String,
    node_ids: Vec<String>,
) -> AppResult<Vec<CanvasNode>> {
    run_canvas_db(db.inner(), move |db| {
        db.visible_canvas_nodes(&project_id, &node_ids)
    })
    .await
}

#[tauri::command]
pub async fn project_canvas_rename(
    db: State<'_, Arc<Database>>,
    project_id: String,
    title: String,
) -> AppResult<bool> {
    run_canvas_db(db.inner(), move |db| {
        db.rename_canvas_project(&project_id, &title)
    })
    .await
}

#[tauri::command]
pub async fn project_canvas_title_from_first_prompt(
    db: State<'_, Arc<Database>>,
    project_id: String,
    title: String,
) -> AppResult<bool> {
    run_canvas_db(db.inner(), move |db| {
        db.title_canvas_project_from_first_prompt(&project_id, &title)
    })
    .await
}

#[tauri::command]
pub async fn project_canvas_update_draft(
    db: State<'_, Arc<Database>>,
    project_id: String,
    draft_json: String,
) -> AppResult<bool> {
    run_canvas_db(db.inner(), move |db| {
        db.update_project_canvas_draft(&project_id, &draft_json)
    })
    .await
}

#[tauri::command]
pub async fn project_canvas_touch(
    db: State<'_, Arc<Database>>,
    project_id: String,
) -> AppResult<bool> {
    run_canvas_db(db.inner(), move |db| db.touch_project_canvas(&project_id)).await
}

#[tauri::command]
pub async fn project_thread_create(
    db: State<'_, Arc<Database>>,
    value: NewCreativeThread,
) -> AppResult<CreativeThread> {
    run_canvas_db(db.inner(), move |db| db.create_creative_thread(&value)).await
}

#[tauri::command]
pub async fn project_thread_archive(
    db: State<'_, Arc<Database>>,
    thread_id: String,
) -> AppResult<bool> {
    run_canvas_db(db.inner(), move |db| db.archive_creative_thread(&thread_id)).await
}

#[tauri::command]
pub async fn project_thread_restore(
    db: State<'_, Arc<Database>>,
    thread_id: String,
) -> AppResult<bool> {
    run_canvas_db(db.inner(), move |db| db.restore_creative_thread(&thread_id)).await
}

#[tauri::command]
pub async fn project_canvas_node_create(
    db: State<'_, Arc<Database>>,
    value: NewCanvasNode,
) -> AppResult<CanvasNode> {
    run_canvas_db(db.inner(), move |db| db.create_canvas_node(&value)).await
}

#[tauri::command]
pub async fn project_canvas_note_update(
    db: State<'_, Arc<Database>>,
    node_id: String,
    payload_json: String,
) -> AppResult<CanvasNode> {
    run_canvas_db(db.inner(), move |db| {
        db.update_canvas_note_payload(&node_id, &payload_json)
    })
    .await
}

#[tauri::command]
pub async fn project_canvas_node_update(
    db: State<'_, Arc<Database>>,
    node_id: String,
    value: CanvasNodeLayoutUpdate,
) -> AppResult<Option<CanvasNode>> {
    run_canvas_db(db.inner(), move |db| {
        db.update_canvas_node_layout(&node_id, &value)
    })
    .await
}

#[tauri::command]
pub async fn project_canvas_nodes_batch_update(
    db: State<'_, Arc<Database>>,
    project_id: String,
    updates: Vec<CanvasNodeBatchLayout>,
    groups: Option<Vec<CanvasGroup>>,
) -> AppResult<()> {
    run_canvas_db(db.inner(), move |db| {
        db.update_canvas_nodes_batch(&project_id, &updates, &groups.unwrap_or_default())
    })
    .await
}

#[tauri::command]
pub async fn project_canvas_nodes_batch_create(
    db: State<'_, Arc<Database>>,
    project_id: String,
    values: Vec<NewCanvasNode>,
    groups: Option<Vec<CanvasGroupBatchCreate>>,
) -> AppResult<CanvasBatchCreated> {
    run_canvas_db(db.inner(), move |db| {
        db.create_canvas_nodes_batch(&project_id, &values, &groups.unwrap_or_default())
    })
    .await
}

#[tauri::command]
pub async fn project_canvas_node_restore(
    db: State<'_, Arc<Database>>,
    project_id: String,
    node_id: String,
) -> AppResult<Option<CanvasNode>> {
    run_canvas_db(db.inner(), move |db| {
        db.restore_canvas_node(&project_id, &node_id)
    })
    .await
}

#[tauri::command]
pub async fn project_canvas_node_remove(
    db: State<'_, Arc<Database>>,
    node_id: String,
) -> AppResult<Option<CanvasNodeRemoval>> {
    run_canvas_db(db.inner(), move |db| db.remove_canvas_node(&node_id)).await
}

#[tauri::command]
pub async fn project_canvas_group_create(
    db: State<'_, Arc<Database>>,
    value: NewCanvasGroup,
    node_ids: Vec<String>,
) -> AppResult<CanvasGroup> {
    run_canvas_db(db.inner(), move |db| {
        db.create_canvas_group_with_items(&value, &node_ids)
    })
    .await
}

#[tauri::command]
pub async fn project_canvas_group_set_items(
    db: State<'_, Arc<Database>>,
    group_id: String,
    node_ids: Vec<String>,
) -> AppResult<Vec<CanvasGroupItem>> {
    run_canvas_db(db.inner(), move |db| {
        db.set_canvas_group_items(&group_id, &node_ids)
    })
    .await
}

#[tauri::command]
pub async fn project_canvas_group_update(
    db: State<'_, Arc<Database>>,
    value: CanvasGroup,
) -> AppResult<bool> {
    run_canvas_db(db.inner(), move |db| db.update_canvas_group(&value)).await
}

#[tauri::command]
pub async fn project_canvas_group_delete(
    db: State<'_, Arc<Database>>,
    group_id: String,
) -> AppResult<bool> {
    run_canvas_db(db.inner(), move |db| db.delete_canvas_group(&group_id)).await
}

#[tauri::command]
pub async fn project_canvas_edge_create(
    db: State<'_, Arc<Database>>,
    value: NewCanvasEdge,
) -> AppResult<CanvasEdge> {
    run_canvas_db(db.inner(), move |db| db.create_canvas_edge(&value)).await
}

#[tauri::command]
pub async fn project_canvas_edge_delete(
    db: State<'_, Arc<Database>>,
    edge_id: String,
) -> AppResult<bool> {
    run_canvas_db(db.inner(), move |db| db.delete_canvas_edge(&edge_id)).await
}

#[tauri::command]
pub async fn project_canvas_view_upsert(
    db: State<'_, Arc<Database>>,
    value: CanvasViewInput,
) -> AppResult<CanvasView> {
    run_canvas_db(db.inner(), move |db| db.upsert_canvas_view(&value)).await
}

#[tauri::command]
pub async fn project_canvas_view_flush(
    db: State<'_, Arc<Database>>,
    value: CanvasViewInput,
) -> AppResult<CanvasView> {
    run_canvas_db(db.inner(), move |db| db.upsert_canvas_view(&value)).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCanvasLocation {
    pub project_id: String,
    pub node_id: String,
    pub thread_id: Option<String>,
}

#[tauri::command]
pub async fn project_canvas_for_asset(
    db: State<'_, Arc<Database>>,
    asset_id: String,
) -> AppResult<Option<ProjectCanvasLocation>> {
    run_canvas_db(db.inner(), move |db| {
        Ok(db.project_canvas_location_for_asset(&asset_id)?.map(
            |(project_id, node_id, thread_id)| ProjectCanvasLocation {
                project_id,
                node_id,
                thread_id,
            },
        ))
    })
    .await
}

#[tauri::command]
pub async fn project_canvas_for_node(
    db: State<'_, Arc<Database>>,
    project_id: String,
    thread_id: String,
    node_id: String,
) -> AppResult<ProjectCanvasLocation> {
    run_canvas_db(db.inner(), move |db| {
        let (project_id, node_id, thread_id) =
            db.project_canvas_location_for_node(&project_id, &thread_id, &node_id)?;
        Ok(ProjectCanvasLocation {
            project_id,
            node_id,
            thread_id,
        })
    })
    .await
}
