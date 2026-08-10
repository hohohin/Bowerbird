//! 生成任务收尾与启动恢复（视频生成 spec Phase A Task 5）。
//!
//! [`finalize_generation_assets`]：把 provider 产出的源图入库为正式资产 + 落 generation_meta /
//! caption / 自动命名，供 `codex_create_image`（正常路径）与启动恢复 worker 复用，保证两条路径
//! 产物元数据一致。[`build_generation_caption`] 等：从生成 prompt 识别 `【维度】：正文` 片段
//! 构造 caption（不调 AI）——从 `commands/codex.rs` 移入，与生成路径解耦。

use std::path::PathBuf;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Semaphore;
use ulid::Ulid;

use crate::codex::jimeng::{poll_query_and_download, resolve_dreamina_binary};
use crate::core::library::{Analysis, Asset};
use crate::core::paths::LibraryPaths;
use crate::core::task_queue::{GenJob, Task};
use crate::core::{caption, ingest};
use crate::db::Database;
use crate::error::{AppError, AppResult};

/// 即梦同账号视频/图片并发上限 = 1（spike 实证 `ExceedConcurrencyLimit`，ret=1310）。
/// permit=1 Semaphore 让即梦 job 在 Bowerbird 侧串行（同时只 1 个 dreamina 子进程），避免多 job
/// 并发撞限制；codex 不受此限可并行。正常生成（`codex_create_image`）与启动恢复 worker
///（`recover_one_jimeng_job`）共用此令牌，FIFO 公平排队（恢复轮询久时新发即梦 job 等待，可接受）。
pub static JIMENG_FLY: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(1));

fn provider_source_tag(provider: &str) -> &'static str {
    match provider {
        "jimeng" | "dreamina" => "jimeng",
        "bowerbird-cloud" => "bowerbird-cloud",
        _ => "codex",
    }
}

