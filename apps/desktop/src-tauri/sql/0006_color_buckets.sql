-- 颜色量化桶（P3）：每张图 K-Means 提取的中心色量化到 12 个命名桶
-- （桶定义见 media/color.rs BUCKETS 常量，不入库——本表只存 bucket key 字符串）。
-- 色板聚合（palette_overview）与按色筛选（list_assets_by_color）都走本表；
-- 原始中心色仍在 assets.colors（缩略图色条用，不动）。
CREATE TABLE asset_colors (
  asset_id TEXT NOT NULL,
  bucket   TEXT NOT NULL,
  PRIMARY KEY (asset_id, bucket),
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);
CREATE INDEX idx_asset_colors_bucket ON asset_colors(bucket);
