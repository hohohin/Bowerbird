-- 生成图同流程合并：给 assets 加 generation_session_id，入库时直写（取自 codex 会话 thread_id）。
-- 瀑布流按此列合并：同 session 的多张过程图只显最新一张，详情/缩略图可左右切换过程图。
-- session_id 原只存 analyses(kind=generation_meta).payload JSON，每次列表 JOIN 太贵，故落列 + 索引。

ALTER TABLE assets ADD COLUMN generation_session_id TEXT;
CREATE INDEX idx_assets_generation_session_id ON assets(generation_session_id);

-- 回填：从已有 generation_meta 取 session_id 写入存量 codex 资产，让旧生成图也分进组。
UPDATE assets SET generation_session_id = (
  SELECT json_extract(payload, '$.session_id') FROM analyses
  WHERE asset_id = assets.id AND kind = 'generation_meta'
    AND json_extract(payload, '$.session_id') IS NOT NULL
) WHERE source = 'codex';
