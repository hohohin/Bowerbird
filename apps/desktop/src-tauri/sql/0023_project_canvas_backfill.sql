-- PROJECT-CANVAS-PLAN PB5: versioned per-source ledger. The old creative-session
-- completion markers are intentionally not accepted as v2 facts.

CREATE TABLE project_canvas_backfill_sources (
  backfill_version  INTEGER NOT NULL,
  source_kind       TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  status            TEXT NOT NULL,
  project_id        TEXT,
  thread_id         TEXT,
  region_json       TEXT,
  diagnostic        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (backfill_version, source_kind, source_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (thread_id) REFERENCES creative_threads(id) ON DELETE SET NULL,
  CHECK (backfill_version >= 2),
  CHECK (source_kind IN ('generation', 'agent')),
  CHECK (status IN ('done', 'failed', 'deleted')),
  CHECK (region_json IS NULL OR json_valid(region_json))
);

CREATE TABLE project_canvas_backfill_reports (
  id                TEXT PRIMARY KEY,
  backfill_version  INTEGER NOT NULL,
  payload_json      TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  CHECK (backfill_version >= 2),
  CHECK (json_valid(payload_json))
);

CREATE INDEX idx_project_canvas_backfill_sources_status
  ON project_canvas_backfill_sources(backfill_version, status, source_kind);

-- A user deletion is a durable migration decision. The source ledger survives through
-- nullable FKs and prevents a later replay from resurrecting the deleted workspace.
CREATE TRIGGER project_canvas_backfill_mark_project_deleted
BEFORE DELETE ON projects
BEGIN
  UPDATE project_canvas_backfill_sources
  SET status='deleted', project_id=NULL, thread_id=NULL,
      diagnostic=COALESCE(diagnostic || '; ', '') || 'project deleted after backfill',
      updated_at=strftime('%s','now')
  WHERE project_id=OLD.id AND status='done';
END;

CREATE TRIGGER project_canvas_backfill_mark_thread_deleted
BEFORE DELETE ON creative_threads
BEGIN
  UPDATE project_canvas_backfill_sources
  SET status='deleted', thread_id=NULL,
      diagnostic=COALESCE(diagnostic || '; ', '') || 'thread deleted after backfill',
      updated_at=strftime('%s','now')
  WHERE thread_id=OLD.id AND status='done';
END;
