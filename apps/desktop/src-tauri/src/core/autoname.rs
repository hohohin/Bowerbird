//! 采集即命名：图片一进库就后台调一次 codex，一次产出「≤8 字命名 + 反推 caption」。
//!
//! - **非阻塞**：codex 单次 10–30s（HTTPS 回退更慢），图片必须先秒级落库可见；
//!   命名/caption 在后台完成后 emit `library://assets-changed` 让前端刷新。
//! - **离线降级**（约定 7）：codex 不可用就 `warn` + 保留原文件名，不崩。
//! - **去重不重跑**：已有 caption 的资产（dHash 去重命中的已有资产 / 重导入）直接跳过。
//! - **并发节流**：全局信号量限制同时跑的 codex 子进程数（批量采集/导入不爆订阅 + 资源）。
//!
//! 一次 codex 调用同时得到命名和描述，描述按反推规则落 `analyses(kind=caption)`，
//! 让新采集的图自动成为「创作板就绪」（`list_prompted_assets` 会带上它）。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter};
use tokio::sync::Semaphore;
use ulid::Ulid;

use crate::codex::codex_cli::CodexCliProvider;
use crate::codex::types::CodexRequest;
use crate::codex::GenProvider;
use crate::core::caption;
use crate::core::library::{Analysis, Asset};
use crate::db::Database;
use crate::error::AppResult;

/// 受控类别词表查空时的硬编码兜底（避免 codex 无类可选）。正常情况词表来自 tags(source='auto')。
const FALLBACK_VOCAB: &[&str] = &[
    "人像", "风景", "静物", "美食", "动物", "建筑", "抽象", "插画", "室内", "街景",
];

/// 采集即命名 + 归类指令：看图 → 取名 + 描述 + 从词表选 1-2 个主类。
/// 类别用哨兵 `[[CAT: ...]]` 标注（extract_categories 抽取，不污染描述正文）。
/// 词表查空时用 FALLBACK_VOCAB。
fn build_auto_instruction(vocab: &[String]) -> String {
    let list = if vocab.is_empty() {
        FALLBACK_VOCAB.join("、")
    } else {
        vocab.join("、")
    };
    format!(
        "请描述这张图片并取名。严格按照以下格式回复：\
         第一行只回复命名本身，不要有标点符号；\
         第二行起回复图片的描述；\
         最后一行单独用 [[CAT: 类别1, 类别2]] 标注主类（最多 2 个，必须从词表里选，只回类别名）。\
         词表：{list}。"
    )
}

/// 批量重归类指令：喂已有 caption 文本（不看图）→ 只回 `[[CAT: ...]]` 一行。
fn build_classify_instruction(vocab: &[String], caption: &str) -> String {
    let list = if vocab.is_empty() {
        FALLBACK_VOCAB.join("、")
    } else {
        vocab.join("、")
    };
    format!(
        "下面是一张图片的描述，请据此判断它属于哪个类别。\
         从词表里选 1-2 个最合适的主类，只用 [[CAT: 类别1, 类别2]] 格式回复这一行，不要其它内容。\
         词表：{list}。\n\n图片描述：\n{caption}"
    )
}

/// 同时跑的 codex 子进程上限（批量采集/导入时节流）。
const MAX_CONCURRENT: usize = 3;
static AUTO_SEM: Semaphore = Semaphore::const_new(MAX_CONCURRENT);

/// 在途的「采集即分析」codex 调用数（拿到信号量后才计）。emit 给前端顶部状态圈。
static AUTO_ACTIVE: AtomicUsize = AtomicUsize::new(0);

/// RAII：构造即在途 +1 并 emit；drop 即 -1 并 emit，跨早退/出错路径都安全复位。
struct AutoActiveGuard(AppHandle);
impl AutoActiveGuard {
    fn new(app: AppHandle) -> Self {
        let n = AUTO_ACTIVE.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = app.emit("codex://auto-active", n);
        Self(app)
    }
}
impl Drop for AutoActiveGuard {
    fn drop(&mut self) {
        let n = AUTO_ACTIVE
            .fetch_sub(1, Ordering::SeqCst)
            .saturating_sub(1);
        let _ = self.0.emit("codex://auto-active", n);
    }
}

