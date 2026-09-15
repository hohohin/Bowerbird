-- PROJECT-CANVAS-PLAN PB1/PB4: execution identities remain authoritative in their
-- existing stores; these columns only anchor safe projection into a project/thread.

ALTER TABLE task_queue ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE task_queue ADD COLUMN thread_id TEXT REFERENCES creative_threads(id) ON DELETE SET NULL;
ALTER TABLE task_queue ADD COLUMN creative_launch_id TEXT;
CREATE INDEX idx_task_queue_project_thread
  ON task_queue(project_id, thread_id, created_at DESC);

ALTER TABLE local_agent_runs ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE local_agent_runs ADD COLUMN thread_id TEXT REFERENCES creative_threads(id) ON DELETE SET NULL;
CREATE INDEX idx_local_agent_runs_project_thread
  ON local_agent_runs(project_id, thread_id, updated_at DESC);

ALTER TABLE cloud_agent_runs ADD COLUMN thread_id TEXT REFERENCES creative_threads(id) ON DELETE SET NULL;
ALTER TABLE cloud_agent_runs ADD COLUMN creative_launch_id TEXT;
CREATE UNIQUE INDEX idx_cloud_agent_runs_launch
  ON cloud_agent_runs(creative_launch_id) WHERE creative_launch_id IS NOT NULL;
CREATE INDEX idx_cloud_agent_runs_project_thread
  ON cloud_agent_runs(project_id, thread_id, updated_at DESC);

CREATE TABLE cloud_agent_artifact_assets (
  run_id       TEXT NOT NULL,
  artifact_id  TEXT NOT NULL UNIQUE,
  asset_id     TEXT REFERENCES assets(id) ON DELETE SET NULL,
  node_id      TEXT REFERENCES canvas_nodes(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (run_id, artifact_id),
  FOREIGN KEY (run_id) REFERENCES cloud_agent_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX idx_cloud_agent_artifact_assets_asset
  ON cloud_agent_artifact_assets(asset_id);

CREATE TRIGGER projects_block_delete_while_running
BEFORE DELETE ON projects
WHEN EXISTS (
  SELECT 1 FROM task_queue
  WHERE project_id = OLD.id AND status IN ('queued', 'running')
) OR EXISTS (
  SELECT 1 FROM cloud_agent_runs
  WHERE project_id = OLD.id AND status NOT IN ('succeeded', 'failed', 'cancelled')
)
BEGIN
  SELECT RAISE(ABORT, 'project has running generation or Agent work');
END;
