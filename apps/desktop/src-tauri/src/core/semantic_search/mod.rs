//! Local text-to-image search over a rebuildable catalog index.

pub(crate) mod embedding;
pub(crate) mod index;
pub(crate) mod model;
pub(crate) mod query;
pub(crate) mod runtime;
mod source;

#[cfg(test)]
mod tests;
