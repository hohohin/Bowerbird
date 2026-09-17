-- Keep canonical files and reference identities while excluding canvas-only images from browsing.
ALTER TABLE assets ADD COLUMN library_hidden INTEGER NOT NULL DEFAULT 0 CHECK(library_hidden IN (0, 1));

-- If the last canvas instance is removed, keep the original discoverable rather than orphaning it.
CREATE TRIGGER canvas_only_asset_after_delete AFTER DELETE ON canvas_nodes
WHEN OLD.asset_id IS NOT NULL
BEGIN
  UPDATE assets SET library_hidden=0 WHERE id=OLD.asset_id AND library_hidden=1
    AND NOT EXISTS(SELECT 1 FROM canvas_nodes WHERE asset_id=OLD.asset_id AND hidden_at IS NULL);
END;
CREATE TRIGGER canvas_only_asset_after_hide AFTER UPDATE OF hidden_at, asset_id ON canvas_nodes
WHEN OLD.asset_id IS NOT NULL
BEGIN
  UPDATE assets SET library_hidden=0 WHERE id=OLD.asset_id AND library_hidden=1
    AND NOT EXISTS(SELECT 1 FROM canvas_nodes WHERE asset_id=OLD.asset_id AND hidden_at IS NULL);
END;