/// 把 provider 产出的源图收尾入库：ingest（每个 src，不算 pHash 不去重）→ 删临时下载目录 →
/// project link → generation_meta（payload 增 `submit_id`）→ caption（从 prompt 识别维度，不调 AI）
/// → emit `analyses://changed`（创作板 @ 池刷新）→ 后台自动命名。返回入库的资产。
///
/// `codex_create_image`（正常路径）与启动恢复 worker 都调它，保证恢复资产也有完整 ✨ 来源 / caption。
/// 自动命名 `spawn_auto_name_only` 自身 spawn task（需 `Arc<Database>`），故本函数为 async。
pub async fn finalize_generation_assets(
    app: AppHandle,
    db: Arc<Database>,
    paths: Arc<LibraryPaths>,
    src_images: Vec<PathBuf>,
    temp_dir: Option<PathBuf>,
    prompt: String,
    references: Vec<String>,
    session_id: Option<String>,
    submit_id: Option<String>,
    provider: String,
    project_id: Option<String>,
) -> AppResult<Vec<Asset>> {
    let source_tag = provider_source_tag(&provider).to_string();

    // ingest + 删 temp + project link + generation_meta + caption（同步 DB 写，spawn_blocking）
    let db_b = db.clone();
    let paths_b = paths.clone();
    let gen_assets: Vec<Asset> = tokio::task::spawn_blocking(
        move || -> AppResult<Vec<Asset>> {
            let mut out: Vec<Asset> = Vec::new();
            for src in &src_images {
                out.push(ingest::ingest_generated(
                    &paths_b,
                    &db_b,
                    src,
                    session_id.as_deref(),
                    &source_tag,
                )?);
            }
            // 源图已 copy 进库，删临时下载目录（即梦用；codex 为 None 不删）。
            if let Some(dir) = &temp_dir {
                let _ = std::fs::remove_dir_all(dir);
            }
            if let Some(pid) = project_id.as_deref() {
                let ids: Vec<String> = out.iter().map(|a| a.id.clone()).collect();
                if let Err(e) = db_b.add_assets_to_project(pid, &ids) {
                    tracing::warn!("failed to link generated assets to project {pid}: {e}");
                }
            }

            // generation_meta（详情页「✨ 生成来源」卡片；payload 增 submit_id 供事后取回）。
            let meta_payload = serde_json::json!({
                "prompt": prompt,
                "session_id": session_id,
                "references": references,
                "provider": provider,
                "submit_id": submit_id,
            })
            .to_string();
            for a in &out {
                let row = Analysis {
                    id: Ulid::new().to_string(),
                    asset_id: a.id.clone(),
                    kind: "generation_meta".to_string(),
                    payload: meta_payload.clone(),
                    provider: Some(provider.clone()),
                    created_at: None,
                };
                db_b.insert_analysis(&row)?;
            }

            // caption 正文：session 在则取会话 prompt 链（首版 + 各轮修改），否则仅本轮 prompt。
            // 从中识别 【维度】：正文 片段（创作板序列化注入），不调 AI。
            let chain = match session_id.as_deref() {
                Some(sid) => db_b
                    .generation_prompt_chain(sid)
                    .unwrap_or_else(|_| vec![prompt.clone()]),
                None => vec![prompt.clone()],
            };
            let caption_text = build_generation_caption(&chain);
            let analysis_parsed = caption::parse(&caption_text);
            let caption_payload = caption::build_payload(
                &caption_text,
                "由生成提示词填充（非反推）",
                session_id.as_deref(),
                &provider,
                &analysis_parsed,
            );
            for a in &out {
                let row = Analysis {
                    id: Ulid::new().to_string(),
                    asset_id: a.id.clone(),
                    kind: "caption".to_string(),
                    payload: caption_payload.clone(),
                    provider: Some(provider.clone()),
                    created_at: None,
                };
                db_b.insert_analysis(&row)?;
            }
            Ok(out)
        },
    )
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;

    // caption 落库后通知创作板 @ 池刷新（与反推同机制：analyses://changed → App 重载 promptedAssets）。
    for a in &gen_assets {
        let _ = app.emit(
            "analyses://changed",
            serde_json::json!({ "asset_id": a.id, "kind": "caption" }),
        );
    }
    // 后台自动命名（每张生成图各跑一次 codex 看图取名，替代 codex 默认 ig_<hash>）。
    for a in gen_assets.clone() {
        crate::core::autoname::spawn_auto_name_only(app.clone(), db.clone(), a);
    }
    Ok(gen_assets)
}

/// app 启动恢复入口：扫 `task_queue` 未完成（queued/running）的 generation job，
/// - codex job → `mark_failed`（codex exec 无 resume-from-mid，不可恢复）+ emit error；
/// - 即梦 job 但 submit_id=None → `mark_failed`（重启前未拿到 submit_id，无法续查）；
/// - 即梦 job + submit_id → 后台 spawn `recover_one_jimeng_job` 续查。
///
/// 异步不阻塞启动；恢复 job 的 permit 与正常生成公平排队（JIMENG_FLY FIFO）。
pub fn spawn_recovery(app: AppHandle, db: Arc<Database>, paths: Arc<LibraryPaths>) {
    tauri::async_runtime::spawn(async move {
        let auth = app.state::<crate::cloud::AuthClient>().inner().clone();
        let entitlement = app.state::<crate::cloud::EntitlementService>();
        let entitlement_snapshot = entitlement.current_or_sync(&auth).await;
        let running = match Task::list_running(&db) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("启动恢复：list_running 失败: {e}");
                return;
            }
        };
        tracing::info!("启动恢复：list_running 扫到 {} 条未完成 job", running.len());
        for task in running {
            let Some(job) = task.gen_job() else { continue };
            tracing::info!(
                "恢复扫描：job={} provider={} status={} submit_id={:?}",
                job.id,
                job.provider,
                job.status,
                job.submit_id
            );
            if matches!(job.provider.as_str(), "jimeng" | "dreamina")
                && !entitlement_snapshot.policy.can_use_byo
            {
                let message = "当前账号已降级，升级 Pro 后才能恢复即梦 CLI 任务";
                let _ = Task::mark_failed(&db, &job.id, message);
                let _ = app.emit(
                    "codex://chunk",
                    serde_json::json!({ "kind": "error", "job_id": job.id, "message": message }),
                );
                continue;
            }
            if !matches!(job.provider.as_str(), "jimeng" | "dreamina" | "bowerbird-cloud") {
                let _ = Task::mark_failed(&db, &job.id, "app 重启中断，codex 会话不可恢复");
                let _ = app.emit(
                    "codex://chunk",
                    serde_json::json!({ "kind": "error", "job_id": job.id, "message": "app 重启中断，codex 会话不可恢复" }),
                );
                continue;
            }
            let Some(submit_id) = job.submit_id.clone() else {
                let _ = Task::mark_failed(&db, &job.id, "重启前未拿到 submit_id，无法续查");
                let _ = app.emit(
                    "codex://chunk",
                    serde_json::json!({ "kind": "error", "job_id": job.id, "message": "未拿到 submit_id，无法续查" }),
                );
                continue;
            };
            // 即梦 job + submit_id → 后台续查（recover_started 自包含，不依赖前端 mount 顺序）。
            let (app2, db2, paths2) = (app.clone(), db.clone(), paths.clone());
            tokio::spawn(async move {
                recover_one_jimeng_job(app2, db2, paths2, job, submit_id).await;
            });
        }
    });
}

