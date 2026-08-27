-- V2：视觉设定来源标记——local_baseline（V0 确定性基线）/ cloud_model（V2 云端模型提炼）。
ALTER TABLE project_visual_profiles ADD COLUMN extractor TEXT NOT NULL DEFAULT 'local_baseline';
