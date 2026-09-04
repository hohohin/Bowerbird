//! Project canvas Tauri commands (`PROJECT-CANVAS-PLAN` PB2).

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::core::project_canvas::{
    CanvasEdge, CanvasGroup, CanvasGroupItem, CanvasNode, CanvasNodeLayoutUpdate,
    CanvasNodeRemoval, CanvasView, CanvasViewInput, CreativeThread, NewCanvasEdge, NewCanvasGroup,
    NewCanvasNode, NewCreativeThread, ProjectCanvas, ProjectCanvasMaterializeInput,
    ProjectCanvasSnapshot,
};
use crate::db::Database;
use crate::error::AppResult;

#[tauri::command]
pub async fn project_canvas_materialize(
    db: State<'_, Arc<Database>>,
    value: ProjectCanvasMaterializeInput,
    initial_threads: Vec<NewCreativeThread>,
    initial_nodes: Vec<NewCanvasNode>,
    initial_view: Option<CanvasViewInput>,
) -> AppResult<ProjectCanvas> {
    db.materialize_project_canvas(
        &value,
        &initial_threads,
        &initial_nodes,
        initial_view.as_ref(),
    )
}

#[tauri::command]
pub async fn project_canvas_ensure(
    db: State<'_, Arc<Database>>,
    project_id: String,
) -> AppResult<ProjectCanvas> {
    db.ensure_project_canvas(&project_id)
}

#[tauri::command]
pub async fn project_canvas_get(
    db: State<'_, Arc<Database>>,
    project_id: String,
) -> AppResult<ProjectCanvasSnapshot> {
    db.project_canvas_snapshot(&project_id)
}

#[tauri::command]
pub async fn project_canvas_rename(
    db: State<'_, Arc<Database>>,
    project_id: String,
    title: String,
) -> AppResult<bool> {
    db.rename_canvas_project(&project_id, &title)
}

#[tauri::command]
pub async fn project_canvas_title_from_first_prompt(
    db: State<'_, Arc<Database>>,
    project_id: String,
    title: String,
) -> AppResult<bool> {
    db.title_canvas_project_from_first_prompt(&project_id, &title)
}

#[tauri::command]
pub async fn project_canvas_update_draft(
    db: State<'_, Arc<Database>>,
    project_id: String,
    draft_json: String,
) -> AppResult<bool> {
    db.update_project_canvas_draft(&project_id, &draft_json)
}

#[tauri::command]
pub async fn project_canvas_touch(
    db: State<'_, Arc<Database>>,
    project_id: String,
) -> AppResult<bool> {
    db.touch_project_canvas(&project_id)
}

#[tauri::command]
pub async fn project_thread_create(
    db: State<'_, Arc<Database>>,
    value: NewCreativeThread,
) -> AppResult<CreativeThread> {
    db.create_creative_thread(&value)
}

#[tauri::command]
pub async fn project_thread_archive(
    db: State<'_, Arc<Database>>,
    thread_id: String,
) -> AppResult<bool> {
    db.archive_creative_thread(&thread_id)
}

#[tauri::command]
pub async fn project_thread_restore(
    db: State<'_, Arc<Database>>,
    thread_id: String,
) -> AppResult<bool> {
    db.restore_creative_thread(&thread_id)
}

#[tauri::command]
pub async fn project_canvas_node_create(
    db: State<'_, Arc<Database>>,
    value: NewCanvasNode,
) -> AppResult<CanvasNode> {
    db.create_canvas_node(&value)
}

#[tauri::command]
pub async fn project_canvas_node_update(
    db: State<'_, Arc<Database>>,
    node_id: String,
    value: CanvasNodeLayoutUpdate,
) -> AppResult<Option<CanvasNode>> {
    db.update_canvas_node_layout(&node_id, &value)
}

#[tauri::command]
pub async fn project_canvas_node_remove(
    db: State<'_, Arc<Database>>,
    node_id: String,
) -> AppResult<Option<CanvasNodeRemoval>> {
    db.remove_canvas_node(&node_id)
}

#[tauri::command]
pub async fn project_canvas_group_create(
    db: State<'_, Arc<Database>>,
    value: NewCanvasGroup,
    node_ids: Vec<String>,
) -> AppResult<CanvasGroup> {
    db.create_canvas_group_with_items(&value, &node_ids)
}

#[tauri::command]
pub async fn project_canvas_group_set_items(
    db: State<'_, Arc<Database>>,
    group_id: String,
    node_ids: Vec<String>,
) -> AppResult<Vec<CanvasGroupItem>> {
    db.set_canvas_group_items(&group_id, &node_ids)
}

#[tauri::command]
pub async fn project_canvas_group_update(
    db: State<'_, Arc<Database>>,
    value: CanvasGroup,
) -> AppResult<bool> {
    db.update_canvas_group(&value)
}

#[tauri::command]
pub async fn project_canvas_group_delete(
    db: State<'_, Arc<Database>>,
    group_id: String,
) -> AppResult<bool> {
    db.delete_canvas_group(&group_id)
}

#[tauri::command]
pub async fn project_canvas_edge_create(
    db: State<'_, Arc<Database>>,
    value: NewCanvasEdge,
) -> AppResult<CanvasEdge> {
    db.create_canvas_edge(&value)
}

#[tauri::command]
pub async fn project_canvas_edge_delete(
    db: State<'_, Arc<Database>>,
    edge_id: String,
) -> AppResult<bool> {
    db.delete_canvas_edge(&edge_id)
}

#[tauri::command]
pub async fn project_canvas_view_upsert(
    db: State<'_, Arc<Database>>,
    value: CanvasViewInput,
) -> AppResult<CanvasView> {
    db.upsert_canvas_view(&value)
}

#[tauri::command]
pub async fn project_canvas_view_flush(
    db: State<'_, Arc<Database>>,
    value: CanvasViewInput,
) -> AppResult<CanvasView> {
    db.upsert_canvas_view(&value)
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
    Ok(db
        .project_canvas_location_for_asset(&asset_id)?
        .map(|(project_id, node_id, thread_id)| ProjectCanvasLocation {
            project_id,
            node_id,
            thread_id,
        }))
}

#[tauri::command]
pub async fn project_canvas_for_node(
    db: State<'_, Arc<Database>>,
    project_id: String,
    thread_id: String,
    node_id: String,
) -> AppResult<ProjectCanvasLocation> {
    let (project_id, node_id, thread_id) =
        db.project_canvas_location_for_node(&project_id, &thread_id, &node_id)?;
    Ok(ProjectCanvasLocation {
        project_id,
        node_id,
        thread_id,
    })
}
