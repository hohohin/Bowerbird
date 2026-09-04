-- PROJECT-CANVAS-PLAN PB1: one project owns exactly one infinite canvas.
-- creative_threads are causal/timeline groupings inside that canvas, never canvases themselves.

ALTER TABLE projects ADD COLUMN title_source TEXT NOT NULL DEFAULT 'manual'
  CHECK (title_source IN ('default', 'first_prompt', 'manual'));
ALTER TABLE projects ADD COLUMN updated_at INTEGER;
ALTER TABLE projects ADD COLUMN last_opened_at INTEGER;
ALTER TABLE projects ADD COLUMN archived_at INTEGER;

UPDATE projects
SET updated_at = COALESCE(updated_at, created_at),
    last_opened_at = COALESCE(last_opened_at, created_at);

CREATE TABLE project_canvases (
  project_id     TEXT PRIMARY KEY,
  draft_json    TEXT NOT NULL DEFAULT '{"schema_version":1}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CHECK (json_valid(draft_json)),
  CHECK (json_extract(draft_json, '$.schema_version') = 1)
);

CREATE TABLE creative_threads (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  title         TEXT NOT NULL,
  origin        TEXT NOT NULL,
  archived_at   INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, id),
  CHECK (origin IN ('direct', 'generation_backfill', 'agent_backfill', 'merged_legacy'))
);

CREATE INDEX idx_creative_threads_project_updated
  ON creative_threads(project_id, archived_at, updated_at DESC, id);

CREATE TABLE canvas_nodes (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  thread_id       TEXT,
  kind            TEXT NOT NULL,
  asset_id        TEXT,
  role            TEXT,
  payload_json    TEXT NOT NULL,
  x               REAL NOT NULL,
  y               REAL NOT NULL,
  width           REAL NOT NULL,
  height          REAL NOT NULL,
  z_index         INTEGER NOT NULL DEFAULT 0,
  position_locked INTEGER NOT NULL DEFAULT 0,
  hidden_at       INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, thread_id) REFERENCES creative_threads(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL,
  UNIQUE (project_id, id),
  CHECK (kind IN ('asset', 'prompt', 'agent_group', 'note')),
  CHECK (role IS NULL OR role IN ('reference', 'output', 'intermediate', 'final')),
  CHECK ((kind = 'asset' AND role IS NOT NULL) OR (kind <> 'asset' AND role IS NULL)),
  CHECK (kind <> 'asset' OR asset_id IS NOT NULL OR json_extract(payload_json, '$.snapshot') IS NOT NULL),
  CHECK (thread_id IS NOT NULL OR (kind IN ('asset', 'note') AND COALESCE(role, 'reference') = 'reference')),
  CHECK (json_valid(payload_json)),
  CHECK (json_extract(payload_json, '$.schema_version') = 1),
  CHECK (width > 0 AND height > 0),
  CHECK (position_locked IN (0, 1))
);

CREATE INDEX idx_canvas_nodes_project_visible
  ON canvas_nodes(project_id, hidden_at, z_index, created_at, id);
CREATE INDEX idx_canvas_nodes_thread
  ON canvas_nodes(project_id, thread_id, created_at, id);
CREATE INDEX idx_canvas_nodes_asset
  ON canvas_nodes(asset_id, project_id);

CREATE TABLE canvas_groups (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  role        TEXT,
  x           REAL NOT NULL,
  y           REAL NOT NULL,
  width       REAL NOT NULL,
  height      REAL NOT NULL,
  z_index     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, id),
  CHECK (role IS NULL OR role IN ('base', 'style', 'composition', 'candidate', 'rejected')),
  CHECK (width > 0 AND height > 0)
);

CREATE TABLE canvas_group_items (
  project_id  TEXT NOT NULL,
  group_id    TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  ordinal     INTEGER NOT NULL,
  PRIMARY KEY (project_id, group_id, node_id),
  FOREIGN KEY (project_id, group_id) REFERENCES canvas_groups(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, node_id) REFERENCES canvas_nodes(project_id, id) ON DELETE CASCADE,
  UNIQUE (project_id, node_id),
  UNIQUE (project_id, group_id, ordinal),
  CHECK (ordinal >= 0)
);

CREATE TABLE canvas_edges (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  from_node_id  TEXT NOT NULL,
  to_node_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, thread_id) REFERENCES creative_threads(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, from_node_id) REFERENCES canvas_nodes(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, to_node_id) REFERENCES canvas_nodes(project_id, id) ON DELETE CASCADE,
  UNIQUE (project_id, id),
  UNIQUE (project_id, thread_id, from_node_id, to_node_id, kind, ordinal),
  CHECK (kind IN ('input', 'produced', 'continued', 'retry', 'branch', 'agent_step')),
  CHECK (from_node_id <> to_node_id),
  CHECK (ordinal >= 0)
);

