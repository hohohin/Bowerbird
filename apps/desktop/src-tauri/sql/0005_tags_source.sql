-- tags 加 source 列：auto = codex 自动归类产出（受控词表）、manual = 用户手加。
-- 自动归类（P2）只把 codex 选中的类别写成 auto tag；详情页用户加的走 manual。
ALTER TABLE tags ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
CREATE INDEX idx_tags_source ON tags(source);

-- 预置自动归类词表（codex 从中选 1-2 个主类；用户可在详情页扩充 manual 类别）。
-- 固定可读 id（seed 专用）；运行时 get_or_create_tag 用 ULID。name UNIQUE → INSERT OR IGNORE 幂等。
INSERT OR IGNORE INTO tags (id, name, source) VALUES
  ('cat_portrait',     '人像', 'auto'),
  ('cat_landscape',    '风景', 'auto'),
  ('cat_still',        '静物', 'auto'),
  ('cat_food',         '美食', 'auto'),
  ('cat_animal',       '动物', 'auto'),
  ('cat_arch',         '建筑', 'auto'),
  ('cat_abstract',     '抽象', 'auto'),
  ('cat_illustration', '插画', 'auto'),
  ('cat_interior',     '室内', 'auto'),
  ('cat_street',       '街景', 'auto');