/// 生成图命名专用指令：只取名、不要描述（生成图不进创作板 @ 引用池，不需要 caption）。
const NAME_ONLY_INSTRUCTION: &str = "请给这张图片取一个不超过 8 个字的中文名字。\
  只回复名字本身，不要标点符号、不要描述、不要解释。";

/// 采集/导入入库后调用：后台让 codex 看图 → 产出命名 + caption，写回 DB 并 emit 刷新。
/// 立即返回（不阻塞导入）；任一失败静默降级。
pub fn spawn_auto_analyze(app: AppHandle, db: Arc<Database>, asset: Asset) {
    tokio::spawn(async move {
        if let Err(e) = auto_analyze(&app, &db, asset).await {
            tracing::warn!("auto-name: {e}");
        }
    });
}

async fn auto_analyze(app: &AppHandle, db: &Arc<Database>, asset: Asset) -> Result<(), String> {
    let asset_id = asset.id.clone();

    // 已有 caption → 跳过（dHash 去重返回已有资产 / 重导入）。查失败也继续（宁多跑一次）。
    let id_for_check = asset_id.clone();
    match db_call(db, move |db| db.has_analysis(&id_for_check, "caption")).await {
        Ok(true) => return Ok(()),
        Ok(false) => {}
        Err(e) => tracing::warn!("auto-name has_analysis {asset_id}: {e}"),
    }

    let Some(store_path) = asset.store_path.clone() else {
        return Ok(()); // 无 store_path 无法看图
    };

    let _permit = AUTO_SEM.acquire().await.map_err(|e| e.to_string())?;
    // 拿到信号量（即将真正调 codex）才计入在途，emit 让前端状态圈反映导入基础分析。
    let _active = AutoActiveGuard::new(app.clone());

    // 受控类别词表（codex 只见 auto 类别）；查失败用兜底（build_auto_instruction 处理空词表）。
    let vocab = db_call(db, |db| db.list_auto_tag_names())
        .await
        .unwrap_or_default();
    let instruction = build_auto_instruction(&vocab);

    let req = CodexRequest {
        instruction: instruction.clone(),
        reference_images: vec![store_path.into()],
        context_prompts: vec![],
    };
    let provider = CodexCliProvider::default();
    let provider_name = provider.name().to_string();
    // codex 不可用/超时 → 向上抛 Err，spawn wrapper 统一 warn（保留原文件名）。
    let result = provider.run(req).await.map_err(|e| e.to_string())?;

    // 抽类别哨兵 → (类别, 剥哨兵后的文本)；name/desc/caption 都基于剥哨兵文本（不含类别）。
    let (cats, clean_text) = extract_categories(&result.text);
    let (name, desc) = split_name_and_desc(&clean_text);
    let mut changed = false;

    // 1) 命名写回（best-effort，失败不阻断 caption）
    if let Some(n) = name {
        let (id_for_name, n_for_name) = (asset_id.clone(), n);
        match db_call(db, move |db| db.update_asset_name(&id_for_name, &n_for_name)).await {
            Ok(()) => changed = true,
            Err(e) => tracing::warn!("auto-name update_asset_name {asset_id}: {e}"),
        }
    }

    // 2) 描述落 caption（剥哨兵；desc 为空则跳过）
    if !desc.is_empty() {
        let analysis_parsed = caption::parse(&desc);
        let payload = caption::build_payload(
            &desc,
            &instruction,
            result.session_id.as_deref(),
            &provider_name,
            &analysis_parsed,
        );
        let row = Analysis {
            id: Ulid::new().to_string(),
            asset_id: asset_id.clone(),
            kind: "caption".to_string(),
            payload,
            provider: Some(provider_name),
            created_at: None,
        };
        match db_call(db, move |db| db.insert_analysis(&row)).await {
            Ok(()) => changed = true,
            Err(e) => tracing::warn!("auto-name insert_analysis {asset_id}: {e}"),
        }
    }

    // 3) 自动归类：codex 选中的类别精确匹配词表才写 auto tag；仅当该图尚无 auto tag（防顶手改）。
    if !cats.is_empty() {
        let id_for_tag = asset_id.clone();
        match db_call(db, move |db| apply_auto_categories(&id_for_tag, &cats, db)).await {
            Ok(true) => changed = true,
            Ok(false) => {}
            Err(e) => tracing::warn!("auto-name classify {asset_id}: {e}"),
        }
    }

    if changed {
        let _ = app.emit("library://assets-changed", ());
    }
    Ok(())
}

