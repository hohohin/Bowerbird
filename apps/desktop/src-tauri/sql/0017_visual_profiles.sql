-- 项目视觉设定 V1（AGENT-RUNTIME-PLAN.md §8.5 / §11 V1-T4）：本地长期权威。
-- draft 只在用户「确认并保存」时升级 confirmed；重新提炼创建新 draft 版本，不覆盖旧版本。
-- source_payload 是点击瞬间冻结的脱敏证据卡快照（只含反推文字，无路径/文件名/URL），
-- 后续移动素材、增删反推不改变已落盘行（§8.2：不监听、不自动重算）。
CREATE TABLE project_visual_profiles (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_folder_id     TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  version              INTEGER NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('draft','confirmed','archived')),
  summary              TEXT NOT NULL DEFAULT '',
  source_scope_hash    TEXT NOT NULL,
  source_count         INTEGER NOT NULL DEFAULT 0,
  source_payload       TEXT NOT NULL,
  content_themes       TEXT NOT NULL DEFAULT '[]',
  conflicts            TEXT NOT NULL DEFAULT '[]',
  candidate_directions TEXT NOT NULL DEFAULT '[]',
  created_at           INTEGER NOT NULL,
  confirmed_at         INTEGER,
  UNIQUE (project_id, source_folder_id, version)
);

CREATE INDEX idx_visual_profiles_scope
  ON project_visual_profiles(project_id, source_folder_id, version DESC);

-- 视觉规则（draft 内容核心；V1 只读展示，编辑/删除属 V2-T3）。
CREATE TABLE visual_profile_rules (
  id                   TEXT PRIMARY KEY,
  profile_id           TEXT NOT NULL REFERENCES project_visual_profiles(id) ON DELETE CASCADE,
  category             TEXT NOT NULL,
  value                TEXT NOT NULL,
  polarity             TEXT NOT NULL CHECK (polarity IN ('must','prefer','avoid')),
  confidence           REAL NOT NULL DEFAULT 0,
  supporting_asset_ids TEXT NOT NULL DEFAULT '[]',
  opposing_asset_ids   TEXT NOT NULL DEFAULT '[]',
  confirmed_by_user    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_visual_profile_rules_profile
  ON visual_profile_rules(profile_id);

-- profile 与素材的关联：source=提炼输入，validation=方向验证图（V3），approved_anchor=确认锚点。
CREATE TABLE visual_profile_assets (
  profile_id TEXT NOT NULL REFERENCES project_visual_profiles(id) ON DELETE CASCADE,
  asset_id   TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('source','validation','approved_anchor')),
  PRIMARY KEY (profile_id, asset_id, role)
);
