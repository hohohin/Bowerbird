# Project deletion UI regression

This page mounts the production `useProjectDeletion`, store route, and confirmation dialog with a synthetic IPC adapter. It does not start Tauri, read a library database, call a provider, or delete real files.

1. From `apps/desktop`, start `pnpm exec vite --host 127.0.0.1 --port 1437`.
2. With Playwright available, run `node apps/desktop/scripts/project-deletion-ui.test.mjs` from the repository root. If Playwright is supplied outside the project, set `BOWERBIRD_PLAYWRIGHT_MODULE` to its module URL (e.g. `file:///.../playwright/index.mjs`). Installed Chrome is used.
3. Optional: set `BOWERBIRD_UI_TEST_URL` to the local preview origin. Screenshots are written into `.tmp/` relative to the test working directory.

Coverage: unchecked default, cancellation and Escape with no delete IPC, reopening resets the option, keep mode, physical mode with backend confirmation token, provisional deletion without persisted IPC, running-work guard, backend rejection, pending cleanup error notice, and modal bounds at 420 px.

Backend synthetic-file/temporary-SQLite tests live in `src-tauri/src/core/project_deletion.rs`: run `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib core::project --offline` from the repository root.
