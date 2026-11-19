# Project deletion UI regression

This page mounts the production `useProjectDeletion`, store route, and confirmation dialog with a synthetic IPC adapter. It does not start Tauri, read a library database, call a provider, or delete real files.

1. From `apps/desktop`, run `node scripts/project-deletion-ui.test.mjs`. The test starts and closes its own Vite server on port 1797.
2. If Playwright is supplied outside the project, set `BOWERBIRD_PLAYWRIGHT_MODULE` to its module URL (e.g. `file:///.../playwright/index.mjs`). Installed Chrome is used.
3. Screenshots are written into `.tmp/` relative to the test working directory.

Coverage: unchecked default, cancellation and Escape with no delete IPC, reopening resets the options, keep mode, physical mode with backend confirmation token, provisional deletion without persisted IPC, active work and pending results allow deletion without another checkbox, failed draft saves cannot veto deletion, discarded workflow ignores late saves, backend rejection, pending cleanup error notice, and modal bounds at 420 px.

2026-10-23 preview coverage: default-collapsed exact exclusive IDs and names, immediate panel, staged scan progress/ETA, queued deletion always keeping assets, Escape/backdrop/close guards, stop acknowledgement and cancellation of queued deletion, stop-before-registration race, failed scans cancel the queue, incomplete/failed previews disable physical deletion while keep remains available, impact retry, empty candidates, 60-item lists at 420×560 in both themes, fixed footer and zero-gutter scrolling. Project rename/menu regressions verify the direct project-delete entry.

2026-11-10 validation: the updated deletion Chromium regression, TypeScript and isolated production Vite build pass. Seven native groups pass 220 tests, including the 0054→0055 upgrade, active/unknown tasks, pending results, late generation updates, local chat, parallel workflows and shared-file retention. Logs: repository `.tmp/project-delete-confirmed-native/` and desktop `.tmp/project-delete-confirmed-*.log`. The screenshot was inspected. No real user projects/files were deleted; the installed application was not rebuilt or replaced.

Historical 2026-10-23 validation: project deletion and project rename Chromium regressions and production Vite build passed; Rust `core::project` passed 73 tests covering exact preview IDs, cooperative cancellation/lock release, cancellation while waiting for SQLite, protected-only scans skipping file checks, keep-mode preservation, and physical/shared-file deletion boundaries. TypeScript at that time reported 16 pre-existing ProseMirror editor errors.

Backend synthetic-file/temporary-SQLite tests live in `src-tauri/src/core/project_deletion.rs`: run `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib core::project --offline` from the repository root.