/// 在 spawn_blocking 里跑一次 DB 调用，把 JoinError 与 AppError 都折成 String。
async fn db_call<T, F>(db: &Arc<Database>, f: F) -> Result<T, String>
where
    F: FnOnce(&Arc<Database>) -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    let db = db.clone();
    tokio::task::spawn_blocking(move || f(&db))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// 生成图入库后调用：后台让 codex 看图 → **只取名**（≤8 字），写回 DB + emit 刷新。
///
/// 与 `spawn_auto_analyze` 的区别：**不写 caption**——生成图不需要进创作板 `@` 引用池
/// （`list_prompted_assets` 按 caption 过滤），只想要个人能读的名字（替代 codex 默认的
/// `ig_<hash>`）。立即返回（不阻塞）；任一失败静默降级（保留原文件名，约定 7）。
pub fn spawn_auto_name_only(app: AppHandle, db: Arc<Database>, asset: Asset) {
    tokio::spawn(async move {
        if let Err(e) = auto_name_only(&app, &db, asset).await {
            tracing::warn!("auto-name-only: {e}");
        }
    });
}

async fn auto_name_only(app: &AppHandle, db: &Arc<Database>, asset: Asset) -> Result<(), String> {
    let asset_id = asset.id.clone();
    let Some(store_path) = asset.store_path.clone() else {
        return Ok(()); // 无 store_path 无法看图
    };

    let _permit = AUTO_SEM.acquire().await.map_err(|e| e.to_string())?;

    let req = CodexRequest {
        instruction: NAME_ONLY_INSTRUCTION.to_string(),
        reference_images: vec![store_path.into()],
        context_prompts: vec![],
    };
    let provider = CodexCliProvider::default();
    // codex 不可用/超时 → 静默降级（保留原文件名）。
    let result = provider.run(req).await.map_err(|e| e.to_string())?;

    // 指令要求单行；用 split_name_and_desc 取首行经 clean_name，防模型偶尔多嘴。
    let name = split_name_and_desc(&result.text).0;
    if let Some(n) = name {
        let (idn, nn) = (asset_id.clone(), n);
        match db_call(db, move |db| db.update_asset_name(&idn, &nn)).await {
            Ok(()) => {
                let _ = app.emit("library://assets-changed", ());
            }
            Err(e) => tracing::warn!("auto-name-only update_asset_name {asset_id}: {e}"),
        }
    }
    Ok(())
}

/// 把 codex 首行结果清洗成 ≤8 字命名。
/// 去前缀标签 / markdown 与引号类字符 / 末尾标点，再截断 8 字；空 → None。
fn clean_name(raw: &str) -> Option<String> {
    // 前缀标签兜底（模型偶尔不守「第 1 行只写命名」格式）
    const PREFIXES: &[&str] = &["命名：", "名称：", "名字：", "标题：", "Name:", "Name：", "name:"];
    // 首尾需剥除的字符：中英文引号 / 书名号 / markdown / 列表标记
    const STRIP: &[char] = &[
        '"', '"', '\'', '\'', '「', '」', '『', '』', '《', '》', '`', '*', '#', '-', '•', '·',
    ];
    let s = raw.trim();
    let s = PREFIXES
        .iter()
        .find_map(|p| s.strip_prefix(p))
        .unwrap_or(s)
        .trim();
    let s = s.trim_matches(|c: char| STRIP.contains(&c));
    let s = s.trim_end_matches(['。', '.', '！', '!', '？', '?', '，', ',', '、']);
    let out: String = s.chars().take(8).collect();
    let out = out.trim();
    if out.is_empty() {
        None
    } else {
        Some(out.to_string())
    }
}

/// 按指令格式切分：首行 → 命名（经 clean_name），其余 → 描述正文。
/// 单行输出按「第 1 行 = 命名」当命名候选，描述留空。
fn split_name_and_desc(text: &str) -> (Option<String>, String) {
    let trimmed = text.trim();
    let Some((first, rest)) = trimmed.split_once('\n') else {
        return (clean_name(trimmed), String::new());
    };
    (clean_name(first), rest.trim().to_string())
}

