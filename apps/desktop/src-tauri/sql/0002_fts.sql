-- 0002：FTS5 同步触发器 + 存量回填（开发计划 §5.3 / Phase 4）。
-- library_fts 表已在 0001 建（trigram tokenizer）。这里把 assets.name 的变更同步进去，
-- 让"按文件名搜索"开箱即用。tags/prompt_body/annotation/ocr 由对应模块后续主动维护。

-- 新增资产 → 插入 FTS 行（其它字段留空，仅 name 即可被搜）
CREATE TRIGGER fts_ai AFTER INSERT ON assets BEGIN
  INSERT INTO library_fts(asset_id, name, tags, prompt_body, annotation, ocr)
  VALUES (new.id, new.name, '', '', '', '');
END;

-- 删除资产 → 清理 FTS 行
CREATE TRIGGER fts_ad AFTER DELETE ON assets BEGIN
  DELETE FROM library_fts WHERE asset_id = old.id;
END;

-- 改名 → 重建该行 FTS（fts5 虚拟表用 DELETE+INSERT 替代 UPDATE，避免兼容问题）
CREATE TRIGGER fts_au AFTER UPDATE OF name ON assets BEGIN
  DELETE FROM library_fts WHERE asset_id = new.id;
  INSERT INTO library_fts(asset_id, name, tags, prompt_body, annotation, ocr)
  VALUES (new.id, new.name, '', '', '', '');
END;

-- 回填存量（迁移前已存在的 assets）
INSERT INTO library_fts(asset_id, name, tags, prompt_body, annotation, ocr)
SELECT id, name, '', '', '', '' FROM assets
WHERE id NOT IN (SELECT asset_id FROM library_fts);
