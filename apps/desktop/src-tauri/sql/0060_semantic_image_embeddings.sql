-- Derived local index. Model revisions and source revisions are independent.
CREATE TABLE semantic_vectors (
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    model_key TEXT NOT NULL,
    content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
    dim INTEGER NOT NULL CHECK(dim = 768),
    vec_f32le BLOB NOT NULL CHECK(typeof(vec_f32le) = 'blob' AND length(vec_f32le) = dim * 4),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (asset_id, model_key)
);

CREATE TABLE semantic_jobs (
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    model_key TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1,
    content_sha256 TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','running','ready','unavailable','failed','unsupported')),
    lease TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    verify_registered INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (asset_id, model_key)
);
CREATE INDEX idx_semantic_jobs_due ON semantic_jobs(model_key, status, next_attempt, asset_id);

CREATE TABLE semantic_index_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    model_key TEXT NOT NULL,
    run_state TEXT NOT NULL CHECK(run_state IN ('running','paused','off')),
    operation_id TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    backfill_after TEXT NOT NULL DEFAULT '',
    backfill_complete INTEGER NOT NULL DEFAULT 0,
    audit_after TEXT NOT NULL DEFAULT '',
    next_audit INTEGER NOT NULL DEFAULT 0
);

-- Changes to registered content revoke a lease in the same transaction as the
-- change. The old vector can be reused only when the verified hash still matches.
CREATE VIEW semantic_requeue AS SELECT NULL AS asset_id, NULL AS sha256, 0 AS verify_registered WHERE 0;
CREATE TRIGGER semantic_requeue_asset INSTEAD OF INSERT ON semantic_requeue
BEGIN
    INSERT INTO semantic_jobs(asset_id, model_key, verify_registered)
    SELECT a.id, s.model_key, NEW.verify_registered FROM assets a, semantic_index_state s
    WHERE a.id = NEW.asset_id AND s.run_state <> 'off' AND a.store_path IS NOT NULL
      AND lower(a.ext) IN ('jpg','jpeg','png','webp','heic','heif')
    ON CONFLICT(asset_id, model_key) DO UPDATE SET
      status='pending', generation=generation+1, content_sha256=NULL, lease=NULL, lease_until=0,
      attempts=0, next_attempt=0, error_code=NULL, verify_registered=excluded.verify_registered
    WHERE NEW.sha256 IS NULL OR semantic_jobs.content_sha256 IS NOT NEW.sha256;
    DELETE FROM semantic_vectors WHERE asset_id=NEW.asset_id AND NEW.sha256 IS NOT NULL
      AND content_sha256 <> NEW.sha256;
END;

CREATE TRIGGER semantic_new_asset AFTER INSERT ON assets
BEGIN
    INSERT INTO semantic_requeue(asset_id, verify_registered) VALUES(NEW.id,0);
END;

CREATE TRIGGER semantic_changed_asset AFTER UPDATE OF store_path, ext, size, file_mtime ON assets
WHEN NEW.ext IS NOT OLD.ext OR (OLD.store_path IS NULL AND NEW.store_path IS NOT NULL)
     OR ((NEW.size IS NOT OLD.size OR NEW.file_mtime IS NOT OLD.file_mtime)
         AND NOT EXISTS(SELECT 1 FROM external_assets WHERE asset_id=NEW.id)
         AND NOT EXISTS(SELECT 1 FROM creative_file_fingerprints WHERE asset_id=NEW.id))
BEGIN
    INSERT INTO semantic_requeue(asset_id, verify_registered) VALUES(NEW.id,0);
END;

CREATE TRIGGER semantic_external_sha_insert AFTER INSERT ON external_assets
BEGIN
    INSERT INTO semantic_requeue(asset_id, sha256, verify_registered) VALUES(NEW.asset_id,NEW.fingerprint,0);
END;
CREATE TRIGGER semantic_external_sha_update AFTER UPDATE OF fingerprint ON external_assets
WHEN NEW.fingerprint IS NOT OLD.fingerprint
BEGIN
    INSERT INTO semantic_requeue(asset_id, sha256, verify_registered) VALUES(NEW.asset_id,NEW.fingerprint,0);
END;
CREATE TRIGGER semantic_creative_sha_insert AFTER INSERT ON creative_file_fingerprints
BEGIN
    INSERT INTO semantic_requeue(asset_id, sha256, verify_registered) VALUES(NEW.asset_id,NEW.sha256,0);
END;
CREATE TRIGGER semantic_creative_sha_update AFTER UPDATE OF sha256 ON creative_file_fingerprints
WHEN NEW.sha256 IS NOT OLD.sha256
BEGIN
    INSERT INTO semantic_requeue(asset_id, sha256, verify_registered) VALUES(NEW.asset_id,NEW.sha256,0);
END;
