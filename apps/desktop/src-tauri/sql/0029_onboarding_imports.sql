-- A committed pack must not replay over the user's subsequent canvas edits.
CREATE TABLE onboarding_imports (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pack_version TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, pack_version)
);
