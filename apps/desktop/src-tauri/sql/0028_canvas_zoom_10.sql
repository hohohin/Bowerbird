-- Rebuild only the viewport table to widen the persisted zoom range.
CREATE TABLE canvas_views_zoom_10 (
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
  CHECK (zoom BETWEEN 0.1 AND 2.4),
  CHECK (source_panel_width IS NULL OR source_panel_width > 0),
  CHECK (view_mode IN ('canvas', 'timeline')),
  CHECK (timeline_scope IN ('focused', 'all'))
);

INSERT INTO canvas_views_zoom_10
  (project_id,pan_x,pan_y,zoom,source_panel_width,active_node_id,focused_thread_id,view_mode,timeline_scope,updated_at)
SELECT project_id,pan_x,pan_y,zoom,source_panel_width,active_node_id,focused_thread_id,view_mode,timeline_scope,updated_at
FROM canvas_views;
DROP TABLE canvas_views;
ALTER TABLE canvas_views_zoom_10 RENAME TO canvas_views;

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
