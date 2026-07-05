-- Bowerbird 初始化 schema（开发计划 §4.2）
-- 所有核心表一次建齐：assets / folders / tags / prompts / asset_prompts / analyses / library_fts + task_queue。

PRAGMA foreign_keys = ON;

-- 文件夹（含智能文件夹：smart_query 非空）
CREATE TABLE folders (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  parent_id TEXT,
  kind      TEXT DEFAULT 'folder',   -- folder | smart
  smart_query TEXT,                   -- 智能文件夹的 FTS5/SQL 条件
  sort      TEXT,
  created_at INTEGER,
  FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE
);

-- 资产主表
CREATE TABLE assets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  ext         TEXT,
  origin_path TEXT,                   -- 原始素材路径（导入前）
  store_path  TEXT,                   -- 库内存储路径（导入后）
  thumb_path  TEXT,
  size        INTEGER,
  width       INTEGER,
  height      INTEGER,
  duration    REAL,
  phash       TEXT,                   -- 仅用于采集去重
  colors      TEXT,                   -- JSON 主色
  rating      INTEGER DEFAULT 0,
  source      TEXT DEFAULT 'imported', -- imported | extension | clipboard
  source_url  TEXT,
  folder_id   TEXT,
  created_at  INTEGER,
  file_mtime  INTEGER,
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL
);

CREATE TABLE tags (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  color TEXT
);

CREATE TABLE asset_tags (
  asset_id TEXT NOT NULL,
  tag_id   TEXT NOT NULL,
  PRIMARY KEY (asset_id, tag_id),
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id)   REFERENCES tags(id)   ON DELETE CASCADE
);

-- ============ 提示词体系（核心枢纽，§5.4）============
CREATE TABLE prompts (
  id           TEXT PRIMARY KEY,
  title        TEXT,
  body         TEXT NOT NULL,          -- FTS5 索引主体
  kind         TEXT DEFAULT 'manual',  -- manual | generated | template
  source_model TEXT,                   -- 生成它的 codex provider
  created_at   INTEGER,
  updated_at   INTEGER
);

-- 图片 ↔ 提示词 多对多
CREATE TABLE asset_prompts (
  asset_id  TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  role      TEXT DEFAULT 'ref',        -- main | ref | desc
  PRIMARY KEY (asset_id, prompt_id),
  FOREIGN KEY (asset_id)  REFERENCES assets(id)  ON DELETE CASCADE,
  FOREIGN KEY (prompt_id) REFERENCES prompts(id) ON DELETE CASCADE
);

-- ============ ⑤ 拆解分析结果（全由 codex 产出，§5.6）============
CREATE TABLE analyses (
  id         TEXT PRIMARY KEY,
  asset_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,            -- caption | keywords | ocr | layout | inspiration_card
  payload    TEXT NOT NULL,            -- JSON：codex 输出
  provider   TEXT,
  created_at INTEGER,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

-- ============ 任务队列（codex 调用持久化，§3.2 稳定性原则）============
CREATE TABLE task_queue (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  payload      TEXT NOT NULL,          -- JSON 输入
  status       TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed | cancelled
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER,
  provider     TEXT
);

-- ============ 索引 ============
CREATE INDEX idx_assets_folder  ON assets(folder_id);
CREATE INDEX idx_assets_created ON assets(created_at DESC);
CREATE INDEX idx_assets_phash   ON assets(phash);
CREATE INDEX idx_assets_source  ON assets(source);
CREATE INDEX idx_analyses_asset ON analyses(asset_id, kind);
CREATE INDEX idx_asset_prompts_prompt ON asset_prompts(prompt_id);
CREATE INDEX idx_tasks_status   ON task_queue(status, created_at);

-- ============ 全文检索（FTS5，trigram 适配中文）============
CREATE VIRTUAL TABLE library_fts USING fts5(
  asset_id UNINDEXED,
  name,
  tags,
  prompt_body,
  annotation,
  ocr,
  tokenize = 'trigram'
);

-- 默认根节点
INSERT INTO folders (id, name, parent_id, kind, created_at)
VALUES ('root', '全部', NULL, 'folder', strftime('%s','now'));
