-- 本机 Agent 预览 checkpoint。与 generation task_queue 严格分离；仅开发态命令读写。
CREATE TABLE local_agent_runs (
  id              TEXT PRIMARY KEY,
  skill_id        TEXT NOT NULL,
  target_asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  status          TEXT NOT NULL,
  phase           TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_local_agent_runs_target_updated
  ON local_agent_runs(target_asset_id, updated_at DESC);
