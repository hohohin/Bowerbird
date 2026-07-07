//! Codex 调用命令（单次 + 流式 + 反推 + 会话回看）。
//!
//! 全部走 [`CodexCliProvider`]（`codex exec --image`，ChatGPT 订阅认证，
//! 真正多模态看图；Mock / DeepSeek / OpenAI HTTP 路线已移除，详见 PROJECT.md）。
//! 流式：通过 event `codex://chunk` 推 Chunk（Delta / Done / Error）。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use ulid::Ulid;

use crate::codex::codex_cli::CodexCliProvider;
use crate::codex::types::{Chunk, CodexRequest, CodexResult};
use crate::codex::CodexProvider;
use crate::db::Database;
use crate::error::AppError;

const DEFAULT_DESCRIBE_INSTRUCTION: &str = "请描述这张图片";
const DIMENSION_KEYS: [&str; 5] = ["composition", "light", "palette", "action", "mood"];

#[derive(Debug, Clone, Serialize)]
struct CaptionSection {
    title: String,
    body: String,
}

#[derive(Debug, Clone, Serialize)]
struct CaptionAnalysis {
    /// 反推结果里所有识别到的 markdown section（保留原始标题与顺序）。
    sections: Vec<CaptionSection>,
    /// 把 sections 标题经别名表归一化后的标准维度（composition/light/...）。
    dimensions: BTreeMap<String, String>,
    parse_status: &'static str,
}

#[tauri::command]
pub async fn codex_run(req: CodexRequest) -> Result<CodexResult, AppError> {
    Ok(CodexCliProvider::default().run(req).await?)
}

#[tauri::command]
pub async fn codex_run_stream(
    app: AppHandle,
    req: CodexRequest,
) -> Result<(), AppError> {
    let p = CodexCliProvider::default();
    let (tx, mut rx) = mpsc::channel::<Chunk>(64);
    let app_clone = app.clone();
    tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            let _ = app_clone.emit("codex://chunk", &chunk);
        }
    });
    p.run_stream(req, tx).await?;
    Ok(())
}

/// codex 可用性检测结果。`ok=false` 时 `reason` 给出置灰提示文案。
#[derive(Debug, Clone, Serialize)]
pub struct CodexHealth {
    pub ok: bool,
    pub reason: String,
}

/// 检测 codex 是否可用于反推：① `codex --version` 可执行；② `~/.codex/auth.json` 存在且非空（已登录）。
/// 任一不满足返回 `ok=false` + 中文 reason，前端据此置灰反推按钮（约定 7：离线/无账号降级置灰）。
/// 注：依赖 `$HOME`（macOS/Linux）；Windows 的 codex 凭证路径不同，暂未覆盖。
#[tauri::command]
pub async fn codex_health() -> Result<CodexHealth, AppError> {
    let binary_ok = tokio::process::Command::new("codex")
        .arg("--version")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !binary_ok {
        return Ok(CodexHealth {
            ok: false,
            reason: "未检测到 codex CLI（需 npm install -g @openai/codex 并在 PATH）".into(),
        });
    }
    let logged_in = std::env::var("HOME")
        .ok()
        .map(|h| {
            let p = std::path::PathBuf::from(h).join(".codex").join("auth.json");
            std::fs::metadata(&p).map(|m| m.len() > 0).unwrap_or(false)
        })
        .unwrap_or(false);
    if !logged_in {
        return Ok(CodexHealth {
            ok: false,
            reason: "codex 未登录（需运行 codex login）".into(),
        });
    }
    Ok(CodexHealth {
        ok: true,
        reason: String::new(),
    })
}

