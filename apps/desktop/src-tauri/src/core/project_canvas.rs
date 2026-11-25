//! Project-centred infinite canvas repository (`PROJECT-CANVAS-PLAN` PB1).
//!
//! A project is the only user-visible lifecycle/title boundary and owns exactly one canvas.
//! Creative threads are causal groupings inside that canvas. Provider sessions, generation jobs
//! and Agent runs remain separate identities and are joined only through explicit link tables.

mod execution_projection;
mod gallery_projection;
mod note_assets;
pub(super) mod placement;
mod repository;
#[cfg(test)]
mod tests;
mod types;

pub(crate) use gallery_projection::{
    hide_asset_canvas_nodes, hide_empty_generation_cards_for_asset,
    hide_removed_original_canvas_nodes,
};
pub(super) use gallery_projection::separate_generation_gallery;
pub(crate) use repository::{insert_node_tx, touch_canvas_tx};
pub use types::*;
