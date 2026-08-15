/** 自动反推提示词默认模板。与 Rust 端 DEFAULT_AUTO_ANALYZE_PROMPT 保持一致。 */
export const DEFAULT_AUTO_ANALYZE_PROMPT =
  "请描述这张图片并取名。严格按照以下格式回复：第一行只回复命名本身，不要有标点符号；第二行起回复图片的描述；最后一行单独用 [[CAT: 类别1, 类别2]] 标注主类（最多 2 个，必须从词表里选，只回类别名）。词表：{vocab}。";

/** 官网首页（设置「关于我们」与账号「升级」共用同一链接）。TODO: 官网域名定稿后替换。 */
export const WEBSITE_URL = "https://bowerbird-demo.onrender.com";
