-- CANVAS-SESSION-PLAN CS0 schema spike。
-- 不是正式 migration；CS1 会在当前本地 migration 尾部按相同契约新增版本化 SQL。

CREATE TABLE projects (id TEXT PRIMARY KEY);
CREATE TABLE assets (id TEXT PRIMARY KEY);

CREATE TABLE creative_sessions (
  id             TEXT PRIMARY KEY,
  project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  title_source   TEXT NOT NULL CHECK (title_source IN ('default', 'first_prompt', 'manual')),
  draft_json     TEXT NOT NULL CHECK (json_valid(draft_json)),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
);

CREATE TABLE creative_nodes (
  id                  TEXT PRIMARY KEY,
  creative_session_id TEXT NOT NULL REFERENCES creative_sessions(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('asset', 'prompt', 'agent_group', 'note')),
  asset_id            TEXT REFERENCES assets(id) ON DELETE SET NULL,
  role                TEXT CHECK (role IN ('reference', 'output', 'intermediate', 'final')),
  payload_json        TEXT NOT NULL CHECK (
                        json_valid(payload_json)
                        AND json_extract(payload_json, '$.schema_version') = 1
                      ),
  x                   REAL NOT NULL,
  y                   REAL NOT NULL,
  width               REAL NOT NULL CHECK (width > 0),
  height              REAL NOT NULL CHECK (height > 0),
  z_index             INTEGER NOT NULL,
  position_locked     INTEGER NOT NULL DEFAULT 0 CHECK (position_locked IN (0, 1)),
  hidden_at           INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK (kind = 'asset' OR asset_id IS NULL),
  CHECK ((kind = 'asset' AND role IS NOT NULL) OR (kind != 'asset' AND role IS NULL)),
  UNIQUE (id, creative_session_id)
);

CREATE TABLE creative_groups (
  id                  TEXT PRIMARY KEY,
  creative_session_id TEXT NOT NULL REFERENCES creative_sessions(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  role                TEXT CHECK (role IN ('base', 'style', 'composition', 'candidate', 'rejected')),
  x                   REAL NOT NULL,
  y                   REAL NOT NULL,
  width               REAL NOT NULL CHECK (width > 0),
  height              REAL NOT NULL CHECK (height > 0),
  z_index             INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (id, creative_session_id)
);

CREATE TABLE creative_group_items (
  group_id TEXT NOT NULL REFERENCES creative_groups(id) ON DELETE CASCADE,
  node_id  TEXT NOT NULL REFERENCES creative_nodes(id) ON DELETE CASCADE,
  ordinal  INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (group_id, node_id),
  UNIQUE (node_id),
  UNIQUE (group_id, ordinal)
);

CREATE TRIGGER creative_group_items_same_session_insert
BEFORE INSERT ON creative_group_items
WHEN (SELECT creative_session_id FROM creative_groups WHERE id = NEW.group_id)
     IS NOT (SELECT creative_session_id FROM creative_nodes WHERE id = NEW.node_id)
BEGIN
  SELECT RAISE(ABORT, 'creative_group_item_cross_session');
END;

CREATE TRIGGER creative_group_items_same_session_update
BEFORE UPDATE OF group_id, node_id ON creative_group_items
WHEN (SELECT creative_session_id FROM creative_groups WHERE id = NEW.group_id)
     IS NOT (SELECT creative_session_id FROM creative_nodes WHERE id = NEW.node_id)
BEGIN
  SELECT RAISE(ABORT, 'creative_group_item_cross_session');
END;

CREATE TABLE creative_edges (
  id                  TEXT PRIMARY KEY,
  creative_session_id TEXT NOT NULL REFERENCES creative_sessions(id) ON DELETE CASCADE,
  from_node_id        TEXT NOT NULL REFERENCES creative_nodes(id) ON DELETE CASCADE,
  to_node_id          TEXT NOT NULL REFERENCES creative_nodes(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('input', 'produced', 'continued', 'retry', 'branch', 'agent_step')),
  ordinal             INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  created_at          INTEGER NOT NULL,
  UNIQUE (creative_session_id, from_node_id, to_node_id, kind)
);

CREATE TRIGGER creative_edges_same_session_insert
BEFORE INSERT ON creative_edges
WHEN NEW.creative_session_id
       IS NOT (SELECT creative_session_id FROM creative_nodes WHERE id = NEW.from_node_id)
  OR NEW.creative_session_id
       IS NOT (SELECT creative_session_id FROM creative_nodes WHERE id = NEW.to_node_id)
BEGIN
  SELECT RAISE(ABORT, 'creative_edge_cross_session');
END;

CREATE TRIGGER creative_edges_same_session_update
BEFORE UPDATE OF creative_session_id, from_node_id, to_node_id ON creative_edges
WHEN NEW.creative_session_id
       IS NOT (SELECT creative_session_id FROM creative_nodes WHERE id = NEW.from_node_id)
  OR NEW.creative_session_id
       IS NOT (SELECT creative_session_id FROM creative_nodes WHERE id = NEW.to_node_id)
BEGIN
  SELECT RAISE(ABORT, 'creative_edge_cross_session');
END;

CREATE TABLE creative_views (
  creative_session_id TEXT PRIMARY KEY REFERENCES creative_sessions(id) ON DELETE CASCADE,
  pan_x                REAL NOT NULL DEFAULT 0,
  pan_y                REAL NOT NULL DEFAULT 0,
  zoom                 REAL NOT NULL DEFAULT 1 CHECK (zoom BETWEEN 0.35 AND 2.4),
  source_panel_width   REAL,
  active_node_id       TEXT,
  view_mode            TEXT NOT NULL DEFAULT 'canvas' CHECK (view_mode IN ('canvas', 'timeline')),
  updated_at           INTEGER NOT NULL
);

CREATE TABLE creative_generation_links (
  creative_session_id        TEXT NOT NULL REFERENCES creative_sessions(id) ON DELETE CASCADE,
  generation_conversation_id TEXT NOT NULL,
  created_at                 INTEGER NOT NULL,
  PRIMARY KEY (creative_session_id, generation_conversation_id),
  UNIQUE (generation_conversation_id)
);

CREATE TABLE creative_agent_links (
  creative_session_id TEXT NOT NULL REFERENCES creative_sessions(id) ON DELETE CASCADE,
  run_id               TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  PRIMARY KEY (creative_session_id, run_id),
  UNIQUE (run_id)
);
