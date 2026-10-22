-- Explicitly adding a local reference to a project library does not transfer
-- ownership of the original file. Browsing/canvas-only references stay hidden.
ALTER TABLE external_assets ADD COLUMN library_member INTEGER NOT NULL DEFAULT 0;
DROP TRIGGER external_asset_keep_hidden;
CREATE TRIGGER external_asset_keep_hidden AFTER UPDATE OF library_hidden ON assets
WHEN NEW.library_hidden=0 AND EXISTS(
  SELECT 1 FROM external_assets WHERE asset_id=NEW.id AND library_member=0
)
BEGIN
  UPDATE assets SET library_hidden=1 WHERE id=NEW.id;
END;