/// 续查单个即梦 job：emit recover_started（前端 upsert 占位 job）→ 拿 JIMENG_FLY permit →
/// status=querying 落库 → poll_query_and_download 续查下载 → finalize_generation_assets 入库 →
/// emit done。远端仍排队则保持 running + emit recover_polling（下次启动再试）；真失败 mark_failed。
async fn recover_one_jimeng_job(
    app: AppHandle,
    db: Arc<Database>,
    paths: Arc<LibraryPaths>,
    mut job: GenJob,
    submit_id: String,
) {
    // ① recover_started 自包含事件：前端据此 upsert 占位 job，防 done 早于 loadGenJobs 丢事件。
    let _ = app.emit(
        "codex://chunk",
        serde_json::json!({ "kind": "recover_started", "job_id": job.id, "prompt": job.prompt, "provider": job.provider }),
    );
    // ② 拿 permit（FIFO 公平，与正常即梦生成串行）。
    let _permit = match JIMENG_FLY.acquire().await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("恢复 job {} 获取即梦令牌失败: {e}", job.id);
            return;
        }
    };
    // ③ status=querying 落库（前端 loadGenJobs 拉到时显示「续查中」）。
    job.status = "querying".into();
    let _ = Task::upsert_gen_job(&db, &job);

    // ④ 轮询续查下载（策略 B：bounded poll loop，向下兼容 query_result 阻塞等待）。
    let binary = resolve_dreamina_binary().unwrap_or_else(|| "dreamina".to_string());
    match poll_query_and_download(&binary, &submit_id, 30, Duration::from_secs(10)).await {
        Ok(src_images) => {
            tracing::info!(
                "恢复续查成功：job={} 图={} 张",
                job.id,
                src_images.len()
            );
            let temp_dir = src_images
                .first()
                .and_then(|p| p.parent().map(|x| x.to_path_buf()));
            match finalize_generation_assets(
                app.clone(),
                db.clone(),
                paths.clone(),
                src_images,
                temp_dir,
                job.prompt.clone(),
                job.references.clone(),
                Some(submit_id.clone()),
                Some(submit_id.clone()),
                "jimeng".to_string(),
                job.project_id.clone(),
            )
            .await
            {
                Ok(assets) => {
                    let asset_paths: Vec<PathBuf> = assets
                        .iter()
                        .filter_map(|a| a.store_path.clone().map(PathBuf::from))
                        .collect();
                    let _ = Task::mark_done(&db, &job.id);
                    let _ = app.emit(
                        "codex://chunk",
                        serde_json::json!({ "kind": "done", "job_id": job.id, "images": asset_paths, "provider": "jimeng", "session_id": submit_id, "text": "", "elapsed_ms": 0 }),
                    );
                    let _ = app.emit("library://assets-changed", ());
                }
                Err(e) => {
                    let msg = e.to_string();
                    let _ = Task::mark_failed(&db, &job.id, &msg);
                    let _ = app.emit(
                        "codex://chunk",
                        serde_json::json!({ "kind": "error", "job_id": job.id, "message": msg }),
                    );
                }
            }
        }
        Err(e) => {
            let msg = e.to_string();
            tracing::info!("恢复续查未完成：job={} err={}", job.id, msg);
            // 远端仍排队中（querying/未下载到图/轮询超时）→ 保持 running + 提示；真失败 mark_failed。
            if msg.contains("排队") || msg.contains("querying") || msg.contains("未下载到图片") {
                let _ = app.emit(
                    "codex://chunk",
                    serde_json::json!({ "kind": "recover_polling", "job_id": job.id, "message": msg }),
                );
            } else {
                let _ = Task::mark_failed(&db, &job.id, &msg);
                let _ = app.emit(
                    "codex://chunk",
                    serde_json::json!({ "kind": "error", "job_id": job.id, "message": msg }),
                );
            }
        }
    }
}

