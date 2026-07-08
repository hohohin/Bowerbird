//! 反推 caption 的解析与落库 payload 构造。
//!
//! `commands::codex` 的「反推」与 `core::autoname` 的「采集即命名」共用这套规则，
//! 保证两条路径产出的 `analyses(kind=caption)` 结构一致（创作板统一消费）。

use std::collections::BTreeMap;

use serde::Serialize;

use crate::core::library::CaptionSection;

pub const DIMENSION_KEYS: [&str; 5] = ["composition", "light", "palette", "action", "mood"];

/// 反推结果的结构化解析：动态 sections + 归一化后的标准 dimensions + 解析状态。
#[derive(Debug, Clone, Serialize)]
pub struct CaptionAnalysis {
    /// 反推结果里所有识别到的 markdown section（保留原始标题与顺序）。
    pub sections: Vec<CaptionSection>,
    /// 把 sections 标题经别名表归一化后的标准维度（composition/light/...）。
    pub dimensions: BTreeMap<String, String>,
    pub parse_status: &'static str,
}

/// 构造 `analyses(kind=caption).payload` 的 JSON 字符串。
/// 兼容旧 `{text}`：新版含 schema_version/text/instruction/session_id/sections/dimensions/parse_status。
pub fn build_payload(
    text: &str,
    instruction: &str,
    session_id: Option<&str>,
    provider: &str,
    analysis: &CaptionAnalysis,
) -> String {
    serde_json::json!({
        "schema_version": 1,
        "text": text,
        "instruction": instruction,
        "session_id": session_id,
        "provider": provider,
        "sections": analysis.sections,
        "dimensions": analysis.dimensions,
        "parse_status": analysis.parse_status,
    })
    .to_string()
}

/// 把 Codex 反推的 markdown 解析成「动态 sections + 标准 dimensions」。
///
/// 任何形如 `**标题**` / `- **标题**` / `### 标题` / `标题：内容` 的行都视为一个
/// 新 section 的起点；section 标题经别名表归一化后写入标准 `dimensions`。
/// 这样前端详情页能看到模型给出的全部维度（含 类型 / 材质 / 反推提示词 等），
/// 创作板则继续只消费稳定的五大标准维度。
pub fn parse(text: &str) -> CaptionAnalysis {
    let mut sections: Vec<(String, Vec<String>)> = Vec::new();

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        // 跳过代码围栏（```/```text），但保留围栏内部的内容作为正文。
        if line.starts_with("```") {
            continue;
        }

        if let Some((title, body)) = parse_section_heading(line) {
            sections.push((title, Vec::new()));
            if !body.is_empty() {
                sections.last_mut().unwrap().1.push(body);
            }
        } else if let Some((_, parts)) = sections.last_mut() {
            parts.push(line.to_string());
        }
    }

    let sections: Vec<CaptionSection> = sections
        .into_iter()
        .map(|(title, parts)| CaptionSection {
            body: parts.join("\n").trim().to_string(),
            title,
        })
        .filter(|section| !section.body.is_empty())
        .collect();

    let dimensions = map_dimensions(&sections);
    let count = dimensions.len();
    let parse_status = if count == DIMENSION_KEYS.len() {
        "structured"
    } else if count > 0 {
        "partial"
    } else {
        "raw_fallback"
    };

    CaptionAnalysis {
        sections,
        dimensions,
        parse_status,
    }
}

fn map_dimensions(sections: &[CaptionSection]) -> BTreeMap<String, String> {
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    for section in sections {
        if let Some(key) = dimension_key(&section.title) {
            out.entry(key.to_string())
                .or_insert_with(|| section.body.clone());
        }
    }
    out
}

/// 识别一行是否为 section 标题。返回 (标题, 同行剩余正文)。
fn parse_section_heading(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();

    // markdown 标题：# / ## / ### ...
    let after_hash = trimmed.trim_start_matches('#').trim_start();
    if after_hash != trimmed && !after_hash.is_empty() {
        if looks_like_section_label(after_hash) {
            return Some((clean_title(after_hash), String::new()));
        }
    }

    let stripped = strip_markdown_prefix(line);
    if stripped.is_empty() {
        return None;
    }

    // 粗体标题：**label** 后可接 `：正文` 或直接正文。
    if let Some(rest) = stripped.strip_prefix("**") {
        if let Some(end) = rest.find("**") {
            let label = &rest[..end];
            if looks_like_section_label(label) {
                let body = strip_label_separator(&rest[end + 2..]).to_string();
                return Some((clean_title(label), body));
            }
        }
    }

    // `标题：正文` —— 仅当整行较短时才认定，避免把长正文里的冒号误判成标题。
    if stripped.chars().count() <= 30 {
        if let Some((label, body)) = split_label_body(stripped) {
            if looks_like_section_label(label) {
                return Some((clean_title(label), body.trim().to_string()));
            }
        }
    }

    None
}

