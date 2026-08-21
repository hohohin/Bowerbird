-- 手改名保护：assets.name_manual = 1 表示名字由用户手动设定（rename_asset_files 写回时置位）。
-- autoname 一律走 update_asset_name_if_auto（AND name_manual = 0 条件写）——生成图命名 /
-- 反推后重命名 / 采集入库命名都不再覆盖用户手改的名字。

ALTER TABLE assets ADD COLUMN name_manual INTEGER NOT NULL DEFAULT 0;