/// 把生成会话的 prompt 链转成 caption 正文：从中识别 `【维度】：正文` 片段（创作板序列化时由
/// `@图名 的【维度】：section 正文` / 独立 `【维度】：正文` 注入），按 `**维度**\n正文` 段落输出，
/// 正中 caption::parse 的 section 识别 → 详情页按段展示、创作板维度 chips 随之生成。
///
/// 生成图本就由这些维度片段变换得来，无需 AI 反推，只做固定特征解析。同名维度后出现者覆盖
/// （修订版维度优先）；一条都没识别到时回退整段 prompt（caption::parse 作 raw_fallback 整段展示）。
/// prompt 完整原文另存于 generation_meta（详情页「✨ 生成来源」卡片），此处只管维度视图。
fn build_generation_caption(chain: &[String]) -> String {
    let mut dims: Vec<(String, String)> = Vec::new();
    for prompt in chain {
        for (title, body) in extract_dim_sections(prompt) {
            if let Some(slot) = dims.iter_mut().find(|(t, _)| t == &title) {
                slot.1 = body; // 后出现覆盖（修订版维度优先）
            } else {
                dims.push((title, body));
            }
        }
    }
    if dims.is_empty() {
        return chain.join("\n\n"); // 无维度片段 → 整段回退
    }
    let mut out = String::new();
    for (title, body) in &dims {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str("**");
        out.push_str(title);
        out.push_str("**\n");
        out.push_str(body);
    }
    out
}

/// 从一段 prompt 文本里抽 `【标题】：正文` 片段。正文延伸到下一个 `【` 或 `@` 或串尾（下一个维度
/// 或 @图名 引用即正文终点），再按最后一个句末标点（。！？）截断以去掉尾随连接词（如「，以及」）。
/// 标题须通过 `is_valid_dim_title`（与 caption::parse 的 section 标题规则一致），否则当普通 `【】` 跳过。
fn extract_dim_sections(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find('【') {
        let after_bracket = &rest[open + '【'.len_utf8()..];
        let Some(close) = after_bracket.find('】') else { break; };
        let title = after_bracket[..close].trim();
        let after_close = &after_bracket[close + '】'.len_utf8()..];
        let body_rest = after_close
            .strip_prefix('：')
            .or_else(|| after_close.strip_prefix(':'));
        match (is_valid_dim_title(title), body_rest) {
            (true, Some(body_rest)) => {
                let body_end = body_rest
                    .find(|c| c == '【' || c == '@')
                    .unwrap_or(body_rest.len());
                let body = cut_trailing_connector(body_rest[..body_end].trim());
                out.push((title.to_string(), body.to_string()));
                rest = &body_rest[body_end..];
            }
            _ => {
                // 非维度 【】（标题非法或 】 后无冒号）→ 跳过这个括号，从其后继续找。
                rest = after_close;
            }
        }
    }
    out
}

