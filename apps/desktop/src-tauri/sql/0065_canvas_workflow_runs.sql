CREATE TABLE canvas_workflow_runs (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  document_revision INTEGER NOT NULL CHECK (document_revision > 0),
  status TEXT,
  run_json TEXT NOT NULL CHECK (json_valid(run_json)),
  PRIMARY KEY (project_id, run_id),
  UNIQUE (project_id, ordinal)
);

CREATE INDEX idx_canvas_workflow_runs_project_ordinal ON canvas_workflow_runs (project_id, ordinal);

ALTER TABLE canvas_workflows ADD COLUMN runs_synced_revision INTEGER;
