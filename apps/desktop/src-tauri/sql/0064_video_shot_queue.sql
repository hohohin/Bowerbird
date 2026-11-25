CREATE TABLE video_shot_queues (
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    source_hash TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    status TEXT NOT NULL,
    stopping INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL,
    PRIMARY KEY(asset_id,source_hash)
);
CREATE TABLE video_shot_receipts (
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    source_hash TEXT NOT NULL,
    shot_id TEXT NOT NULL,
    task_key TEXT NOT NULL,
    result TEXT NOT NULL,
    PRIMARY KEY(asset_id,source_hash,shot_id)
);

CREATE TABLE video_shot_deliveries (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  delivery_key TEXT NOT NULL,
  focus_id TEXT NOT NULL,
  PRIMARY KEY(project_id,delivery_key)
);