/// 为单个资产生成提示词并写回 asset_prompts（批量由前端循环）。
#[tauri::command]
pub async fn codex_generate_prompt_for_asset(
    db: State<'_, Arc<Database>>,
    asset_id: String,
    role: String,
) -> Result<String, AppError> {
    let store_path = get_asset_store_path(&db, &asset_id).await?;

    let req = CodexRequest {
        instruction: "为这张图片生成一段适合 AI 绘画的提示词（描述主体、风格、构图、光影）".into(),
        reference_images: vec![PathBuf::from(store_path)],
        context_prompts: vec![],
        output_schema: None,
    };
    let p = CodexCliProvider::default();
    let provider_name = p.name().to_string();
    let result = p.run(req).await?;

    let prompt_id = Ulid::new().to_string();
    let db_for_write = db.inner().clone();
    let (pid, aid, role_for_write) = (prompt_id.clone(), asset_id.clone(), role.clone());
    let (text, pname) = (result.text, provider_name);
    tokio::task::spawn_blocking(move || {
        db_for_write.create_prompt(&pid, None, &text, Some("generated"), Some(&pname))?;
        db_for_write.link_prompt(&aid, &pid, &role_for_write)?;
        Ok::<_, AppError>(())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;

    Ok(prompt_id)
}

/// 当前反推任务的取消信号。同一时刻只支持一个反推任务（前端反推按钮 disabled 保证）；
/// 取消时往 sender 发信号，select 命中后 run future 被 drop，codex 子进程靠
/// `kill_on_drop` 自动终止（见 codex_cli.rs）。
static DESCRIBE_CANCEL: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>> =
    std::sync::Mutex::new(None);

/// 「反推」：让 codex 描述指定资产，结果落 analyses(kind=caption)。
/// payload 同时存 session_id，前端「在 codex 中打开」按钮据此唤起 `codex resume`。
/// 可取消：前端调 `cancel_codex_describe` 即中断本次 codex 执行（子进程被 kill）。
#[tauri::command]
pub async fn codex_describe_asset(
    db: State<'_, Arc<Database>>,
    asset_id: String,
    instruction: Option<String>,
) -> Result<String, AppError> {
    let store_path = get_asset_store_path(&db, &asset_id).await?;
    let instruction = instruction
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_DESCRIBE_INSTRUCTION.to_string());

    let req = CodexRequest {
        instruction: instruction.clone(),
        reference_images: vec![PathBuf::from(store_path)],
        context_prompts: vec![],
        output_schema: None,
    };
    let p = CodexCliProvider::default();
    let provider_name = p.name().to_string();

    // 可取消：select codex 执行 与 取消信号。取消时 run future 被 drop，
    // codex 子进程靠 kill_on_drop 自动 kill。
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    DESCRIBE_CANCEL
        .lock()
        .unwrap()
        .replace(cancel_tx);
    let run_fut = p.run(req);
    tokio::pin!(run_fut);
    let result = tokio::select! {
        r = &mut run_fut => r,
        _ = &mut cancel_rx => {
            return Err(AppError::Codex("已取消".into()));
        }
    };
    DESCRIBE_CANCEL.lock().unwrap().take();
    let result = result?;
    let caption = parse_caption_analysis(&result.text);

    let id = Ulid::new().to_string();
    let payload = serde_json::json!({
        "schema_version": 1,
        "text": result.text,
        "instruction": instruction,
        "session_id": result.session_id,
        "sections": caption.sections,
        "dimensions": caption.dimensions,
        "parse_status": caption.parse_status,
    })
    .to_string();
    let analysis = crate::core::library::Analysis {
        id: id.clone(),
        asset_id: asset_id.clone(),
        kind: "caption".to_string(),
        payload,
        provider: Some(provider_name),
        created_at: None,
    };
    let db_for_write = db.inner().clone();
    tokio::task::spawn_blocking(move || db_for_write.insert_analysis(&analysis))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    Ok(id)
}

/// 取消正在进行的反推（`codex_describe_asset`）。无任务在跑则空操作。
#[tauri::command]
pub async fn cancel_codex_describe() -> Result<(), AppError> {
    if let Some(tx) = DESCRIBE_CANCEL.lock().unwrap().take() {
        let _ = tx.send(());
    }
    Ok(())
}

/// 「在 codex 中打开会话」：唤起系统终端跑 `codex resume <session_id>`，
/// 让用户在 codex TUI 里翻看本次反推的完整对话（含图）。macOS 用 Terminal.app。
#[tauri::command]
pub async fn open_codex_session(session_id: String) -> Result<(), AppError> {
    let sid = session_id.trim();
    if sid.is_empty() {
        return Err(AppError::Codex("session_id 为空".into()));
    }
    #[cfg(target_os = "macos")]
    {
        // session_id 是 codex 输出的 UUID（我们落库的值），非用户自由输入；
        // osascript 的 do script 把它作为单参传给 `codex resume`，无注入风险。
        let script = format!(
            "tell application \"Terminal\"\nactivate\ndo script \"codex resume {sid}\"\nend tell"
        );
        tokio::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .spawn()
            .map_err(|e| AppError::Codex(format!("启动 Terminal 失败: {e}")))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = sid;
        Err(AppError::Codex("open_codex_session 仅支持 macOS".into()))
    }
}

/// 取资产的 store_path（spawn_blocking 读 DB），不存在或无 store_path 报错。
async fn get_asset_store_path(
    db: &State<'_, Arc<Database>>,
    asset_id: &str,
) -> Result<String, AppError> {
    let db_for_get = db.inner().clone();
    let aid_for_get = asset_id.to_string();
    let asset = tokio::task::spawn_blocking(move || db_for_get.get_asset(&aid_for_get))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??
        .ok_or_else(|| AppError::NotFound(asset_id.to_string()))?;
    asset
        .store_path
        .ok_or_else(|| AppError::Media(format!("asset {asset_id} has no store_path")))
}

/// 把 Codex 反推的 markdown 解析成「动态 sections + 标准 dimensions」。
///
/// 任何形如 `**标题**` / `- **标题**` / `### 标题` / `标题：内容` 的行都视为一个
/// 新 section 的起点；section 标题经别名表归一化后写入标准 `dimensions`。
/// 这样前端详情页能看到模型给出的全部维度（含 类型 / 材质 / 反推提示词 等），
/// 创作板则继续只消费稳定的五大标准维度。
fn parse_caption_analysis(text: &str) -> CaptionAnalysis {
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
        let parsed = parse_caption_analysis(
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
        let parsed = parse_caption_analysis(
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
        let parsed = parse_caption_analysis(
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
        let parsed = parse_caption_analysis(
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
        let parsed = parse_caption_analysis("构图：三分法构图\nlighting: hard rim light");

        assert_eq!(parsed.parse_status, "partial");
        assert_eq!(parsed.dimensions.len(), 2);
        assert_eq!(parsed.sections.len(), 2);
        assert_eq!(parsed.dimensions.get("composition").unwrap(), "三分法构图");
        assert_eq!(parsed.dimensions.get("light").unwrap(), "hard rim light");
    }

    #[test]
    fn unknown_sections_do_not_leak_into_previous_dimension() {
        let parsed = parse_caption_analysis(
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
        let parsed = parse_caption_analysis("这是一张霓虹街景，人物站在雨夜的路口。");

        assert_eq!(parsed.parse_status, "raw_fallback");
        assert!(parsed.dimensions.is_empty());
        assert!(parsed.sections.is_empty());
    }
}