fn clean_title(label: &str) -> String {
    label.trim().trim_matches('*').trim_matches('`').trim().to_string()
}

fn looks_like_section_label(label: &str) -> bool {
    let label = normalize_label(label);
    !label.is_empty()
        && label.chars().count() <= 16
        && !label.chars().any(|c| c.is_ascii_digit())
        && !label.contains('`')
}

fn strip_markdown_prefix(mut line: &str) -> &str {
    line = line.trim_start_matches('#').trim_start();
    if line.starts_with("- ") || line.starts_with("+ ") || line.starts_with("• ") {
        line = line[1..].trim_start();
    } else if line.starts_with("* ") {
        line = line[1..].trim_start();
    }

    let mut chars = line.char_indices().peekable();
    while let Some((_, c)) = chars.peek().copied() {
        if c.is_ascii_digit() {
            chars.next();
        } else {
            break;
        }
    }
    if let Some((i, c)) = chars.peek().copied() {
        if matches!(c, '.' | '、' | ')' | '）') {
            line = &line[i + c.len_utf8()..];
        }
    }

    line.trim()
}

fn split_label_body(line: &str) -> Option<(&str, &str)> {
    for sep in ['：', ':'] {
        if let Some(i) = line.find(sep) {
            return Some((&line[..i], &line[i + sep.len_utf8()..]));
        }
    }
    None
}

fn strip_label_separator(s: &str) -> &str {
    s.trim()
        .trim_start_matches(['：', ':', '-', '—', '–'])
        .trim()
}

fn dimension_key(label: &str) -> Option<&'static str> {
    let label = normalize_label(label);
    let aliases: [(&str, &[&str]); 5] = [
        ("composition", &["构图/ratio", "构图", "ratio", "比例", "画幅", "布局"]),
        ("light", &["光影", "光线", "lighting", "灯光", "照明"]),
        ("palette", &["色调", "色彩", "配色", "color", "颜色"]),
        ("action", &["主体动作", "人物动作", "动作", "姿态", "行为"]),
        ("mood", &["氛围", "情绪", "mood", "atmosphere", "感觉"]),
    ];

    aliases.iter().find_map(|(key, values)| {
        values
            .iter()
            .any(|value| {
                let value = normalize_label(value);
                label == value || (label.starts_with(&value) && label.chars().count() <= value.chars().count() + 8)
            })
            .then_some(*key)
    })
}