CREATE INDEX idx_canvas_edges_thread
  ON canvas_edges(project_id, thread_id, created_at, ordinal, id);

CREATE TRIGGER canvas_edges_validate_insert
BEFORE INSERT ON canvas_edges
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM canvas_nodes n
    WHERE n.project_id = NEW.project_id
      AND n.id IN (NEW.from_node_id, NEW.to_node_id)
      AND n.thread_id IS NOT NULL
      AND n.thread_id <> NEW.thread_id
  ) THEN RAISE(ABORT, 'canvas edge crosses creative threads') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM canvas_nodes f, canvas_nodes t
    WHERE f.project_id = NEW.project_id AND f.id = NEW.from_node_id
      AND t.project_id = NEW.project_id AND t.id = NEW.to_node_id
      AND (
        (NEW.kind = 'input' AND f.kind IN ('asset', 'prompt') AND t.kind IN ('prompt', 'agent_group')) OR
        (NEW.kind = 'produced' AND f.kind IN ('prompt', 'agent_group') AND t.kind = 'asset' AND t.role IN ('output', 'final')) OR
        (NEW.kind IN ('continued', 'retry', 'branch') AND f.kind = 'asset' AND f.role IN ('output', 'intermediate', 'final') AND t.kind = 'prompt') OR
        (NEW.kind = 'agent_step' AND f.kind = 'agent_group' AND t.kind = 'asset' AND t.role IN ('intermediate', 'final'))
      )
  ) THEN RAISE(ABORT, 'invalid canvas edge endpoints') END;

  SELECT CASE WHEN EXISTS (
    WITH RECURSIVE reachable(node_id) AS (
      SELECT NEW.to_node_id
      UNION
      SELECT e.to_node_id
      FROM canvas_edges e JOIN reachable r ON e.from_node_id = r.node_id
      WHERE e.project_id = NEW.project_id AND e.thread_id = NEW.thread_id
    )
    SELECT 1 FROM reachable WHERE node_id = NEW.from_node_id
  ) THEN RAISE(ABORT, 'canvas edge would create a cycle') END;
END;

CREATE TABLE canvas_views (
  project_id          TEXT PRIMARY KEY,
  pan_x               REAL NOT NULL DEFAULT 0,
  pan_y               REAL NOT NULL DEFAULT 0,
  zoom                REAL NOT NULL DEFAULT 1,
  source_panel_width  REAL,
  active_node_id      TEXT,
  focused_thread_id   TEXT,
  view_mode           TEXT NOT NULL DEFAULT 'canvas',
  timeline_scope      TEXT NOT NULL DEFAULT 'focused',
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (active_node_id) REFERENCES canvas_nodes(id) ON DELETE SET NULL,
  FOREIGN KEY (focused_thread_id) REFERENCES creative_threads(id) ON DELETE SET NULL,
  CHECK (zoom BETWEEN 0.35 AND 2.4),
  CHECK (source_panel_width IS NULL OR source_panel_width > 0),
  CHECK (view_mode IN ('canvas', 'timeline')),
  CHECK (timeline_scope IN ('focused', 'all'))
);

CREATE TRIGGER canvas_views_validate_insert
BEFORE INSERT ON canvas_views
BEGIN
  SELECT CASE WHEN NEW.active_node_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM canvas_nodes WHERE id=NEW.active_node_id AND project_id=NEW.project_id
  ) THEN RAISE(ABORT, 'active canvas node belongs to another project') END;
  SELECT CASE WHEN NEW.focused_thread_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM creative_threads WHERE id=NEW.focused_thread_id AND project_id=NEW.project_id
  ) THEN RAISE(ABORT, 'focused creative thread belongs to another project') END;
END;

CREATE TRIGGER canvas_views_validate_update
BEFORE UPDATE ON canvas_views
BEGIN
  SELECT CASE WHEN NEW.active_node_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM canvas_nodes WHERE id=NEW.active_node_id AND project_id=NEW.project_id
  ) THEN RAISE(ABORT, 'active canvas node belongs to another project') END;
  SELECT CASE WHEN NEW.focused_thread_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM creative_threads WHERE id=NEW.focused_thread_id AND project_id=NEW.project_id
  ) THEN RAISE(ABORT, 'focused creative thread belongs to another project') END;
END;

CREATE TABLE thread_generation_links (
  thread_id                  TEXT NOT NULL,
  generation_conversation_id TEXT NOT NULL UNIQUE,
  created_at                 INTEGER NOT NULL,
  PRIMARY KEY (thread_id, generation_conversation_id),
  FOREIGN KEY (thread_id) REFERENCES creative_threads(id) ON DELETE CASCADE
);

CREATE TABLE thread_agent_links (
  thread_id   TEXT NOT NULL,
  run_id      TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (thread_id, run_id),
  FOREIGN KEY (thread_id) REFERENCES creative_threads(id) ON DELETE CASCADE
);
