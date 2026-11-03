-- Recycling an original preserves its creative identity, independently of canvas-only visibility.
CREATE TABLE trashed_asset_originals (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  fingerprint TEXT NOT NULL
);

-- Removing the final canvas instance must not make a recycled original visible again.
CREATE TRIGGER trashed_original_keep_hidden AFTER UPDATE OF library_hidden ON assets
WHEN NEW.library_hidden=0 AND EXISTS(
  SELECT 1 FROM trashed_asset_originals WHERE asset_id=NEW.id
)
BEGIN
  UPDATE assets SET library_hidden=1 WHERE id=NEW.id;
END;
