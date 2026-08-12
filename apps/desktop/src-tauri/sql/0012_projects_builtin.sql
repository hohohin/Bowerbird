-- 项目 kind 列：区分用户项目（'user'）与预置项目（'builtin'，如「欢迎来到园丁鸟」）。
-- 预置项目删除时强制 Keep 语义（仅删项目行，成员素材留全局，不物理删除、不移出到虚拟 workspace）。
ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'user';