/// 从 codex 回复里抽 `[[CAT: 类1, 类2]]` 哨兵 → (类别列表, 剥哨兵后的描述)。
/// 无哨兵返回空 + 原文（trim）；类别按 `,、，` 切并 trim、去空。是否在词表由调用方过滤。
fn extract_categories(text: &str) -> (Vec<String>, String) {
    let Some(start) = text.find("[[CAT:") else {
        return (Vec::new(), text.trim().to_string());
    };
    let after = &text[start + "[[CAT:".len()..];
    let Some(end) = after.find("]]") else {
        return (Vec::new(), text.trim().to_string());
    };
    let inner = &after[..end];
    let cats: Vec<String> = inner
        .split(|c| matches!(c, ',' | '、' | '，'))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let sentinel_len = "[[CAT:".len() + end + "]]".len();
    let mut cleaned = String::with_capacity(text.len());
    cleaned.push_str(&text[..start]);
    cleaned.push_str(&text[start + sentinel_len..]);
    (cats, cleaned.trim().to_string())
}

/// 给资产写 auto 类别：仅当尚无 auto tag（防顶手改）；只收精确匹配词表的类别
/// （codex 偶尔回不在词表的，丢弃不污染词表）。返回是否有变更。
fn apply_auto_categories(asset_id: &str, cats: &[String], db: &Arc<Database>) -> AppResult<bool> {
    if db.has_auto_tag(asset_id)? {
        return Ok(false);
    }
    let vocab: std::collections::HashSet<String> =
        db.list_auto_tag_names()?.into_iter().collect();
    let ids: Vec<String> = cats
        .iter()
        .filter(|c| vocab.contains(*c))
        .filter_map(|c| db.get_or_create_tag(c, "auto").ok())
        .collect();
    if ids.is_empty() {
        return Ok(false);
    }
    db.set_asset_tags(asset_id, &ids, "auto")?;
    Ok(true)
}

/// 批量重归类入口：对所有「无 auto tag 且有 caption」的资产，喂 caption 文本（不看图）
/// 让 codex 分类。复用 AUTO_SEM 节流；逐张 emit 进度 `classify://progress {done,total,ended?}`。
/// 无 auto tag 的过滤由 list_assets_to_classify 保证；apply_auto_categories 再查一次防并发竞态。
pub fn spawn_reclassify_all(app: AppHandle, db: Arc<Database>) {
    tokio::spawn(async move {
        let ids = db_call(&db, |db| db.list_assets_to_classify())
            .await
            .unwrap_or_default();
        let total = ids.len();
        let _ = app.emit(
            "classify://progress",
            serde_json::json!({ "done": 0, "total": total }),
        );
        for (i, asset_id) in ids.iter().enumerate() {
            if let Err(e) = classify_one(&app, &db, asset_id).await {
                tracing::warn!("reclassify {asset_id}: {e}");
            }
            let _ = app.emit(
                "classify://progress",
                serde_json::json!({ "done": i + 1, "total": total }),
            );
        }
        let _ = app.emit(
            "classify://progress",
            serde_json::json!({ "done": total, "total": total, "ended": true }),
        );
    });
}

