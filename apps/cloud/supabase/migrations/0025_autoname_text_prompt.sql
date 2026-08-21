-- Seed the cloud text-only autoname instruction (remote prompt config, cf. 0020).
-- Cloud autoname names generated images from the generation prompt's dimension
-- data (【维度】：正文) without uploading the image; this instruction states the
-- naming rules only -- the desktop appends the dimension text after it.

insert into public.prompt_configs (key, value) values (
  'understand_autoname_text',
  '下面是这张图片的生成参数（按【维度】标注）。请根据这些内容给图片取一个不超过 8 个字的中文名字。只回复名字本身，不要标点符号、不要描述、不要解释。'
);
