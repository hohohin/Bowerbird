-- File identity lookups run for every newly connected file. These are deliberately
-- non-unique: aliases and distinct live originals must retain their own Asset IDs.
CREATE INDEX IF NOT EXISTS idx_assets_store_path ON assets(store_path);
CREATE INDEX IF NOT EXISTS idx_external_assets_fingerprint ON external_assets(fingerprint);