/// 单张重归类：取最新 caption 文本 → 纯文本 run()（不看图）→ 抽类别 → 写 auto tag。
async fn classify_one(app: &AppHandle, db: &Arc<Database>, asset_id: &str) -> Result<(), String> {
    let id_for_cap = asset_id.to_string();
    let caption_text = db_call(db, move |db| db.latest_caption_text(&id_for_cap))
        .await?
        .unwrap_or_default();
    if caption_text.trim().is_empty() {
        return Ok(()); // 无 caption 无法分类
    }

    let _permit = AUTO_SEM.acquire().await.map_err(|e| e.to_string())?;
    let vocab = db_call(db, |db| db.list_auto_tag_names())
        .await
        .unwrap_or_default();
    let req = CodexRequest {
        instruction: build_classify_instruction(&vocab, &caption_text),
        reference_images: vec![],
        context_prompts: vec![],
    };
    let result = CodexCliProvider::default()
        .run(req)
        .await
        .map_err(|e| e.to_string())?;
    let (cats, _) = extract_categories(&result.text);

    let id_for_tag = asset_id.to_string();
    let changed = db_call(db, move |db| apply_auto_categories(&id_for_tag, &cats, db)).await?;
    if changed {
        let _ = app.emit("library://assets-changed", ());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_name_strips_wrapper_chars() {
        assert_eq!(clean_name("雨夜霓虹"), Some("雨夜霓虹".into()));
        assert_eq!(clean_name("  雨夜霓虹  "), Some("雨夜霓虹".into()));
        assert_eq!(clean_name("\"雨夜霓虹\""), Some("雨夜霓虹".into()));
        assert_eq!(clean_name("「雨夜霓虹」"), Some("雨夜霓虹".into()));
        assert_eq!(clean_name("**雨夜霓虹**"), Some("雨夜霓虹".into()));
        assert_eq!(clean_name("命名：雨夜霓虹"), Some("雨夜霓虹".into()));
        assert_eq!(clean_name("雨夜霓虹。"), Some("雨夜霓虹".into()));
        assert_eq!(clean_name("- 雨夜霓虹"), Some("雨夜霓虹".into()));
    }

    #[test]
    fn clean_name_truncates_to_8_chars() {
        // 取前 8 个字（Unicode 标量），不按字节截。
        assert_eq!(
            clean_name("这是一个非常非常长的名字"),
            Some("这是一个非常非常".into())
        );
    }

    #[test]
    fn clean_name_empty_to_none() {
        assert_eq!(clean_name(""), None);
        assert_eq!(clean_name("   "), None);
        assert_eq!(clean_name("***"), None);
        assert_eq!(clean_name("。。。"), None);
    }

    #[test]
    fn split_name_and_desc_multiline() {
        let (name, desc) = split_name_and_desc("雨夜霓虹\n这是一张雨夜的照片。\n**构图**\n竖幅");
        assert_eq!(name.as_deref(), Some("雨夜霓虹"));
        assert_eq!(desc, "这是一张雨夜的照片。\n**构图**\n竖幅");
    }

    #[test]
    fn split_name_and_desc_strips_crlf_first_line() {
        let (name, desc) = split_name_and_desc("雨夜霓虹\r\n描述正文");
        assert_eq!(name.as_deref(), Some("雨夜霓虹"));
        assert_eq!(desc, "描述正文");
    }

    #[test]
    fn split_name_and_desc_single_line_is_name() {
        let (name, desc) = split_name_and_desc("雨夜霓虹");
        assert_eq!(name.as_deref(), Some("雨夜霓虹"));
        assert_eq!(desc, "");
    }

    #[test]
    fn split_name_and_desc_unnameable_first_line_yields_no_name() {
        // 首行清洗后为空 → 不命名；首行被丢弃，其余当描述。
        let (name, desc) = split_name_and_desc("。。。\n这是一张雨夜的照片。");
        assert_eq!(name, None);
        assert_eq!(desc, "这是一张雨夜的照片。");
    }

    #[test]
    fn extract_categories_parses_sentinel_and_strips() {
        let (cats, desc) =
            extract_categories("雨夜霓虹\n这是一张雨夜的照片。\n[[CAT: 风景, 街景]]");
        assert_eq!(cats, vec!["风景".to_string(), "街景".to_string()]);
        assert!(!desc.contains("[[CAT"), "哨兵应从描述里剥除");
        assert!(desc.contains("雨夜的照片"));
    }

    #[test]
    fn extract_categories_no_sentinel_returns_clean() {
        let (cats, desc) = extract_categories("雨夜霓虹\n这是一张雨夜的照片。");
        assert!(cats.is_empty());
        assert_eq!(desc, "雨夜霓虹\n这是一张雨夜的照片。");
    }

    #[test]
    fn extract_categories_keeps_multiline_desc_after_strip() {
        // 描述里本来就有换行；哨兵在最后，剥掉后多行描述结构保留。
        let (cats, desc) = extract_categories("名字\n第一行描述\n第二行描述\n[[CAT: 人像]]");
        assert_eq!(cats, vec!["人像".to_string()]);
        assert_eq!(desc, "名字\n第一行描述\n第二行描述");
    }

    #[test]
    fn extract_categories_splits_cn_punctuation() {
        let (cats, _) = extract_categories("[[CAT: 风景、美食，街景]]");
        assert_eq!(
            cats,
            vec!["风景".to_string(), "美食".to_string(), "街景".to_string()]
        );
    }
}
