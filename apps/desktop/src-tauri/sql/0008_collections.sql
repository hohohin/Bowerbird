-- 多对多收藏夹：folders.kind='collection' + asset_collections 关联表。
-- 普通文件夹继续由 assets.folder_id 表示位置；收藏关系不改变 folder_id。

CREATE TABLE asset_collections (
  asset_id   TEXT NOT NULL,
  folder_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (asset_id, folder_id),
  FOREIGN KEY (asset_id)  REFERENCES assets(id)   ON DELETE CASCADE,
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
);

CREATE INDEX idx_asset_collections_folder_created
  ON asset_collections(folder_id, created_at DESC);

CREATE INDEX idx_folders_kind_name ON folders(kind, name);

-- 防止把普通文件夹/智能文件夹误作为收藏夹目标。
CREATE TRIGGER asset_collections_folder_kind_insert
BEFORE INSERT ON asset_collections
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM folders WHERE id = NEW.folder_id AND kind = 'collection'
)
BEGIN
  SELECT RAISE(ABORT, 'asset_collections.folder_id must reference a collection folder');
END;
