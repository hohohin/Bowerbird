-- 项目 workspace：项目登记 + 素材多对多成员关系。
-- 素材物理文件仍只存在中央库；workspace_path 仅作身份与初始导入来源。

CREATE TABLE projects (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  workspace_key  TEXT NOT NULL UNIQUE,
  created_at     INTEGER NOT NULL
);

CREATE TABLE project_assets (
  project_id TEXT NOT NULL,
  asset_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, asset_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id)   REFERENCES assets(id)   ON DELETE CASCADE
);

CREATE INDEX idx_project_assets_asset ON project_assets(asset_id);
