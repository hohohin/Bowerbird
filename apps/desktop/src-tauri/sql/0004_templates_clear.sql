-- 0004：清空 0003 seed 的维度模板行（创作板交互收敛，§5.4）。
-- 创作板的「维度下拉」改为前端固定的 6 个维度标签（调性/人物动作/构图/色调/光影/排版），
-- 选项背后的内容来自所选图的反推 caption，不再使用预置 prompt 片段。
-- 故 0003 seed 的赛博朋克/水彩/电影感/极简 等行作废，统一清空。
-- prompts 表本身保留（仍存 manual/main 提示词）；后续若做用户自定义模板可复用 kind='template'。

DELETE FROM prompts WHERE kind = 'template';
