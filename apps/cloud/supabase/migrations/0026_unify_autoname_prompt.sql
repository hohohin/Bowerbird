-- Unify autonaming into a single text-only path: every provider (codex today,
-- future ones) names from text only (generation prompt dimensions, or the
-- caption after a manual 反推) and shares ONE prompt. Update the seeded
-- understand_autoname wording to the text-based instruction and drop the
-- temporary understand_autoname_text row from the two-prompt interim state.

update public.prompt_configs
set value = '下面是这张图片的相关文本（生成参数或反推描述，含【维度】信息）。请据此给图片取一个不超过 8 个字的中文名字。只回复名字本身，不要标点符号、不要描述、不要解释。',
    version = version + 1,
    updated_at = now()
where key = 'understand_autoname';

delete from public.prompt_configs where key = 'understand_autoname_text';