/// 句末标点（。！？）之后的尾随文字多为连接词（如「，以及」「，然后」），截掉。
/// 无句末标点则原样返回（正文可能本就不含句号）。
fn cut_trailing_connector(s: &str) -> &str {
    match s.rfind(|c| matches!(c, '。' | '！' | '？')) {
        Some(idx) => {
            let ch_len = s[idx..].chars().next().map_or(0, |c| c.len_utf8());
            &s[..idx + ch_len]
        }
        None => s,
    }
}

/// 维度标题有效性：非空、≤16 字、不含 ASCII 数字与反引号（与 caption::parse 的
/// `looks_like_section_label` 一致，保证 `**标题**` 能被解析成 section）。
fn is_valid_dim_title(title: &str) -> bool {
    let t = title.trim();
    !t.is_empty()
        && t.chars().count() <= 16
        && !t.chars().any(|c| c.is_ascii_digit() || c == '`')
}

#[cfg(test)]
mod tests {
    use super::*;

    // 用户给的范例（略缩短）：色调 / 光影 是现成维度，其余为 @图名 引用与自由指令。
    const EXAMPLE: &str = "请参考@街头倚坐 的【色调】：整体以暖米色、奶油黄为主。色彩饱和度不高，具有夏日街头的色彩情绪。【光影】：自然日光为主，光线柔和偏散射，没有强烈硬阴影。人物面部曝光均匀。整体对比度中等，带有胶片摄影常见的柔和层次和低锐度边缘。，以及@紫垫白猫.jpg的场景和主体动作，并为猫咪戴上@彩虹宠物项圈广告.jpg中紫色的项圈。";

    #[test]
    fn cloud_provider_keeps_own_source_tag() {
        assert_eq!(provider_source_tag("bowerbird-cloud"), "bowerbird-cloud");
        assert_eq!(provider_source_tag("jimeng"), "jimeng");
        assert_eq!(provider_source_tag("codex"), "codex");
    }

    #[test]
    fn extract_dims_from_generation_prompt() {
        let dims = extract_dim_sections(EXAMPLE);
        let titles: Vec<&str> = dims.iter().map(|(t, _)| t.as_str()).collect();
        assert_eq!(titles, vec!["色调", "光影"]);

        let palette = dims.iter().find(|(t, _)| t == "色调").unwrap();
        assert!(palette.1.contains("暖米色"));
        assert!(palette.1.ends_with('。'));
        assert!(!palette.1.contains("@"));

        let light = dims.iter().find(|(t, _)| t == "光影").unwrap();
        assert!(light.1.ends_with("低锐度边缘。"), "got: {}", light.1);
        assert!(!light.1.contains("，以及"), "尾随连接词应被截掉");
        assert!(!light.1.contains("@紫垫白猫"), "正文不应吞掉后续 @图名");
    }

    #[test]
    fn build_caption_with_dims_as_sections() {
        let caption = build_generation_caption(&[EXAMPLE.to_string()]);
        assert!(caption.contains("**色调**"));
        assert!(caption.contains("**光影**"));
        // 不应回退成整段（有维度时走分段）。
        assert!(!caption.contains("以及@紫垫白猫"));
    }

    #[test]
    fn build_caption_falls_back_to_raw_when_no_dims() {
        let caption = build_generation_caption(&["把背景改成白天".to_string()]);
        assert_eq!(caption, "把背景改成白天");
    }

    #[test]
    fn later_dim_overrides_earlier() {
        let chain = vec!["【色调】：暖色调".to_string(), "【色调】：冷色调".to_string()];
        let caption = build_generation_caption(&chain);
        assert!(caption.contains("冷色调"));
        assert!(!caption.contains("暖色调"));
        assert_eq!(caption.matches("**色调**").count(), 1);
    }

    #[test]
    fn skips_non_dimension_brackets() {
        // 【...】 后无冒号 → 不当维度，继续找下一个。
        let dims = extract_dim_sections("一段【普通括号】文字【光影】：柔和光线。");
        let titles: Vec<&str> = dims.iter().map(|(t, _)| t.as_str()).collect();
        assert_eq!(titles, vec!["光影"]);
    }
}
