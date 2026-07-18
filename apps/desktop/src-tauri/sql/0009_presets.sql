-- 创作板「用途」（preset）：命名的预设 prompt 片段。
-- 发送给 codex 时作为基底注入（类 CLAUDE.md 上下文），不进创作板编辑器。
-- 用户点选即用，免去每次手打常用基底 prompt（如「产品图」=「产品图片，真实光影，sonyA73拍摄，185mm焦段」）。
-- V1 纯文本（name + body）；参考图挂钩留 V2（需资产多选 UI）。

CREATE TABLE presets (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER
);
