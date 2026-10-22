-- Stable page order, and reverse tag lookup for large catalogs.
CREATE INDEX idx_assets_catalog_order ON assets(created_at DESC, id);
CREATE INDEX idx_asset_tags_tag_asset ON asset_tags(tag_id, asset_id);
