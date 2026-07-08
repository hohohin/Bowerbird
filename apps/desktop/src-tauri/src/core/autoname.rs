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

use std::sync::Arc;

use tauri::{AppHandle, Emitter};
use tokio::sync::Semaphore;
use ulid::Ulid;

use crate::codex::codex_cli::CodexCliProvider;
use crate::codex::types::CodexRequest;
use crate::codex::CodexProvider;
use crate::core::caption;
use crate::core::library::{Analysis, Asset};
use crate::db::Database;
use crate::error::AppResult;

/// 第 1 行 = 命名（无标点），第 2 行起 = 图片描述。基础分析不要求按维度分点；
/// 维度结构（构图/光影/...）交给用户后续手动「反推」按需做。
const AUTO_INSTRUCTION: &str = "请描述这张图片并取名。严格按照以下格式回复：\
  第一行只回复命名本身，不要有标点符号；\
  第二行回复图片的描述。";

/// 同时跑的 codex 子进程上限（批量采集/导入时节流）。
const MAX_CONCURRENT: usize = 3;
static AUTO_SEM: Semaphore = Semaphore::const_new(MAX_CONCURRENT);

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

    let req = CodexRequest {
        instruction: AUTO_INSTRUCTION.to_string(),
        reference_images: vec![store_path.into()],
        context_prompts: vec![],
        output_schema: None,
    };
    let provider = CodexCliProvider::default();
    let provider_name = provider.name().to_string();
    // codex 不可用/超时 → 向上抛 Err，spawn wrapper 统一 warn（保留原文件名）。
    let result = provider.run(req).await.map_err(|e| e.to_string())?;

    let (name, desc) = split_name_and_desc(&result.text);
    let mut changed = false;

    // 1) 命名写回（best-effort，失败不阻断 caption）
    if let Some(n) = name {
        let (id_for_name, n_for_name) = (asset_id.clone(), n);
        match db_call(db, move |db| db.update_asset_name(&id_for_name, &n_for_name)).await {
            Ok(()) => changed = true,
            Err(e) => tracing::warn!("auto-name update_asset_name {asset_id}: {e}"),
        }
    }

    // 2) 描述落 caption（不浪费这次分析；desc 为空则跳过）
    if !desc.is_empty() {
        let analysis_parsed = caption::parse(&desc);
        let payload = caption::build_payload(
            &desc,
            AUTO_INSTRUCTION,
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
}
