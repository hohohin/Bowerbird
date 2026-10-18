-- A durable content identity survives an unavailable source disk.
CREATE TABLE creative_file_fingerprints (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  asset_size INTEGER,
  asset_mtime INTEGER
);
