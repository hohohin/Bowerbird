-- 0003：创作板维度模板 seed（开发计划 §5.4 / Phase 6）。
-- 维度下拉选项背后的 prompt 片段，落 prompts(kind='template')。
-- 约定（详见前端 dimensions.ts / PROJECT.md）：
--   title = 维度名（调性/人物动作/构图/色调/光影/排版）—— 用作分组键
--   body  = "短标签 | 英文 fragment" —— 前端按 " | " 拆：前段=下拉中文标签，后段=真 prompt 片段
-- 固定 id + INSERT OR IGNORE → 可重复执行无副作用（dev 库重建 / 部分迁移均安全）。

INSERT OR IGNORE INTO prompts (id, title, body, kind, source_model, created_at, updated_at) VALUES
-- 调性
('tpl_tone_cinematic',  '调性', '电影感 | cinematic, film still, dramatic lighting, shallow depth of field', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
('tpl_tone_cyberpunk',  '调性', '赛博朋克 | cyberpunk, neon-lit, rain-soaked streets, futuristic', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
('tpl_tone_watercolor', '调性', '水彩 | watercolor, soft wash, paper texture, delicate brushwork', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
('tpl_tone_minimal',    '调性', '极简 | minimalist, clean composition, negative space, subtle', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
-- 人物动作
('tpl_action_stand',    '人物动作', '站姿 | standing pose, full body, confident stance', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
('tpl_action_run',      '人物动作', '奔跑 | running, dynamic motion, mid-stride', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
('tpl_action_lookback', '人物动作', '回眸 | looking back over shoulder, turning glance', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
('tpl_action_sit',      '人物动作', '静坐 | seated quietly, contemplative pose', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
-- 构图
('tpl_comp_center',     '构图', '居中对称 | centered symmetrical composition', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
('tpl_comp_thirds',     '构图', '三分法 | rule of thirds composition', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
('tpl_comp_topdown',    '构图', '俯视 | top-down bird''s eye view', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
('tpl_comp_closeup',    '构图', '特写 | extreme close-up shot', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
-- 色调
('tpl_pal_warm',        '色调', '暖色调 | warm color palette, golden tones', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
('tpl_pal_cool',        '色调', '冷色调 | cool color palette, blue tones', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
('tpl_pal_morandi',     '色调', '莫兰迪 | morandi muted palette, low saturation', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
('tpl_pal_contrast',    '色调', '高对比 | high contrast, vivid colors', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
-- 光影
('tpl_light_backlit',   '光影', '逆光 | backlit, rim lighting, silhouette', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
('tpl_light_side',      '光影', '侧光 | side lighting, dramatic shadows', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
('tpl_light_soft',      '光影', '柔光 | soft diffused lighting', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
('tpl_light_neon',      '光影', '霓虹光 | neon lighting, glowing highlights', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
-- 排版
('tpl_layoutspace',     '排版', '留白 | generous negative space, airy layout', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
('tpl_layout_full',     '排版', '满版 | full-bleed, edge to edge', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
('tpl_layout_collage',  '排版', '拼贴 | collage, mixed media layout', 'template', NULL, strftime('%s','now'), strftime('%s','now')),
('tpl_layout_magazine', '排版', '杂志风 | editorial magazine layout, typography focus', 'template', NULL, strftime('%s','now'), strftime('%s','now'));
