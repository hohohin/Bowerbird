-- 0020：素材被创作板调用（参考）计数（to-do「自学习功能」数据基础）。
-- 语义：每次生成实际下发的参考图（store_path 命中的资产）各 +1；同一次调用内去重。
-- 历史回填在 Rust hook（generation_meta.payload.references 按条解析），不在此做。
ALTER TABLE assets ADD COLUMN reference_count INTEGER NOT NULL DEFAULT 0;
