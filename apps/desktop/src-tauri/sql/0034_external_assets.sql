-- External originals remain owned by the user. Only the reference and preview are ours.
CREATE TABLE external_assets (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL
);
CREATE TABLE external_asset_paths (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  PRIMARY KEY(asset_id, path)
);
CREATE INDEX external_asset_paths_path ON external_asset_paths(path);

-- Existing canvas cleanup restores managed images to the library. External references
-- stay out of browsing until the user explicitly copies their bytes into the library.
CREATE TRIGGER external_asset_keep_hidden AFTER UPDATE OF library_hidden ON assets
WHEN NEW.library_hidden=0 AND EXISTS(SELECT 1 FROM external_assets WHERE asset_id=NEW.id)
BEGIN
  UPDATE assets SET library_hidden=1 WHERE id=NEW.id;
END;
