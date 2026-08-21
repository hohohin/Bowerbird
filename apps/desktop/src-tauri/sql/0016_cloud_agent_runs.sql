-- Bowerbird Cloud Agent Run 的本地恢复索引。云端正文按 TTL 过期，本表保留
-- 用户本机的最小会话快照与最终入库资产关联；不复用 generation task_queue。
CREATE TABLE cloud_agent_runs (
  run_id               TEXT PRIMARY KEY,
  conversation_id      TEXT NOT NULL,
  skill_id             TEXT NOT NULL,
  status               TEXT NOT NULL,
  intent_prompt        TEXT NOT NULL,
  reference_asset_ids  TEXT NOT NULL,
  project_id           TEXT REFERENCES projects(id) ON DELETE SET NULL,
  snapshot_json        TEXT NOT NULL,
  feedback_action      TEXT,
  final_asset_id       TEXT REFERENCES assets(id) ON DELETE SET NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX idx_cloud_agent_runs_updated
  ON cloud_agent_runs(updated_at DESC);
