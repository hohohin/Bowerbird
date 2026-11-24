//! Standalone test target for the production native drag implementation.
#[path = "../../../apps/desktop/src-tauri/src/external_drag.rs"]
mod implementation;
pub use implementation::*;
#[cfg(windows)]
#[path = "../../../apps/desktop/src-tauri/src/windows_shell.rs"]
mod windows_shell;
