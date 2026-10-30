-- Physical directory entries have their own identity; creative records remain on assets.
CREATE TABLE connected_roots (
  id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, project_id TEXT,
  available INTEGER NOT NULL DEFAULT 1, scanning INTEGER NOT NULL DEFAULT 0,
  error TEXT, scanned_at INTEGER
);
CREATE TABLE connected_folders (
  id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES connected_roots(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES connected_folders(id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, available INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX connected_folders_parent ON connected_folders(parent_id);
CREATE TABLE connected_folder_projects (
  folder_id TEXT NOT NULL REFERENCES connected_folders(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY(folder_id,project_id)
);
CREATE TABLE connected_entries (
  id TEXT PRIMARY KEY, folder_id TEXT NOT NULL REFERENCES connected_folders(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, is_reference INTEGER NOT NULL,
  available INTEGER NOT NULL DEFAULT 1, size INTEGER, mtime TEXT
);
CREATE INDEX connected_entries_folder ON connected_entries(folder_id,id);
CREATE INDEX connected_entries_asset ON connected_entries(asset_id);
