-- Visual profiles are library assets. Keep legacy project_id only as provenance;
-- neither project nor source-folder deletion owns the saved guide's lifetime.
-- Preserve IDs, versions, hashes and all child rows, including colliding legacy
-- versions from different projects. Rebuild with foreign keys enabled.
CREATE TABLE independent_visual_profiles (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  source_folder_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','confirmed','archived')),
  summary TEXT NOT NULL DEFAULT '',
  source_scope_hash TEXT NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 0,
  source_payload TEXT NOT NULL,
  content_themes TEXT NOT NULL DEFAULT '[]',
  conflicts TEXT NOT NULL DEFAULT '[]',
  candidate_directions TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  extractor TEXT NOT NULL DEFAULT 'local_baseline'
);
INSERT INTO independent_visual_profiles SELECT * FROM project_visual_profiles;
CREATE TEMP TABLE visual_rules_backup AS SELECT * FROM visual_profile_rules;
CREATE TEMP TABLE visual_assets_backup AS SELECT * FROM visual_profile_assets;
DROP TABLE visual_profile_rules;
DROP TABLE visual_profile_assets;
DROP TABLE project_visual_profiles;
ALTER TABLE independent_visual_profiles RENAME TO project_visual_profiles;
CREATE INDEX idx_visual_profiles_scope ON project_visual_profiles(source_folder_id, version DESC);
CREATE UNIQUE INDEX idx_visual_profiles_independent_version
  ON project_visual_profiles(source_folder_id, version) WHERE project_id IS NULL;
CREATE TABLE visual_profile_rules (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES project_visual_profiles(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  value TEXT NOT NULL,
  polarity TEXT NOT NULL CHECK (polarity IN ('must','prefer','avoid')),
  confidence REAL NOT NULL DEFAULT 0,
  supporting_asset_ids TEXT NOT NULL DEFAULT '[]',
  opposing_asset_ids TEXT NOT NULL DEFAULT '[]',
  confirmed_by_user INTEGER NOT NULL DEFAULT 0
);
INSERT INTO visual_profile_rules SELECT * FROM visual_rules_backup;
DROP TABLE visual_rules_backup;
CREATE INDEX idx_visual_profile_rules_profile ON visual_profile_rules(profile_id);
CREATE TABLE visual_profile_assets (
  profile_id TEXT NOT NULL REFERENCES project_visual_profiles(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('source','validation','approved_anchor')),
  PRIMARY KEY (profile_id, asset_id, role)
);
INSERT INTO visual_profile_assets SELECT * FROM visual_assets_backup;
DROP TABLE visual_assets_backup;
