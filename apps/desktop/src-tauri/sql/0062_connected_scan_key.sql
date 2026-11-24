ALTER TABLE assets ADD COLUMN connected_scan_key TEXT;

CREATE INDEX idx_external_assets_pending_fingerprint
ON external_assets(asset_id) WHERE fingerprint = '';

CREATE INDEX idx_assets_connected_relocation_size ON assets(size);