fn normalize_label(label: &str) -> String {
    label
        .trim()
        .chars()
        .filter(|c| {
            !c.is_whitespace()
                && !matches!(
                    c,
                    '*' | '`' | '[' | ']' | '【' | '】' | '「' | '」' | '（' | '）' | '(' | ')'
                        | '/' | '：' | ':' | '、' | '，' | ','
                )
        })
        .collect::<String>()
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_caption_dimensions() {
        let parsed = parse(
            r#"
- **构图/ratio**：竖幅近景，主体居中。
- **光影**：柔和侧光，阴影很浅。
- **色调**：低饱和蓝灰配暖橙点缀。
- **主体动作**：人物侧身回头。
- **氛围/情绪**：安静、克制、带一点怀旧。
"#,
        );

        assert_eq!(parsed.parse_status, "structured");
        assert_eq!(parsed.sections.len(), 5);
        assert_eq!(parsed.dimensions.get("composition").unwrap(), "竖幅近景，主体居中。");
        assert_eq!(parsed.dimensions.get("light").unwrap(), "柔和侧光，阴影很浅。");
        assert_eq!(parsed.dimensions.get("palette").unwrap(), "低饱和蓝灰配暖橙点缀。");
        assert_eq!(parsed.dimensions.get("action").unwrap(), "人物侧身回头。");
        assert_eq!(parsed.dimensions.get("mood").unwrap(), "安静、克制、带一点怀旧。");
    }

    #[test]
    fn captures_dynamic_sections_beyond_standard_dimensions() {
        // 模型给出的非标准维度（类型 / 材质 / 反推提示词 / 负面提示词）也应保留进 sections，
        // 同时标准五维仍正确映射。
        let parsed = parse(
            r#"
这是一张绘画风格的 AI 生成图。

**类型**
绘画 / AI 插画 / 数字绘画

**构图**
竖构图，比例约 `4:5`，主体偏右。

**光影**
高调强光，逆光 / 顶侧光效果明显。

**色调**
主色为明亮的草绿色、黄绿色。

**主体动作**
一只白色小羊正在奔跑或跳跃。

**氛围 / 情绪**
梦幻、治愈、轻盈、自由、明亮。

**反推提示词**
```text
一只发光的白色小羊在明亮的绿色草地上奔跑，4:5
```

**可补充的负面提示词**
```text
写实摄影，硬边轮廓，低光
```
"#,
        );

        assert_eq!(parsed.parse_status, "structured");
        assert_eq!(parsed.dimensions.len(), 5);
        assert_eq!(parsed.dimensions.get("mood").unwrap(), "梦幻、治愈、轻盈、自由、明亮。");

        let titles: Vec<&str> = parsed.sections.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(
            titles,
            [
                "类型",
                "构图",
                "光影",
                "色调",
                "主体动作",
                "氛围 / 情绪",
                "反推提示词",
                "可补充的负面提示词"
            ]
        );
        let prompt_section = parsed
            .sections
            .iter()
            .find(|s| s.title == "反推提示词")
            .unwrap();
        assert_eq!(
            prompt_section.body,
            "一只发光的白色小羊在明亮的绿色草地上奔跑，4:5"
        );
    }

    #[test]
    fn parses_heading_and_multiline_section() {
        let parsed = parse(
            r#"
### 光影
主光从画面左侧进入。
背景有一圈冷色轮廓光。

### 色调
整体偏青绿。
"#,
        );

        assert_eq!(parsed.parse_status, "partial");
        assert_eq!(
            parsed.dimensions.get("light").unwrap(),
            "主光从画面左侧进入。\n背景有一圈冷色轮廓光。"
        );
        assert_eq!(parsed.dimensions.get("palette").unwrap(), "整体偏青绿。");
    }

    #[test]
    fn parses_bold_parenthesized_heading_before_ratio_body() {
        let parsed = parse(
            r#"
**构图（ratio）**
竖版构图，约 `9:16`。主体小羊位于画面中下部偏右，身体斜向从左下延伸到右上，形成强烈的动势。
"#,
        );

        assert_eq!(parsed.parse_status, "partial");
        assert_eq!(
            parsed.dimensions.get("composition").unwrap(),
            "竖版构图，约 `9:16`。主体小羊位于画面中下部偏右，身体斜向从左下延伸到右上，形成强烈的动势。"
        );
    }

    #[test]
    fn marks_partial_when_sections_missing() {
        let parsed = parse("构图：三分法构图\nlighting: hard rim light");

        assert_eq!(parsed.parse_status, "partial");
        assert_eq!(parsed.dimensions.len(), 2);
        assert_eq!(parsed.sections.len(), 2);
        assert_eq!(parsed.dimensions.get("composition").unwrap(), "三分法构图");
        assert_eq!(parsed.dimensions.get("light").unwrap(), "hard rim light");
    }

    #[test]
    fn unknown_sections_do_not_leak_into_previous_dimension() {
        let parsed = parse(
            r#"
**氛围 / 情绪**
梦幻、治愈、轻盈、自由、明亮。
有一种春天、希望、童话、被阳光包围的感觉。

**反推提示词**
```text
一只发光的白色小羊在明亮的绿色草地上奔跑，梦幻数字绘画，4:5
```

**可补充的负面提示词**
```text
写实摄影，硬边轮廓，低光，阴暗
```
"#,
        );

        assert_eq!(parsed.parse_status, "partial");
        assert_eq!(
            parsed.dimensions.get("mood").unwrap(),
            "梦幻、治愈、轻盈、自由、明亮。\n有一种春天、希望、童话、被阳光包围的感觉。"
        );
    }

    #[test]
    fn marks_raw_fallback_without_known_labels() {
        let parsed = parse("这是一张霓虹街景，人物站在雨夜的路口。");

        assert_eq!(parsed.parse_status, "raw_fallback");
        assert!(parsed.dimensions.is_empty());
        assert!(parsed.sections.is_empty());
    }
}
