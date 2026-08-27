-- 0019：FTS5 扩列（Phase 4 收尾，约定 3）——prompt_body ← 反推 caption 正文、annotation ← 标注 token。
-- 检索仍走 search_assets_ex 的 LIKE 多维语义（trigram <3 字符 + 跨维度 AND/NOT 不适合 MATCH）；
-- 本迁移把 0002 留空的两列补齐并保持同步，使索引数据与提示词体系一致。
--
-- prompt_body：仅聚合「有 sections 的 caption」（= 正式反推结果）的 $.text。
--   基础分析 caption（sections 空）刻意不入索引——未反推的图不应被泛化描述词命中
--   （与 search_assets_ex「未反推搜不到」的既有刻意行为同口径）。
-- annotation：聚合 kind=annotation payload 的 shapes[].token（火山坐标标记，纯坐标）。
-- 所有 JSON 访问先过 json_valid/json_type：坏行安全降级为空，绝不让 analyses 写入失败。
-- SQLite 触发器无法抽公共函数，四条触发器共用同两段子查询（X 为资产 id 占位）。

-- 改名触发器重建时不再清空两列（0002 版本会写成空串，导致改名即丢索引）。
DROP TRIGGER IF EXISTS fts_au;
CREATE TRIGGER fts_au AFTER UPDATE OF name ON assets BEGIN
  DELETE FROM library_fts WHERE asset_id = new.id;
  INSERT INTO library_fts(asset_id, name, tags, prompt_body, annotation, ocr)
  VALUES (new.id, new.name, '',
    COALESCE((SELECT group_concat(json_extract(an.payload, '$.text'), char(10)) FROM analyses an
      WHERE an.asset_id = new.id AND an.kind = 'caption'
        AND CASE WHEN json_valid(an.payload) THEN json_array_length(an.payload, '$.sections') ELSE 0 END > 0), ''),
    COALESCE((SELECT group_concat(CASE WHEN json_valid(an.payload) AND json_type(an.payload, '$.shapes') = 'array'
        THEN (SELECT group_concat(json_extract(s.value, '$.token'), ' ') FROM json_each(an.payload, '$.shapes') s)
        ELSE NULL END, char(10)) FROM analyses an
      WHERE an.asset_id = new.id AND an.kind = 'annotation'), ''),
    '');
END;

-- caption / annotation 增改删 → 重算该资产的 FTS 行（name 列取 assets 当下值）。
CREATE TRIGGER fts_analyses_ai AFTER INSERT ON analyses
WHEN new.kind IN ('caption', 'annotation')
BEGIN
  DELETE FROM library_fts WHERE asset_id = new.asset_id;
  INSERT INTO library_fts(asset_id, name, tags, prompt_body, annotation, ocr)
  VALUES (new.asset_id, COALESCE((SELECT name FROM assets WHERE id = new.asset_id), ''), '',
    COALESCE((SELECT group_concat(json_extract(an.payload, '$.text'), char(10)) FROM analyses an
      WHERE an.asset_id = new.asset_id AND an.kind = 'caption'
        AND CASE WHEN json_valid(an.payload) THEN json_array_length(an.payload, '$.sections') ELSE 0 END > 0), ''),
    COALESCE((SELECT group_concat(CASE WHEN json_valid(an.payload) AND json_type(an.payload, '$.shapes') = 'array'
        THEN (SELECT group_concat(json_extract(s.value, '$.token'), ' ') FROM json_each(an.payload, '$.shapes') s)
        ELSE NULL END, char(10)) FROM analyses an
      WHERE an.asset_id = new.asset_id AND an.kind = 'annotation'), ''),
    '');
END;

CREATE TRIGGER fts_analyses_au AFTER UPDATE OF payload, kind ON analyses
WHEN new.kind IN ('caption', 'annotation') OR old.kind IN ('caption', 'annotation')
BEGIN
  DELETE FROM library_fts WHERE asset_id = new.asset_id;
  INSERT INTO library_fts(asset_id, name, tags, prompt_body, annotation, ocr)
  VALUES (new.asset_id, COALESCE((SELECT name FROM assets WHERE id = new.asset_id), ''), '',
    COALESCE((SELECT group_concat(json_extract(an.payload, '$.text'), char(10)) FROM analyses an
      WHERE an.asset_id = new.asset_id AND an.kind = 'caption'
        AND CASE WHEN json_valid(an.payload) THEN json_array_length(an.payload, '$.sections') ELSE 0 END > 0), ''),
    COALESCE((SELECT group_concat(CASE WHEN json_valid(an.payload) AND json_type(an.payload, '$.shapes') = 'array'
        THEN (SELECT group_concat(json_extract(s.value, '$.token'), ' ') FROM json_each(an.payload, '$.shapes') s)
        ELSE NULL END, char(10)) FROM analyses an
      WHERE an.asset_id = new.asset_id AND an.kind = 'annotation'), ''),
    '');
END;

CREATE TRIGGER fts_analyses_ad AFTER DELETE ON analyses
WHEN old.kind IN ('caption', 'annotation')
BEGIN
  DELETE FROM library_fts WHERE asset_id = old.asset_id;
  INSERT INTO library_fts(asset_id, name, tags, prompt_body, annotation, ocr)
  VALUES (old.asset_id, COALESCE((SELECT name FROM assets WHERE id = old.asset_id), ''), '',
    COALESCE((SELECT group_concat(json_extract(an.payload, '$.text'), char(10)) FROM analyses an
      WHERE an.asset_id = old.asset_id AND an.kind = 'caption'
        AND CASE WHEN json_valid(an.payload) THEN json_array_length(an.payload, '$.sections') ELSE 0 END > 0), ''),
    COALESCE((SELECT group_concat(CASE WHEN json_valid(an.payload) AND json_type(an.payload, '$.shapes') = 'array'
        THEN (SELECT group_concat(json_extract(s.value, '$.token'), ' ') FROM json_each(an.payload, '$.shapes') s)
        ELSE NULL END, char(10)) FROM analyses an
      WHERE an.asset_id = old.asset_id AND an.kind = 'annotation'), ''),
    '');
END;

-- 存量回填：整表重建（迁移时点独占连接，DELETE 全表 + 重插最简）。
DELETE FROM library_fts;
INSERT INTO library_fts(asset_id, name, tags, prompt_body, annotation, ocr)
SELECT a.id, a.name, '',
  COALESCE((SELECT group_concat(json_extract(an.payload, '$.text'), char(10)) FROM analyses an
    WHERE an.asset_id = a.id AND an.kind = 'caption'
      AND CASE WHEN json_valid(an.payload) THEN json_array_length(an.payload, '$.sections') ELSE 0 END > 0), ''),
  COALESCE((SELECT group_concat(CASE WHEN json_valid(an.payload) AND json_type(an.payload, '$.shapes') = 'array'
      THEN (SELECT group_concat(json_extract(s.value, '$.token'), ' ') FROM json_each(an.payload, '$.shapes') s)
      ELSE NULL END, char(10)) FROM analyses an
    WHERE an.asset_id = a.id AND an.kind = 'annotation'), ''),
  ''
FROM assets a;
